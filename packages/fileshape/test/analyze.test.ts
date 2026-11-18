import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSources } from "@diffshape/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeFiles } from "../src/analyze.js";
import { fileApi } from "../src/api.js";
import type { DiffFile } from "../src/types.js";

let repo: string;

function write(path: string, content: string | Buffer) {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
}

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });

const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "fileshape-test-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  // settings that would change git diff's output if the analyzer did not fix them
  git("config", "diff.noprefix", "true");
  git("config", "color.diff", "always");
  write("src/a.ts", lines(20, (i) => `export const a${i} = ${i};`));
  write("src/old-name.ts", lines(10, (i) => `line ${i}`));
  write("src/gone.ts", "bye\n");
  write("run.sh", "echo hi\n");
  write("pnpm-lock.yaml", "lockfileVersion: 9\n");
  write("img.bin", Buffer.from([0, 1, 2, 3]));
  write("日本語 ファイル.md", "# あ\n");
  // never changed: only the tree's "全体" view shows them
  write("src/same.ts", "same 1\r\nsame 2\n");
  write("assets/same.bin", Buffer.from([0, 9]));
  git("add", ".");
  git("commit", "-q", "-m", "base");

  write("src/a.ts", lines(20, (i) => (i === 10 ? "export const a10 = 100;" : `export const a${i} = ${i};`)) + "export const a21 = 21;\n");
  git("mv", "src/old-name.ts", "src/new-name.ts");
  git("rm", "-q", "src/gone.ts");
  chmodSync(join(repo, "run.sh"), 0o755);
  write("pnpm-lock.yaml", "lockfileVersion: 9\npackages: {}\n");
  write("img.bin", Buffer.from([0, 1, 2, 4]));
  write("日本語 ファイル.md", "# あ\n\nい\n");
  write("src/new.ts", "export const n = 1;\r\nexport const m = 2;\r\n");
  write("notes/empty.txt", "");
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

async function run(target?: string, base?: string) {
  const r = await analyzeFiles(await resolveSources(repo, { target, base }));
  return { run: r, byPath: new Map<string, DiffFile>(r.files.map((f) => [f.path, f])) };
}

describe("analyzeFiles", () => {
  it("reads every change of the working tree, untracked files included", async () => {
    const { run: r, byPath } = await run();
    expect(r.files.map((f) => f.path)).toEqual(["img.bin", "notes/empty.txt", "pnpm-lock.yaml", "run.sh", "src/a.ts", "src/gone.ts", "src/new-name.ts", "src/new.ts", "日本語 ファイル.md"]);

    const a = byPath.get("src/a.ts")!;
    expect(a).toMatchObject({ status: "modified", additions: 2, deletions: 1 });
    const changed = a.chunks.flatMap((c) => c.lines).filter((l) => l.type !== "normal");
    expect(changed).toEqual([
      { type: "delete", content: "export const a10 = 10;", oldLine: 10 },
      { type: "add", content: "export const a10 = 100;", newLine: 10 },
      { type: "add", content: "export const a21 = 21;", newLine: 21 },
    ]);
    const ctx = a.chunks[0].lines.find((l) => l.type === "normal")!;
    expect(ctx.oldLine).toBe(ctx.newLine);

    expect(byPath.get("src/new-name.ts")).toMatchObject({ status: "renamed", oldPath: "src/old-name.ts", additions: 0, deletions: 0 });
    expect(byPath.get("src/gone.ts")).toMatchObject({ status: "removed", deletions: 1 });
    expect(byPath.get("run.sh")).toMatchObject({ status: "modified", modeChange: "100644 → 100755", chunks: [] });
    expect(byPath.get("img.bin")).toMatchObject({ status: "modified", binary: true, chunks: [] });
    expect(byPath.get("pnpm-lock.yaml")?.generated).toBe(true);
    expect(byPath.get("src/a.ts")?.generated).toBeUndefined();
    expect(byPath.get("日本語 ファイル.md")).toMatchObject({ status: "modified", additions: 2 });
  });

  it("shows untracked files as added, without carriage returns", async () => {
    const { byPath } = await run();
    const n = byPath.get("src/new.ts")!;
    expect(n).toMatchObject({ status: "added", additions: 2, deletions: 0 });
    expect(n.chunks[0].lines).toEqual([
      { type: "add", content: "export const n = 1;", newLine: 1 },
      { type: "add", content: "export const m = 2;", newLine: 2 },
    ]);
    expect(byPath.get("notes/empty.txt")).toMatchObject({ status: "added", chunks: [] });
  });

  it("leaves untracked files out of the staged changes", async () => {
    const { byPath } = await run("staged");
    expect(byPath.has("src/new.ts")).toBe(false);
    expect(byPath.has("src/a.ts")).toBe(false); // not staged
    expect(byPath.get("src/new-name.ts")?.status).toBe("renamed");
  });

  it("compares two commits", async () => {
    git("add", "-A");
    git("commit", "-q", "-m", "change");
    const { run: r, byPath } = await run("HEAD");
    expect(r.baseLabel).toBe("HEAD^");
    expect(byPath.get("src/new.ts")?.status).toBe("added");
    expect(byPath.get("src/gone.ts")?.status).toBe("removed");
    // nothing left uncommitted
    expect((await run()).run.files).toEqual([]);
  });
});

describe("the whole tree (fileApi)", () => {
  const call = async (name: "files" | "plain" | "content", query: string) => {
    const sources = await resolveSources(repo, {});
    const data = await analyzeFiles(sources);
    return fileApi[name](new URL(`http://x/?${query}`), { sources, data }) as Promise<any>;
  };

  it("lists every file of the target side, unchanged and untracked ones included", async () => {
    const { paths } = await call("files", "");
    expect(paths).toEqual(expect.arrayContaining(["assets/same.bin", "src/same.ts", "src/a.ts", "src/new.ts", "notes/empty.txt"]));
    expect(paths).not.toContain("src/gone.ts");
    expect(paths).not.toContain("src/old-name.ts");
  });

  it("reads an unchanged file, and tells a binary one apart", async () => {
    expect(await call("plain", "path=src/same.ts")).toEqual({ lines: ["same 1", "same 2"] });
    expect(await call("plain", "path=assets/same.bin")).toEqual({ binary: true });
    // the content endpoint serves it too (the Markdown preview reads files through it)
    expect(await call("content", "path=src/same.ts&side=new")).toEqual({ lines: ["same 1", "same 2"] });
  });

  it("serves nothing outside the repository's files", async () => {
    await expect(call("plain", "path=src/gone.ts")).rejects.toMatchObject({ status: 404 });
    await expect(call("plain", "path=.git/config")).rejects.toMatchObject({ status: 404 });
    await expect(call("plain", "path=../etc/passwd")).rejects.toMatchObject({ status: 400 });
  });
});
