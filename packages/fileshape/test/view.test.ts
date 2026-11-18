import { describe, expect, it } from "vitest";
import { addedFile, parseUnifiedDiff } from "../src/diff.js";
import type { DiffFile, FileShapeRun } from "../src/types.js";
import { formatPrompt, locate, newComment } from "../ui/src/comments";
import { highlightFile, highlightLines, languageOf } from "../ui/src/highlight";
import { fileFor, placeItem, reviewSection } from "../ui/src/review";
import { reviewedFiles, reviewTargets } from "../ui/src/reviewed";
import { buildRows, buildTree, changedFolders, changeHash, unchangedFile, expand, filesInTreeOrder, filterTree, gapsOf, markRanges, oldToNew, pairLines, reveal, wordRanges, type Row } from "../ui/src/model";

const file = (path: string, extra: Partial<DiffFile> = {}): DiffFile => ({ path, status: "modified", additions: 0, deletions: 0, chunks: [], ...extra });

const diff = (body: string[]) => parseUnifiedDiff(["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", ...body, ""].join("\n"))[0];

describe("file tree", () => {
  const files = [file("src/app/a.ts"), file("src/app/b.ts"), file("README.md"), file("src/lib/deep/c.ts"), file("pkg/only/one.go")];

  it("joins folders with one child folder, and lists folders before files", () => {
    const tree = buildTree(files);
    expect(tree.children.map((c) => c.name)).toEqual(["pkg/only", "src", "README.md"]);
    const src = tree.children[1];
    expect(src.children.map((c) => c.name)).toEqual(["app", "lib/deep"]);
    expect(filesInTreeOrder(tree).map((f) => f.path)).toEqual(["pkg/only/one.go", "src/app/a.ts", "src/app/b.ts", "src/lib/deep/c.ts", "README.md"]);
  });

  it("adds the rest of the repository as plain files (the 全体 view)", () => {
    const tree = buildTree([file("src/app/a.ts")], ["src/app/a.ts", "src/app/z.ts", "src/lib/x.ts", "README.md"]);
    expect(tree.children.map((c) => [c.name, !!c.plain])).toEqual([
      ["src", false],
      ["README.md", true],
    ]);
    const app = tree.children[0].children[0];
    expect(app.children.map((c) => [c.name, !!c.file, !!c.plain])).toEqual([
      ["a.ts", true, false],
      ["z.ts", false, true],
    ]);
    // only the changes are in the list, and their folders open first
    expect(filesInTreeOrder(tree).map((f) => f.path)).toEqual(["src/app/a.ts"]);
    expect([...changedFolders(tree)].sort()).toEqual(["src", "src/app"]);
    expect(filesInTreeOrder(filterTree(tree, "lib/x")!)).toEqual([]);
    expect(filterTree(tree, "lib/x")!.children[0].children[0].children[0].path).toBe("src/lib/x.ts");
  });

  it("does not count an opened unchanged file as a change", () => {
    const tree = buildTree([unchangedFile("docs/a.md", { lines: ["x"] })], ["docs/a.md", "docs/b.md"]);
    expect(changedFolders(tree).size).toBe(0);
  });

  it("filters by path", () => {
    const shown = filterTree(buildTree(files), "APP/b");
    expect(filesInTreeOrder(shown!).map((f) => f.path)).toEqual(["src/app/b.ts"]);
    expect(filterTree(buildTree(files), "nothing")!.children).toEqual([]);
  });
});

describe("pairLines", () => {
  it("pairs each run of deleted lines with the added lines after it", () => {
    const f = diff(["@@ -1,4 +1,4 @@", " a", "-b", "-c", "+B", " d", "+e"]);
    expect(pairLines(f.chunks[0].lines).map((r) => [r.old?.content ?? null, r.new?.content ?? null])).toEqual([
      ["a", "a"],
      ["b", "B"],
      ["c", null],
      ["d", "d"],
      [null, "e"],
    ]);
  });
});

describe("changeHash", () => {
  it("changes only when the changed lines change", () => {
    const a = diff(["@@ -1,2 +1,2 @@", " ctx", "-x", "+y"]);
    const moved = diff(["@@ -10,2 +10,2 @@", " other", "-x", "+y"]);
    const again = diff(["@@ -1,2 +1,2 @@", " ctx", "-x", "+z"]);
    expect(changeHash(a)).toBe(changeHash(moved));
    expect(changeHash(a)).not.toBe(changeHash(again));
  });
});

