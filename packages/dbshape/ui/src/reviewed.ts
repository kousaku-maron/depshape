import { loadJSON, removeKeysWithPrefix, saveJSON, type Comparison } from "@diffshape/ui";

/*
 * Tables marked "確認済み" (reviewed), saved per repository and comparison. Each mark keeps a hash of the
 * table's change, so a table that changes again after it was marked shows up as not reviewed.
 */

const PREFIX = "dbshape.reviewed:";

export const loadReviewed = (scope: string) => loadJSON<Record<string, string>>(PREFIX + scope, {});

export const saveReviewed = (scope: string, marks: Record<string, string>) => saveJSON(PREFIX + scope, marks);

/** The start of the scope of every database in a comparison (a scope ends with the database's id) */
export const comparisonScope = (c: Comparison) => `${c.repoRoot}|${c.baseLabel}|${c.targetLabel}|`;

/** Removes the marks of every database in the comparison */
export const clearReviewed = (c: Comparison) => removeKeysWithPrefix(PREFIX + comparisonScope(c));
