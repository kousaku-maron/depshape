import { diffPatch, git, readFiles, untrackedFiles, type ResolvedSources, type Source } from "@diffshape/core";
import { addedFile, parseUnifiedDiff } from "./diff.js";
import { isGenerated } from "./generated.js";
import type { DiffFile, FileShapeRun } from "./types.js";

/*
 * The line diff of one comparison: git's patch, plus the untracked files when the target is the
 * working tree (the other modules count them as part of "." too).
 */

/** Untracked files larger than this are listed without their lines */
const MAX_UNTRACKED = 2 * 1024 * 1024;

export async function analyzeFiles(sources: ResolvedSources): Promise<FileShapeRun> {
  const { root, base, target } = sources;
  const files = parseUnifiedDiff(await diffPatch(root, base, target));
  if (target.kind === "worktree") files.push(...(await untracked(root, target)));
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const attr = await linguistGenerated(root, target, files.map((f) => f.path));
  for (const f of files) if (attr.has(f.path) || isGenerated(f)) f.generated = true;

  return { repoRoot: root, targetLabel: sources.targetLabel, baseLabel: sources.baseLabel, files };
}

async function untracked(root: string, worktree: Source): Promise<DiffFile[]> {
  const list = await untrackedFiles(root);
  const small = list.filter((f) => f.size <= MAX_UNTRACKED).map((f) => f.path);
  const contents = await readFiles(root, worktree, small);
  return list.flatMap((f): DiffFile[] => {
    if (f.size > MAX_UNTRACKED) return [{ path: f.path, status: "added", additions: 0, deletions: 0, chunks: [], large: true }];
    const c = contents.get(f.path);
    return c === undefined ? [] : [addedFile(f.path, c)];
  });
}

/** Paths marked `linguist-generated` in .gitattributes, read from the target side */
async function linguistGenerated(root: string, target: Source, paths: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const from = target.kind === "rev" ? ["--source", target.rev] : target.kind === "index" ? ["--cached"] : [];
  try {
    for (let i = 0; i < paths.length; i += 200) {
      const out = await git(root, ["check-attr", "-z", ...from, "linguist-generated", "--", ...paths.slice(i, i + 200)]);
      const f = out.split("\0");
      for (let j = 0; j + 2 < f.length; j += 3) if (f[j + 2] === "true" || f[j + 2] === "set") found.add(f[j]);
    }
  } catch {
    // an old git without --source: the path rules still apply
  }
  return found;
}
