import { describe, expect, it } from "vitest";
import { buildTsProject, isTsTest, packageName, parseJsonc, parseTsImports, resolveTsImport } from "../src/ts.js";

const specs = (src: string) => parseTsImports(src).map((i) => (i.typeOnly ? `type:${i.spec}` : i.spec));

describe("parseTsImports", () => {
  it("finds static imports, re-exports, side-effect imports, import() and require()", () => {
    const src = `
      import React from "react";
      import { a, b as c } from './a';
      import * as ns from "../ns";
      import Default, { named } from "@scope/pkg/sub";
      import "./side-effect.css";
      export { x } from "./x";
      export * from './all';
      export * as grouped from "./grouped";
      const lazy = () => import("./lazy");
      const cjs = require('./cjs');
      import fs = require("fs");
    `;
    expect(specs(src)).toEqual([
      "react",
      "./a",
      "../ns",
      "@scope/pkg/sub",
      "./side-effect.css",
      "./x",
      "./all",
      "./grouped",
      "./lazy",
      "./cjs",
      "fs",
    ]);
  });

  it("marks type-only imports and re-exports", () => {
    const src = `
      import type { User } from "./types";
      import type Foo from "./foo";
      export type { Bar } from "./bar";
      import { type Baz, qux } from "./mixed";
      import type from "./named-type";
    `;
    expect(specs(src)).toEqual(["type:./types", "type:./foo", "type:./bar", "./mixed", "./named-type"]);
  });

  it("ignores specifiers inside comments, strings, templates and regexes", () => {
    const src = `
      // import x from "./commented";
      /* import y from "./block" */
      const s = "import z from './in-string'";
      const t = \`import w from "./in-template" \${ require("./in-expr") } done\`;
      const r = /import v from "\\.\\/regex"/g;
      const half = total / 2; const q = "./not-a-regex/";
      obj.require("./method-call");
      const m = import.meta.url;
      import real from "./real";
    `;
    expect(specs(src)).toEqual(["./in-expr", "./real"]);
  });

  it("does not take a later statement's from when a re-export has no semicolon", () => {
    const src = `export { a, b }\nimport c from "./c"\nexport default c`;
    expect(specs(src)).toEqual(["./c"]);
  });

  it("handles JSX", () => {
    const src = `import { Button } from "@/components/button";\nexport const App = () => <div className="x">{items.map((i) => <Button key={i} />)}</div>;`;
    expect(specs(src)).toEqual(["@/components/button"]);
  });
});

describe("parseJsonc", () => {
  it("keeps strings that look like comments (e.g. path aliases)", () => {
    const v = parseJsonc(`{
      // comment
      "compilerOptions": { "paths": { "@/*": ["./src/*"], }, /* block */ },
    }`) as { compilerOptions: { paths: Record<string, string[]> } };
    expect(v.compilerOptions.paths["@/*"]).toEqual(["./src/*"]);
  });
});

describe("resolveTsImport", () => {
  const files = new Set([
    "apps/web/src/app/page.tsx",
    "apps/web/src/components/button.tsx",
    "apps/web/src/lib/api/index.ts",
    "apps/web/src/lib/util.ts",
    "apps/web/src/types.d.ts",
    "apps/mobile/src/screen.tsx",
    "apps/mobile/modules/player/index.ts",
    "packages/tokens/src/index.ts",
    "packages/tokens/src/colors.ts",
    "libs/esm/src/a.ts",
  ]);
  const project = buildTsProject(
    files,
    new Map([
      ["apps/web/tsconfig.json", `{ "extends": "../../tsconfig.base.json", "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }`],
      ["tsconfig.base.json", `{ "compilerOptions": { "strict": true } }`],
      // paths inherited through a local extends; the npm-package extends is ignored
      ["apps/mobile/tsconfig.base.json", `{ "compilerOptions": { "paths": { "@/*": ["./src/*"], "@modules/*": ["./modules/*"] } } }`],
      ["apps/mobile/tsconfig.json", `{ "extends": ["expo/tsconfig.base", "./tsconfig.base.json"] }`],
      ["libs/esm/tsconfig.json", `{ "compilerOptions": { "baseUrl": "src" } }`],
    ]),
    new Map([["packages/tokens/package.json", `{ "name": "@acme/tokens", "main": "./src/index.ts" }`]]),
  );
  const r = (from: string, spec: string) => {
    const res = resolveTsImport(project, from, spec);
    return res.kind === "file" ? res.path : res.kind === "external" ? `external:${res.name}` : res.kind;
  };

  it("resolves relative imports with extensions, .js → .ts and index files", () => {
    expect(r("apps/web/src/app/page.tsx", "../components/button")).toBe("apps/web/src/components/button.tsx");
    expect(r("apps/web/src/app/page.tsx", "../lib/util.js")).toBe("apps/web/src/lib/util.ts");
    expect(r("apps/web/src/app/page.tsx", "../lib/api")).toBe("apps/web/src/lib/api/index.ts");
    expect(r("apps/web/src/app/page.tsx", "../types")).toBe("apps/web/src/types.d.ts");
    expect(r("apps/web/src/app/page.tsx", "./missing")).toBe("unresolved");
  });

  it("resolves tsconfig paths, including ones inherited through a local extends", () => {
    expect(r("apps/web/src/app/page.tsx", "@/components/button")).toBe("apps/web/src/components/button.tsx");
    expect(r("apps/mobile/src/screen.tsx", "@/screen")).toBe("apps/mobile/src/screen.tsx");
    expect(r("apps/mobile/src/screen.tsx", "@modules/player")).toBe("apps/mobile/modules/player/index.ts");
  });

  it("resolves baseUrl lookups before treating a name as a Node built-in", () => {
    expect(r("libs/esm/src/a.ts", "a")).toBe("libs/esm/src/a.ts");
    expect(r("libs/esm/src/a.ts", "node:fs")).toBe("builtin");
    expect(r("libs/esm/src/a.ts", "fs/promises")).toBe("builtin");
  });

  it("resolves workspace packages and subpaths; everything else is external", () => {
    expect(r("apps/web/src/app/page.tsx", "@acme/tokens")).toBe("packages/tokens/src/index.ts");
    expect(r("apps/web/src/app/page.tsx", "@acme/tokens/colors")).toBe("packages/tokens/src/colors.ts");
    expect(r("apps/web/src/app/page.tsx", "react")).toBe("external:react");
    expect(r("apps/web/src/app/page.tsx", "@tanstack/react-query/devtools")).toBe("external:@tanstack/react-query");
  });
});

describe("helpers", () => {
  it("detects test files and package names", () => {
    expect(isTsTest("src/a.test.ts")).toBe(true);
    expect(isTsTest("src/a.spec.tsx")).toBe(true);
    expect(isTsTest("src/a.test.mts")).toBe(true);
    expect(isTsTest("src/__tests__/a.ts")).toBe(false);
    expect(isTsTest("src/a.ts")).toBe(false);
    expect(packageName("@scope/pkg/deep/path")).toBe("@scope/pkg");
    expect(packageName("lodash/fp")).toBe("lodash");
  });
});
