import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareRange, type ResolvedSources } from "@diffshape/core";
import { dbAnalyzer } from "@diffshape/dbshape";
import { depAnalyzer } from "@diffshape/depshape";
import { fileAnalyzer } from "@diffshape/fileshape";
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
  writeFileSync(join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("App", () => {
  it("runs every module on one comparison, and keeps a module's error to itself", async () => {
    const app = new App(repo, {}, [fileAnalyzer, depAnalyzer, dbAnalyzer()]);
    const info = await app.refresh();
    expect(info.modules).toEqual(["file", "dep", "db"]);
    expect(info.targetLabel).toBe("作業ディレクトリ（未コミットの変更を含む）");
    const dep = await app.result("dep");
    expect("data" in dep && (dep.data as { files: unknown[] }).files.length).toBe(3);
    // the untracked files, as in the other modules
    const file = await app.result("file");
    expect("data" in file && (file.data as { files: { path: string }[] }).files.map((f) => f.path)).toEqual(["app/handler/b.go", "app/usecase/u.go", "logo.png"]);
    // this repository has no SQL files
    const db = await app.result("db");
    expect("error" in db && db.error).toMatch(/SQL ファイルが見つかりません/);
  });

  it("gives the run an id with --clean, so the screen clears this comparison once", async () => {
    expect((await new App(repo, {}, [fileAnalyzer]).refresh()).clean).toBeNull();
    const app = new App(repo, {}, [fileAnalyzer], { clean: true });
    const { clean } = await app.refresh();
    expect(clean).toMatch(/^[0-9a-z]+$/);
    // the same id on every ask of this run, a reload included
    expect((await app.refresh()).clean).toBe(clean);
    expect((await new App(repo, {}, [fileAnalyzer], { clean: true }).refresh()).clean).not.toBe(clean);
  });

  it("throws for a comparison that can not be resolved", async () => {
    await expect(new App(repo, { target: "no-such-rev" }, [depAnalyzer]).refresh()).rejects.toThrow();
  });
});

describe("server", () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    const app = new App(repo, {}, [fileAnalyzer, depAnalyzer, dbAnalyzer()]);
    await app.refresh();
    ({ server, url } = await startServer(app, "127.0.0.1", 49777));
  });
  afterAll(() => server.close());

  it("answers the comparison and each module", async () => {
    const info = await (await fetch(`${url}/api/info`)).json();
    expect(info.modules).toEqual(["file", "dep", "db"]);
    expect(Object.keys(await (await fetch(`${url}/api/module/dep`)).json())).toEqual(["data"]);
    expect(Object.keys(await (await fetch(`${url}/api/module/db`)).json())).toEqual(["error"]);
    expect((await fetch(`${url}/api/info?refresh=1`)).status).toBe(200);
  });

  it("serves a module's own endpoints: the content of a repository file, and images only", async () => {
    const res = await fetch(`${url}/api/module/file/content?path=app/handler/b.go&side=new`);
    expect(await res.json()).toEqual({ lines: ["package handler", "", 'import "example.com/app/usecase"'] });
    // an unchanged file of the repository is served too (the tree's "全体" view)
    expect((await fetch(`${url}/api/module/file/content?path=go.mod&side=new`)).status).toBe(200);
    // not in the repository, outside it, or not on that side
    expect((await fetch(`${url}/api/module/file/content?path=nope.go&side=new`)).status).toBe(404);
    expect((await fetch(`${url}/api/module/file/content?path=../x&side=new`)).status).toBe(400);
    expect((await fetch(`${url}/api/module/file/content?path=app/handler/b.go&side=old`)).status).toBe(404);
    const png = await fetch(`${url}/api/module/file/raw?path=logo.png&side=new`);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await png.arrayBuffer())).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect((await fetch(`${url}/api/module/file/raw?path=go.mod&side=new`)).status).toBe(400);
    expect((await fetch(`${url}/api/module/nope/x`)).status).toBe(404);
  });
});

describe("parseArgs", () => {
  it("reads the comparison and options", () => {
    const a = parseArgs([".", "main", "--merge-base", "--schema", "db/*.sql", "--only", "db", "--no-open"], "diffshape");
    expect(a).toMatchObject({ target: ".", base: "main", mergeBase: true, schema: ["db/*.sql"], only: "db", open: false });
    expect(a.clean).toBe(false);
    expect(parseArgs(["--clean"], "diffshape").clean).toBe(true);
    expect(parseArgs(["--clean", "--json"], "fileshape")).toMatchObject({ clean: true, json: true });
  });

  it("fixes the module for fileshape / depshape / dbshape and keeps their output options", () => {
    expect(parseArgs(["--json"], "fileshape")).toMatchObject({ only: "file", json: true });
    expect(parseArgs(["--only", "file"], "diffshape")).toMatchObject({ only: "file" });
    expect(() => parseArgs(["--schema", "x"], "fileshape")).toThrow(/不明なオプション/);
    expect(() => parseArgs(["--text"], "fileshape")).toThrow(/不明なオプション/);
    expect(parseArgs(["--json"], "depshape")).toMatchObject({ only: "dep", json: true });
    expect(parseArgs(["--text", "--no-color"], "dbshape")).toMatchObject({ only: "db", text: true, color: false });
    expect(() => parseArgs(["--json"], "diffshape")).toThrow(/不明なオプション/);
    expect(() => parseArgs(["--schema", "x"], "depshape")).toThrow(/不明なオプション/);
    expect(() => parseArgs(["--only", "x"], "diffshape")).toThrow(/file \/ dep \/ db/);
    expect(() => parseArgs([".", "main", "x"], "diffshape")).toThrow(/多すぎます/);
  });
});

describe("compareRange", () => {
  const A = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
  const B = "5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80";
  const sources = (target: ResolvedSources["target"], base: ResolvedSources["base"]): ResolvedSources => ({ root: "/r", target, base, targetLabel: "t", baseLabel: "b" });

  it("names a comparison of commits as a git range, with the commits compared", () => {
    expect(compareRange({ target: "feature", base: "main" }, sources({ kind: "rev", rev: B }, { kind: "rev", rev: A }))).toBe("diff main..feature (1a2b3c4..5d6e7f8)");
    expect(compareRange({ target: "feature", base: "main", mergeBase: true }, sources({ kind: "rev", rev: B }, { kind: "rev", rev: A }))).toBe("diff main...feature (1a2b3c4..5d6e7f8)");
    // one commit against its parent
    expect(compareRange({ target: "@" }, sources({ kind: "rev", rev: B }, { kind: "rev", rev: A }))).toBe("diff HEAD^..HEAD (1a2b3c4..5d6e7f8)");
    // the names are the commits already
    expect(compareRange({ target: "5d6e7f8", base: "1a2b3c4" }, sources({ kind: "rev", rev: B }, { kind: "rev", rev: A }))).toBe("diff 1a2b3c4..5d6e7f8");
  });

  it("has no range for the working tree or the staged state", () => {
    expect(compareRange({ target: "." }, sources({ kind: "worktree" }, { kind: "rev", rev: A }))).toBeNull();
    expect(compareRange({ target: "staged" }, sources({ kind: "index" }, { kind: "rev", rev: A }))).toBeNull();
    expect(compareRange({ target: "working" }, sources({ kind: "worktree" }, { kind: "index" }))).toBeNull();
  });
});
