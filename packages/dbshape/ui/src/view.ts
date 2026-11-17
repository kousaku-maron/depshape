import type { ColumnView, ConstraintView, IndexView, TableChange, ValueChange } from "../../src/model";

/* Pure helpers for the view (kept free of React so they can be tested). */

export type Status = "added" | "removed" | "modified";

export interface Stats {
  added: number;
  removed: number;
  modified: number;
}

/** How many columns, constraints and indexes of a table were added / removed / changed. */
/** The tooltip of a table's counts: what changed among its columns, constraints and indexes */
export const changeTitle = (s: Stats) => `カラム・制約・インデックス：追加 ${s.added}・削除 ${s.removed}・変更 ${s.modified}`;

export function tableStats(t: TableChange): Stats {
  const s: Stats = { added: 0, removed: 0, modified: 0 };
  for (const x of [...t.columns, ...t.constraints, ...t.indexes]) s[x.status]++;
  if (t.comment && t.status === "modified") s.modified++;
  return s;
}

export interface ColumnBadges {
  primary: boolean;
  unique: boolean;
  /** "schema.table (col)" for each foreign key that starts at this column */
  references: { table: string; columns: string[] }[];
  /** Values of a CHECK on this column */
  values?: string[];
}

/** Key / reference / value badges for each column, from the constraints on one side of a table. */
export function columnBadges(constraints: ConstraintView[]): Map<string, ColumnBadges> {
  const out = new Map<string, ColumnBadges>();
  const get = (c: string) => {
    let b = out.get(c);
    if (!b) out.set(c, (b = { primary: false, unique: false, references: [] }));
    return b;
  };
  for (const c of constraints) {
    if (c.kind === "primary") c.columns.forEach((col) => (get(col).primary = true));
    if (c.kind === "unique" && c.columns.length === 1) get(c.columns[0]).unique = true;
    if (c.kind === "foreign" && c.references && c.columns.length === 1) {
      get(c.columns[0]).references.push({ table: c.references.table, columns: c.references.columns });
    }
    if (c.kind === "check" && c.values) get(c.values.column).values = c.values.values;
  }
  return out;
}

/** The constraints of a table on the target side (or the base side for a removed table). */
export function sideConstraints(t: TableChange): ConstraintView[] {
  const changed = t.constraints.map((c) => c.after ?? (t.status === "removed" ? c.before : undefined)).filter((c): c is ConstraintView => !!c);
  return [...changed, ...(t.unchanged?.constraints ?? [])];
}

export interface Chip {
  value: string;
  status: "added" | "removed" | "same";
}

/** Values of a value change as chips: the current values in order (new ones marked), then the removed ones. */
export function valueChips(before: string[] | undefined, after: string[] | undefined): Chip[] {
  const b = new Set(before ?? []);
  const a = new Set(after ?? []);
  return [
    ...(after ?? []).map((v): Chip => ({ value: v, status: before && !b.has(v) ? "added" : "same" })),
    ...(before ?? []).filter((v) => !a.has(v)).map((v): Chip => ({ value: v, status: "removed" })),
  ];
}

/** Where a value change lives, for display and for jumping to its table */
export function valueTarget(v: ValueChange): { label: string; table?: string } {
  if (v.source === "check") return { label: `${v.table}.${v.column}`, table: v.table };
  return { label: v.type ?? "" };
}

/** Column attributes as short text, in display order */
export function columnParts(c: ColumnView): { key: string; text: string }[] {
  const parts = [{ key: "type", text: c.type }];
  parts.push({ key: "notNull", text: c.notNull ? "NOT NULL" : "NULL" });
  if (c.default !== undefined) parts.push({ key: "default", text: `DEFAULT ${c.default}` });
  if (c.identity) parts.push({ key: "identity", text: `IDENTITY ${c.identity === "always" ? "ALWAYS" : "BY DEFAULT"}` });
  if (c.generated) parts.push({ key: "generated", text: `GENERATED (${c.generated})` });
  return parts;
}

/** "USING gin (a, b) INCLUDE (c) WHERE ..." (what follows "INDEX") */
export function indexBody(i: IndexView): string {
  return `${i.method ? `USING ${i.method} ` : ""}(${i.columns.join(", ")})${i.include ? ` INCLUDE (${i.include.join(", ")})` : ""}${i.where ? ` WHERE ${i.where}` : ""}`;
}

/** "UNIQUE INDEX USING gin (a, b) WHERE ..." */
export function indexText(i: IndexView): string {
  return `${i.unique ? "UNIQUE " : ""}INDEX ${indexBody(i)}`;
}

export { hashOf } from "@diffshape/ui";

/** Whether a table matches the filter text (name, schema or any changed column name). */
export function matchesFilter(t: TableChange, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return t.name.toLowerCase().includes(s) || t.columns.some((c) => c.name.toLowerCase().includes(s));
}