describe("line comments", () => {
  const before = diff(["@@ -1,3 +1,3 @@", " keep", "-old()", "+fixMe()", " end"]);
  const run = (f: DiffFile): FileShapeRun => ({ repoRoot: "/repo", targetLabel: "作業ディレクトリ", baseLabel: "HEAD", files: [f] });

  it("stays on its line, follows the code when lines are added above, and notices a change", () => {
    const c = newComment({ path: "x.ts", side: "new", line: 2, code: "fixMe()" }, "名前を直して");
    expect(locate(before, c)).toEqual({ state: "open", line: 2 });
    const shifted = diff(["@@ -1,3 +1,5 @@", "+import a", "+import b", " keep", "-old()", "+fixMe()", " end"]);
    expect(locate(shifted, c)).toEqual({ state: "open", line: 4 });
    const changed = diff(["@@ -1,3 +1,3 @@", " keep", "-old()", "+fixedName()", " end"]);
    expect(locate(changed, c)).toEqual({ state: "updated", line: 2 });
    expect(locate(diff(["@@ -5,1 +5,1 @@", "-p", "+q"]), c)).toEqual({ state: "resolved" });
    expect(locate(undefined, c)).toEqual({ state: "resolved" });
  });

  it("points at the base side with (old)", () => {
    const c = newComment({ path: "x.ts", side: "old", line: 2, code: "old()" }, "消して大丈夫？");
    expect(locate(before, c)).toEqual({ state: "open", line: 2 });
    const { text, included } = formatPrompt(run(before), [c], { header: false });
    expect(included).toBe(1);
    expect(text).toBe("1. x.ts:L2 (old)（変更前の 2 行目）\n   コード: old()\n   コメント: 消して大丈夫？\n");
  });

  it("copies open comments with the header, and leaves resolved ones out", () => {
    const open = newComment({ path: "x.ts", side: "new", line: 2, code: "fixMe()" }, "一行目\n二行目");
    const gone = newComment({ path: "y.ts", side: "new", line: 1, code: "z" }, "消えた");
    const { text, included } = formatPrompt(run(before), [open, gone]);
    expect(included).toBe(1);
    expect(text).toContain("対象: ファイルの差分（fileshape）");
    expect(text).toContain("1. x.ts:L2（変更後の 2 行目）\n   コード: fixMe()\n   コメント: 一行目\n   二行目");
    expect(text).not.toContain("消えた");
  });
});

describe("highlight", () => {
  it("picks a language from the file name", () => {
    expect(languageOf("src/a.tsx")).toBe("tsx");
    expect(languageOf("cmd/main.go")).toBe("go");
    expect(languageOf("Dockerfile.dev")).toBe("docker");
    expect(languageOf("LICENSE")).toBeUndefined();
  });

  it("keeps a comment over several lines right, and cuts tokens back into lines", () => {
    const lines = highlightLines(["/* a", "b */ const x = 1;"], "typescript");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual([{ types: "comment", text: "/* a" }]);
    expect(lines[1][0]).toEqual({ types: "comment", text: "b */" });
    expect(lines[1].find((t) => t.text === "const")?.types).toBe("keyword");
    expect(lines[1].map((t) => t.text).join("")).toBe("b */ const x = 1;");
  });

  it("gives tokens per side and line, and none for very large files", () => {
    const f = diff(["@@ -1,2 +1,2 @@", " const a = 1;", "-let b = 2;", "+var b = 3;"]);
    const t = highlightFile(f)!;
    expect(t.get("old:2")?.[0]).toEqual({ types: "keyword", text: "let" });
    expect(t.get("new:2")?.[0]).toEqual({ types: "keyword", text: "var" });
    expect(t.get("new:1")).toEqual(t.get("old:1"));
    const big = addedFile("big.ts", "x\n".repeat(6000));
    expect(highlightFile(big)).toBeUndefined();
  });
});

// a file of 30 lines where line 10 and line 25 changed
const content = Array.from({ length: 30 }, (_, i) => (i + 1 === 10 ? "TEN" : i + 1 === 25 ? "TWENTY-FIVE" : `line ${i + 1}`));
const twoHunks = () =>
  diff([
    "@@ -7,7 +7,7 @@",
    " line 7",
    " line 8",
    " line 9",
    "-line 10",
    "+TEN",
    " line 11",
    " line 12",
    " line 13",
    "@@ -22,7 +22,7 @@ function g() {",
    " line 22",
    " line 23",
    " line 24",
    "-line 25",
    "+TWENTY-FIVE",
    " line 26",
    " line 27",
    " line 28",
  ]);

