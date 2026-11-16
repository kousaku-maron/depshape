import { beforeAll, describe, expect, it } from "vitest";
import { parser } from "../src/analyze.js";
import { diffSchemas } from "../src/diff.js";
import { erTables } from "../src/er.js";
import { buildSchema, type Parser } from "../src/schema.js";

let parse: Parser;
beforeAll(async () => {
  parse = await parser();
});

function er(before: string, after: string) {
  const b = buildSchema([{ path: "db.sql", sql: before }], parse);
  const a = buildSchema([{ path: "db.sql", sql: after }], parse);
  return erTables(b, a, diffSchemas(b, a));
}

describe("erTables", () => {
  const BEFORE = `
    CREATE TABLE billing.prices (id uuid PRIMARY KEY, tier text CHECK (tier IN ('basic', 'pro')));
    CREATE TABLE billing.invoices (id uuid PRIMARY KEY, amount integer, legacy_id uuid REFERENCES billing.legacy (id));
    CREATE TABLE billing.legacy (id uuid PRIMARY KEY);
    CREATE TABLE billing.notes (id int);`;
  const AFTER = `
    CREATE TABLE billing.prices (id uuid PRIMARY KEY, tier text CHECK (tier IN ('basic', 'pro', 'team')));
    CREATE TABLE billing.invoices (id uuid PRIMARY KEY, amount bigint, price_id uuid REFERENCES billing.prices (id));
    CREATE INDEX invoices_price_idx ON billing.invoices (price_id);
    CREATE TABLE billing.legacy (id uuid PRIMARY KEY);
    CREATE TABLE billing.subscriptions (id uuid PRIMARY KEY, price_id uuid REFERENCES billing.prices (id));`;

  it("lists every table with its status", () => {
    expect(er(BEFORE, AFTER).map((t) => [t.name, t.status])).toEqual([
      ["billing.invoices", "modified"],
      ["billing.legacy", "unchanged"],
      ["billing.notes", "removed"],
      ["billing.prices", "modified"],
      ["billing.subscriptions", "added"],
    ]);
  });

  it("marks columns and foreign keys, keeping removed ones", () => {
    const inv = er(BEFORE, AFTER).find((t) => t.name === "billing.invoices")!;
    expect(inv.columns.map((c) => [c.name, c.status, c.primary, c.beforeType])).toEqual([
      ["id", "unchanged", true, undefined],
      ["amount", "modified", false, "integer"],
      ["price_id", "added", false, undefined],
      ["legacy_id", "removed", false, undefined],
    ]);
    expect(inv.foreignKeys.map((f) => [f.columns, f.table, f.status])).toEqual([
      [["price_id"], "billing.prices", "added"],
      [["legacy_id"], "billing.legacy", "removed"],
    ]);
    expect(inv.otherChanges).toEqual({ constraints: 0, indexes: 1, comment: false });
  });

  it("marks columns whose values changed, and every part of an added table", () => {
    const tables = er(BEFORE, AFTER);
    const prices = tables.find((t) => t.name === "billing.prices")!;
    expect(prices.columns.find((c) => c.name === "tier")!.values).toBe(true);
    expect(prices.otherChanges.constraints).toBe(1);
    const sub = tables.find((t) => t.name === "billing.subscriptions")!;
    expect(sub.columns.every((c) => c.status === "added")).toBe(true);
    expect(sub.foreignKeys.map((f) => f.status)).toEqual(["added"]);
  });
});
