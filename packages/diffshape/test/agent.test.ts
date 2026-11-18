import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCancelled, agentOptions, changedSince, detectAgents, postAllowed, runAgent, SNAPSHOT_REF, snapshotWorktree } from "@diffshape/core";
import { fileAnalyzer } from "@diffshape/fileshape";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseStart, type AgentJob, type AgentState } from "../src/agent.js";
import { App } from "../src/app.js";
import { startServer } from "../src/server.js";

/*
 * The agents are stand-ins: two scripts that take the same arguments and print the same events as
 * `claude -p --output-format stream-json` and `codex exec --json`, and do what the prompt's first word says.
 */

let dir: string;
let repo: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString();

const COMMENT = { module: "file", body: "境界を確かめてください", target: null, path: "cart.ts", side: "new", line: 2, endLine: null, code: "export const b = 2;" };

// what both stand-ins do with the prompt: "fail" → an error, "slow" → never ends, "edit" → changes files
const COMMON = `
const fs = require("node:fs");
const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const prompt = fs.readFileSync(0, "utf8");
const out = (o) => console.log(JSON.stringify(o));
const comments = ${JSON.stringify({ comments: [COMMENT, { module: "file", body: "  " }] })};
const asked = args[0] === "--version" || args[0] === "debug" || args.includes("--input-format");
if (!asked) fs.writeFileSync(process.env.FAKE_ARGS, JSON.stringify(args));
const edit = () => { fs.writeFileSync("cart.ts", "export const a = 1;\\nexport const b = 3;\\n"); fs.writeFileSync("new.ts", "export {};\\n"); };
`;

const FAKE_CLAUDE = `#!/usr/bin/env node
${COMMON}
if (args[0] === "--version") { console.log("9.8.7 (Claude Code)"); process.exit(0); }
if (args.includes("--input-format")) {
  // asked what it supports (no prompt): the models of the account
  const levels = ["low", "medium", "high", "xhigh", "max"];
  out({ type: "control_response", response: { subtype: "success", request_id: JSON.parse(prompt).request_id, response: { models: process.env.FAKE_NO_MODELS ? [] : [
    { value: "default", displayName: "Default (recommended)", supportedEffortLevels: levels },
    { value: "sonnet", displayName: "Sonnet 5.5", description: "Efficient for routine tasks", supportedEffortLevels: levels },
    { value: "claude-haiku-4-5", displayName: "Haiku 4.5" },
  ] } } });
  process.exit(0);
}
const review = args.includes("--json-schema");
out({ type: "system", subtype: "init" });
out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: process.cwd() + "/cart.ts" } }] } });
if (prompt.startsWith("slow")) setInterval(() => {}, 1000);
else if (prompt.startsWith("fail")) out({ type: "result", subtype: "error_during_execution", is_error: true, result: "ログインしていません" });
else if (review) {
  out({ type: "assistant", message: { content: [{ type: "tool_use", name: "StructuredOutput", input: comments }] } });
  out({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(comments), structured_output: comments });
} else {
  if (prompt.startsWith("edit")) edit();
  out({ type: "assistant", message: { content: [{ type: "text", text: "直しました\\n詳細" }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "[cart.ts](" + process.cwd() + "/cart.ts) を直しました" });
}
`;

const FAKE_CODEX = `#!/usr/bin/env node
${COMMON}
if (args[0] === "--version") { console.log("codex-cli 0.1.2-alpha.3"); process.exit(0); }
if (args[0] === "debug" && args[1] === "models") {
  const level = (effort) => ({ effort, description: "" });
  out({ models: [
    { slug: "gpt-x", display_name: "GPT-X", visibility: "list", supported_reasoning_levels: ["low", "medium", "high", "ultra"].map(level) },
    { slug: "gpt-x-mini", display_name: "GPT-X mini", visibility: "list", supported_reasoning_levels: ["low", "medium"].map(level) },
    { slug: "gpt-internal", display_name: "Internal", visibility: "hide", supported_reasoning_levels: ["low"].map(level) },
  ] });
  process.exit(0);
}
const review = args.includes("--output-schema");
out({ type: "thread.started" });
out({ type: "item.started", item: { type: "command_execution", command: "/bin/zsh -lc 'git diff HEAD -- '\\"'*.ts'\\"''" } });
if (prompt.startsWith("fail")) {
  out({ type: "error", message: JSON.stringify({ error: { message: "モデルが使えません" } }) });
  out({ type: "turn.failed", error: { message: JSON.stringify({ error: { message: "モデルが使えません" } }) } });
  process.exit(1);
}
if (prompt.startsWith("edit")) { edit(); out({ type: "item.completed", item: { type: "file_change", changes: [{ path: process.cwd() + "/cart.ts", kind: "update" }] } }); }
const last = review ? JSON.stringify(comments) : "直しました";
out({ type: "item.completed", item: { type: "agent_message", text: last } });
fs.writeFileSync(arg("-o"), last);
out({ type: "turn.completed" });
`;

