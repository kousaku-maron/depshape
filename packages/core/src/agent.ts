import { execFile, spawn } from "node:child_process";
import { access, constants, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/*
 * Runs the coding agent the user already has on this machine (Claude Code or Codex) without a terminal:
 * read-only to review a comparison, or with edits and commands to fix what the comments say.
 * The agent uses its own login; nothing here knows about keys or accounts.
 */

export type AgentId = "claude" | "codex";

/** "review" reads the repository and answers with comments; "fix" edits the working tree */
export type AgentKind = "review" | "fix";

export const AGENT_IDS: readonly AgentId[] = ["claude", "codex"];

/** A model the agent can run, with the reasoning efforts it takes */
export interface AgentModel {
  /** What is passed to the agent ("sonnet", "gpt-6-astra") */
  id: string;
  label: string;
  description?: string;
  efforts: string[];
}

/** What the screen offers for one agent. Nothing chosen means the agent's own default (its settings) */
export interface AgentOptions {
  label: string;
  /** The version of the executable that runs ("0.153.4"): an old one knows fewer models */
  version?: string;
  models: AgentModel[];
  /** The efforts to offer while no model is chosen */
  defaultEfforts: string[];
}

export const AGENT_LABEL: Record<AgentId, string> = { claude: "Claude Code", codex: "Codex" };

// offered when the agent can not be asked for its list (an older version, no login yet)
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const FALLBACK_OPTIONS: Record<AgentId, AgentOptions> = {
  claude: {
    label: AGENT_LABEL.claude,
    models: [
      { id: "opus", label: "Opus", efforts: CLAUDE_EFFORTS },
      { id: "fable", label: "Fable", efforts: CLAUDE_EFFORTS },
      { id: "sonnet", label: "Sonnet", efforts: CLAUDE_EFFORTS },
      { id: "haiku", label: "Haiku", efforts: CLAUDE_EFFORTS },
    ],
    defaultEfforts: CLAUDE_EFFORTS,
  },
  codex: { label: AGENT_LABEL.codex, models: [], defaultEfforts: ["low", "medium", "high"] },
};

/** A model name or an effort is passed to the agent as one argument: no spaces, and not something that reads as an option */
export const validModel = (m: string) => /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,99}$/.test(m);
export const validEffort = (e: string) => /^[a-z]{1,20}$/.test(e);

/**
 * One comment of a review, as the agent answers it. Every module reads the fields it needs:
 * fileshape `path` / `side` / `line` / `endLine` / `code`, the others `target` (one of the keys the
 * prompt listed). The screen has the same shape as `AiComment` in @diffshape/ui.
 */
export interface ReviewItem {
  module: string;
  body: string;
  target: string | null;
  path: string | null;
  side: "old" | "new" | null;
  line: number | null;
  endLine: number | null;
  code: string | null;
}

// every field required and nullable: the form both agents accept for a structured answer
const nullable = (type: string) => ({ type: [type, "null"] });
export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["comments"],
  properties: {
    comments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["module", "body", "target", "path", "side", "line", "endLine", "code"],
        properties: {
          module: { type: "string" },
          body: { type: "string" },
          target: nullable("string"),
          path: nullable("string"),
          side: { type: ["string", "null"], enum: ["old", "new", null] },
          line: nullable("integer"),
          endLine: nullable("integer"),
          code: nullable("string"),
        },
      },
    },
  },
};

const ENV: Record<AgentId, string> = { claude: "DIFFSHAPE_CLAUDE", codex: "DIFFSHAPE_CODEX" };

// where the agent's own installer puts it when it is not on PATH (a shell alias points there)
const FALLBACK: Record<AgentId, string[]> = { claude: [join(homedir(), ".claude", "local", "claude")], codex: [] };

const executable = (path: string) =>
  access(path, constants.X_OK).then(
    () => true,
    () => false,
  );

/** The agent's executable: DIFFSHAPE_CLAUDE / DIFFSHAPE_CODEX when set, else from PATH, else where its installer puts it */
export async function findAgent(id: AgentId): Promise<string | null> {
  const forced = process.env[ENV[id]];
  if (forced !== undefined) return forced && (await executable(forced)) ? forced : null;
  const names = process.platform === "win32" ? [`${id}.exe`] : [id];
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const p of [...dirs.flatMap((d) => names.map((n) => join(d, n))), ...FALLBACK[id]]) if (await executable(p)) return p;
  return null;
}

