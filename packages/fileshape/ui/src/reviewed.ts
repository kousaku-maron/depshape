import { loadJSON, saveJSON } from "@diffshape/ui";
import type { DiffFile, FileShapeRun } from "../../src/types";
import { changeHash } from "./model";

/*
 * Files marked "確認済み" (reviewed), like depshape's files and dbshape's tables. Each mark keeps a hash
 * of the file's change, so a file that changes again after it was marked shows up as not reviewed.
 */

const PREFIX = "fileshape.reviewed:";

/** Saved per repository and comparison, like the comments */
export const reviewScope = (r: FileShapeRun) => `${r.repoRoot}|${r.targetLabel}|${r.baseLabel}`;

export const loadReviewed = (scope: string) => loadJSON<Record<string, string>>(PREFIX + scope, {});

export const saveReviewed = (scope: string, marks: Record<string, string>) => saveJSON(PREFIX + scope, marks);

/** Each changed file → a hash of its change */
export const reviewTargets = (files: DiffFile[]) => new Map(files.map((f) => [f.path, changeHash(f)]));

/** The files whose mark still matches their current change */
export function reviewedFiles(targets: Map<string, string>, marks: Record<string, string>): Set<string> {
  const out = new Set<string>();
  for (const [path, hash] of targets) if (marks[path] === hash) out.add(path);
  return out;
}