function script(name: string, body: string) {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

const lastArgs = () => JSON.parse(readFileSync(process.env.FAKE_ARGS!, "utf8")) as string[];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "diffshape-agent-test-"));
  repo = join(dir, "repo");
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(join(repo, ".gitignore"), "ignored.log\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  writeFileSync(join(repo, "cart.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "cart");
  process.env.DIFFSHAPE_CLAUDE = script("fake-claude", FAKE_CLAUDE);
  process.env.DIFFSHAPE_CODEX = script("fake-codex", FAKE_CODEX);
  process.env.FAKE_ARGS = join(dir, "args.json");
});

// every test starts from the same uncommitted change: one edited line, one untracked file
function dirty() {
  writeFileSync(join(repo, "cart.ts"), "export const a = 1;\nexport const b = 2;\n");
  writeFileSync(join(repo, "untracked.ts"), "export {};\n");
  writeFileSync(join(repo, "ignored.log"), "x\n");
  rmSync(join(repo, "new.ts"), { force: true });
}

afterAll(() => {
  delete process.env.DIFFSHAPE_CLAUDE;
  delete process.env.DIFFSHAPE_CODEX;
  delete process.env.FAKE_ARGS;
  rmSync(dir, { recursive: true, force: true });
});

describe("runAgent", () => {
  beforeAll(dirty);

  it("finds the agents named by DIFFSHAPE_CLAUDE / DIFFSHAPE_CODEX, and none for a path that is not there", async () => {
    expect(await detectAgents()).toEqual(["claude", "codex"]);
    const real = process.env.DIFFSHAPE_CODEX;
    process.env.DIFFSHAPE_CODEX = join(dir, "nope");
    expect(await detectAgents()).toEqual(["claude"]);
    process.env.DIFFSHAPE_CODEX = real;
  });

  it("asks each agent for its models and their efforts", async () => {
    // what runs with no model chosen is "default": not a choice of its own
    expect(await agentOptions("claude", repo)).toEqual({
      label: "Claude Code",
      version: "9.8.7",
      models: [
        { id: "sonnet", label: "Sonnet 5.5", description: "Efficient for routine tasks", efforts: ["low", "medium", "high", "xhigh", "max"] },
        { id: "claude-haiku-4-5", label: "Haiku 4.5", efforts: [] },
      ],
      defaultEfforts: ["low", "medium", "high", "xhigh", "max"],
    });
    // hidden models are left out; with no model chosen, any effort a model takes can be picked
    expect(await agentOptions("codex", repo)).toEqual({
      label: "Codex",
      version: "0.1.2-alpha.3",
      models: [
        { id: "gpt-x", label: "GPT-X", efforts: ["low", "medium", "high", "ultra"] },
        { id: "gpt-x-mini", label: "GPT-X mini", efforts: ["low", "medium"] },
      ],
      defaultEfforts: ["low", "medium", "high", "ultra"],
    });
  });

  it("offers a short fixed list when the agent does not answer", async () => {
    process.env.FAKE_NO_MODELS = "1";
    const o = await agentOptions("claude", repo);
    delete process.env.FAKE_NO_MODELS;
    expect(o.models.map((m) => m.id)).toEqual(["opus", "fable", "sonnet", "haiku"]);
    expect(o.version).toBe("9.8.7");
    expect(o.defaultEfforts).toContain("high");
  });

  it("reviews read-only with Claude Code and reads the structured answer", async () => {
    const log: string[] = [];
    const r = await runAgent({ agent: "claude", kind: "review", cwd: repo, prompt: "review", onLog: (l) => log.push(l) });
    // a comment without text is dropped
    expect(r.comments).toEqual([COMMENT]);
    // paths are shown from the repository root, and the answer itself is not a step
    expect(log).toEqual(["Read: cart.ts"]);
    const args = lastArgs();
    expect(args.slice(0, 3)).toEqual(["-p", "--permission-mode", "plan"]);
    expect(args).toContain("--json-schema");
    expect(args).not.toContain("--model");
  });

  it("fixes with Claude Code in its automatic mode, with the chosen model and effort", async () => {
    const log: string[] = [];
    const r = await runAgent({ agent: "claude", kind: "fix", cwd: repo, prompt: "fix", model: "sonnet", effort: "high", onLog: (l) => log.push(l) });
    // paths in the report are from the repository root too
    expect(r).toEqual({ text: "[cart.ts](cart.ts) を直しました" });
    expect(log).toEqual(["Read: cart.ts", "直しました"]);
    const args = lastArgs();
    expect(args.slice(0, 3)).toEqual(["-p", "--permission-mode", "auto"]);
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 4)).toEqual(["--model", "sonnet", "--effort", "high"]);
    expect(args).not.toContain("--json-schema");
  });

  it("reviews and fixes with Codex in its sandboxes", async () => {
    const log: string[] = [];
    const r = await runAgent({ agent: "codex", kind: "review", cwd: repo, prompt: "review", effort: "low", onLog: (l) => log.push(l) });
    expect(r.comments).toEqual([COMMENT]);
    // the shell wrapper and its quoting are taken off the command; the JSON answer is not a step
    expect(log).toEqual(["$ git diff HEAD -- '*.ts'"]);
    let args = lastArgs();
    expect(args.slice(0, 3)).toEqual(["exec", "--sandbox", "read-only"]);
    expect(args).toContain("--output-schema");
    expect(args).toContain('model_reasoning_effort="low"');
    expect(args.at(-1)).toBe("-");

    const fixLog: string[] = [];
    expect(await runAgent({ agent: "codex", kind: "fix", cwd: repo, prompt: "edit", model: "gpt-x", onLog: (l) => fixLog.push(l) })).toEqual({ text: "直しました" });
    expect(fixLog).toEqual(["$ git diff HEAD -- '*.ts'", "Edit: cart.ts", "直しました"]);
    args = lastArgs();
    expect(args.slice(0, 3)).toEqual(["exec", "--sandbox", "workspace-write"]);
    expect(args.slice(args.indexOf("-m"), args.indexOf("-m") + 2)).toEqual(["-m", "gpt-x"]);
    expect(args).not.toContain("--output-schema");
    dirty();
  });

  it("reports the agent's own error", async () => {
    await expect(runAgent({ agent: "claude", kind: "review", cwd: repo, prompt: "fail", onLog: () => {} })).rejects.toThrow("ログインしていません");
    await expect(runAgent({ agent: "codex", kind: "review", cwd: repo, prompt: "fail", onLog: () => {} })).rejects.toThrow("モデルが使えません");
  });

  it("refuses a model or an effort that could be read as something else", async () => {
    const run = { agent: "claude", kind: "fix", cwd: repo, prompt: "fix", onLog: () => {} } as const;
    await expect(runAgent({ ...run, model: "--dangerously-skip-permissions" })).rejects.toThrow(/モデル名/);
    await expect(runAgent({ ...run, effort: "high --x" })).rejects.toThrow(/effort/);
  });

  it("stops when its signal says so", async () => {
    const abort = new AbortController();
    const run = runAgent({ agent: "claude", kind: "fix", cwd: repo, prompt: "slow", signal: abort.signal, onLog: () => abort.abort() });
    await expect(run).rejects.toBeInstanceOf(AgentCancelled);
  });
});