export async function detectAgents(): Promise<AgentId[]> {
  const found = await Promise.all(AGENT_IDS.map(findAgent));
  return AGENT_IDS.filter((_, i) => found[i] !== null);
}

/** Runs the agent for a short answer (no prompt to a model): its output, or an error after `timeout` ms */
function capture(bin: string, args: string[], cwd: string, input = "", timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { cwd, timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && validEffort(x)) : []);
const union = (lists: string[][]) => [...new Set(lists.flat())];

/**
 * Claude Code has no command that lists its models, but a session started without a prompt answers
 * what it supports (the same answer its SDK reads): the models of the account, each with its efforts.
 */
async function claudeOptions(bin: string, cwd: string): Promise<AgentOptions> {
  const ask = JSON.stringify({ type: "control_request", request_id: "diffshape-models", request: { subtype: "initialize" } });
  const out = await capture(bin, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], cwd, `${ask}\n`);
  for (const line of out.split("\n")) {
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const list = o?.type === "control_response" ? (o.response?.response ?? o.response)?.models : undefined;
    if (!Array.isArray(list)) continue;
    const all = list.filter((m: any) => typeof m?.value === "string" && validModel(m.value));
    const models: AgentModel[] = all
      .filter((m: any) => m.value !== "default")
      .map((m: any) => ({ id: m.value, label: String(m.displayName ?? m.value), ...(m.description ? { description: String(m.description) } : {}), efforts: strings(m.supportedEffortLevels) }));
    if (!models.length) break;
    // "default" is what runs when no model is chosen
    const byDefault = all.find((m: any) => m.value === "default");
    return { label: AGENT_LABEL.claude, models, defaultEfforts: byDefault ? strings(byDefault.supportedEffortLevels) : union(models.map((m) => m.efforts)) };
  }
  throw new Error("no models in the answer");
}

/** `codex debug models`: the catalog of the account, each model with its reasoning levels */
async function codexOptions(bin: string, cwd: string): Promise<AgentOptions> {
  const list = (JSON.parse(await capture(bin, ["debug", "models"], cwd)) as { models?: unknown }).models;
  if (!Array.isArray(list)) throw new Error("no models in the answer");
  const models: AgentModel[] = list
    .filter((m: any) => typeof m?.slug === "string" && validModel(m.slug) && m.visibility === "list")
    .map((m: any) => ({
      id: m.slug,
      label: String(m.display_name ?? m.slug),
      ...(m.description ? { description: String(m.description) } : {}),
      efforts: strings((m.supported_reasoning_levels ?? []).map((l: any) => l?.effort)),
    }));
  if (!models.length) throw new Error("no models in the answer");
  // the model of the user's settings is not known here: offer what any model takes
  return { label: AGENT_LABEL.codex, models, defaultEfforts: union(models.map((m) => m.efforts)) };
}

/** The models and efforts to choose from, asked from the agent itself; a short fixed list when it does not answer */
export async function agentOptions(id: AgentId, cwd: string): Promise<AgentOptions> {
  const bin = await findAgent(id);
  if (!bin) return FALLBACK_OPTIONS[id];
  const [options, version] = await Promise.all([
    (id === "claude" ? claudeOptions(bin, cwd) : codexOptions(bin, cwd)).catch(() => FALLBACK_OPTIONS[id]),
    // "codex-cli 0.153.4", "2.1.0 (Claude Code)"
    capture(bin, ["--version"], cwd).then(
      (out) => /\d+\.\d+\.\d+[\w.-]*/.exec(out)?.[0],
      () => undefined,
    ),
  ]);
  return { ...options, ...(version ? { version } : {}) };
}

export interface AgentRun {
  agent: AgentId;
  kind: AgentKind;
  /** The repository root: the agent works there */
  cwd: string;
  prompt: string;
  /** Model to use (see validModel); the agent's default when left out */
  model?: string;
  /** One of the model's efforts; the agent's default when left out */
  effort?: string;
  /** One line for each thing the agent does (a command, a file it reads or edits, what it says) */
  onLog: (line: string) => void;
  signal?: AbortSignal;
}

