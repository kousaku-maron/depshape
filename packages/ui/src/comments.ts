import { loadJSON, removeKey, saveJSON } from "./storage";

/*
 * Pieces of the review comments that every module shares: where they are saved, ids, the header of
 * the prompt copied for an AI agent, and the labels of their states. What a comment points at and when
 * it counts as resolved stay with each module.
 */

/** Comments saved under a key (each module keys them per repository and comparison) */
export function loadCommentList<T>(key: string): T[] {
  const v = loadJSON<unknown>(key, []);
  return Array.isArray(v) ? (v as T[]) : [];
}

export function saveCommentList(key: string, comments: unknown[]) {
  if (comments.length) saveJSON(key, comments);
  else removeKey(key);
}

export const newCommentId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export type CommentStateName = "open" | "partial" | "updated" | "resolved";

export const COMMENT_STATE_LABEL: Record<CommentStateName, string> = {
  open: "未対応",
  partial: "一部解消",
  updated: "コメント後に変更あり",
  resolved: "解消済み？",
};

/**
 * One comment of a copied list, like difit's: the line that says what it points at ("src/a.ts:L12",
 * "db/schema.sql:L4 カラム billing.invoices.price_id"), then its body as written.
 */
export const promptEntry = (where: string, body: string) => `${where}\n${body.trim()}`;

/** The comments of one module as one text, "=====" between them; "" for none */
export const joinEntries = (entries: string[]) => (entries.length ? `${entries.join("\n=====\n")}\n` : "");
