import { beforeAll, describe, expect, it } from "vitest";
import { parser } from "../src/analyze.js";
import { buildSchema, type Parser, type Schema } from "../src/schema.js";

let parse: Parser;
beforeAll(async () => {
  parse = await parser();
});

const build = (...sql: string[]): Schema => buildSchema(sql.map((s, i) => ({ path: `db/${i}.sql`, sql: s })), parse);

describe("tables", () => {
  it("reads columns with types, NOT NULL, defaults and identity", () => {
    const s = build(`
      CREATE TABLE billing.invoices (
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        amount numeric(12,2) NOT NULL DEFAULT 0,
        status character varying DEFAULT 'draft'::character varying NOT NULL,
        tags text[],
        seq int GENERATED ALWAYS AS IDENTITY,
        issued_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
      );`);
    const t = s.tables.get("billing.invoices")!;
    expect(t.columns.map((c) => c.view)).toEqual([
      { name: "id", type: "uuid", notNull: true, default: "gen_random_uuid()" },
      { name: "amount", type: "numeric(12,2)", notNull: true, default: "0" },
      { name: "status", type: "varchar", notNull: true, default: "'draft'::varchar" },
      { name: "tags", type: "text[]", notNull: false },
      { name: "seq", type: "integer", notNull: false, identity: "always" },
      { name: "issued_at", type: "timestamptz", notNull: false, default: "CURRENT_TIMESTAMP" },
    ]);
  });

  it("uses the search_path for unqualified names", () => {
    const s = build(`SET search_path TO billing; CREATE TABLE prices (id int);`, `CREATE TABLE notes (id int);`);
    expect([...s.tables.keys()]).toEqual(["billing.prices", "public.notes"]);
  });

  it("gives unnamed constraints PostgreSQL's default names", () => {
    const s = build(`
      CREATE TABLE billing.invoices (
        id uuid PRIMARY KEY,
        code text UNIQUE,
        price_id uuid REFERENCES billing.prices (id) ON DELETE CASCADE,
        kind text CHECK (kind IN ('a', 'b')),
        total int,
        CHECK (total > 0),
        UNIQUE (price_id, kind)
      );`);
    expect(s.tables.get("billing.invoices")!.constraints.map((c) => [c.view.name, c.view.definition])).toEqual([
      ["invoices_pkey", "PRIMARY KEY (id)"],
      ["invoices_code_key", "UNIQUE (code)"],
      ["invoices_price_id_fkey", "FOREIGN KEY (price_id) REFERENCES billing.prices (id) ON DELETE CASCADE"],
      ["invoices_kind_check", "CHECK (kind IN ('a', 'b'))"],
      ["invoices_total_check", "CHECK (total > 0)"],
      ["invoices_price_id_kind_key", "UNIQUE (price_id, kind)"],
    ]);
  });

  it("applies pg_dump style ALTER TABLE ONLY ... ADD CONSTRAINT", () => {
    const s = build(`
      CREATE TABLE IF NOT EXISTS "billing"."invoices" ("id" uuid NOT NULL, "price_id" uuid);
      ALTER TABLE ONLY "billing"."invoices" ADD CONSTRAINT "invoices_pkey" PRIMARY KEY ("id");
      ALTER TABLE ONLY "billing"."invoices"
        ADD CONSTRAINT "invoices_price_fk" FOREIGN KEY ("price_id") REFERENCES "billing"."prices"("id");`);
    const cs = s.tables.get("billing.invoices")!.constraints.map((c) => c.view);
    expect(cs.map((c) => c.name)).toEqual(["invoices_pkey", "invoices_price_fk"]);
    expect(cs[1].references).toEqual({ table: "billing.prices", columns: ["id"] });
  });

  it("applies column changes and drops what depends on a dropped column", () => {
    const s = build(`
      CREATE TABLE t (a int, b text, c text);
      CREATE INDEX t_b_idx ON t (b);
      ALTER TABLE t ADD CONSTRAINT t_b_check CHECK (b <> '');
      ALTER TABLE t ALTER COLUMN a TYPE bigint, ALTER COLUMN a SET NOT NULL, ALTER COLUMN c SET DEFAULT 'x';
      ALTER TABLE t DROP COLUMN b, ADD COLUMN d boolean;
      ALTER TABLE t RENAME COLUMN c TO e;`);
    const t = s.tables.get("public.t")!;
    expect(t.columns.map((c) => c.view)).toEqual([
      { name: "a", type: "bigint", notNull: true },
      { name: "e", type: "text", notNull: false, default: "'x'" },
      { name: "d", type: "boolean", notNull: false },
    ]);
    expect(t.constraints).toEqual([]);
    expect(t.indexes).toEqual([]);
  });

  it("reads indexes", () => {
    const s = build(`
      CREATE TABLE t (a int, b text, c text);
      CREATE UNIQUE INDEX t_ab ON t USING btree (a, b DESC) WHERE (c IS NOT NULL);
      CREATE INDEX ON t USING gin (lower(b));`);
    expect(s.tables.get("public.t")!.indexes.map((i) => i.view)).toEqual([
      { name: "t_ab", unique: true, columns: ["a", "b DESC"], where: "c IS NOT NULL" },
      { name: "t_lower_b__idx", unique: false, method: "gin", columns: ["lower(b)"] },
    ]);
  });

  it("reads table and column comments", () => {
    const s = build(`CREATE TABLE t (a int); COMMENT ON TABLE t IS 'things'; COMMENT ON COLUMN t.a IS 'count';`);
    const t = s.tables.get("public.t")!;
    expect(t.comment).toBe("things");
    expect(t.columns[0].view.comment).toBe("count");
  });
});

describe("types, errors and ignored statements", () => {
  it("reads enum types and their changes", () => {
    const s = build(`
      CREATE TYPE billing.mood AS ENUM ('sad', 'ok');
      ALTER TYPE billing.mood ADD VALUE 'happy';
      ALTER TYPE billing.mood ADD VALUE 'meh' BEFORE 'ok';
      ALTER TYPE billing.mood RENAME VALUE 'sad' TO 'blue';`);
    expect(s.enums.get("billing.mood")!.view.values).toEqual(["blue", "meh", "ok", "happy"]);
  });

  it("reads domains with their CHECK values", () => {
    const s = build(`CREATE DOMAIN billing.size AS text NOT NULL CHECK (VALUE IN ('s', 'm'));`);
    const d = s.domains.get("billing.size")!.view;
    expect(d.type).toBe("text");
    expect(d.notNull).toBe(true);
    expect(d.checks[0].values).toEqual({ column: "value", values: ["s", "m"] });
  });

  it("records a file that fails to parse and keeps reading the others", () => {
    const s = build(`CREATE TABLE ok_table (a int);`, `CREATE TABLE broken (a int`);
    expect([...s.tables.keys()]).toEqual(["public.ok_table"]);
    expect([...s.errors.keys()]).toEqual(["db/1.sql"]);
  });

  it("counts statements it does not compare", () => {
    const s = build(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE t (a int);
      CREATE VIEW v AS SELECT a FROM t;
      GRANT SELECT ON t TO reader;
      ALTER TABLE t OWNER TO admin;`);
    expect(Object.fromEntries(s.ignored)).toEqual({ CreateExtension: 1, View: 1, Grant: 1, "ALTER TABLE ChangeOwner": 1 });
  });
});