export interface AgentResult {
  /** The agent's last message (for a fix: what it changed) */
  text: string;
  /** The comments of a review */
  comments?: ReviewItem[];
}

/** The run was stopped through its signal */
export class AgentCancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

interface Parsed {
  text: string;
  structured?: unknown;
  error?: string;
}

const firstLine = (s: string, max = 200) => {
  const l = s.trim().split("\n")[0] ?? "";
  return l.length > max ? `${l.slice(0, max)}…` : l;
};

/** Reads one line of `claude -p --output-format stream-json` */
function claudeEvent(o: any, out: Parsed, log: (line: string) => void) {
  if (o.type === "assistant" && Array.isArray(o.message?.content)) {
    for (const c of o.message.content) {
      if (c.type === "text" && c.text?.trim()) log(firstLine(c.text));
      // the structured answer is a tool call too: not something the agent "does"
      if (c.type === "tool_use" && c.name !== "StructuredOutput") {
        const i = c.input ?? {};
        const what = i.description ?? i.file_path ?? i.path ?? i.pattern ?? i.command ?? "";
        log(what ? `${c.name}: ${firstLine(String(what))}` : String(c.name));
      }
    }
  }
  if (o.type === "result") {
    out.text = typeof o.result === "string" ? o.result : "";
    out.structured = o.structured_output;
    if (o.is_error) out.error = out.text || String(o.subtype ?? "error");
  }
}

/** An API error arrives as JSON in a string: {"error":{"message":"…"}} */
function errorText(message: unknown): string {
  const s = String(message ?? "");
  try {
    const o = JSON.parse(s);
    return String(o?.error?.message ?? o?.message ?? s);
  } catch {
    return s;
  }
}

/** The text one quoted shell word stands for ('a '"'b'"' c' → a 'b' c), or null when it is not one word */
function shellWord(w: string): string | null {
  let out = "";
  let i = 0;
  while (i < w.length) {
    const c = w[i];
    if (c === "'") {
      const end = w.indexOf("'", i + 1);
      if (end < 0) return null;
      out += w.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      for (i++; i < w.length && w[i] !== '"'; i++) {
        if (w[i] === "\\" && '"\\$`'.includes(w[i + 1] ?? "")) i++;
        out += w[i];
      }
      if (i >= w.length) return null;
      i++;
    } else if (/\s/.test(c)) {
      return null;
    } else {
      if (c === "\\" && i + 1 < w.length) i++;
      out += w[i++];
    }
  }
  return out;
}

/** Reads one line of `codex exec --json` */
function codexEvent(o: any, out: Parsed, log: (line: string) => void, review: boolean) {
  const item = o.item;
  if (o.type === "item.started" && item?.type === "command_execution") {
    // "/bin/zsh -lc 'git diff'" → "git diff"
    const m = /^\S+ -lc ([\s\S]+)$/.exec(String(item.command));
    log(`$ ${firstLine((m && shellWord(m[1])) ?? String(item.command))}`);
  }
  if (o.type === "item.completed" && item) {
    if (item.type === "agent_message" && typeof item.text === "string") {
      out.text = item.text;
      // the last message of a review is the JSON answer
      if (!(review && item.text.trimStart().startsWith("{"))) log(firstLine(item.text));
    }
    if (item.type === "file_change" && Array.isArray(item.changes)) log(`Edit: ${item.changes.map((c: any) => String(c.path)).join(", ")}`);
    // warnings of the agent itself (its own settings); the run goes on
    if (item.type === "error") log(firstLine(String(item.message)));
  }
  if (o.type === "error") out.error = errorText(o.message);
  if (o.type === "turn.failed") out.error = errorText(o.error?.message);
}

function toItems(value: unknown): ReviewItem[] {
  const list = (value as { comments?: unknown } | null)?.comments;
  if (!Array.isArray(list)) throw new Error("エージェントの答えにコメントの一覧がありません");
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
  return list
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && typeof (c as any).module === "string" && typeof (c as any).body === "string" && (c as any).body.trim() !== "")
    .map((c) => ({
      module: c.module as string,
      body: (c.body as string).trim(),
      target: str(c.target),
      path: str(c.path),
      side: c.side === "old" || c.side === "new" ? c.side : null,
      line: int(c.line),
      endLine: int(c.endLine),
      // not trimmed: the code is matched against the file's lines
      code: typeof c.code === "string" ? c.code : null,
    }));
}

