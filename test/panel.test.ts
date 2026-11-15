import { describe, expect, it } from "vitest";
import type { DiffGraph, Edge, FileNode } from "../src/types";
import { buildModel, buildTree } from "../ui/src/model";
import { buildPanel, commonParent, findLink } from "../ui/src/panel";
import { formatPrompt, linkKey } from "../ui/src/comments";

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
    // like the targets, the folder the pins share is shown once and each pin is labelled below it
    expect(p.sourcePrefix).toBe("src");
    expect(p.sources.map((s) => s.label)).toEqual(["a.go", "b.go", "c.go"]);
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
      ["b.go", true],
      ["c.go", false],
    ]);
  });

  it("a folder counts its files and skips imports inside itself; a rest row covers unchanged files", () => {
    const folder = buildPanel(model, byPath, ["d:src"], null, false);
    const hoge = folder.links.find((l) => l.to === "d:lib/hoge")!;
    expect([hoge.before, hoge.after, hoge.added]).toEqual([1, 2, 1]);
    const rest = buildPanel(model, byPath, ["r:src"], null, false);
    expect(rest.sources[0].label + rest.sources[0].suffix).toBe("src/ のほか 2 ファイル");
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

describe("opening a target folder (TS)", () => {
  const ts: DiffGraph = {
    repoRoot: "/repo",
    targetLabel: "t",
    baseLabel: "b",
    modules: [],
    generatedAt: "",
    files: [
      file("web/app/page.tsx", "modified"),
      file("web/app/other.tsx"),
      file("web/ui/button.tsx"),
      file("web/ui/card.tsx", "added"),
      file("web/ui/types.ts"),
    ],
    edges: [
      {
        from: "web/app/page.tsx",
        to: "web/ui",
        external: false,
        status: "unchanged",
        typeOnly: false,
        files: [
          { path: "web/ui/button.tsx", status: "unchanged" },
          { path: "web/ui/card.tsx", status: "added" },
          { path: "web/ui/types.ts", status: "unchanged", typeOnly: true },
        ],
      },
      { from: "web/app/other.tsx", to: "web/ui", external: false, status: "unchanged", files: [{ path: "web/ui/button.tsx", status: "unchanged" }] },
    ],
  };
  const m = buildModel(ts);
  const t = buildTree(m).byPath;

  it("keeps one folder row until opened, then lists the imported files and links to them", () => {
    const closed = buildPanel(m, t, ["d:web/app"], null, false);
    expect(closed.targets.map((x) => [x.id, x.fileCount, x.open])).toEqual([["d:web/ui", 3, false]]);
    expect(closed.links.map((l) => l.to)).toEqual(["d:web/ui"]);

    const opened = buildPanel(m, t, ["d:web/app"], null, false, new Map([["d:web/ui", true]]));
    expect(opened.targets.map((x) => x.id)).toEqual(["d:web/ui", "t:web/ui/button.tsx", "t:web/ui/card.tsx", "t:web/ui/types.ts"]);
    expect(opened.targets[1]).toMatchObject({ label: "button.tsx", file: "web/ui/button.tsx", dir: "web/ui" });
    const byTo = Object.fromEntries(opened.links.map((l) => [l.to, `${l.before}→${l.after}:${l.status}${l.typeOnly ? ":type" : ""}`]));
    expect(byTo).toEqual({
      "t:web/ui/button.tsx": "2→2:unchanged",
      "t:web/ui/card.tsx": "0→1:added",
      "t:web/ui/types.ts": "1→1:unchanged:type",
    });
  });

  it("finds a file-level link for comments", () => {
    expect(findLink(m, t, "f:web/app/page.tsx", "t:web/ui/card.tsx")).toMatchObject({ status: "added", after: 1 });
    expect(findLink(m, t, "f:web/app/other.tsx", "t:web/ui/card.tsx")).toBeNull();
  });
});

describe("target tree", () => {
  // page.tsx imports lib/ directly, plus lib/front and lib/server; ui/ sits elsewhere
  const g: DiffGraph = {
    repoRoot: "/repo",
    targetLabel: "t",
    baseLabel: "b",
    modules: [],
    generatedAt: "",
    files: [
      file("web/app/page.tsx", "modified"),
      file("web/lib/utils.ts"),
      file("web/lib/front/api.ts"),
      file("web/lib/front/types.ts"),
      file("web/lib/server/db.ts", "added"),
      file("web/ui/button.tsx"),
    ],
    edges: [
      { from: "web/app/page.tsx", to: "web/lib", external: false, status: "unchanged", files: [{ path: "web/lib/utils.ts", status: "unchanged" }] },
      {
        from: "web/app/page.tsx",
        to: "web/lib/front",
        external: false,
        status: "unchanged",
        files: [
          { path: "web/lib/front/api.ts", status: "unchanged" },
          { path: "web/lib/front/types.ts", status: "unchanged", typeOnly: true },
        ],
      },
      { from: "web/app/page.tsx", to: "web/lib/server", external: false, status: "added", files: [{ path: "web/lib/server/db.ts", status: "added" }] },
      { from: "web/app/page.tsx", to: "web/ui", external: false, status: "unchanged", files: [{ path: "web/ui/button.tsx", status: "unchanged" }] },
    ],
  };
  const m = buildModel(g);
  const t = buildTree(m).byPath;
  const rows = (p: ReturnType<typeof buildPanel>) => p.targets.map((x) => `${"  ".repeat(x.depth)}${x.label}${x.canOpen ? (x.open ? " ▾" : " ▸") : ""}`);

  it("nests imported folders under their parent and lists the parent's own imported files right in it", () => {
    const p = buildPanel(m, t, ["f:web/app/page.tsx"], null, false);
    expect(p.targetPrefix).toBe("web");
    expect(rows(p)).toEqual(["lib ▾", "  front ▸", "  server ▸", "  utils.ts", "ui ▸"]);
    expect(p.targets.find((x) => x.label === "utils.ts")).toMatchObject({ kind: "file", parent: "g:web/lib", depth: 1 });
    expect(p.links.map((l) => `${l.to}:${l.status}`).sort()).toEqual([
      "d:web/lib/front:unchanged",
      "d:web/lib/server:added",
      "d:web/ui:unchanged",
      "t:web/lib/utils.ts:unchanged",
    ]);
    const folded = buildPanel(m, t, ["f:web/app/page.tsx"], null, false, new Map([["g:web/lib", false]]));
    expect(folded.targets[0]).toMatchObject({ folderCount: 2, directFileCount: 1 });
  });

  it("folds a group into one link that counts each importing file once", () => {
    const p = buildPanel(m, t, ["f:web/app/page.tsx"], null, false, new Map([["g:web/lib", false]]));
    expect(rows(p)).toEqual(["lib ▸", "ui ▸"]);
    const lib = p.links.find((l) => l.to === "g:web/lib")!;
    expect([lib.before, lib.after, lib.status]).toEqual([1, 1, "unchanged"]);
    expect(lib.files?.map((f) => f.path)).toEqual(["web/lib/front/api.ts", "web/lib/front/types.ts", "web/lib/server/db.ts", "web/lib/utils.ts"]);
  });

  it("describes a folded group in the AI prompt", () => {
    const key = linkKey("f:web/app/page.tsx", "g:web/lib");
    expect(findLink(m, t, "f:web/app/page.tsx", "g:web/lib")).toMatchObject({ after: 1 });
    const { text } = formatPrompt(m, t, [{ id: "c", targets: [key], body: "x", createdAt: 0 }]);
    expect(text).toContain("web/app/page.tsx → web/lib/ 配下（front/api.ts, front/types.ts, server/db.ts, utils.ts）");
  });

  it("keeps Go packages as the leaves: groups fold, a parent package gets its own row, nothing opens into files", () => {
    const goGraph: DiffGraph = {
      ...g,
      modules: [{ dir: "", path: "example.com/app" }],
      files: [file("api/handler/h.go", "added"), file("api/driver/d.go"), file("api/driver/live/l.go"), file("api/driver/rest/r.go"), file("api/usecase/u.go")],
      edges: [
        edge("api/handler/h.go", "api/driver", "added"),
        edge("api/handler/h.go", "api/driver/live", "added"),
        edge("api/handler/h.go", "api/driver/rest", "added"),
        edge("api/handler/h.go", "api/usecase", "added"),
      ],
    };
    const gm = buildModel(goGraph);
    const gt = buildTree(gm).byPath;
    const p = buildPanel(gm, gt, ["f:api/handler/h.go"], null, false);
    expect(rows(p)).toEqual(["driver ▾", "  live", "  rest", "  driver（パッケージ）", "usecase"]);
    // pinning the package row shows only the files directly in the folder
    const pkg = buildPanel(gm, gt, ["p:api/driver"], null, false);
    expect(pkg.sources.map((s) => [s.label + s.suffix, s.files.map((f) => f.path)])).toEqual([["driver（パッケージ）", ["api/driver/d.go"]]]);
  });
});

describe("opening a source folder", () => {
  it("splits into its subfolders and the files directly in it", () => {
    const folded = buildPanel(model, byPath, ["d:src"], null, false);
    expect(folded.sources.map((s) => [s.label, s.canOpen, s.open])).toEqual([["src/", true, false]]);

    const opened = buildPanel(model, byPath, ["d:src"], null, false, new Map(), new Map([["d:src", true]]));
    expect(opened.sources.map((s) => `${"  ".repeat(s.depth)}${s.label}`)).toEqual(["src/", "  a.go", "  b.go", "  c.go"]);
    // the opened folder draws nothing itself; its rows do
    expect(opened.links.some((l) => l.from === "d:src")).toBe(false);
    expect(opened.links.filter((l) => l.from === "f:src/a.go").map((l) => l.to).sort()).toEqual(["d:lib/fuga", "d:lib/hoge"]);
  });

  it("keeps imports inside the opened folder hidden, and shows each item once", () => {
    const g: DiffGraph = {
      ...graph,
      files: [file("app/handler/h.go", "added"), file("app/handler/util/u.go"), file("lib/x/x.go")],
      edges: [edge("app/handler/h.go", "app/handler/util", "added"), edge("app/handler/h.go", "lib/x", "added"), edge("app/handler/util/u.go", "lib/x")],
    };
    const m = buildModel(g);
    const t = buildTree(m).byPath;
    const p = buildPanel(m, t, ["d:app/handler", "f:app/handler/h.go"], null, false, new Map(), new Map([["d:app/handler", true]]));
    expect(p.sources.map((s) => s.id)).toEqual(["d:app/handler", "d:app/handler/util", "f:app/handler/h.go"]);
    expect(p.links.map((l) => `${l.from}>${l.to}`).sort()).toEqual(["d:app/handler/util>d:lib/x", "f:app/handler/h.go>d:lib/x"]);
  });
});

describe("dependents (who imports the shown items)", () => {
  it("Go: lists the files importing the package, grouped by folder, opening into files", () => {
    // lib/hoge is imported by src/a.go (new) and src/b.go (existing)
    const p = buildPanel(model, byPath, ["f:lib/hoge/h.go"], null, false);
    expect(p.dependents.map((d) => [d.id, d.label, d.fileCount, d.open])).toEqual([["i:d:src", "src", 2, false]]);
    expect(p.inLinks.map((l) => `${l.from}>${l.to} ${l.before}→${l.after} +${l.added}`)).toEqual(["i:d:src>f:lib/hoge/h.go 1→2 +1"]);

    const opened = buildPanel(model, byPath, ["f:lib/hoge/h.go"], null, false, new Map([["i:d:src", true]]));
    expect(opened.dependents.map((d) => `${"  ".repeat(d.depth)}${d.label}`)).toEqual(["src", "  a.go", "  b.go"]);
    expect(opened.inLinks.map((l) => `${l.from}:${l.status}`)).toEqual(["i:f:src/a.go:added", "i:f:src/b.go:unchanged"]);
  });

  it("a folder's own files are not its dependents", () => {
    const p = buildPanel(model, byPath, ["d:src"], null, false);
    expect(p.dependents).toEqual([]);
  });

  it("TS: only the files importing that exact file, and comments describe them", () => {
    const ts: DiffGraph = {
      repoRoot: "/repo",
      targetLabel: "t",
      baseLabel: "b",
      modules: [],
      generatedAt: "",
      files: [file("web/app/page.tsx", "modified"), file("web/app/other.tsx"), file("web/ui/button.tsx"), file("web/ui/card.tsx", "added")],
      edges: [
        {
          from: "web/app/page.tsx",
          to: "web/ui",
          external: false,
          status: "unchanged",
          files: [
            { path: "web/ui/button.tsx", status: "unchanged" },
            { path: "web/ui/card.tsx", status: "added" },
          ],
        },
        { from: "web/app/other.tsx", to: "web/ui", external: false, status: "unchanged", files: [{ path: "web/ui/button.tsx", status: "unchanged" }] },
      ],
    };
    const m = buildModel(ts);
    const t = buildTree(m).byPath;
    const card = buildPanel(m, t, ["f:web/ui/card.tsx"], null, false, new Map([["i:d:web/app", true]]));
    expect(card.dependents.map((d) => d.id)).toEqual(["i:d:web/app", "i:f:web/app/page.tsx"]);
    const button = buildPanel(m, t, ["f:web/ui/button.tsx"], null, false);
    expect(button.inLinks.map((l) => `${l.from} ${l.before}→${l.after}`)).toEqual(["i:d:web/app 2→2"]);

    const key = linkKey("i:f:web/app/page.tsx", "f:web/ui/card.tsx");
    expect(findLink(m, t, "i:f:web/app/page.tsx", "f:web/ui/card.tsx")).toMatchObject({ status: "added" });
    const { text } = formatPrompt(m, t, [{ id: "c", targets: [key], body: "x", createdAt: 0 }]);
    expect(text).toContain("web/app/page.tsx → web/ui/card.tsx（今回追加した import）");
  });
});
