import { HttpError, resolveSources, type Analyzer, type CompareOptions, type ResolvedSources } from "@diffshape/core";
import { AgentJobs, type AgentJob, type AgentState } from "./agent.js";

/*
 * One comparison analyzed by every module. The comparison is resolved once and shared, and each module
 * runs on its own: a module that has nothing to read (no SQL files, say) reports an error for its own
 * view without stopping the others.
 */

export type ModuleResult = { data: unknown } | { error: string };

export interface Info {
  repoRoot: string;
  targetLabel: string;
  baseLabel: string;
  /** The commit compared with, or null when it is the staged state (for `git diff <rev>` in an AI prompt) */
  baseRev: string | null;
  modules: string[];
  /**
   * Set when the server was started with --clean: an id of this run. The screen clears the comments and
   * the reviewed marks of this comparison the first time it sees the id, so reloading the page later
   * keeps what was written since.
   */
  clean: string | null;
}

const message = (e: unknown) => (e instanceof Error ? (e as Error & { stderr?: string }).stderr || e.message : String(e)).trim();

export class App {
  private sources!: ResolvedSources;
  private results = new Map<string, Promise<ModuleResult>>();
  private jobs: AgentJobs;
  private cleanId: string | null;

  constructor(
    private cwd: string,
    private opts: CompareOptions,
    readonly analyzers: Analyzer[],
    /**
     * `agents: false` turns the AI review and fix off (a server open to the network); `clean: true` has
     * the screen start this comparison's review over (--clean)
     */
    appOpts: { agents?: boolean; clean?: boolean } = {},
  ) {
    this.jobs = new AgentJobs(appOpts.agents ?? true);
    this.cleanId = appOpts.clean ? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}` : null;
  }

  /** Resolves the comparison (errors like an unknown revision are thrown) and starts every module */
  async refresh(): Promise<Info> {
    this.sources = await resolveSources(this.cwd, this.opts);
    for (const a of this.analyzers) {
      this.results.set(
        a.id,
        a.analyze(this.sources).then(
          (data) => ({ data }),
          (e) => ({ error: message(e) }),
        ),
      );
    }
    return this.info();
  }

  info(): Info {
    const { root, targetLabel, baseLabel, base } = this.sources;
    return { repoRoot: root, targetLabel, baseLabel, baseRev: base.kind === "rev" ? base.rev : null, modules: this.analyzers.map((a) => a.id), clean: this.cleanId };
  }

  result(id: string): Promise<ModuleResult> {
    return this.results.get(id) ?? Promise.resolve({ error: `unknown module: ${id}` });
  }

  /** One of a module's own endpoints, on the current comparison and the module's data */
  async call(id: string, name: string, url: URL): Promise<unknown> {
    const a = this.analyzers.find((x) => x.id === id);
    const handler = a?.api?.[name];
    if (!handler) throw new HttpError(404, `unknown endpoint: ${id}/${name}`);
    const r = await this.result(id);
    if ("error" in r) throw new HttpError(409, r.error);
    return handler(url, { sources: this.sources, data: r.data });
  }

  /** Whether an AI review or fix can run here, with which agents, and the running (or last) job */
  agentState(): Promise<AgentState> {
    return this.jobs.state(this.sources);
  }

  /** Starts an AI review or fix from what the screen posted ({ kind, agent, prompt, model?, effort? }) */
  startAgent(body: unknown): Promise<AgentJob> {
    return this.jobs.start(this.sources, body);
  }

  cancelAgent(): AgentJob | null {
    return this.jobs.cancel();
  }

  /** Resolves when no AI job runs any more */
  agentIdle(): Promise<void> {
    return this.jobs.idle();
  }
}
