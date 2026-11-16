import { describe, expect, it } from "vitest";
import { atlasConfigs, atlasSources, expandSource, globRegex, matchGlobs } from "../src/sources.js";

describe("atlas.hcl", () => {
  it("reads the file:// paths of src, relative to the config", () => {
    const hcl = `
      # src = ["file://old.sql"]
      env "local" {
        src = [
          "file://sql/billing.sql",
          "file://sql/catalog/", // a folder
        ]
        dev = "docker://postgres/15/dev"
        migration { dir = "file://migrations" }
      }
      env "ci" {
        src = "file://sql/billing.sql"
      }`;
    expect(atlasSources("db/atlas.hcl", hcl)).toEqual(["db/sql/billing.sql", "db/sql/catalog"]);
    expect(atlasSources("atlas.hcl", `env { src = ["file://./schema.sql"] }`)).toEqual(["schema.sql"]);
  });

  it("finds atlas.hcl files outside node_modules and hidden folders", () => {
    expect(atlasConfigs(["db/atlas.hcl", "node_modules/x/atlas.hcl", ".cache/atlas.hcl", "atlas.hcl.bak"])).toEqual(["db/atlas.hcl"]);
  });

  it("expands a folder to the .sql files directly in it", () => {
    const files = ["db/s/b.sql", "db/s/a.sql", "db/s/sub/c.sql", "db/s/readme.md", "db/one.sql"];
    expect(expandSource("db/s", files)).toEqual(["db/s/a.sql", "db/s/b.sql"]);
    expect(expandSource("db/one.sql", files)).toEqual(["db/one.sql"]);
    expect(expandSource("db/missing", files)).toEqual([]);
  });
});

describe("globs", () => {
  it("matches *, ** and {a,b}", () => {
    expect(globRegex("db/**/*.sql").test("db/schema.sql")).toBe(true);
    expect(globRegex("db/**/*.sql").test("db/a/b/schema.sql")).toBe(true);
    expect(globRegex("db/*.sql").test("db/a/schema.sql")).toBe(false);
    expect(globRegex("db/{billing,catalog}.sql").test("db/catalog.sql")).toBe(true);
    expect(matchGlobs(["./db/*.sql"], ["db/b.sql", "db/a.sql", "other/c.sql"])).toEqual(["db/a.sql", "db/b.sql"]);
  });
});