function parseAnswer(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`エージェントの答えを読めませんでした: ${firstLine(text) || "（空）"}`);
  }
}

export async function runAgent(run: AgentRun): Promise<AgentResult> {
  const bin = await findAgent(run.agent);
  if (!bin) throw new Error(`${run.agent} が見つかりません`);
  const review = run.kind === "review";
  if (run.model !== undefined && !validModel(run.model)) throw new Error(`モデル名が正しくありません: ${run.model}`);
  if (run.effort !== undefined && !validEffort(run.effort)) throw new Error(`effort が正しくありません: ${run.effort}`);
  const tmp =await mkdtemp(join(tmpdir(), "diffshape-agent-"));
  try {
    let args: string[];
    const last = join(tmp, "last.txt");
    if (run.agent === "claude") {
      args = ["-p", "--permission-mode", review ? "plan" : "auto", "--output-format", "stream-json", "--verbose"];
      if (run.model) args.push("--model", run.model);
      if (run.effort) args.push("--effort", run.effort);
      if (review) args.push("--json-schema", JSON.stringify(REVIEW_SCHEMA));
    } else {
      args = ["exec", "--sandbox", review ? "read-only" : "workspace-write", "--json", "-o", last, "-C", run.cwd];
      if (run.model) args.push("-m", run.model);
      if (run.effort) args.push("-c", `model_reasoning_effort="${run.effort}"`);
      if (review) {
        const schema = join(tmp, "schema.json");
        await writeFile(schema, JSON.stringify(REVIEW_SCHEMA));
        args.push("--output-schema", schema);
      }
      args.push("-"); // the prompt comes on stdin
    }

    // paths in the log are shown from the repository root
    // (the longer spelling first: one may be the other behind a symlink, /private/tmp and /tmp)
    const roots = [...new Set([run.cwd, await realpath(run.cwd).catch(() => run.cwd)])].map((r) => `${r}/`).sort((x, y) => y.length - x.length);
    const fromRoot = (text: string) => roots.reduce((l, r) => l.split(r).join(""), text);
    let lastLine = "";
    const log = (text: string) => {
      const line = fromRoot(text);
      // an agent may say the same thing twice in a row (a warning about its own settings)
      if (line !== lastLine) run.onLog((lastLine = line));
    };

    const out: Parsed = { text: "" };
    const code = await new Promise<number | null>((resolve, reject) => {
      // its own process group, so stopping it also stops the commands it started
      const proc = spawn(bin, args, { cwd: run.cwd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
      const kill = (sig: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, sig);
          else proc.kill(sig);
        } catch {
          /* already gone */
        }
      };
      const stop = () => {
        kill("SIGTERM");
        setTimeout(() => kill("SIGKILL"), 3000).unref();
      };
      if (run.signal?.aborted) stop();
      run.signal?.addEventListener("abort", stop, { once: true });

      let buf = "";
      proc.stdout.setEncoding("utf8").on("data", (d: string) => {
        buf += d;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let o: unknown;
          try {
            o = JSON.parse(line);
          } catch {
            continue; // not an event
          }
          if (run.agent === "claude") claudeEvent(o, out, log);
          else codexEvent(o, out, log, review);
        }
      });
      let err = "";
      proc.stderr.setEncoding("utf8").on("data", (d: string) => (err = (err + d).slice(-2000)));
      proc.on("error", reject);
      proc.on("close", (c) => {
        run.signal?.removeEventListener("abort", stop);
        if (c !== 0 && !out.error && !out.text) out.error = err.trim() || `${run.agent} が終了コード ${c} で終わりました`;
        resolve(c);
      });
      proc.stdin.on("error", () => {}); // the agent closed before reading the prompt: `close` reports it
      proc.stdin.end(run.prompt);
    });

    if (run.signal?.aborted) throw new AgentCancelled();
    if (out.error) throw new Error(out.error);
    if (code !== 0) throw new Error(`${run.agent} が終了コード ${code} で終わりました`);
    if (run.agent === "codex") out.text = (await readFile(last, "utf8").catch(() => "")) || out.text;
    if (!review) return { text: fromRoot(out.text.trim()) };
    return { text: "", comments: toItems(out.structured ?? parseAnswer(out.text)) };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
