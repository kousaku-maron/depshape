import { describe, expect, it } from "vitest";
import type { DiffGraph, Edge, FileNode } from "../src/types";
import { buildModel, buildTree } from "../ui/src/model";
import { buildAllView, buildChangesView, findItems, rowsOf, type ViewNode } from "../ui/src/view";

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
  it("shows only the changed files and the folders they sit in, like fileshape's 変更 tree", () => {
    const v = buildChangesView(model, root);
    // app/internal/handler is one chain of single folders, so it is one row
    expect(outline(v.roots)).toEqual(["app/internal/handler(open)", "  new.go(file)"]);
    expect(v.fileRep.get("app/internal/handler/new.go")).toBe("f:app/internal/handler/new.go");
    // no "ほか N" rows: unchanged files, and the packages the change imports, are not in this tree
    expect(v.fileRep.has("app/internal/handler/a.go")).toBe(false);
    expect(v.pkgRep.has("app/internal/driver/api")).toBe(false);
    expect(v.pkgRep.has("app/internal/usecase")).toBe(false);
  });

  it("keeps sibling folders with changes apart", () => {
    const g: DiffGraph = { ...graph, files: [...graph.files.filter((f) => f.path !== "app/internal/usecase/u.go"), file("app/internal/usecase/u.go", "modified")] };
    const m = buildModel(g);
    const t = buildTree(m);
    expect(outline(buildChangesView(m, t.root).roots)).toEqual(["app/internal(open)", "  handler(open)", "    new.go(file)", "  usecase(open)", "    u.go(file)"]);
  });

  it("a folded folder shows as one row and stands for everything inside it", () => {
    const v = buildChangesView(model, root, new Set(["app/internal/handler"]));
    const lines = outline(v.roots);
    expect(lines).toEqual(["app/internal/handler(open)"]);
    expect(v.fileRep.get("app/internal/handler/new.go")).toBe("d:app/internal/handler");
    expect(v.roots[0].collapsed).toBe(true);
  });

  it("folds a chain of single folders into one row", () => {
    const g: DiffGraph = { ...graph, files: [file("x/y/z/new.go", "added")], edges: [] };
    const m = buildModel(g);
    const t = buildTree(m);
    const v = buildChangesView(m, t.root);
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

describe("findItems", () => {
  it("changes: looks among the changed files and their folders, by name, in the tree's order", () => {
    expect(findItems(model, root, "changes", "a", false)).toEqual([
      { kind: "dir", path: "app", reveal: [] },
      { kind: "dir", path: "app/internal", reveal: ["app"] },
      { kind: "dir", path: "app/internal/handler", reveal: ["app", "app/internal"] },
    ]);
    // unchanged files are not in that view
    expect(findItems(model, root, "changes", "a.go", false)).toEqual([]);
  });

  it("all: looks through the whole repository; a file reveals every folder above it", () => {
    expect(findItems(model, root, "all", "A.GO", false)).toEqual([{ kind: "file", path: "app/internal/handler/a.go", reveal: ["app", "app/internal", "app/internal/handler"] }]);
    expect(findItems(model, root, "all", "A.GO", true)).toEqual([]);
    expect(findItems(model, root, "all", "", false)).toEqual([]);
  });
});

describe("rowsOf", () => {
  it("a chain folded into one row shows each of its folders, at where its name starts", () => {
    const rows = rowsOf(buildChangesView(model, root));
    expect(rows.get("d:app")).toEqual({ id: "d:app/internal/handler", offset: 0 });
    expect(rows.get("d:app/internal")).toEqual({ id: "d:app/internal/handler", offset: 4 });
    expect(rows.get("d:app/internal/handler")).toEqual({ id: "d:app/internal/handler", offset: 13 });
    expect(rows.get("f:app/internal/handler/new.go")).toEqual({ id: "f:app/internal/handler/new.go", offset: 0 });
  });
});
