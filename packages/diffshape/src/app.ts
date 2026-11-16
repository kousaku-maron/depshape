import { resolveSources, type Analyzer, type CompareOptions, type ResolvedSources } from "@diffshape/core";

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
  modules: string[];
}

const message = (e: unknown) => (e instanceof Error ? (e as Error & { stderr?: string }).stderr || e.message : String(e)).trim();

export class App {
  private sources!: ResolvedSources;
  private results = new Map<string, Promise<ModuleResult>>();

  constructor(
    private cwd: string,
    private opts: CompareOptions,
    readonly analyzers: Analyzer[],
  ) {}

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
    const { root, targetLabel, baseLabel } = this.sources;
    return { repoRoot: root, targetLabel, baseLabel, modules: this.analyzers.map((a) => a.id) };
  }

  result(id: string): Promise<ModuleResult> {
    return this.results.get(id) ?? Promise.resolve({ error: `unknown module: ${id}` });
  }
}
