import { describe, expect, it } from "vitest";
import type { DiffGraph, Edge, FileNode } from "../src/types";
import { commentState, formatPrompt, importPath, itemKey, linkKey, parseKey, type ReviewComment } from "../ui/src/comments";
import { buildModel, buildTree } from "../ui/src/model";
import { reviewSection, toComments } from "../ui/src/review";

function file(path: string, status: FileNode["status"] = "unchanged"): FileNode {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return { path, dir, status, linesBefore: 10, linesAfter: 10, isTest: path.endsWith("_test.go") };
}
function edge(from: string, to: string, status: Edge["status"] = "unchanged"): Edge {
  return { from, to, external: false, status };
}

function graphWith(files: FileNode[], edges: Edge[]): DiffGraph {
  return {
    repoRoot: "/repo",
    targetLabel: "作業ディレクトリ",
    baseLabel: "HEAD",
    modules: [{ dir: "app", path: "example.com/app" }],
    generatedAt: "",
    files,
    edges,
  };
}

// existing handlers go through usecase; the new one calls the driver directly
const before = graphWith(
  [
    file("app/handler/a.go"),
    file("app/handler/a_test.go"),
    file("app/handler/b.go"),
    file("app/handler/new.go", "added"),
    file("app/usecase/u.go"),
    file("app/driver/api/d.go"),
  ],
  [
    edge("app/handler/a.go", "app/usecase"),
    edge("app/handler/b.go", "app/usecase"),
    edge("app/handler/new.go", "app/driver/api", "added"),
  ],
);

const NEW_LINK = linkKey("f:app/handler/new.go", "d:app/driver/api");
const NEW_FILE = itemKey("f:app/handler/new.go");

function comment(targets: string[]): ReviewComment {
  return { id: "c1", targets, body: "usecase を経由してください", createdAt: 0 };
}

describe("comment keys", () => {
  it("round-trip links and items", () => {
    expect(parseKey(NEW_LINK)).toEqual({ kind: "link", from: "f:app/handler/new.go", to: "d:app/driver/api" });
    expect(parseKey(NEW_FILE)).toEqual({ kind: "item", id: "f:app/handler/new.go" });
  });
});

describe("formatPrompt", () => {
  it("puts every target of a comment on its first line, then the comment, like difit", () => {
    const model = buildModel(before);
    const { byPath } = buildTree(model);
    const { text, included } = formatPrompt(model, byPath, [comment([NEW_LINK, NEW_FILE])]);
    expect(included).toBe(1);
    // the full import path, so an agent can grep for the import line
    expect(text).toBe("app/handler/new.go → example.com/app/driver/api, app/handler/new.go\nusecase を経由してください\n");
  });

  it("separates comments with =====, and has no header of its own", () => {
    const model = buildModel(before);
    const { byPath } = buildTree(model);
    const { text } = formatPrompt(model, byPath, [comment([NEW_FILE]), comment([NEW_LINK])]);
    expect(text.split("\n=====\n")).toHaveLength(2);
    expect(text).not.toContain("diffshape");
  });
});

describe("commentState", () => {
  it("resolves when the dependency and the file disappear", () => {
    const c = comment([NEW_LINK, NEW_FILE]);
    const fixedLink = graphWith(
      [...before.files, file("app/handler/x.go")],
      [edge("app/handler/a.go", "app/usecase"), edge("app/handler/b.go", "app/usecase"), edge("app/handler/new.go", "app/usecase", "added")],
    );
    const m1 = buildModel(fixedLink);
    expect(commentState(m1, buildTree(m1).byPath, c)).toBe("partial");

    // adding a test file does not resolve a file comment; only the file going away does
    const withTest = graphWith([...fixedLink.files, file("app/handler/new_test.go", "added")], fixedLink.edges);
    const mt = buildModel(withTest);
    expect(commentState(mt, buildTree(mt).byPath, c)).toBe("partial");

    const fixedBoth = graphWith(
      fixedLink.files.filter((f) => f.path !== "app/handler/new.go"),
      fixedLink.edges.filter((e) => e.from !== "app/handler/new.go"),
    );
    const m2 = buildModel(fixedBoth);
    expect(commentState(m2, buildTree(m2).byPath, c)).toBe("resolved");
    // resolved comments are left out of the prompt
    expect(formatPrompt(m2, buildTree(m2).byPath, [c]).included).toBe(0);
  });
});

