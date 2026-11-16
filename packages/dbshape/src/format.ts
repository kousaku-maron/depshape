import type { ColumnView, DbShapeResult, DbShapeRun, IndexView, TableChange, ValueChange } from "./model.js";
import { schemaFromText } from "./names.js";

/* The terminal summary (the default output until the browser view exists). */

export interface Colors {
  add: (s: string) => string;
  del: (s: string) => string;
  mod: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
}

const ansi = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
export const COLORS: Colors = { add: ansi("32"), del: ansi("31"), mod: ansi("33"), dim: ansi("2"), bold: ansi("1") };
export const PLAIN: Colors = { add: (s) => s, del: (s) => s, mod: (s) => s, dim: (s) => s, bold: (s) => s };

function column(c: ColumnView): string {
  const parts = [c.type];
  if (c.notNull) parts.push("NOT NULL");
  if (c.default !== undefined) parts.push(`DEFAULT ${c.default}`);
  if (c.identity) parts.push(`GENERATED ${c.identity === "always" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`);
  if (c.generated) parts.push(`GENERATED ALWAYS AS (${c.generated}) STORED`);
  return parts.join(" ");
}

/** "UNIQUE INDEX USING gin (a, b) WHERE ..." */
export function indexText(i: IndexView): string {
  return `${i.unique ? "UNIQUE " : ""}INDEX ${i.method ? `USING ${i.method} ` : ""}(${i.columns.join(", ")})${i.include ? ` INCLUDE (${i.include.join(", ")})` : ""}${i.where ? ` WHERE ${i.where}` : ""}`;
}

const values = (v: string[]) => v.map((x) => `'${x}'`).join(", ");

function tableLines(t: TableChange, c: Colors): string[] {
  const out: string[] = [];
  const mark = { added: c.add("+"), removed: c.del("-"), modified: c.mod("~") };
  const full = t.status !== "modified";
  for (const col of t.columns) {
    if (full) {
      out.push(`      ${col.name}  ${c.dim(column((col.after ?? col.before)!))}`);
      continue;
    }
    if (col.status === "modified") {
      out.push(`    ${mark.modified} ${col.name}  ${c.dim(column(col.before!))} → ${column(col.after!)}`);
    } else {
      out.push(`    ${mark[col.status]} ${col.name}  ${column((col.after ?? col.before)!)}`);
    }
  }
  for (const k of t.constraints) {
    const v = (k.after ?? k.before)!;
    if (full) out.push(`      ${c.dim(`${v.name}: ${v.definition}`)}`);
    else if (k.status === "modified") out.push(`    ${mark.modified} ${k.name}  ${c.dim(k.before!.definition)} → ${k.after!.definition}`);
    else out.push(`    ${mark[k.status]} ${k.name}  ${v.definition}`);
  }
  for (const i of t.indexes) {
    const v = (i.after ?? i.before)!;
    if (full) out.push(`      ${c.dim(`${v.name}: ${indexText(v)}`)}`);
    else if (i.status === "modified") out.push(`    ${mark.modified} ${i.name}  ${c.dim(indexText(i.before!))} → ${indexText(i.after!)}`);
    else out.push(`    ${mark[i.status]} ${i.name}  ${indexText(v)}`);
  }
  if (t.comment && !full) out.push(`    ${mark.modified} COMMENT  ${c.dim(t.comment.before ?? "(なし)")} → ${t.comment.after ?? "(なし)"}`);
  return out;
}

function valueLine(v: ValueChange, c: Colors): string {
  const where = v.source === "check" ? `${v.table}.${v.column}` : `${v.type}（${v.source === "enum" ? "ENUM 型" : "DOMAIN"}）`;
  const what =
    v.status === "added"
      ? `CHECK で値を制限: ${values(v.added)}`
      : v.status === "removed"
        ? `値の制限がなくなった（${values(v.removed)}）`
        : [...v.added.map((x) => c.add(`+'${x}'`)), ...v.removed.map((x) => c.del(`-'${x}'`))].join(" ");
  const extra = v.source === "check" ? c.dim(`  CHECK ${v.constraint}`) : v.usedBy?.length ? c.dim(`  使用: ${v.usedBy.join(", ")}`) : "";
  return `  ${where}  ${what}${extra}`;
}

/** The summary of one database; with `header: false` the comparison line is left out */
export function formatSummary(r: DbShapeResult, c: Colors = PLAIN, opts: { header?: boolean } = {}): string {
  const d = r.diff;
  const added = d.tables.filter((t) => t.status === "added");
  const modified = d.tables.filter((t) => t.status === "modified");
  const removed = d.tables.filter((t) => t.status === "removed");
  const out: string[] = [];
  if (opts.header !== false) out.push(c.bold(`${r.target.label}  vs  ${r.base.label}`));
  out.push(c.dim(`スキーマ: ${r.target.files.length} ファイル（${schemaFromText(r.schemaFrom)}）、変更のないテーブル ${d.unchangedTables}`));
  out.push("");

  const section = (title: string, items: TableChange[], mark: string) => {
    out.push(c.bold(`${title} (${items.length})`));
    for (const t of items) {
      out.push(`  ${mark} ${t.name}${t.status !== "modified" ? c.dim(`  ${t.columns.length} カラム  ${t.file}`) : ""}`);
      out.push(...tableLines(t, c));
    }
    out.push("");
  };
  section("新規テーブル", added, c.add("+"));
  section("変更したテーブル", modified, c.mod("~"));
  section("削除したテーブル", removed, c.del("-"));

  out.push(c.bold(`値の変化 (${d.values.length})`));
  for (const v of d.values) out.push(valueLine(v, c));
  out.push("");

  const types = [...d.enums.map((e) => ({ ...e, kind: "ENUM 型" })), ...d.domains.map((e) => ({ ...e, kind: "DOMAIN" }))];
  if (types.length) {
    out.push(c.bold(`型 (${types.length})`));
    for (const t of types) {
      const mark = t.status === "added" ? c.add("+") : t.status === "removed" ? c.del("-") : c.mod("~");
      out.push(`  ${mark} ${t.name}  ${c.dim(t.kind)}`);
    }
    out.push("");
  }

  if (r.ignored.length) {
    out.push(c.dim(`比較していない文: ${r.ignored.map((i) => `${i.statement} ${i.count}`).join(", ")}`));
  }
  for (const w of r.warnings) out.push(c.mod(`注意: ${w}`));
  return out.join("\n").replace(/\n+$/, "") + "\n";
}

/** The summary of every database: one after another, each under its name when there are several */
export function formatRunSummary(run: DbShapeRun, c: Colors = PLAIN): string {
  if (run.databases.length === 1) return formatSummary(run.databases[0], c);
  const parts = run.databases.map((d) => `${c.bold(`■ DB: ${d.database.name}`)}\n${formatSummary(d, c, { header: false })}`);
  return `${c.bold(`${run.targetLabel}  vs  ${run.baseLabel}`)}\n\n${parts.join("\n")}`;
}
