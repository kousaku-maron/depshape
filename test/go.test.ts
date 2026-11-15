import { describe, expect, it } from "vitest";
import { diffSnapshots, fileKind } from "../src/analyze.js";
import { isStdlib, parseGoImports, parseGoModModulePath } from "../src/go.js";

describe("parseGoImports", () => {
  it("handles grouped, aliased, dot and blank imports with comments", () => {
    const src = `// Package x does things.
/* block
   import "fake/inside/comment" */
package handler // trailing

import "fmt"
import (
	"context"
	// "commented/out"
	paymentapi "github.com/acme/app/internal/driver/payment-api"
	. "github.com/acme/app/internal/dot"
	_ "github.com/lib/pq"
	raw \`github.com/acme/app/raw\`
)

import alias "github.com/acme/app/single"

var s = "import \\"not/an/import\\""

func main() {}
`;
    expect(parseGoImports(src)).toEqual([
      "fmt",
      "context",
      "github.com/acme/app/internal/driver/payment-api",
      "github.com/acme/app/internal/dot",
      "github.com/lib/pq",
      "github.com/acme/app/raw",
      "github.com/acme/app/single",
    ]);
  });

  it("returns nothing for files without imports", () => {
    expect(parseGoImports("package x\n\nfunc A() {}\n")).toEqual([]);
  });

  it("supports build tags before the package clause", () => {
    expect(parseGoImports(`//go:build linux\n\npackage x\n\nimport "os"\n`)).toEqual(["os"]);
  });
});

describe("parseGoModModulePath", () => {
  it("reads the module directive", () => {
    expect(parseGoModModulePath("// c\nmodule github.com/acme/app/api // x\n\ngo 1.26\n")).toBe(
      "github.com/acme/app/api",
    );
  });
});

describe("isStdlib", () => {
  it("detects stdlib by the first path element", () => {
    expect(isStdlib("net/http")).toBe(true);
    expect(isStdlib("github.com/x/y")).toBe(false);
  });
});

describe("diffSnapshots", () => {
  it("classifies files and edges", () => {
    const mods = [{ dir: "app", path: "example.com/app" }];
    const before = {
      modules: mods,
      files: new Map([
        ["app/handler/member.go", { hash: "1", lines: 10, imports: [{ to: "app/usecase", external: false }] }],
        ["app/handler/old.go", { hash: "2", lines: 5, imports: [{ to: "app/repo", external: false }] }],
      ]),
    };
    const after = {
      modules: mods,
      files: new Map([
        ["app/handler/member.go", { hash: "1", lines: 10, imports: [{ to: "app/usecase", external: false }] }],
        ["app/handler/notice.go", { hash: "3", lines: 80, imports: [{ to: "app/repo", external: false }] }],
      ]),
    };
    const { files, edges } = diffSnapshots(before, after);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["app/handler/member.go", "unchanged"],
      ["app/handler/notice.go", "added"],
      ["app/handler/old.go", "removed"],
    ]);
    expect(edges.map((e) => [e.from, e.to, e.status])).toEqual([
      ["app/handler/member.go", "app/usecase", "unchanged"],
      ["app/handler/notice.go", "app/repo", "added"],
      ["app/handler/old.go", "app/repo", "removed"],
    ]);
  });
});

describe("diffSnapshots with TS file detail", () => {
  it("keeps one edge per folder and tracks which files inside it were added or dropped", () => {
    const snap = (imports: { to: string; external: boolean; files?: string[]; typeOnly?: boolean; typeOnlyFiles?: string[] }[]) => ({
      modules: [],
      files: new Map([["web/page.tsx", { hash: JSON.stringify(imports), lines: 1, imports }]]),
    });
    const before = snap([{ to: "web/lib", external: false, files: ["web/lib/a.ts", "web/lib/b.ts"], typeOnly: false }]);
    const after = snap([
      { to: "web/lib", external: false, files: ["web/lib/b.ts", "web/lib/c.ts"], typeOnly: false, typeOnlyFiles: ["web/lib/c.ts"] },
      { to: "react", external: true, typeOnly: false },
    ]);
    const { edges } = diffSnapshots(before, after);
    const lib = edges.find((e) => e.to === "web/lib")!;
    expect(lib.status).toBe("unchanged");
    expect(lib.files).toEqual([
      { path: "web/lib/a.ts", status: "removed" },
      { path: "web/lib/b.ts", status: "unchanged" },
      { path: "web/lib/c.ts", status: "added", typeOnly: true },
    ]);
    expect(edges.find((e) => e.to === "react")).toMatchObject({ external: true, status: "added" });
  });
});

describe("fileKind", () => {
  it("applies Go's exclusions to Go only, so Next.js folders like _components and (group) stay", () => {
    expect(fileKind("pkg/_internal/x.go")).toBeNull();
    expect(fileKind("vendor/a/b.go")).toBeNull();
    expect(fileKind("web/src/app/_components/nav.tsx")).toBe("ts");
    expect(fileKind("web/src/app/(market)/[item]/page.tsx")).toBe("ts");
    expect(fileKind("web/node_modules/react/index.js")).toBeNull();
    expect(fileKind("web/.next/server/app.js")).toBeNull();
    expect(fileKind("web/tsconfig.json")).toBe("tsconfig");
    expect(fileKind("web/package.json")).toBe("package");
    expect(fileKind("web/vendor.min.js")).toBeNull();
  });
});