const shape = (rows: Row[]) => rows.map((r) => (r.kind === "gap" ? `gap${r.gap.index}:${r.hidden ?? "?"}` : `${r.opened ? "o" : r.line.type[0]}${r.line.newLine ?? ""}/${r.line.oldLine ?? ""}`));

describe("lines around the hunks", () => {
  it("finds the gaps before, between and after the hunks", () => {
    const gaps = gapsOf(twoHunks(), 30);
    expect(gaps.map((g) => [g.from, g.to, g.delta])).toEqual([
      [1, 6, 0],
      [14, 21, 0],
      [29, 30, 0],
    ]);
    expect(gapsOf(twoHunks())[2].to).toBeUndefined();
    expect(gapsOf(addedFile("a.ts", "x\n"))).toEqual([]);
  });

  it("keeps the base side's numbers when the sides differ in length", () => {
    // two lines added above: the base side is 2 lines behind after the hunk
    const f = diff(["@@ -1,3 +1,5 @@", "+a", "+b", " line 1", " line 2", " line 3"]);
    const [, after] = gapsOf(f, 10);
    expect([after.from, after.to, after.delta]).toEqual([6, 10, -2]);
    expect(oldToNew(f, 5)).toBe(7);
  });

  it("opens 20 lines at a time, and all of a small gap", () => {
    const f = twoHunks();
    expect(shape(buildRows(f, undefined, {})).filter((x) => x.startsWith("gap"))).toEqual(["gap0:6", "gap1:8", "gap2:?"]);
    const gaps = gapsOf(f, 30);
    let exp = expand({}, gaps[1], "down", 30);
    expect(exp[1]).toEqual({ top: 8, bottom: 0 });
    exp = expand(exp, gaps[0], "up", 30);
    exp = expand(exp, gaps[2], "down", 30);
    const rows = buildRows(f, content, exp);
    // every gap fully open: no gap row but the first hunk's header
    expect(shape(rows).filter((x) => x.startsWith("gap"))).toEqual(["gap0:0"]);
    expect(rows.filter((r) => r.kind === "line" && r.opened)).toHaveLength(6 + 8 + 2);
    const l14 = rows.find((r) => r.kind === "line" && r.opened && r.line.newLine === 14);
    expect(l14 && l14.kind === "line" && l14.line).toEqual({ type: "normal", content: "line 14", oldLine: 14, newLine: 14 });
  });

  it("opens from both ends of a gap", () => {
    const f = twoHunks();
    const g = gapsOf(f, 30)[1];
    const big = { ...g, to: 60 };
    let exp = expand({}, big, "down", 100);
    exp = expand(exp, big, "up", 100);
    expect(exp[1]).toEqual({ top: 20, bottom: 20 });
    expect(expand(exp, big, "up", 100)[1]).toEqual({ top: 20, bottom: 27 });
  });

  it("reveals the lines a comment points at", () => {
    const f = twoHunks();
    const exp = reveal(f, 30, {}, 17, 18);
    expect(exp[1].top).toBe(8);
    expect(reveal(f, 30, exp, 17, 18)).toBe(exp);
  });
});

describe("word-level changes", () => {
  it("marks the changed words of a paired line", () => {
    expect(wordRanges("const a = foo(1);", "const a = bar(1);")).toEqual({ old: [[10, 13]], new: [[10, 13]] });
    // too different: nothing marked
    expect(wordRanges("alpha beta", "gamma delta")).toBeUndefined();
    expect(wordRanges("same", "same")).toBeUndefined();
  });

  it("cuts syntax tokens at the marked ranges", () => {
    const tokens = [
      { types: "keyword", text: "const" },
      { types: "", text: " a = " },
      { types: "function", text: "foo" },
    ];
    expect(markRanges(tokens, [[4, 7]])).toEqual([
      { types: "keyword", text: "cons" },
      { types: "keyword", text: "t", mark: true },
      { types: "", text: " a", mark: true },
      { types: "", text: " = " },
      { types: "function", text: "foo" },
    ]);
  });
});

