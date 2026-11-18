import { loadCommentList, newCommentId, promptHeader, saveCommentList } from "@diffshape/ui";
import type { ColumnView, DbShapeResult, IndexView, SourceLocation, TableChange } from "../../src/model";
import { schemaFromText } from "../../src/names";
import { columnParts, indexText } from "./view";

/*
 * Review comments on the schema diff: one note on a table, a column, a constraint / index, the values of
 * a column, or an enum type / domain; then everything is copied as a prompt for an AI agent.
 *
 * A comment keeps what the change looked like when it was written, so after a reload it can tell:
 *   resolved = the part is gone, or it was changed then and now matches the base again
 *   updated  = it changed again since the comment was written
 */

export type TargetKind = "table" | "column" | "constraint" | "index" | "value" | "type";

export interface CommentTarget {
  kind: TargetKind;
  /** "schema.table" for everything but types */
  table?: string;
  /** Column, constraint or index name; the table name for a table; "schema.type" for a type */
  name: string;
}

export interface ReviewComment {
  id: string;
  target: CommentTarget;
  body: string;
  createdAt: number;
  /** The change when the comment was written (undefined: the part was unchanged) */
  snapshot?: string;
  /** The agent whose AI review wrote it ("Claude Code"); a comment of the user has none */
  ai?: string;
}

export type CommentState = "open" | "updated" | "resolved";

export const targetId = (t: CommentTarget) => `${t.kind}:${t.table ?? ""}:${t.name}`;

export const tableTarget = (table: string): CommentTarget => ({ kind: "table", table, name: table });

/** The key of a target in `DbShapeResult.locations` */
function locKey(t: CommentTarget): string {
  switch (t.kind) {
    case "table":
    case "type":
      return t.name;
    case "column":
    case "value":
      return `${t.table}.${t.name}`;
    default:
      return `${t.table}:${t.name}`;
  }
}

const KIND_LABEL: Record<TargetKind, string> = { table: "テーブル", column: "カラム", constraint: "制約", index: "インデックス", value: "値", type: "型" };

/** "カラム billing.invoices.price_id" */
export function targetLabel(t: CommentTarget): string {
  if (t.kind === "table" || t.kind === "type") return `${KIND_LABEL[t.kind]} ${t.name}`;
  if (t.kind === "column" || t.kind === "value") return `${KIND_LABEL[t.kind]} ${t.table}.${t.name}`;
  return `${KIND_LABEL[t.kind]} ${t.table} の ${t.name}`;
}

/** The short part of the label, shown next to a comment inside the table's panel */
export function shortLabel(t: CommentTarget): string {
  if (t.kind === "table") return "テーブル全体";
  if (t.kind === "type") return t.name;
  return `${KIND_LABEL[t.kind]} ${t.name}`;
}

const STATUS_TEXT = { added: "今回追加", removed: "今回削除", modified: "今回変更" } as const;

const columnText = (c: ColumnView) =>
  columnParts(c)
    .filter((p) => p.key !== "notNull" || c.notNull)
    .map((p) => p.text)
    .join(" ");

const indexLine = (i: IndexView) => indexText(i);

function tableSummary(t: TableChange): string {
  if (t.status !== "modified") return STATUS_TEXT[t.status];
  const parts: string[] = [];
  const count = (items: { status: string }[], label: string) => {
    const a = items.filter((x) => x.status === "added").length;
    const r = items.filter((x) => x.status === "removed").length;
    const m = items.filter((x) => x.status === "modified").length;
    const s = [a && `+${a}`, r && `−${r}`, m && `~${m}`].filter(Boolean).join(" ");
    if (s) parts.push(`${label} ${s}`);
  };
  count(t.columns, "カラム");
  count(t.constraints, "制約");
  count(t.indexes, "インデックス");
  if (t.comment) parts.push("コメント");
  return `${STATUS_TEXT.modified}（${parts.join("、")}）`;
}

