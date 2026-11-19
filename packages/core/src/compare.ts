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

/**
 * The comparison as a git range for a copied list of comments, like difit: "diff main..feature",
 * "diff main...feature" with --merge-base, and the commits compared after it when the names are not
 * already them ("diff main..feature (1a2b3c4..5d6e7f8)"). Null unless both sides are commits: the
 * working tree and the staged state have no range to name.
 */
export function compareRange(opts: CompareOptions, s: ResolvedSources): string | null {
  if (s.target.kind !== "rev" || s.base.kind !== "rev") return null;
  const target = opts.target === "@" ? "HEAD" : opts.target ?? ".";
  const base = opts.base ? (opts.base === "@" ? "HEAD" : opts.base) : `${target}^`;
  const sep = opts.base && opts.mergeBase ? "..." : "..";
  const short = (rev: string) => rev.slice(0, 7);
  const named = (name: string, rev: string) => /^[0-9a-f]{7,40}$/.test(name) && rev.startsWith(name);
  const commits = named(base, s.base.rev) && named(target, s.target.rev) ? "" : ` (${short(s.base.rev)}..${short(s.target.rev)})`;
  return `diff ${base}${sep}${target}${commits}`;
}
