import type { AiComment } from "@diffshape/ui";
import type { DbShapeResult } from "../../src/model";
import { schemaFromText } from "../../src/names";
import { changeText, exists, locationOf, newComment, tableTarget, targetId, targetLabel, type CommentTarget, type ReviewComment, type TargetKind } from "./comments";

/*
 * The AI review of the schema diff: the reviewer is told every changed table, column, constraint,
 * index, value list and type of one database, each with the target a comment on it names
 * ("column:billing.invoices:price_id"). Its comments come back with those targets.
 *
 * A repository can have several databases: each gets a `prefix` ("1/", "2/") in front of its targets.
 */

const KINDS: readonly TargetKind[] = ["table", "column", "constraint", "index", "value", "type"];

/** "column:billing.invoices:price_id" → the target; null for anything else */
export function parseTarget(text: string): CommentTarget | null {
  const m = /^([a-z]+):([^:]*):(.+)$/.exec(text);
  if (!m || !KINDS.includes(m[1] as TargetKind)) return null;
  return { kind: m[1] as TargetKind, ...(m[2] ? { table: m[2] } : {}), name: m[3] };
}

/** What changed in one database, one line per part a comment can point at; "" when nothing changed */
export function reviewList(data: DbShapeResult, prefix = ""): string {
  const d = data.diff;
  const line = (t: CommentTarget, depth: number) => {
    const at = locationOf(data, t);
    const where = at && !at.base ? ` 定義: ${at.file}:${at.line}` : "";
    return `${"  ".repeat(depth)}- ${targetLabel(t)}（${changeText(data, t) ?? "変更なし"}）${where} target: "${prefix}${targetId(t)}"`;
  };
  const out: string[] = [];
  for (const t of d.tables) {
    out.push(line(tableTarget(t.name), 0));
    for (const c of t.columns) out.push(line({ kind: "column", table: t.name, name: c.name }, 1));
    for (const c of t.constraints) out.push(line({ kind: "constraint", table: t.name, name: c.name }, 1));
    for (const i of t.indexes) out.push(line({ kind: "index", table: t.name, name: i.name }, 1));
  }
  for (const v of d.values) if (v.source === "check" && v.table && v.column) out.push(line({ kind: "value", table: v.table, name: v.column }, 0));
  for (const e of [...d.enums, ...d.domains]) out.push(line({ kind: "type", name: e.name }, 0));
  if (out.length === 0) return "";
  return [`スキーマの SQL: ${schemaFromText(data.schemaFrom)}`, "変更:", ...out].join("\n");
}

/** How to answer, after the lists of every database */
export const REVIEW_RULES = [
  "コメントの付け方:",
  "- target: 上の target の値をそのまま",
  "- path / side / line / endLine / code: null",
  "- スキーマの設計を見てください（型、NULL を許すか、既定値、制約、外部キー、インデックス、値の制限、既存のテーブルとの揃い方、既存のデータへの影響など）。定義は SQL ファイルを読んで確かめてください。",
  "- 一覧にないテーブルやカラムも同じ形の target で指せます（table:<schema.table>:<schema.table>、column:<schema.table>:<カラム名>）。",
].join("\n");

/** The comments of an AI review that point at something this database has; the rest is dropped */
export function toComments(items: AiComment[], data: DbShapeResult, prefix: string, ai: string): ReviewComment[] {
  const out: ReviewComment[] = [];
  for (const item of items) {
    if (!item.target || !item.target.startsWith(prefix)) continue;
    const target = parseTarget(item.target.slice(prefix.length));
    // a part of the schema that is there, or one this change removed
    if (!target || (!exists(data, target) && changeText(data, target) === undefined)) continue;
    out.push({ ...newComment(data, target, item.body), ai });
  }
  return out;
}
