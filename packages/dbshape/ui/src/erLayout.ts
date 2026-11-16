// the ESM build has only a default export (its type definitions describe it as named exports)
import dagre from "@dagrejs/dagre";
import type { ErColumn, ErForeignKey, ErStatus, ErTable } from "../../src/model";

/*
 * Which tables and rows the ER diagram shows, their sizes, and where they go (dagre, grouped by
 * PostgreSQL schema). Kept free of React so it can be tested; text width comes from a function the
 * caller passes (a canvas in the browser).
 */

export type Mode = "changes" | "all";

export interface Row {
  kind: "column";
  column: ErColumn;
  /** A foreign key starts at this column */
  fk: boolean;
}

export interface MoreRow {
  kind: "more";
  hidden: number;
}

export interface DiagramTable {
  table: ErTable;
  /** Shown only because a changed table points at it */
  neighbor: boolean;
  rows: (Row | MoreRow)[];
  /** "制約 ~1・インデックス +1" when constraints / indexes changed */
  footer?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiagramEdge {
  fk: ErForeignKey;
  from: string;
  to: string;
  /** Column rows the edge starts and ends at (undefined = the table header) */
  fromColumn?: string;
  toColumn?: string;
  points: { x: number; y: number }[];
}

export interface DiagramGroup {
  schema: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Diagram {
  tables: DiagramTable[];
  edges: DiagramEdge[];
  groups: DiagramGroup[];
  width: number;
  height: number;
}

export const HEADER_H = 28;
export const ROW_H = 20;
export const FOOTER_H = 20;
const PAD_X = 10;
const MIN_W = 150;

/**
 * The tables to show. "changes": every changed table, plus the unchanged tables a changed table's
 * foreign key points at (its neighbors). "all": every table.
 */
export function pickTables(tables: ErTable[], mode: Mode): { table: ErTable; neighbor: boolean }[] {
  if (mode === "all") return tables.map((t) => ({ table: t, neighbor: false }));
  const changed = tables.filter((t) => t.status !== "unchanged");
  const names = new Set(changed.map((t) => t.name));
  const neighbors = new Set<string>();
  for (const t of changed) for (const fk of t.foreignKeys) if (!names.has(fk.table)) neighbors.add(fk.table);
  return tables.filter((t) => names.has(t.name) || neighbors.has(t.name)).map((t) => ({ table: t, neighbor: neighbors.has(t.name) }));
}

/**
 * The rows of a table: changed columns, keys, foreign key columns, columns whose values changed and
 * columns other shown tables point at. The rest fold into one "他 N カラム" row unless expanded.
 */
export function pickRows(t: ErTable, referenced: ReadonlySet<string>, expanded: boolean): (Row | MoreRow)[] {
  const fkCols = new Set(t.foreignKeys.flatMap((f) => f.columns));
  const keep = (c: ErColumn) => expanded || c.status !== "unchanged" || c.primary || fkCols.has(c.name) || c.values || referenced.has(c.name);
  const rows: (Row | MoreRow)[] = t.columns.filter(keep).map((c) => ({ kind: "column", column: c, fk: fkCols.has(c.name) }));
  const hidden = t.columns.length - rows.length;
  if (hidden > 0) rows.push({ kind: "more", hidden });
  return rows;
}

function footerText(t: ErTable): string | undefined {
  const parts: string[] = [];
  if (t.otherChanges.constraints) parts.push(`制約 ${t.otherChanges.constraints}`);
  if (t.otherChanges.indexes) parts.push(`インデックス ${t.otherChanges.indexes}`);
  if (t.otherChanges.comment) parts.push("コメント");
  return parts.length ? `${parts.join("・")} の変更` : undefined;
}

export function rowText(c: ErColumn): { name: string; type: string } {
  return { name: c.name, type: c.beforeType ? `${c.beforeType} → ${c.type}` : c.type };
}

export type Measure = (text: string, bold?: boolean) => number;

export function buildDiagram(all: ErTable[], mode: Mode, expanded: ReadonlySet<string>, measure: Measure): Diagram {
  const picked = pickTables(all, mode);
  const shown = new Set(picked.map((p) => p.table.name));

  // columns that shown foreign keys point at, per table
  const referenced = new Map<string, Set<string>>();
  for (const { table } of picked) {
    for (const fk of table.foreignKeys) {
      if (!shown.has(fk.table)) continue;
      const s = referenced.get(fk.table) ?? new Set<string>();
      fk.refColumns.forEach((c) => s.add(c));
      referenced.set(fk.table, s);
    }
  }

  const g = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  g.setGraph({ rankdir: "LR", nodesep: 28, ranksep: 90, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));

  const tables: DiagramTable[] = picked.map(({ table, neighbor }) => {
    const rows = pickRows(table, referenced.get(table.name) ?? new Set(), expanded.has(table.name));
    const footer = footerText(table);
    let width = Math.max(MIN_W, measure(table.name, true) + PAD_X * 2 + 24);
    for (const r of rows) {
      if (r.kind === "more") continue;
      const t = rowText(r.column);
      width = Math.max(width, 18 + measure(t.name) + 16 + measure(t.type) + 34 + PAD_X * 2);
    }
    if (footer) width = Math.max(width, measure(footer) + PAD_X * 2);
    const height = HEADER_H + rows.length * ROW_H + (footer ? FOOTER_H : 0) + 4;
    return { table, neighbor, rows, footer, x: 0, y: 0, width: Math.ceil(width), height };
  });

  const schemas = [...new Set(tables.map((t) => t.table.schema))];
  for (const s of schemas) g.setNode(`schema:${s}`, { label: s, paddingTop: 26 });
  for (const t of tables) {
    g.setNode(t.table.name, { width: t.width, height: t.height });
    g.setParent(t.table.name, `schema:${t.table.schema}`);
  }

  const edges: DiagramEdge[] = [];
  for (const t of tables) {
    for (const fk of t.table.foreignKeys) {
      if (!shown.has(fk.table)) continue;
      const target = tables.find((x) => x.table.name === fk.table)!;
      const hasRow = (dt: DiagramTable, col?: string) => !!col && dt.rows.some((r) => r.kind === "column" && r.column.name === col);
      edges.push({
        fk,
        from: t.table.name,
        to: fk.table,
        fromColumn: hasRow(t, fk.columns[0]) ? fk.columns[0] : undefined,
        toColumn: hasRow(target, fk.refColumns[0]) ? fk.refColumns[0] : undefined,
        points: [],
      });
      if (fk.table !== t.table.name) g.setEdge(t.table.name, fk.table, {}, fk.name);
    }
  }

  dagre.layout(g);

  for (const t of tables) {
    const n = g.node(t.table.name);
    t.x = n.x - t.width / 2;
    t.y = n.y - t.height / 2;
  }
  const groups: DiagramGroup[] = schemas.map((s) => {
    const n = g.node(`schema:${s}`);
    return { schema: s, x: n.x - n.width / 2, y: n.y - n.height / 2, width: n.width, height: n.height };
  });

  const byName = new Map(tables.map((t) => [t.table.name, t]));
  for (const e of edges) e.points = edgePoints(byName.get(e.from)!, e.fromColumn, byName.get(e.to)!, e.toColumn);

  const right = Math.max(0, ...tables.map((t) => t.x + t.width), ...groups.map((gr) => gr.x + gr.width));
  const bottom = Math.max(0, ...tables.map((t) => t.y + t.height), ...groups.map((gr) => gr.y + gr.height));
  return { tables, edges, groups, width: right + 20, height: bottom + 20 };
}

/** The y of a column row's middle (or the header's) inside a table */
export function rowY(t: DiagramTable, column?: string): number {
  const i = column ? t.rows.findIndex((r) => r.kind === "column" && r.column.name === column) : -1;
  return i < 0 ? t.y + HEADER_H / 2 : t.y + HEADER_H + i * ROW_H + ROW_H / 2;
}

/** A foreign key line from the side of one row to the side of the other table's row. */
export function edgePoints(from: DiagramTable, fromCol: string | undefined, to: DiagramTable, toCol: string | undefined) {
  const y1 = rowY(from, fromCol);
  const y2 = rowY(to, toCol);
  if (from === to) {
    const x = from.x + from.width;
    return [
      { x, y: y1 },
      { x: x + 28, y: y1 },
      { x: x + 28, y: y2 },
      { x, y: y2 },
    ];
  }
  const fromCenter = from.x + from.width / 2;
  const toCenter = to.x + to.width / 2;
  const toRight = toCenter >= fromCenter;
  const x1 = toRight ? from.x + from.width : from.x;
  const x2 = toRight ? to.x : to.x + to.width;
  return [
    { x: x1, y: y1 },
    { x: x2, y: y2 },
  ];
}

/** SVG path for edge points: a horizontal S-curve between two points, or a polyline for a loop */
export function edgePath(points: { x: number; y: number }[]): string {
  if (points.length !== 2) return `M ${points.map((p) => `${p.x} ${p.y}`).join(" L ")}`;
  const [a, b] = points;
  const dx = Math.max(30, Math.abs(b.x - a.x) / 2) * (b.x >= a.x ? 1 : -1);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

export const STATUS_MARK: Record<ErStatus, string> = { added: "+", removed: "−", modified: "~", unchanged: "" };