describe("range comments", () => {
  const f = twoHunks();
  const run = (x: DiffFile): FileShapeRun => ({ repoRoot: "/repo", targetLabel: "作業ディレクトリ", baseLabel: "HEAD", files: [x] });

  it("follows the same lines, and copies them as L-L with the code", () => {
    const c = newComment({ path: "x.ts", side: "new", line: 9, endLine: 11, code: "line 9\nTEN\nline 11" }, "まとめて見直して");
    expect(locate(f, c)).toEqual({ state: "open", line: 9, endLine: 11 });
    const shifted = diff(["@@ -1,3 +1,4 @@", "+new first", " line 1", " line 2", " line 3", "@@ -7,7 +8,7 @@", " line 7", " line 8", " line 9", "-line 10", "+TEN", " line 11", " line 12", " line 13"]);
    expect(locate(shifted, c)).toEqual({ state: "open", line: 10, endLine: 12 });
    const { text } = formatPrompt(run(f), [c], { header: false });
    expect(text).toBe("1. x.ts:L9-L11（変更後の 9〜11 行目）\n   コード:\n   ```\n   line 9\n   TEN\n   line 11\n   ```\n   コメント: まとめて見直して\n");
  });

  it("places a comment on an opened line once the file's content is loaded", () => {
    const c = newComment({ path: "x.ts", side: "new", line: 17, code: "line 17" }, "ここも");
    expect(locate(f, c)).toEqual({ state: "resolved" });
    expect(locate(f, c, content)).toEqual({ state: "open", line: 17 });
    const old = newComment({ path: "x.ts", side: "old", line: 17, code: "line 17" }, "変更前の行");
    expect(locate(f, old, content)).toEqual({ state: "open", line: 17 });
  });
});

describe("own word diff", () => {
  it("compares words of any script and joins neighbouring changes", () => {
    expect(wordRanges("名前を 直す", "名前を 変える")).toEqual({ old: [[4, 6]], new: [[4, 7]] });
    // "b c" replaced by "x y": one range, not three
    expect(wordRanges("a b c d", "a x y d")).toEqual({ old: [[2, 5]], new: [[2, 5]] });
    expect(wordRanges("return a + b;", "return a + b + c;")).toEqual({ old: [], new: [[12, 16]] });
  });
});

describe("reviewed marks", () => {
  it("keep a file reviewed until its change changes", () => {
    const before = diff(["@@ -1,1 +1,1 @@", "-a", "+b"]);
    const marks = { "x.ts": reviewTargets([before]).get("x.ts")! };
    expect(reviewedFiles(reviewTargets([before]), marks)).toEqual(new Set(["x.ts"]));
    const again = diff(["@@ -1,1 +1,1 @@", "-a", "+c"]);
    expect(reviewedFiles(reviewTargets([again]), marks)).toEqual(new Set());
  });
});

describe("unchanged files", () => {
  it("shows every line as context, with no hunk header", () => {
    const f = unchangedFile("a.ts", { lines: ["one", "two"] });
    expect(f.unchanged).toBe(true);
    expect(gapsOf(f, 2)).toEqual([]);
    expect(buildRows(f, undefined, {})).toEqual([
      { kind: "line", line: { type: "normal", content: "one", oldLine: 1, newLine: 1 } },
      { kind: "line", line: { type: "normal", content: "two", oldLine: 2, newLine: 2 } },
    ]);
  });

  it("knows a file still being read, a binary one, a large one and an empty one", () => {
    expect(unchangedFile("a", undefined)).toMatchObject({ loading: true, chunks: [] });
    expect(unchangedFile("a", { binary: true })).toMatchObject({ binary: true, chunks: [] });
    expect(unchangedFile("a", { large: true })).toMatchObject({ large: true, chunks: [] });
    expect(unchangedFile("a", { lines: [] })).toMatchObject({ chunks: [] });
  });

  it("places and copies a comment on one of its lines without a side", () => {
    const f = unchangedFile("a.ts", { lines: ["one", "two"] });
    const run: FileShapeRun = { repoRoot: "/r", targetLabel: "t", baseLabel: "b", files: [f] };
    const c = newComment({ path: "a.ts", side: "new", line: 2, code: "two" }, "why?", true);
    expect(locate(f, c)).toEqual({ state: "open", line: 2 });
    expect(formatPrompt(run, [c], { header: false }).text).toContain("a.ts:L2（2 行目（変更なし））");
  });
});

