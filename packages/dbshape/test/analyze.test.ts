import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze.js";
import { formatSummary } from "../src/format.js";

let repo: string;

function write(path: string, content: string) {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
}

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "dbshape-test-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  write("db/atlas.hcl", `env "local" {\n  src = ["file://sql/billing.sql", "file://sql/catalog/"]\n}\n`);
  write("db/sql/billing.sql", `CREATE TABLE billing.invoices (id uuid PRIMARY KEY, status text CHECK (status IN ('open', 'paid')));\n`);
  write("db/sql/catalog/products.sql", `CREATE TABLE catalog.products (id uuid PRIMARY KEY);\n`);
  write("db/sql/catalog/notes.md", `not sql\n`);
  git("add", ".");
  git("commit", "-q", "-m", "base");
  // working tree changes
  write("db/sql/billing.sql", `CREATE TABLE billing.invoices (id uuid PRIMARY KEY, status text CHECK (status IN ('open', 'paid', 'void')), product_id uuid REFERENCES catalog.products (id));\n`);
  write("db/sql/catalog/prices.sql", `CREATE TABLE catalog.prices (id uuid PRIMARY KEY);\n`);
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("analyze", () => {
  it("compares the working tree with HEAD using atlas.hcl", async () => {
    const r = await analyze(repo, {});
    expect(r.schemaFrom).toEqual({ kind: "atlas", configs: ["db/atlas.hcl"] });
    expect(r.target.files).toEqual(["db/sql/billing.sql", "db/sql/catalog/prices.sql", "db/sql/catalog/products.sql"]);
    expect(r.base.files).toEqual(["db/sql/billing.sql", "db/sql/catalog/products.sql"]);
    expect(r.diff.tables.map((t) => [t.name, t.status])).toEqual([
      ["billing.invoices", "modified"],
      ["catalog.prices", "added"],
    ]);
    expect(r.diff.values.map((v) => [v.table, v.column, v.added])).toEqual([["billing.invoices", "status", ["void"]]]);
    expect(r.diff.unchangedTables).toBe(1);
    expect(r.warnings).toEqual([]);

    const text = formatSummary(r);
    expect(text).toContain("+ catalog.prices");
    expect(text).toContain("+ invoices_product_id_fkey  FOREIGN KEY (product_id) REFERENCES catalog.products (id)");
    expect(text).toContain("billing.invoices.status  +'void'");
  });

  it("takes --schema globs instead of atlas.hcl", async () => {
    const r = await analyze(repo, { schema: ["db/sql/catalog/*.sql"] });
    expect(r.schemaFrom).toEqual({ kind: "option", patterns: ["db/sql/catalog/*.sql"] });
    expect(r.diff.tables.map((t) => t.name)).toEqual(["catalog.prices"]);
  });

  it("says what to do when no schema file is found", async () => {
    await expect(analyze(repo, { schema: ["nothing/*.sql"] })).rejects.toThrow("--schema に一致する SQL ファイルがありません");
  });
});
