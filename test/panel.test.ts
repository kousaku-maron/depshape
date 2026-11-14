import { describe, expect, it } from "vitest";
import type { DiffGraph, Edge, FileNode } from "../src/types";
import { buildModel, buildTree } from "../ui/src/model";
import { buildPanel, commonParent } from "../ui/src/panel";

function file(path: string, status: FileNode["status"] = "unchanged"): FileNode {
  const dir = path.slice(0, path.lastIndexOf("/"));
  return { path, dir, status, linesBefore: 10, linesAfter: 10, isTest: path.endsWith("_test.go") };
}
function edge(from: string, to: string, status: Edge["status"] = "unchanged"): Edge {
  return { from, to, external: false, status };
}

// the example from the design discussion: a -> hoge, fuga; b -> hoge; c -> fuga
const graph: DiffGraph = {
  repoRoot: "/repo",
  targetLabel: "t",
  baseLabel: "b",
  modules: [{ dir: "", path: "example.com/app" }],
  generatedAt: "",
  files: [file("src/a.go", "added"), file("src/b.go"), file("src/c.go"), file("lib/hoge/h.go"), file("lib/fuga/f.go")],
  edges: [
    edge("src/a.go", "lib/hoge", "added"),
    edge("src/a.go", "lib/fuga", "added"),
    edge("src/b.go", "lib/hoge"),
    edge("src/c.go", "lib/fuga"),
  ],
};
const model = buildModel(graph);
const { byPath } = buildTree(model);

describe("buildPanel", () => {
  it("draws pinned files and the union of what they import", () => {
    const p = buildPanel(model, byPath, ["f:src/a.go", "f:src/b.go", "f:src/c.go"], null, false);
    expect(p.sources.map((s) => s.label)).toEqual(["src/a.go", "src/b.go", "src/c.go"]);
    expect(p.targets.map((t) => t.label)).toEqual(["hoge", "fuga"]);
    expect(p.targetPrefix).toBe("lib");
    expect(p.links.map((l) => `${l.from}>${l.to}:${l.status}`).sort()).toEqual([
      "f:src/a.go>d:lib/fuga:added",
      "f:src/a.go>d:lib/hoge:added",
      "f:src/b.go>d:lib/hoge:unchanged",
      "f:src/c.go>d:lib/fuga:unchanged",
    ]);
  });

  it("adds the hovered item after the pins without pinning it", () => {
    const p = buildPanel(model, byPath, ["f:src/b.go"], "f:src/c.go", false);
    expect(p.sources.map((s) => [s.label, s.pinned])).toEqual([
      ["src/b.go", true],
      ["src/c.go", false],
    ]);
  });

  it("a folder counts its files and skips imports inside itself; a rest row covers unchanged files", () => {
    const folder = buildPanel(model, byPath, ["d:src"], null, false);
    const hoge = folder.links.find((l) => l.to === "d:lib/hoge")!;
    expect([hoge.before, hoge.after, hoge.added]).toEqual([1, 2, 1]);
    const rest = buildPanel(model, byPath, ["r:src"], null, false);
    expect(rest.sources[0].label).toBe("src/ のほか 2 ファイル");
    expect(rest.links.every((l) => l.status === "unchanged")).toBe(true);
  });
});

describe("commonParent", () => {
  it("keeps at least each folder's own name", () => {
    expect(commonParent(["a/b/c", "a/b/d/e"])).toBe("a/b");
    expect(commonParent(["a/b/c"])).toBe("a/b");
    expect(commonParent(["x", "y"])).toBe("");
  });
});
