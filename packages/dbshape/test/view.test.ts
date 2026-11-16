import { describe, expect, it } from "vitest";
import type { TableChange } from "../src/model.js";
import { columnBadges, hashOf, indexText, matchesFilter, sideConstraints, tableStats, valueChips } from "../ui/src/view.js";

const table: TableChange = {
  name: "billing.invoices",
  schema: "billing",
  table: "invoices",
  status: "modified",
  file: "db/billing.sql",
  columns: [
    { name: "price_id", status: "added", after: { name: "price_id", type: "uuid", notNull: true } },
    { name: "legacy", status: "removed", before: { name: "legacy", type: "text", notNull: false } },
    { name: "amount", status: "modified", changed: ["type"], before: { name: "amount", type: "integer", notNull: true }, after: { name: "amount", type: "bigint", notNull: true } },
  ],
  constraints: [
    {
      name: "invoices_price_id_fkey",
      kind: "foreign",
      status: "added",
      after: { name: "invoices_price_id_fkey", kind: "foreign", columns: ["price_id"], definition: "FOREIGN KEY (price_id) REFERENCES billing.prices (id)", references: { table: "billing.prices", columns: ["id"] } },
    },
  ],
  indexes: [],
  unchanged: {
    columns: [{ name: "id", type: "uuid", notNull: true }],
    constraints: [
      { name: "invoices_pkey", kind: "primary", columns: ["id"], definition: "PRIMARY KEY (id)" },
      { name: "invoices_kind_check", kind: "check", columns: ["kind"], definition: "CHECK (kind IN ('a'))", values: { column: "kind", values: ["a"] } },
    ],
    indexes: [],
  },
};

describe("view helpers", () => {
  it("counts changes per table", () => {
    expect(tableStats(table)).toEqual({ added: 2, removed: 1, modified: 1 });
  });

  it("collects key, reference and value badges from the target side", () => {
    const b = columnBadges(sideConstraints(table));
    expect(b.get("id")).toMatchObject({ primary: true });
    expect(b.get("price_id")!.references).toEqual([{ table: "billing.prices", columns: ["id"] }]);
    expect(b.get("kind")!.values).toEqual(["a"]);
  });

  it("orders value chips as current values, then removed ones", () => {
    expect(valueChips(["a", "b", "c"], ["a", "c", "d"])).toEqual([
      { value: "a", status: "same" },
      { value: "c", status: "same" },
      { value: "d", status: "added" },
      { value: "b", status: "removed" },
    ]);
    expect(valueChips(undefined, ["a"])).toEqual([{ value: "a", status: "same" }]);
  });

  it("prints UNIQUE before INDEX", () => {
    expect(indexText({ name: "i", unique: true, method: "gin", columns: ["a"], where: "b IS NULL" })).toBe("UNIQUE INDEX USING gin (a) WHERE b IS NULL");
  });

  it("hashes stably and filters by table or column name", () => {
    expect(hashOf(table)).toBe(hashOf(JSON.parse(JSON.stringify(table))));
    expect(hashOf(table)).not.toBe(hashOf({ ...table, file: "x" }));
    expect(matchesFilter(table, "INVOICE")).toBe(true);
    expect(matchesFilter(table, "legacy")).toBe(true);
    expect(matchesFilter(table, "orders")).toBe(false);
  });
});
