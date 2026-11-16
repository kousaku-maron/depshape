import { describe, expect, it } from "vitest";
import type { ErTable } from "../src/model.js";
import { buildDiagram, edgePath, pickRows, pickTables, rowY } from "../ui/src/erLayout.js";

const col = (name: string, extra: Partial<ErTable["columns"][number]> = {}) => ({ name, type: "uuid", status: "unchanged" as const, notNull: true, primary: false, ...extra });
const none = { constraints: 0, indexes: 0, comment: false };

const TABLES: ErTable[] = [
  {
    name: "billing.invoices",
    schema: "billing",
    table: "invoices",
    status: "modified",
    columns: [col("id", { primary: true }), col("price_id", { status: "added" }), col("memo", { type: "text" }), col("note", { type: "text" })],
    foreignKeys: [{ name: "invoices_price_id_fkey", columns: ["price_id"], table: "billing.prices", refColumns: ["id"], status: "added" }],
    otherChanges: { constraints: 1, indexes: 0, comment: false },
  },
  {
    name: "billing.prices",
    schema: "billing",
    table: "prices",
    status: "unchanged",
    columns: [col("id", { primary: true }), col("label", { type: "text" })],
    foreignKeys: [],
    otherChanges: none,
  },
  {
    name: "catalog.items",
    schema: "catalog",
    table: "items",
    status: "unchanged",
    columns: [col("id", { primary: true }), col("price_id")],
    foreignKeys: [{ name: "items_price_id_fkey", columns: ["price_id"], table: "billing.prices", refColumns: ["id"], status: "unchanged" }],
    otherChanges: none,
  },
];

const measure = (text: string) => text.length * 7;

describe("pickTables", () => {
  it("shows changed tables and the tables they point at", () => {
    expect(pickTables(TABLES, "changes").map((p) => [p.table.name, p.neighbor])).toEqual([
      ["billing.invoices", false],
      ["billing.prices", true],
    ]);
    expect(pickTables(TABLES, "all")).toHaveLength(3);
  });
});

describe("pickRows", () => {
  it("keeps changed, key and foreign key columns, and folds the rest", () => {
    const rows = pickRows(TABLES[0], new Set(), false);
    expect(rows.map((r) => (r.kind === "column" ? r.column.name : `more ${r.hidden}`))).toEqual(["id", "price_id", "more 2"]);
    expect(pickRows(TABLES[0], new Set(), true)).toHaveLength(4);
  });

  it("keeps columns other tables point at", () => {
    const rows = pickRows(TABLES[1], new Set(["id"]), false);
    expect(rows.map((r) => (r.kind === "column" ? r.column.name : "more"))).toEqual(["id", "more"]);
  });
});

describe("buildDiagram", () => {
  const d = buildDiagram(TABLES, "all", new Set(), measure);

  it("places every table inside its schema box without overlaps", () => {
    expect(d.tables).toHaveLength(3);
    expect(d.groups.map((g) => g.schema).sort()).toEqual(["billing", "catalog"]);
    for (const t of d.tables) {
      const g = d.groups.find((x) => x.schema === t.table.schema)!;
      expect(t.x).toBeGreaterThanOrEqual(g.x);
      expect(t.y).toBeGreaterThanOrEqual(g.y);
      expect(t.x + t.width).toBeLessThanOrEqual(g.x + g.width + 0.5);
      expect(t.y + t.height).toBeLessThanOrEqual(g.y + g.height + 0.5);
    }
    for (const a of d.tables) {
      for (const b of d.tables) {
        if (a === b) continue;
        const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        expect(apart).toBe(true);
      }
    }
  });

  it("draws foreign keys from the column row to the referenced row", () => {
    const e = d.edges.find((x) => x.fk.name === "invoices_price_id_fkey")!;
    expect(e.fromColumn).toBe("price_id");
    expect(e.toColumn).toBe("id");
    const from = d.tables.find((t) => t.table.name === "billing.invoices")!;
    expect(e.points[0].y).toBe(rowY(from, "price_id"));
    expect(edgePath(e.points)).toMatch(/^M .* C /);
    expect(d.tables.find((t) => t.table.name === "billing.invoices")!.footer).toBe("制約 1 の変更");
  });
});
