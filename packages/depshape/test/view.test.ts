import { describe, expect, it } from "vitest";
import type { DiffGraph, Edge, FileNode } from "../src/types";
import { buildModel, buildTree } from "../ui/src/model";
import { buildAllView, buildChangesView, type ViewNode } from "../ui/src/view";

function file(path: string, status: FileNode["status"] = "unchanged"): FileNode {
  const dir = path.slice(0, path.lastIndexOf("/"));
  return { path, dir, status, linesBefore: 10, linesAfter: 10, isTest: path.endsWith("_test.go") };
}
function edge(from: string, to: string, status: Edge["status"] = "unchanged"): Edge {
  return { from, to, external: false, status };
}

// handler/{a,b}.go are existing and go through usecase; handler/new.go is new and calls driver directly
const graph: DiffGraph = {
  repoRoot: "/repo",
  targetLabel: "t",
  baseLabel: "b",
  modules: [{ dir: "", path: "example.com/app" }],
  generatedAt: "",
  files: [
    file("app/internal/handler/a.go"),
    file("app/internal/handler/b.go"),
    file("app/internal/handler/new.go", "added"),
    file("app/internal/usecase/u.go"),
    file("app/internal/driver/api/d.go"),
    file("app/internal/driver/other/o.go"),
    file("app/cmd/main.go"),
  ],
  edges: [
    edge("app/internal/handler/a.go", "app/internal/usecase"),
    edge("app/internal/handler/b.go", "app/internal/usecase"),
    edge("app/internal/handler/b.go", "app/internal/driver/other"),
    edge("app/internal/handler/new.go", "app/internal/driver/api", "added"),
    edge("app/internal/usecase/u.go", "app/internal/driver/api"),
  ],
};

const model = buildModel(graph);
const { root, byPath } = buildTree(model);

/** "label(kind)" outline, children indented, for readable assertions. */
function outline(nodes: ViewNode[], depth = 0): string[] {
  return nodes.flatMap((n) => [`${"  ".repeat(depth)}${n.label}(${n.kind})`, ...outline(n.children, depth + 1)]);
}

describe("buildChangesView", () => {
  it("shows changed files, their targets, and a rest row for the existing files", () => {
    const v = buildChangesView(model, root, byPath, new Set());
    expect(outline(v.roots)).toEqual([
      "app(open)",
      "  internal(open)",
      "    driver(open)",
      "      api(dir)",
      "      ほか 1 フォルダ(rest)",
      "    handler(open)",
      "      new.go(file)",
      "      ほか 2 ファイル(rest)",
      "    ほか 1 フォルダ(rest)",
      "  ほか 1 フォルダ(rest)",
    ]);
    // the rest row stands for the hidden existing files, so their imports still have a source
    expect(v.fileRep.get("app/internal/handler/a.go")).toBe("r:app/internal/handler");
    expect(v.fileRep.get("app/internal/handler/new.go")).toBe("f:app/internal/handler/new.go");
    // usecase is only imported by unchanged files, so it is hidden until a folder is revealed
    expect(v.pkgRep.has("app/internal/usecase")).toBe(false);
    expect(v.pkgRep.get("app/internal/driver/api")).toBe("d:app/internal/driver/api");
  });

  it("revealing a folder opens its rest row in place; closing it folds the items back", () => {
    const open = buildChangesView(model, root, byPath, new Set(["app/internal/handler"]));
    const lines = outline(open.roots);
    const at = lines.indexOf("      ほか 2 ファイル(rest)");
    // changed file first, then the opened group holding the existing files
    expect(lines.slice(at - 1, at + 3)).toEqual(["      new.go(file)", "      ほか 2 ファイル(rest)", "        a.go(file)", "        b.go(file)"]);
    expect(open.fileRep.get("app/internal/handler/a.go")).toBe("f:app/internal/handler/a.go");

    const closed = buildChangesView(model, root, byPath, new Set());
    expect(closed.fileRep.get("app/internal/handler/a.go")).toBe("r:app/internal/handler");
  });

  it("a revealed folder's hidden subfolders go into its rest group", () => {
    const v = buildChangesView(model, root, byPath, new Set(["app/internal/driver"]));
    const lines = outline(v.roots);
    const at = lines.indexOf("      ほか 1 フォルダ(rest)");
    expect(lines.slice(at - 1, at + 2)).toEqual(["      api(dir)", "      ほか 1 フォルダ(rest)", "        other(dir)"]);
  });

  it("a folded folder shows as one row and stands for everything inside it", () => {
    const v = buildChangesView(model, root, byPath, new Set(), new Set(["app/internal/handler"]));
    const lines = outline(v.roots);
    expect(lines).toContain("    handler(open)");
    expect(lines.some((l) => l.includes("new.go"))).toBe(false);
    expect(v.fileRep.get("app/internal/handler/new.go")).toBe("d:app/internal/handler");
    expect(v.roots[0].children[0].children.find((n) => n.label === "handler")?.collapsed).toBe(true);
  });

  it("folds a chain of single folders into one row", () => {
    const g: DiffGraph = { ...graph, files: [file("x/y/z/new.go", "added")], edges: [] };
    const m = buildModel(g);
    const t = buildTree(m);
    const v = buildChangesView(m, t.root, t.byPath, new Set());
    expect(outline(v.roots)).toEqual(["x/y/z(open)", "  new.go(file)"]);
    expect(v.roots[0].path).toBe("x/y/z");
  });
});

describe("buildAllView", () => {
  it("collapsed folders stand for everything inside them", () => {
    const v = buildAllView(root, new Set(["app"]));
    expect(outline(v.roots)).toEqual(["app(open)", "  cmd(dir)", "  internal(dir)"]);
    expect(v.fileRep.get("app/internal/handler/a.go")).toBe("d:app/internal");
    expect(v.pkgRep.get("app/internal/usecase")).toBe("d:app/internal");
  });
});
