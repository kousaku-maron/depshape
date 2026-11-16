import { loadJSON, saveJSON } from "@diffshape/ui";

/*
 * Tables marked "確認済み" (reviewed), saved per repository and comparison. Each mark keeps a hash of the
 * table's change, so a table that changes again after it was marked shows up as not reviewed.
 */

const PREFIX = "dbshape.reviewed:";

export const loadReviewed = (scope: string) => loadJSON<Record<string, string>>(PREFIX + scope, {});

export const saveReviewed = (scope: string, marks: Record<string, string>) => saveJSON(PREFIX + scope, marks);