describe("snapshotWorktree", () => {
  beforeAll(dirty);

  it("keeps the working tree, untracked files included, without touching it or what is staged", async () => {
    const before = git("status", "--porcelain");
    const commit = await snapshotWorktree(repo);
    expect(git("status", "--porcelain")).toBe(before);
    expect(git("rev-parse", SNAPSHOT_REF).trim()).toBe(commit);
    expect(git("ls-tree", "-r", "--name-only", commit).trim().split("\n")).toEqual([".gitignore", "cart.ts", "untracked.ts"]);
    expect(git("show", `${commit}:cart.ts`)).toBe("export const a = 1;\nexport const b = 2;\n");
    // not a branch, and HEAD stays
    expect(git("branch", "--list").trim()).toBe("* main");
    expect(git("rev-parse", `${commit}^`)).toBe(git("rev-parse", "HEAD"));

    expect(await changedSince(repo, commit)).toEqual([]);
    writeFileSync(join(repo, "cart.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, "new.ts"), "export {};\n");
    rmSync(join(repo, "untracked.ts"));
    expect(await changedSince(repo, commit)).toEqual(["cart.ts", "new.ts", "untracked.ts"]);
  });
});

describe("postAllowed", () => {
  const json = { "content-type": "application/json" };

  it("takes a JSON request from the server's own page only", () => {
    expect(postAllowed("127.0.0.1", { host: "127.0.0.1:4977", origin: "http://127.0.0.1:4977", ...json })).toBe(true);
    expect(postAllowed("127.0.0.1", { host: "localhost:5173", origin: "http://localhost:5173", "content-type": "application/json; charset=utf-8" })).toBe(true);
    // another site, another port, no origin (not a page), a form
    expect(postAllowed("127.0.0.1", { host: "127.0.0.1:4977", origin: "https://example.com", ...json })).toBe(false);
    expect(postAllowed("127.0.0.1", { host: "127.0.0.1:4977", origin: "http://127.0.0.1:8080", ...json })).toBe(false);
    expect(postAllowed("127.0.0.1", { host: "127.0.0.1:4977", ...json })).toBe(false);
    expect(postAllowed("127.0.0.1", { host: "127.0.0.1:4977", origin: "http://127.0.0.1:4977", "content-type": "text/plain" })).toBe(false);
    // never on a server open to the network
    expect(postAllowed("0.0.0.0", { host: "192.168.0.2:4977", origin: "http://192.168.0.2:4977", ...json })).toBe(false);
  });
});

describe("parseStart", () => {
  it("reads what the screen posts and refuses the rest", () => {
    expect(parseStart({ kind: "review", agent: "codex", prompt: "p", model: " gpt-x ", effort: "" })).toEqual({ kind: "review", agent: "codex", prompt: "p", model: "gpt-x" });
    expect(() => parseStart({ kind: "run", agent: "claude", prompt: "p" })).toThrow(/kind/);
    expect(() => parseStart({ kind: "fix", agent: "other", prompt: "p" })).toThrow(/agent/);
    expect(() => parseStart({ kind: "fix", agent: "claude", prompt: " " })).toThrow(/prompt/);
    expect(() => parseStart({ kind: "fix", agent: "claude", prompt: "p", model: "-x" })).toThrow(/モデル名/);
    expect(() => parseStart({ kind: "fix", agent: "codex", prompt: "p", effort: "--max" })).toThrow(/effort/);
    expect(() => parseStart(null)).toThrow(/kind/);
  });
});

describe("the agent endpoints", () => {
  let server: Server;
  let url: string;
  let app: App;

  beforeAll(async () => {
    dirty();
    app = new App(repo, {}, [fileAnalyzer]);
    await app.refresh();
    ({ server, url } = await startServer(app, "127.0.0.1", 49797));
  });
  afterEach(async () => {
    app.cancelAgent();
    await app.agentIdle();
    dirty();
  });
  afterAll(() => server.close());

  const state = async () => (await (await fetch(`${url}/api/agent`)).json()) as AgentState;
  const post = (path: string, body: unknown, headers: Record<string, string> = { origin: url }) => fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const finished = async () => {
    await app.agentIdle();
    return (await state()).job!;
  };

  it("says what can run: the agents found, with their models and efforts", async () => {
    const s = await state();
    expect(s.available).toBe(true);
    expect(s.job).toBeNull();
    expect(s.agents.map((a) => [a.id, a.label, a.models.map((m) => m.id)])).toEqual([
      ["claude", "Claude Code", ["sonnet", "claude-haiku-4-5"]],
      ["codex", "Codex", ["gpt-x", "gpt-x-mini"]],
    ]);
    expect(s.agents[0].defaultEfforts).toContain("xhigh");
    expect((await (await fetch(`${url}/api/info`)).json()).baseRev).toBe(git("rev-parse", "HEAD").trim());
  });

  it("runs a review and keeps its comments for the screen", async () => {
    const res = await post("/api/agent/start", { kind: "review", agent: "claude", prompt: "review", model: "sonnet", effort: "low" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as AgentJob).status).toBe("running");
    const job = await finished();
    expect(job).toMatchObject({ kind: "review", agent: "claude", model: "sonnet", effort: "low", status: "done", comments: [COMMENT], log: ["Read: cart.ts"] });
    // a review takes no snapshot
    expect(job.snapshot).toBeUndefined();
  });

  it("keeps the working tree before a fix and lists what the fix changed", async () => {
    expect((await post("/api/agent/start", { kind: "fix", agent: "codex", prompt: "edit" })).status).toBe(200);
    const job = await finished();
    expect(job).toMatchObject({ status: "done", text: "直しました", snapshot: SNAPSHOT_REF, changedFiles: ["cart.ts", "new.ts"] });
    expect(git("show", `${SNAPSHOT_REF}:cart.ts`)).toBe("export const a = 1;\nexport const b = 2;\n");
    expect(readFileSync(join(repo, "cart.ts"), "utf8")).toBe("export const a = 1;\nexport const b = 3;\n");
  });

  it("reports a failed job, and runs one job at a time until it is stopped", async () => {
    await post("/api/agent/start", { kind: "review", agent: "codex", prompt: "fail" });
    expect(await finished()).toMatchObject({ status: "failed", error: "モデルが使えません" });

    await post("/api/agent/start", { kind: "fix", agent: "claude", prompt: "slow" });
    const second = await post("/api/agent/start", { kind: "review", agent: "claude", prompt: "review" });
    expect(second.status).toBe(409);
    expect((await post("/api/agent/cancel", {})).status).toBe(200);
    expect(await finished()).toMatchObject({ status: "cancelled", changedFiles: [] });
  });

  it("takes only a model of the agent's list, and an effort that model takes", async () => {
    const start = (more: object) => post("/api/agent/start", { kind: "review", agent: "codex", prompt: "review", ...more });
    expect((await start({ model: "gpt-unknown" })).status).toBe(400);
    expect((await start({ model: "gpt-internal" })).status).toBe(400);
    // "ultra" is for gpt-x only; with no model chosen it can be picked (the user's own model may take it)
    expect((await start({ model: "gpt-x-mini", effort: "ultra" })).status).toBe(400);
    expect((await start({ effort: "max" })).status).toBe(400);
    expect((await state()).job?.status).not.toBe("running");
    expect((await start({ model: "gpt-x", effort: "ultra" })).status).toBe(200);
    expect(await finished()).toMatchObject({ status: "done", model: "gpt-x", effort: "ultra" });
  });

  it("starts nothing for a request that is not from its own page", async () => {
    const body = { kind: "fix", agent: "claude", prompt: "edit" };
    expect((await post("/api/agent/start", body, { origin: "https://example.com" })).status).toBe(403);
    expect((await post("/api/agent/start", body, {})).status).toBe(403);
    expect((await fetch(`${url}/api/agent/start`)).status).toBe(405);
    expect((await post("/api/agent/start", { ...body, agent: "other" })).status).toBe(400);
    expect((await state()).job?.status).not.toBe("running");
    expect(existsSync(join(repo, "new.ts"))).toBe(false);
  });
});

describe("where the AI is not offered", () => {
  it("is off for a comparison of commits, and on a server open to the network", async () => {
    dirty();
    const commits = new App(repo, { target: "@" }, [fileAnalyzer]);
    await commits.refresh();
    expect(await commits.agentState()).toMatchObject({ available: false, reason: expect.stringContaining("作業ディレクトリ") });
    await expect(commits.startAgent({ kind: "review", agent: "claude", prompt: "review" })).rejects.toThrow(/作業ディレクトリ/);

    const open = new App(repo, {}, [fileAnalyzer], { agents: false });
    await open.refresh();
    expect(await open.agentState()).toMatchObject({ available: false, agents: [], reason: expect.stringContaining("--host") });
  });
});
