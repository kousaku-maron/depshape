import { mergeBase, repoRoot, resolveRev, type Source } from "./git.js";

export interface CompareOptions {
  /** ".", "staged", "working", or any git revision. Default "." */
  target?: string;
  /** Git revision to compare with. Default depends on target. */
  base?: string;
  /** Use `git merge-base base target` as the base (like a GitHub PR). */
  mergeBase?: boolean;
}

/** One comparison: the repository and the two sides, with labels for the screen */
export interface ResolvedSources {
  root: string;
  target: Source;
  base: Source;
  targetLabel: string;
  baseLabel: string;
}

export async function resolveSources(cwd: string, opts: CompareOptions): Promise<ResolvedSources> {
  const root = await repoRoot(cwd);
  const targetArg = opts.target ?? ".";

  let target: Source;
  let defaultBase: string | Source;
  let targetLabel: string;
  if (targetArg === "." ) {
    target = { kind: "worktree" };
    defaultBase = "HEAD";
    targetLabel = "作業ディレクトリ（未コミットの変更を含む）";
  } else if (targetArg === "staged") {
    target = { kind: "index" };
    defaultBase = "HEAD";
    targetLabel = "ステージ済みの変更";
  } else if (targetArg === "working") {
    target = { kind: "worktree" };
    defaultBase = { kind: "index" };
    targetLabel = "未ステージの変更";
  } else {
    const rev = targetArg === "@" ? "HEAD" : targetArg;
    target = { kind: "rev", rev: await resolveRev(root, rev) };
    defaultBase = `${rev}^`;
    targetLabel = rev;
  }

  let base: Source;
  let baseLabel: string;
  if (opts.base) {
    const baseRev = opts.base === "@" ? "HEAD" : opts.base;
    if (opts.mergeBase) {
      const other = target.kind === "rev" ? target.rev : "HEAD";
      base = { kind: "rev", rev: await mergeBase(root, baseRev, other) };
      baseLabel = `${baseRev} との分岐点（merge-base: ${base.rev.slice(0, 8)}）`;
    } else {
      base = { kind: "rev", rev: await resolveRev(root, baseRev) };
      baseLabel = baseRev;
    }
  } else if (typeof defaultBase === "string") {
    base = { kind: "rev", rev: await resolveRev(root, defaultBase) };
    baseLabel = defaultBase;
  } else {
    base = defaultBase;
    baseLabel = "ステージ済みの状態";
  }

  return { root, target, base, targetLabel, baseLabel };
}
