import { newCommentId, type AiComment } from "@diffshape/ui";
import type { FileNode } from "../../src/types";
import { describeTarget, folderPattern, itemKey, linkFor, linkKey, targetState, type ReviewComment } from "./comments";
import type { Model, TreeDir } from "./model";

/*
 * The AI review of the dependency changes: the reviewer is told which imports each changed file added
 * and removed, with the key a comment on each can point at, and where the unchanged files of the same
 * folder usually go (the existing pattern to compare with). Its comments come back with those keys.
 */

/** More changed files than this are not listed (a change that large is not reviewed import by import) */
const FILES_MAX = 200;

const STATUS: Record<Exclude<FileNode["status"], "unchanged">, string> = { added: "今回追加", modified: "今回変更", removed: "今回削除" };

/** The section of the review prompt for this module, or "" when no dependency changed */
export function reviewSection(model: Model, tree: Map<string, TreeDir>): string {
  const blocks: string[] = [];
  const files = model.graph.files.filter((f) => f.status !== "unchanged").sort((a, b) => a.path.localeCompare(b.path));
  for (const f of files) {
    const edges = (model.edgesByFrom.get(f.path) ?? []).filter((e) => e.status !== "unchanged").sort((a, b) => a.to.localeCompare(b.to));
    // a file whose imports did not change is the file diff's business
    if (edges.length === 0) continue;
    if (blocks.length === FILES_MAX) break;
    const from = `f:${f.path}`;
    // a removed file is gone: there is nothing left to hold a comment
    const lines = [f.status === "removed" ? `- ${f.path}（${STATUS.removed}）` : `- ${f.path}（${STATUS[f.status as "added" | "modified"]}） target: "${itemKey(from)}"`];
    for (const e of edges) {
      const to = e.external ? `x:${e.to}` : `d:${e.to}`;
      const l = linkFor(model, tree, from, to);
      const what = `${describeTarget(model, to, l)}${l?.typeOnly ? "（型のみ）" : ""}`;
      lines.push(e.status === "added" ? `  - 追加した import → ${what} target: "${linkKey(from, to)}"` : `  - 削除した import → ${what}`);
    }
    if (f.status !== "removed" && edges.some((e) => e.status === "added" && !e.external)) {
      const usual = folderPattern(model, tree, f.dir);
      if (usual) lines.push(`  参考: ${usual}`);
    }
    blocks.push(lines.join("\n"));
  }
  if (blocks.length === 0) return "";
  return [
    "依存の変化（import しているファイルごと）:",
    ...blocks,
    "",
    "コメントの付け方:",
    "- target: 上の target の値をそのまま。追加した import を指すなら \"L:…\"、ファイルそのものを指すなら \"I:f:…\"",
    "- path / side / line / endLine / code: null",
    "- ここでは依存の向きと形だけを見てください（層をまたぐ import、同じフォルダの既存のファイルが使っていない依存先、循環、置き場所が合わないファイルなど）。コードの中身への指摘は、ファイルの差分の方に書いてください。",
    "- 削除した import への指摘は、その import をしていたファイルの target に付けてください。",
  ].join("\n");
}

/** The comments of an AI review that point at something this module has; the rest is dropped */
export function toComments(items: AiComment[], model: Model, tree: Map<string, TreeDir>, ai: string): ReviewComment[] {
  const out: ReviewComment[] = [];
  for (const item of items) {
    const key = item.target;
    // a dependency or a tree row that is there now (a removed import can not hold a comment)
    if (!key || !/^(L:[^>]+>.+|I:.+)$/.test(key) || targetState(model, tree, key) !== "open") continue;
    out.push({ id: newCommentId(), targets: [key], body: item.body, createdAt: Date.now(), ai });
  }
  return out;
}