/** The current change of a target as one line, or undefined when it does not differ from the base */
export function changeText(data: DbShapeResult, t: CommentTarget): string | undefined {
  const d = data.diff;
  const table = t.table ? d.tables.find((x) => x.name === t.table) : undefined;
  switch (t.kind) {
    case "table":
      return table ? tableSummary(table) : undefined;
    case "column": {
      const c = table?.columns.find((x) => x.name === t.name);
      if (!c) return undefined;
      if (c.status !== "modified") return `${STATUS_TEXT[c.status]}: ${columnText((c.after ?? c.before)!)}`;
      return `${STATUS_TEXT.modified}: ${columnText(c.before!)} → ${columnText(c.after!)}`;
    }
    case "constraint": {
      const c = table?.constraints.find((x) => x.name === t.name);
      if (!c) return undefined;
      if (c.status !== "modified") return `${STATUS_TEXT[c.status]}: ${(c.after ?? c.before)!.definition}`;
      return `${STATUS_TEXT.modified}: ${c.before!.definition} → ${c.after!.definition}`;
    }
    case "index": {
      const i = table?.indexes.find((x) => x.name === t.name);
      if (!i) return undefined;
      if (i.status !== "modified") return `${STATUS_TEXT[i.status]}: ${indexLine((i.after ?? i.before)!)}`;
      return `${STATUS_TEXT.modified}: ${indexLine(i.before!)} → ${indexLine(i.after!)}`;
    }
    case "value": {
      const v = d.values.find((x) => x.source === "check" && x.table === t.table && x.column === t.name);
      return v ? valueLine(v) : undefined;
    }
    case "type": {
      const e = d.enums.find((x) => x.name === t.name);
      if (e) {
        if (e.status !== "modified") return `${STATUS_TEXT[e.status]}: ENUM (${(e.after ?? e.before)!.values.join(", ")})`;
        const v = d.values.find((x) => x.type === t.name);
        return v ? `値の変更: ${valueLine(v)}` : STATUS_TEXT.modified;
      }
      const dm = d.domains.find((x) => x.name === t.name);
      if (!dm) return undefined;
      const text = (x: NonNullable<typeof dm.after>) => `${x.type}${x.notNull ? " NOT NULL" : ""}${x.checks.map((k) => ` ${k.definition}`).join("")}`;
      if (dm.status !== "modified") return `${STATUS_TEXT[dm.status]}: DOMAIN ${text((dm.after ?? dm.before)!)}`;
      return `${STATUS_TEXT.modified}: ${text(dm.before!)} → ${text(dm.after!)}`;
    }
  }
}

function valueLine(v: DbShapeResult["diff"]["values"][number]): string {
  if (v.status === "added") return `値の制限を追加（${(v.after ?? []).join(", ")}）`;
  if (v.status === "removed") return `値の制限を削除（変更前: ${(v.before ?? []).join(", ")}）`;
  const parts = [...v.added.map((x) => `+${x}`), ...v.removed.map((x) => `−${x}`)];
  return `${parts.join(" ")}（変更後: ${(v.after ?? []).join(", ")}）`;
}

/** Where the target is defined (the CHECK itself for a value change, when known) */
export function locationOf(data: DbShapeResult, t: CommentTarget): SourceLocation | undefined {
  if (t.kind === "value") {
    const v = data.diff.values.find((x) => x.source === "check" && x.table === t.table && x.column === t.name);
    if (v?.constraint) {
      const l = data.locations[`${t.table}:${v.constraint}`];
      if (l) return l;
    }
  }
  return data.locations[locKey(t)];
}

/** Whether the target exists on the target side */
export function exists(data: DbShapeResult, t: CommentTarget): boolean {
  const l = data.locations[locKey(t)];
  return !!l && !l.base;
}

export function commentState(data: DbShapeResult, c: ReviewComment): CommentState {
  const now = changeText(data, c.target);
  const gone = !exists(data, c.target) && !now;
  // a removed part stays open while it is still removed; it is resolved once the diff no longer has it
  if (gone || (c.snapshot !== undefined && now === undefined)) return "resolved";
  return now !== c.snapshot ? "updated" : "open";
}

export function newComment(data: DbShapeResult, target: CommentTarget, body: string): ReviewComment {
  return {
    id: newCommentId(),
    target,
    body,
    createdAt: Date.now(),
    snapshot: changeText(data, target),
  };
}

const where = (l?: SourceLocation) => (l ? (l.base ? `比較元の ${l.file}:${l.line}（変更後にはありません）` : `${l.file}:${l.line}`) : undefined);

export function formatPrompt(data: DbShapeResult, comments: ReviewComment[], opts: { includeResolved?: boolean; header?: boolean } = {}): { text: string; included: number; skipped: number } {
  const list = opts.includeResolved ? comments : comments.filter((c) => commentState(data, c) !== "resolved");
  // without the header: a section of the prompt the app combines from every module
  const out: string[] = [
    ...(opts.header === false ? [] : [...promptHeader({ repoRoot: data.repoRoot, targetLabel: data.target.label, baseLabel: data.base.label }), "対象: DB スキーマ（dbshape）"]),
    `スキーマの SQL: ${schemaFromText(data.schemaFrom)}`,
    "",
  ];
  list.forEach((c, i) => {
    const state = commentState(data, c);
    const now = changeText(data, c.target);
    out.push(`${i + 1}. ${targetLabel(c.target)}${now ? `（${now}）` : "（変更なし）"}${state === "resolved" ? "（解消済み？）" : ""}`);
    const w = where(locationOf(data, c.target));
    if (w) out.push(`   定義: ${w}`);
    if (state === "updated") out.push(`   コメントしたときは: ${c.snapshot ?? "変更なし"}`);
    out.push(`   コメント: ${c.body.trim().replace(/\n/g, "\n   ")}`);
    out.push("");
  });
  return { text: out.join("\n").trimEnd() + "\n", included: list.length, skipped: comments.length - list.length };
}

// ---- saved per repository and comparison, like the reviewed marks

const PREFIX = "dbshape.comments:";

export const loadComments = (scope: string) => loadCommentList<ReviewComment>(PREFIX + scope);

export const saveComments = (scope: string, comments: ReviewComment[]) => saveCommentList(PREFIX + scope, comments);
