import type { AiComment } from "@diffshape/ui";
import type { DiffFile, FileShapeRun } from "../../src/types";
import { sideText, type LineTarget, type Side } from "./comments";

/*
 * The AI review of the file diff: what the reviewer is told about the changed files and how to answer,
 * and where each of its comments goes. An AI often gets a line number wrong but quotes the code right,
 * so a comment is placed by the code it quotes; the line number only picks between the same code twice.
 */

/** More files than this are not listed one by one (the reviewer reads the diff itself anyway) */
const LIST_MAX = 300;

const MARK: Record<DiffFile["status"], string> = { added: "A", modified: "M", removed: "D", renamed: "R" };

function fileLine(f: DiffFile): string {
  const notes = [f.additions || f.deletions ? `+${f.additions} −${f.deletions}` : "", f.binary ? "バイナリ" : "", f.large ? "大きいファイル" : ""].filter(Boolean);
  const name = f.status === "renamed" && f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
  return `- ${MARK[f.status]} ${name}${notes.length ? `（${notes.join("、")}）` : ""}`;
}

/** The section of the review prompt for this module: the changed files, and how a comment points at lines */
export function reviewSection(run: FileShapeRun): string {
  // lock files and build output are not worth a review
  const files = run.files.filter((f) => !f.unchanged && !f.generated);
  const skipped = run.files.filter((f) => !f.unchanged && f.generated).length;
  const out = [`変更されたファイル（${files.length}）:`, ...files.slice(0, LIST_MAX).map(fileLine)];
  if (files.length > LIST_MAX) out.push(`- ほか ${files.length - LIST_MAX} ファイル`);
  if (skipped) out.push(`（生成されたファイル ${skipped} 個は対象外）`);
  out.push(
    "",
    "コメントの付け方:",
    "- path: ファイルのパス（リポジトリのルートから）",
    "- line: 指摘する行の番号。side が \"new\" なら変更後のファイルの行、\"old\" なら変更前のファイルの行",
    "- side: ふつうは \"new\"。削除された行を指すときだけ \"old\"",
    "- code: その行のコードをファイルにあるとおりに（複数行のときは改行でつなぎ、endLine に最後の行の番号。1行なら endLine は null）",
    "- target: null",
    "- 変更されていないファイルの行も指せます（この変更に合わせて直すべき箇所など）。そのときも side は \"new\"",
  );
  return out.join("\n");
}

export interface Placed {
  target: LineTarget;
  /** The quoted code was found; otherwise the comment sits on the line number the reviewer gave */
  exact: boolean;
}

/**
 * Where an AI comment goes in a file: the lines that hold the code it quotes, nearest to the line it
 * names; without such code, the named lines themselves; null when the file has neither.
 * `content` is the file's whole target side, for lines outside the hunks.
 */
export function placeItem(file: DiffFile, item: Pick<AiComment, "side" | "line" | "endLine" | "code">, content?: string[]): Placed | null {
  // a side the file does not have is the reviewer's slip
  const side: Side = file.status === "removed" ? "old" : file.status === "added" || file.unchanged ? "new" : (item.side ?? "new");
  const text = sideText(file, side, content);
  if (text.size === 0) return null;

  const want = (item.code ?? "").replace(/\n+$/, "").split("\n");
  const near = item.line ?? 1;
  const find = (same: (a: string, b: string) => boolean) => {
    let best: number | undefined;
    for (const n of text.keys()) {
      if (!want.every((w, i) => text.has(n + i) && same(text.get(n + i)!, w))) continue;
      if (best === undefined || Math.abs(n - near) < Math.abs(best - near)) best = n;
    }
    return best;
  };
  const target = (start: number, len: number): LineTarget => ({
    path: file.path,
    side,
    line: start,
    ...(len > 1 ? { endLine: start + len - 1 } : {}),
    // the file's own text: a comment follows its code after a reload
    code: Array.from({ length: len }, (_, i) => text.get(start + i) ?? "").join("\n"),
  });

  if (want.some((w) => w.trim() !== "")) {
    // as quoted, then with the indentation the reviewer may have dropped
    const start = find((a, b) => a === b) ?? find((a, b) => a.trim() === b.trim());
    if (start !== undefined) return { target: target(start, want.length), exact: true };
  }
  if (item.line === null || !text.has(item.line)) return null;
  let len = item.endLine !== null && item.endLine > item.line ? item.endLine - item.line + 1 : 1;
  while (len > 1 && !text.has(item.line + len - 1)) len--;
  return { target: target(item.line, len), exact: false };
}

/** The file of the diff a comment names: by its path, or by the path it had before a rename */
export const fileFor = (run: FileShapeRun, path: string): DiffFile | undefined => run.files.find((f) => f.path === path) ?? run.files.find((f) => f.oldPath === path);
