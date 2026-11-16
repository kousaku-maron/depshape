import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbAnalyzer } from "@diffshape/dbshape";
import { depAnalyzer } from "@diffshape/depshape";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { parseArgs } from "../src/cli.js";
import { startServer } from "../src/server.js";

let repo: string;

function write(path: string, content: string) {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
}

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "diffshape-test-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  write("go.mod", "module example.com/app\n");
  write("app/handler/a.go", "package handler\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  write("app/handler/b.go", 'package handler\n\nimport "example.com/app/usecase"\n');
  write("app/usecase/u.go", "package usecase\n");
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("App", () => {
  it("runs every module on one comparison, and keeps a module's error to itself", async () => {
    const app = new App(repo, {}, [depAnalyzer, dbAnalyzer()]);
    const info = await app.refresh();
    expect(info.modules).toEqual(["dep", "db"]);
    expect(info.targetLabel).toBe("作業ディレクトリ（未コミットの変更を含む）");
    const dep = await app.result("dep");
    expect("data" in dep && (dep.data as { files: unknown[] }).files.length).toBe(3);
    // this repository has no SQL files
    const db = await app.result("db");
    expect("error" in db && db.error).toMatch(/SQL ファイルが見つかりません/);
  });

  it("throws for a comparison that can not be resolved", async () => {
    await expect(new App(repo, { target: "no-such-rev" }, [depAnalyzer]).refresh()).rejects.toThrow();
  });
});

describe("server", () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    const app = new App(repo, {}, [depAnalyzer, dbAnalyzer()]);
    await app.refresh();
    ({ server, url } = await startServer(app, "127.0.0.1", 49777));
  });
  afterAll(() => server.close());

  it("answers the comparison and each module", async () => {
    const info = await (await fetch(`${url}/api/info`)).json();
    expect(info.modules).toEqual(["dep", "db"]);
    expect(Object.keys(await (await fetch(`${url}/api/module/dep`)).json())).toEqual(["data"]);
    expect(Object.keys(await (await fetch(`${url}/api/module/db`)).json())).toEqual(["error"]);
    expect((await fetch(`${url}/api/info?refresh=1`)).status).toBe(200);
  });
});

describe("parseArgs", () => {
  it("reads the comparison and options", () => {
    const a = parseArgs([".", "main", "--merge-base", "--schema", "db/*.sql", "--only", "db", "--no-open"], "diffshape");
    expect(a).toMatchObject({ target: ".", base: "main", mergeBase: true, schema: ["db/*.sql"], only: "db", open: false });
  });

  it("fixes the module for depshape / dbshape and keeps their output options", () => {
    expect(parseArgs(["--json"], "depshape")).toMatchObject({ only: "dep", json: true });
    expect(parseArgs(["--text", "--no-color"], "dbshape")).toMatchObject({ only: "db", text: true, color: false });
    expect(() => parseArgs(["--json"], "diffshape")).toThrow(/不明なオプション/);
    expect(() => parseArgs(["--schema", "x"], "depshape")).toThrow(/不明なオプション/);
    expect(() => parseArgs(["--only", "x"], "diffshape")).toThrow(/dep か db/);
    expect(() => parseArgs([".", "main", "x"], "diffshape")).toThrow(/多すぎます/);
  });
});
