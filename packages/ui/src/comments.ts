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

/** The first lines of a copied prompt: what the comments are and which comparison they are about */
export function promptHeader(p: { repoRoot: string; targetLabel: string; baseLabel: string }): string[] {
  return ["以下は、git の差分のレビュービューア diffshape で付けたレビューコメントです。各指摘に対応してください。", `リポジトリ: ${p.repoRoot}`, `比較: ${p.targetLabel} と ${p.baseLabel} の差分`];
}
