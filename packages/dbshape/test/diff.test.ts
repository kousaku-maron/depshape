import { beforeAll, describe, expect, it } from "vitest";
import { parser } from "../src/analyze.js";
import { diffSchemas } from "../src/diff.js";
import { buildSchema, type Parser } from "../src/schema.js";

let parse: Parser;
beforeAll(async () => {
  parse = await parser();
});

const diff = (before: string | string[], after: string | string[]) => {
  const files = (sql: string | string[]) => [sql].flat().map((s, i) => ({ path: `db/${i}.sql`, sql: s }));
  return diffSchemas(buildSchema(files(before), parse), buildSchema(files(after), parse));
};

const BASE = `
  CREATE TABLE billing.prices (id uuid PRIMARY KEY, tier text NOT NULL CHECK (tier IN ('basic', 'pro')));
  CREATE TABLE billing.invoices (
    id uuid PRIMARY KEY,
    amount integer NOT NULL,
    legacy_ref text,
    status varchar NOT NULL DEFAULT 'draft'
  );
  CREATE TABLE billing.notes (id int);`;

describe("diffSchemas", () => {
  it("reports nothing for the same schema written differently", () => {
    const d = diff(BASE, BASE.replace(/\s+/g, " ").replace("integer", "int4").replace("varchar", "character varying"));
    expect(d.tables).toEqual([]);
    expect(d.unchangedTables).toBe(3);
  });

  it("lists added, removed and modified tables", () => {
    const after = `
      CREATE TABLE billing.prices (id uuid PRIMARY KEY, tier text NOT NULL CHECK (tier IN ('basic', 'pro', 'team')));
      CREATE TABLE billing.invoices (
        id uuid PRIMARY KEY,
        amount numeric(12,2) NOT NULL,
        status varchar NOT NULL DEFAULT 'draft',
        subscription_id uuid NOT NULL REFERENCES billing.subscriptions (id)
      );
      CREATE INDEX invoices_subscription_idx ON billing.invoices (subscription_id);
      CREATE TABLE billing.subscriptions (id uuid PRIMARY KEY, price_id uuid REFERENCES billing.prices (id));`;
    const d = diff(BASE, after);
    expect(d.tables.map((t) => [t.name, t.status])).toEqual([
      ["billing.invoices", "modified"],
      ["billing.notes", "removed"],
      ["billing.prices", "modified"],
      ["billing.subscriptions", "added"],
    ]);

    const inv = d.tables[0];
    expect(inv.columns.map((c) => [c.name, c.status, c.changed])).toEqual([
      ["amount", "modified", ["type"]],
      ["subscription_id", "added", undefined],
      ["legacy_ref", "removed", undefined],
    ]);
    expect(inv.columns[0].before!.type).toBe("integer");
    expect(inv.columns[0].after!.type).toBe("numeric(12,2)");
    expect(inv.constraints.map((c) => [c.name, c.status])).toEqual([["invoices_subscription_id_fkey", "added"]]);
    expect(inv.indexes.map((i) => [i.name, i.status])).toEqual([["invoices_subscription_idx", "added"]]);
    expect(inv.unchanged!.columns.map((c) => c.name)).toEqual(["id", "status"]);
    expect(inv.unchanged!.constraints.map((c) => c.name)).toEqual(["invoices_pkey"]);

    const sub = d.tables[3];
    expect(sub.columns.map((c) => c.name)).toEqual(["id", "price_id"]);
    expect(sub.columns.every((c) => c.status === "added")).toBe(true);
    expect(sub.constraints.map((c) => c.after!.references?.table)).toEqual([undefined, "billing.prices"]);

    // the CHECK on prices.tier changed its values; the new table's own CHECKs are not value changes
    expect(d.values).toEqual([
      {
        source: "check",
        table: "billing.prices",
        column: "tier",
        constraint: "prices_tier_check",
        status: "modified",
        added: ["team"],
        removed: [],
        before: ["basic", "pro"],
        after: ["basic", "pro", "team"],
      },
    ]);
    expect(d.tables[2].constraints.map((c) => [c.name, c.status])).toEqual([["prices_tier_check", "modified"]]);
  });

  it("matches a CHECK by column when its name changed", () => {
    const d = diff(
      `CREATE TABLE t (kind text CHECK (kind IN ('a', 'b')));`,
      `CREATE TABLE t (kind text, CONSTRAINT t_kind_values CHECK (kind = ANY (ARRAY['a', 'c'])));`,
    );
    expect(d.values.map((v) => [v.constraint, v.status, v.added, v.removed])).toEqual([["t_kind_values", "modified", ["c"], ["b"]]]);
  });

  it("reports a value list added to or removed from an existing column", () => {
    const added = diff(`CREATE TABLE t (kind text);`, `CREATE TABLE t (kind text CHECK (kind IN ('a', 'b')));`);
    expect(added.values.map((v) => [v.status, v.added])).toEqual([["added", ["a", "b"]]]);
    const removed = diff(`CREATE TABLE t (kind text CHECK (kind IN ('a', 'b')));`, `CREATE TABLE t (kind text);`);
    expect(removed.values.map((v) => [v.status, v.removed])).toEqual([["removed", ["a", "b"]]]);
  });

  it("does not count a new column's CHECK as a value change", () => {
    const d = diff(`CREATE TABLE t (id int);`, `CREATE TABLE t (id int, kind text CHECK (kind IN ('a')));`);
    expect(d.values).toEqual([]);
  });

  it("reports enum type values with the columns that use the type", () => {
    const d = diff(
      `CREATE TYPE billing.mood AS ENUM ('sad', 'ok'); CREATE TABLE billing.t (m billing.mood);`,
      `CREATE TYPE billing.mood AS ENUM ('ok', 'happy'); CREATE TABLE billing.t (m billing.mood);`,
    );
    expect(d.values).toEqual([
      {
        source: "enum",
        type: "billing.mood",
        usedBy: ["billing.t.m"],
        status: "modified",
        added: ["happy"],
        removed: ["sad"],
        before: ["sad", "ok"],
        after: ["ok", "happy"],
      },
    ]);
    expect(d.enums.map((e) => [e.name, e.status])).toEqual([["billing.mood", "modified"]]);
  });

  it("reports domain CHECK values", () => {
    const d = diff(`CREATE DOMAIN size AS text CHECK (VALUE IN ('s'));`, `CREATE DOMAIN size AS text CHECK (VALUE IN ('s', 'm'));`);
    expect(d.values.map((v) => [v.source, v.type, v.added])).toEqual([["domain", "public.size", ["m"]]]);
  });

  it("leaves out tables of a file that failed to parse on one side", () => {
    const d = diff([`CREATE TABLE a (id int);`, `CREATE TABLE b (id int);`], [`CREATE TABLE a (id int, x int);`, `CREATE TABLE b (id int`]);
    expect(d.tables.map((t) => [t.name, t.status])).toEqual([["public.a", "modified"]]);
  });

  it("reports comment changes", () => {
    const d = diff(`CREATE TABLE t (a int); COMMENT ON COLUMN t.a IS 'old';`, `CREATE TABLE t (a int); COMMENT ON COLUMN t.a IS 'new';`);
    expect(d.tables[0].columns.map((c) => [c.name, c.changed])).toEqual([["a", ["comment"]]]);
  });
});