describe("AI review", () => {
  const changed = diff(["@@ -1,4 +1,5 @@", " const a = 1;", "-const b = 2;", "+const b = 3;", "+const c = b;", " ", " export { a };"]);
  const item = (over: Partial<Parameters<typeof placeItem>[1]>) => ({ side: null, line: null, endLine: null, code: null, ...over });

  it("puts a comment on the lines whose code it quotes, whatever line number it names", () => {
    // the reviewer is one line off: the code decides
    expect(placeItem(changed, item({ line: 2, code: "const c = b;" }))).toEqual({ target: { path: "x.ts", side: "new", line: 3, code: "const c = b;" }, exact: true });
    // several lines, with the indentation dropped and a newline at the end
    expect(placeItem(changed, item({ line: 9, code: "const b = 3;\n  const c = b;\n" }))?.target).toEqual({ path: "x.ts", side: "new", line: 2, endLine: 3, code: "const b = 3;\nconst c = b;" });
    // a deleted line is on the base side
    expect(placeItem(changed, item({ side: "old", line: 2, code: "const b = 2;" }))?.target).toMatchObject({ side: "old", line: 2 });
  });

  it("takes the nearest place when the same code is there twice", () => {
    const twice = diff(["@@ -1,3 +1,4 @@", " x();", " y();", "+x();", " z();"]);
    expect(placeItem(twice, item({ line: 3, code: "x();" }))?.target.line).toBe(3);
    expect(placeItem(twice, item({ line: 1, code: "x();" }))?.target.line).toBe(1);
  });

  it("falls back to the named line when the code is not there, and drops what points at nothing", () => {
    expect(placeItem(changed, item({ line: 3, endLine: 9, code: "something else" }))).toEqual({ target: { path: "x.ts", side: "new", line: 3, endLine: 5, code: "const c = b;\n\nexport { a };" }, exact: false });
    expect(placeItem(changed, item({ line: 40, code: "nowhere" }))).toBeNull();
    expect(placeItem(changed, item({ code: "nowhere" }))).toBeNull();
    expect(placeItem(file("logo.png", { binary: true }), item({ line: 1 }))).toBeNull();
  });

  it("finds lines outside the hunks once the file's content is read", () => {
    const far = diff(["@@ -10,3 +10,3 @@", " ten", "-old", "+new", " twelve"]);
    const content = Array.from({ length: 20 }, (_, i) => (i === 9 ? "ten" : i === 10 ? "new" : i === 11 ? "twelve" : `line ${i + 1}`));
    expect(placeItem(far, item({ line: 18, code: "line 18" }))).toBeNull();
    expect(placeItem(far, item({ line: 17, code: "line 18" }), content)).toEqual({ target: { path: "x.ts", side: "new", line: 18, code: "line 18" }, exact: true });
  });

  it("uses the side a file has: an added or unchanged file has no base side, a removed one no target side", () => {
    const added = addedFile("new.ts", "one\ntwo\n");
    expect(placeItem(added, item({ side: "old", line: 2, code: "two" }))?.target).toMatchObject({ side: "new", line: 2 });
    const plain = unchangedFile("lib.ts", { lines: ["a", "b"] });
    expect(placeItem(plain, item({ side: "old", line: 1, code: "b" }))?.target).toMatchObject({ path: "lib.ts", side: "new", line: 2 });
    const removed = file("gone.ts", { status: "removed", chunks: [{ section: "", oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: [{ type: "delete", content: "bye", oldLine: 1 }] }] });
    expect(placeItem(removed, item({ side: "new", line: 1, code: "bye" }))?.target).toMatchObject({ side: "old", line: 1 });
  });

  it("finds a renamed file by the path it had", () => {
    const run: FileShapeRun = { repoRoot: "/r", targetLabel: "t", baseLabel: "b", files: [file("src/new.ts", { status: "renamed", oldPath: "src/old.ts" })] };
    expect(fileFor(run, "src/old.ts")?.path).toBe("src/new.ts");
    expect(fileFor(run, "src/none.ts")).toBeUndefined();
  });

  it("tells the reviewer which files changed and how to point at a line", () => {
    const run: FileShapeRun = {
      repoRoot: "/r",
      targetLabel: "t",
      baseLabel: "b",
      files: [file("src/a.ts", { additions: 3, deletions: 1 }), file("src/b.ts", { status: "added", additions: 9 }), file("src/new.ts", { status: "renamed", oldPath: "src/old.ts" }), file("pnpm-lock.yaml", { generated: true }), file("lib.ts", { unchanged: true })],
    };
    const text = reviewSection(run);
    expect(text).toContain("変更されたファイル（3）:\n- M src/a.ts（+3 −1）\n- A src/b.ts（+9 −0）\n- R src/old.ts → src/new.ts\n（生成されたファイル 1 個は対象外）");
    expect(text).toContain("- code: その行のコードをファイルにあるとおりに");
    expect(text).not.toContain("lib.ts");
  });
});
