/*
 * Tables marked "確認済み" (reviewed), saved per repository and comparison. Each mark keeps a hash of the
 * table's change, so a table that changes again after it was marked shows up as not reviewed.
 */

const PREFIX = "dbshape.reviewed:";

export function loadReviewed(scope: string): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(PREFIX + scope) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

export function saveReviewed(scope: string, marks: Record<string, string>) {
  try {
    localStorage.setItem(PREFIX + scope, JSON.stringify(marks));
  } catch {
    /* ignore */
  }
}
