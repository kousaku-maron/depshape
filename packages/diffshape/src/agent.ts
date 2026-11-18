import {
  AGENT_IDS,
  AgentCancelled,
  agentOptions,
  changedSince,
  detectAgents,
  HttpError,
  runAgent,
  SNAPSHOT_REF,
  snapshotWorktree,
  validEffort,
  validModel,
  type AgentId,
  type AgentKind,
  type AgentOptions,
  type ResolvedSources,
  type ReviewItem,
} from "@diffshape/core";

/*
 * The AI review and fix of the app: one job at a time, run by the agent the user chose. The screen
 * writes the prompt (it has every module's data and comments), starts the job and asks how it goes.
 *
 * Only for a comparison with the working tree: a fix edits the working tree, so the next reload shows
 * it in the diff and the comments tell what it resolved.
 */

export interface AgentJob {
  id: number;
  kind: AgentKind;
  agent: AgentId;
  model?: string;
  effort?: string;
  status: "running" | "done" | "failed" | "cancelled";
  startedAt: number;
  endedAt?: number;
  /** What the agent did so far, one line each (the last LOG_LINES) */
  log: string[];
  error?: string;
  /** The agent's last message (a fix: what it changed) */
  text?: string;
  /** The comments of a review */
  comments?: ReviewItem[];
  /** A fix: the ref that keeps the working tree as it was before, and the files that differ from it now */
  snapshot?: string;
  changedFiles?: string[];
}

export interface AgentState {
  /** Whether a job can be started on this comparison */
  available: boolean;
  /** Why not, for the screen */
  reason?: string;
  /** The agents found on this machine, with what can be chosen for each */
  agents: ({ id: AgentId } & AgentOptions)[];
  /** The running job, or the last one */
  job: AgentJob | null;
}

export interface StartRequest {
  kind: AgentKind;
  agent: AgentId;
  prompt: string;
  model?: string;
  effort?: string;
}

const LOG_LINES = 300;
const MAX_PROMPT = 1024 * 1024;

const bad = (message: string): never => {
  throw new HttpError(400, message);
};

/** Checks what the screen sent (anything can be posted to a local server) */
export function parseStart(body: unknown): StartRequest {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (b.kind !== "review" && b.kind !== "fix") bad("kind は review か fix です");
  if (!AGENT_IDS.includes(b.agent as AgentId)) bad("agent は claude か codex です");
  if (typeof b.prompt !== "string" || !b.prompt.trim() || b.prompt.length > MAX_PROMPT) bad("prompt がないか、長すぎます");
  const agent = b.agent as AgentId;
  // "" is the agent's own default, like leaving it out
  const model = typeof b.model === "string" && b.model.trim() ? b.model.trim() : undefined;
  const effort = typeof b.effort === "string" && b.effort ? b.effort : undefined;
  if (model !== undefined && !validModel(model)) bad(`モデル名が正しくありません: ${model}`);
  if (effort !== undefined && !validEffort(effort)) bad(`effort が正しくありません: ${effort}`);
  return { kind: b.kind as AgentKind, agent, prompt: b.prompt as string, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

export class AgentJobs {
  private job: AgentJob | null = null;
  private abort: AbortController | null = null;
  private running: Promise<void> = Promise.resolve();
  private found: Promise<AgentState["agents"]> | null = null;
  private seq = 0;

  /** `enabled` is false when the server is open to the network: nobody else may start an agent here */
  constructor(private enabled: boolean) {}

  /** The agents on this machine with their models, asked once: they do not change while the app runs */
  private agents(root: string): Promise<AgentState["agents"]> {
    return (this.found ??= detectAgents().then((ids) => Promise.all(ids.map(async (id) => ({ id, ...(await agentOptions(id, root)) })))));
  }

  async state(sources: ResolvedSources): Promise<AgentState> {
    const agents = this.enabled ? await this.agents(sources.root) : [];
    const ids = agents.map((a) => a.id);
    const reason = !this.enabled
      ? "--host でほかのマシンに公開しているときは使えません"
      : sources.target.kind !== "worktree"
        ? "作業ディレクトリとの比較（target が . か working）のときだけ使えます"
        : ids.length === 0
          ? "claude も codex も見つかりません"
          : undefined;
    return { available: !reason, ...(reason ? { reason } : {}), agents, job: this.job };
  }

  async start(sources: ResolvedSources, body: unknown): Promise<AgentJob> {
    const req = parseStart(body);
    const state = await this.state(sources);
    if (!state.available) throw new HttpError(409, state.reason!);
    const agent = state.agents.find((a) => a.id === req.agent);
    if (!agent) throw new HttpError(409, `${req.agent} が見つかりません`);
    // only what the screen offers: a model of the agent's list, and an effort that model takes
    const model = req.model === undefined ? undefined : agent.models.find((m) => m.id === req.model);
    if (req.model !== undefined && !model) throw new HttpError(400, `${agent.label} にないモデルです: ${req.model}`);
    if (req.effort !== undefined && !(model?.efforts ?? agent.defaultEfforts).includes(req.effort)) throw new HttpError(400, `${model?.label ?? agent.label} にない effort です: ${req.effort}`);
    if (this.job?.status === "running") throw new HttpError(409, "ほかの AI の実行が終わっていません");

    const { prompt, ...chosen } = req;
    const job: AgentJob = { id: ++this.seq, ...chosen, status: "running", startedAt: Date.now(), log: [] };
    const abort = new AbortController();
    this.job = job;
    this.abort = abort;
    this.running = (async () => {
      let status: AgentJob["status"] = "done";
      let commit: string | undefined;
      try {
        if (req.kind === "fix") {
          commit = await snapshotWorktree(sources.root);
          job.snapshot = SNAPSHOT_REF;
        }
        const r = await runAgent({
          ...chosen,
          cwd: sources.root,
          prompt,
          signal: abort.signal,
          onLog: (line) => {
            job.log.push(line);
            if (job.log.length > LOG_LINES) job.log.splice(0, job.log.length - LOG_LINES);
          },
        });
        job.text = r.text;
        if (r.comments) job.comments = r.comments;
      } catch (e) {
        status = e instanceof AgentCancelled ? "cancelled" : "failed";
        if (status === "failed") job.error = e instanceof Error ? e.message : String(e);
      }
      // a fix that failed or was stopped may have edited files too
      if (commit) job.changedFiles = await changedSince(sources.root, commit).catch(() => undefined);
      job.endedAt = Date.now();
      job.status = status;
    })();
    return job;
  }

  /** Stops the running job (nothing happens when none runs) */
  cancel(): AgentJob | null {
    if (this.job?.status === "running") this.abort?.abort();
    return this.job;
  }

  /** Resolves when no job runs any more */
  idle(): Promise<void> {
    return this.running;
  }
}
