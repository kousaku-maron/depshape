import { describe, expect, it } from "vitest";
import { atlasConfigs, atlasDatabases, atlasEnvs, atlasSources, expandSource, globRegex, matchGlobs, schemaPatterns } from "../src/sources.js";

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

  it("reads the src of each env", () => {
    const hcl = `
      src = ["file://shared.sql"]
      env "app" {
        src = ["file://app/"]
        migration { dir = "file://migrations/app" }
      }
      # env "old" { src = ["file://old.sql"] }
      env "analytics" { src = "file://analytics.sql" }`;
    expect(atlasEnvs("db/atlas.hcl", hcl)).toEqual([
      { name: "", sources: ["db/shared.sql"] },
      { name: "app", sources: ["db/app"] },
      { name: "analytics", sources: ["db/analytics.sql"] },
    ]);
  });

  it("treats envs that share schema files as one database", () => {
    const files = ["db/app/a.sql", "db/app/b.sql", "db/analytics.sql"];
    const hcl = `
      env "local" { src = ["file://app/"] }
      env "prod" { src = ["file://app/a.sql"] }
      env "analytics" { src = ["file://analytics.sql"] }`;
    expect(atlasDatabases("db/atlas.hcl", hcl, files)).toEqual([
      { envs: ["local", "prod"], files: ["db/app/a.sql", "db/app/b.sql"] },
      { envs: ["analytics"], files: ["db/analytics.sql"] },
    ]);
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

describe("--schema", () => {
  it("groups name=glob patterns by name, plain globs go to one unnamed database", () => {
    expect([...schemaPatterns(["billing=db/b/*.sql", "db/x.sql", "billing=db/b2.sql"])]).toEqual([
      ["billing", ["db/b/*.sql", "db/b2.sql"]],
      ["", ["db/x.sql"]],
    ]);
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