describe("importPath", () => {
  it("joins the module path with the folder inside the module", () => {
    const model = buildModel(before);
    expect(importPath(model, "app/driver/api")).toBe("example.com/app/driver/api");
    expect(importPath(model, "app")).toBe("example.com/app");
  });
});

describe("AI review", () => {
  const model = buildModel(before);
  const { byPath } = buildTree(model);
  const item = (target: string | null, body = "usecase を経由してください") => ({ module: "dep", body, target, path: null, side: null, line: null, endLine: null, code: null });

  it("tells the reviewer the imports each changed file added, with what a comment can point at and the folder's usual dependencies", () => {
    const text = reviewSection(model, byPath);
    expect(text).toContain(`- app/handler/new.go（今回追加） target: "${NEW_FILE}"`);
    expect(text).toContain(`  - 追加した import → example.com/app/driver/api target: "${NEW_LINK}"`);
    expect(text).toContain("  参考: app/handler/ の変更のないファイル 3 個の主な依存先: example.com/app/usecase (2)");
    expect(text).toContain("- target: 上の target の値をそのまま");
    // files whose imports did not change are not listed
    expect(text).not.toContain("app/handler/a.go");
  });

  it("lists a removed import without a target, and has nothing to say when no dependency changed", () => {
    const g = graphWith([file("app/handler/a.go", "modified"), file("app/handler/gone.go", "removed"), file("app/usecase/u.go")], [edge("app/handler/a.go", "app/usecase", "removed"), edge("app/handler/gone.go", "app/usecase", "removed")]);
    const m = buildModel(g);
    const text = reviewSection(m, buildTree(m).byPath);
    expect(text).toContain(`- app/handler/a.go（今回変更） target: "I:f:app/handler/a.go"\n  - 削除した import → example.com/app/usecase\n`);
    expect(text).toContain("- app/handler/gone.go（今回削除）\n  - 削除した import → example.com/app/usecase");
    const quiet = buildModel(graphWith([file("app/handler/a.go", "modified"), file("app/usecase/u.go")], [edge("app/handler/a.go", "app/usecase")]));
    expect(reviewSection(quiet, buildTree(quiet).byPath)).toBe("");
  });

  it("writes the root of a repository without a Go module as \".\"", () => {
    const g: DiffGraph = {
      ...graphWith(
        [file("config.ts"), file("env.ts"), file("web/page.ts", "added"), file("web/old.ts")],
        [
          { from: "web/page.ts", to: "", external: false, status: "added", files: [{ path: "config.ts", status: "added" }, { path: "env.ts", status: "added" }] },
          { from: "web/old.ts", to: "", external: false, status: "unchanged", files: [{ path: "config.ts", status: "unchanged" }] },
        ],
      ),
      modules: [],
    };
    const m = buildModel(g);
    const { byPath: tree } = buildTree(m);
    const text = reviewSection(m, tree);
    expect(text).toContain("  - 追加した import → ./（config.ts, env.ts）");
    expect(text).toContain("  参考: web/ の変更のないファイル 1 個の主な依存先: . (1)");
    const c: ReviewComment = { id: "1", targets: [linkKey("f:web/page.ts", "d:")], body: "設定は lib から", createdAt: 0 };
    expect(formatPrompt(m, tree, [c]).text).toBe("web/page.ts → .\n設定は lib から\n");
  });

  it("keeps the comments that point at a dependency or a file that is there, marked as the AI's", () => {
    const kept = toComments([item(NEW_LINK), item(NEW_FILE, "置き場所"), item("L:f:app/handler/new.go>d:app/nowhere"), item("I:f:app/none.go"), item("app/handler/new.go"), item(null)], model, byPath, "Codex");
    expect(kept.map((c) => [c.targets, c.body, c.ai])).toEqual([
      [[NEW_LINK], "usecase を経由してください", "Codex"],
      [[NEW_FILE], "置き場所", "Codex"],
    ]);
    expect(commentState(model, byPath, kept[0])).toBe("open");
  });
});
