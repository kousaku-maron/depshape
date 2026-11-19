import { joinEntries, loadCommentList, newCommentId, promptEntry, removeKey, saveCommentList } from "@diffshape/ui";
import type { DiffFile, FileShapeRun } from "../../src/types";
import { oldToNew } from "./model";

/*
 * Review comments on lines of the diff: one note on a line, or on a run of lines, of the base
 * side ("old") or the target side ("new"), copied as "path:L12" / "path:L12-L15" for an AI agent.
 *
 * A comment keeps the code of its lines. After a reload the lines may have moved (lines added above),
 * so the comment follows the same code to the nearest place on its side:
 *   open     = that code is still there
 *   updated  = the code changed (its first line number is still there, with other code)
 *   resolved = the lines or the file are no longer there
 * Lines around the hunks count too once the file's content is loaded (comments on opened lines).
 */

export type Side = "old" | "new";

export interface ReviewComment {
  id: string;
  path: string;
  side: Side;
  line: number;
  /** Last line of a comment on several lines */
  endLine?: number;
  /** The code of its lines when the comment was written, joined with "\n" */
  code: string;
  body: string;
  createdAt: number;
  /**
   * Written on a file without changes (opened from the tree's "全体" view). That file stays in the list
   * for the comment; a comment on a change still resolves when its file leaves the diff.
   */
  unchanged?: boolean;
  /** The agent whose AI review wrote it ("Claude Code"); a comment of the user has none */
  ai?: string;
}

export type CommentState = "open" | "updated" | "resolved";

export interface Located {
  state: CommentState;
  /** Where it is now (undefined when it is resolved) */
  line?: number;
  endLine?: number;
}

/** The text of each line of one side that the screen can show, by number */
export function sideText(file: DiffFile, side: Side, content?: string[]): Map<number, string> {
  const m = new Map<number, string>();
  // the lines around the hunks are read from the target side's content (the same text on both sides)
  if (content && side === "new") content.forEach((t, i) => m.set(i + 1, t));
  for (const c of file.chunks)
    for (const l of c.lines) {
      if (side === "old" && l.type !== "add") m.set(l.oldLine!, l.content);
      if (side === "new" && l.type !== "delete") m.set(l.newLine!, l.content);
    }
  if (content && side === "old") {
    // a base-side line outside the hunks has the target side's text, `delta` lines away
    const maxOld = Math.max(0, ...file.chunks.map((c) => c.oldStart + c.oldLines)) + content.length;
    for (let n = 1; n <= maxOld; n++) {
      if (m.has(n)) continue;
      const t = oldToNew(file, n);
      if (t !== undefined && content[t - 1] !== undefined) m.set(n, content[t - 1]);
    }
  }
  return m;
}

const lengthOf = (c: { line: number; endLine?: number }) => (c.endLine ?? c.line) - c.line + 1;

export function locate(file: DiffFile | undefined, c: ReviewComment, content?: string[]): Located {
  if (!file) return { state: "resolved" };
  const text = sideText(file, c.side, content);
  const want = c.code.split("\n");
  const len = lengthOf(c);
  const matches = (start: number) => want.every((w, i) => text.get(start + i) === w);
  const at = (start: number, state: CommentState): Located => ({ state, line: start, ...(len > 1 ? { endLine: start + len - 1 } : {}) });
  if (matches(c.line)) return at(c.line, "open");
  // the same code moved: the nearest place with it
  let best: number | undefined;
  for (const [n, t] of text) if (t === want[0] && matches(n) && (best === undefined || Math.abs(n - c.line) < Math.abs(best - c.line))) best = n;
  if (best !== undefined) return at(best, "open");
  if (text.has(c.line)) return at(c.line, "updated");
  return { state: "resolved" };
}

/** Whether a comment's lines are all inside the hunks (no content is needed to place it) */
export function inHunks(file: DiffFile, c: ReviewComment): boolean {
  const text = sideText(file, c.side);
  for (let n = c.line; n <= (c.endLine ?? c.line); n++) if (!text.has(n)) return false;
  return true;
}

export const fileOf = (run: FileShapeRun, path: string) => run.files.find((f) => f.path === path);

export const commentState = (run: FileShapeRun, c: ReviewComment, content?: string[]) => locate(fileOf(run, c.path), c, content).state;

export interface LineTarget {
  path: string;
  side: Side;
  line: number;
  endLine?: number;
  code: string;
}

export function newComment(t: LineTarget, body: string, unchanged = false): ReviewComment {
  return {
    id: newCommentId(),
    path: t.path,
    side: t.side,
    line: t.line,
    ...(t.endLine && t.endLine !== t.line ? { endLine: t.endLine } : {}),
    code: t.code,
    body,
    createdAt: Date.now(),
    ...(unchanged ? { unchanged: true } : {}),
  };
}

/** "src/a.ts:L12" / "src/a.ts:L12-L15" "(old)" for the base side */
export const where = (path: string, side: Side, line: number, endLine?: number) => `${path}:L${line}${endLine && endLine !== line ? `-L${endLine}` : ""}${side === "old" ? " (old)" : ""}`;

export const SIDE_LABEL: Record<Side, string> = { old: "変更前", new: "変更後" };

/** "変更後の 12 行目"; a file without changes has one side: "12 行目（変更なし）" */
export const linesLabel = (side: Side, line: number, endLine?: number, unchanged?: boolean) => {
  const lines = `${endLine && endLine !== line ? `${line}〜${endLine}` : line} 行目`;
  return unchanged ? `${lines}（変更なし）` : `${SIDE_LABEL[side]}の ${lines}`;
};

/**
 * Comments as a list to hand to an AI, like difit's: where each one is now, then its body.
 * A resolved comment is left out unless `includeResolved` (the copy of one comment).
 */
export function formatPrompt(
  run: FileShapeRun,
  comments: ReviewComment[],
  opts: { includeResolved?: boolean; contents?: Map<string, string[]> } = {},
): { text: string; included: number; skipped: number } {
  const shown = comments.map((c) => ({ c, at: locate(fileOf(run, c.path), c, opts.contents?.get(c.path)) }));
  const list = opts.includeResolved ? shown : shown.filter((x) => x.at.state !== "resolved");
  // the line it is on now; a comment that lost its line keeps the one it was written on
  const entries = list.map(({ c, at }) => promptEntry(where(c.path, c.side, at.line ?? c.line, at.line !== undefined ? at.endLine : c.endLine), c.body));
  return { text: joinEntries(entries), included: list.length, skipped: comments.length - list.length };
}

// ---- saved per repository and comparison, like the other modules

const PREFIX = "fileshape.comments:";

export const loadComments = (scope: string) => loadCommentList<ReviewComment>(PREFIX + scope);

export const saveComments = (scope: string, comments: ReviewComment[]) => saveCommentList(PREFIX + scope, comments);

export const clearComments = (scope: string) => removeKey(PREFIX + scope);
