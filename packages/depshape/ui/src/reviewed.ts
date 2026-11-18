import { hashOf, loadJSON, removeKey, saveJSON, type Comparison } from "@diffshape/ui";
import type { Edge, FileNode } from "../../src/types";

/*
 * Files marked "確認済み" (reviewed), like dbshape's tables and fileshape's files. Every changed file
 * can be marked, and so can a file whose imports changed without the file being edited (an import that
 * now resolves to another folder). Each mark keeps a hash of that file's added / removed imports, so a
 * file whose dependencies change again after it was marked shows up as not reviewed.
 */

const PREFIX = "depshape.reviewed:";

/** Saved per repository and comparison, like the comments */
export const reviewScope = (g: Comparison) => `${g.repoRoot}|${g.targetLabel}|${g.baseLabel}`;

export const loadReviewed = (scope: string) => loadJSON<Record<string, string>>(PREFIX + scope, {});

export const saveReviewed = (scope: string, marks: Record<string, string>) => saveJSON(PREFIX + scope, marks);

export const clearReviewed = (scope: string) => removeKey(PREFIX + scope);

/** Where the comments of a comparison are saved (the same scope as the marks) */
export const commentKey = (scope: string) => `depshape.comments:${scope}`;

/** Each changed file, and each file whose local imports appeared / disappeared → a hash of those changes */
export function reviewTargets(files: FileNode[], edges: Edge[]): Map<string, string> {
  const changes = new Map<string, string[]>();
  for (const f of files) if (f.status !== "unchanged") changes.set(f.path, []);
  for (const e of edges) {
    if (e.external || e.status === "unchanged") continue;
    let list = changes.get(e.from);
    if (!list) changes.set(e.from, (list = []));
    list.push(`${e.status === "added" ? "+" : "-"} ${e.to}`);
  }
  return new Map([...changes].map(([path, list]) => [path, hashOf(list.sort())]));
}

/** The files whose mark still matches their current changes */
export function reviewedFiles(targets: Map<string, string>, marks: Record<string, string>): Set<string> {
  const out = new Set<string>();
  for (const [path, hash] of targets) if (marks[path] === hash) out.add(path);
  return out;
}

/** A folder counts as reviewed when it holds at least one file to review and all of them are reviewed */
export function folderReviewed(dir: string, targets: Map<string, string>, reviewed: Set<string>): boolean {
  let any = false;
  for (const path of targets.keys()) {
    if (dir !== "" && !path.startsWith(dir + "/")) continue;
    if (!reviewed.has(path)) return false;
    any = true;
  }
  return any;
}
