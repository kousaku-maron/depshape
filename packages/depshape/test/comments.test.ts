import { describe, expect, it } from "vitest";
import type { DiffGraph, Edge, FileNode } from "../src/types";
import { commentState, formatPrompt, importPath, itemKey, linkKey, parseKey, type ReviewComment } from "../ui/src/comments";
import { buildModel, buildTree } from "../ui/src/model";

function file(path: string, status: FileNode["status"] = "unchanged"): FileNode {
  const dir = path.slice(0, path.lastIndexOf("/"));
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
  it("adds the import path, link status and the folder's existing pattern", () => {
    const model = buildModel(before);
    const { byPath } = buildTree(model);
    const { text, included } = formatPrompt(model, byPath, [comment([NEW_LINK, NEW_FILE])]);
    expect(included).toBe(1);
    expect(text).toContain("リポジトリ: /repo");
    expect(text).toContain("app/handler/new.go → example.com/app/driver/api（今回追加した import）");
    expect(text).toContain("ファイル app/handler/new.go（今回追加）");
    expect(text).toContain("参考: app/handler/ の変更のないファイル 3 個の主な依存先: example.com/app/usecase (2)");
    expect(text).toContain("コメント: usecase を経由してください");
  });

  it("leaves out the shared header when the app combines it with other modules", () => {
    const model = buildModel(before);
    const { byPath } = buildTree(model);
    const full = formatPrompt(model, byPath, [comment([NEW_FILE])]).text;
    const section = formatPrompt(model, byPath, [comment([NEW_FILE])], { header: false }).text;
    expect(full.split("\n")[0]).toContain("diffshape");
    expect(full).toContain("対象: コードの依存関係（depshape）");
    expect(section.startsWith("1.")).toBe(true);
    expect(full.endsWith(section)).toBe(true);
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
