import { builtinModules } from "node:module";
import { posix } from "node:path";

/*
 * TypeScript / JavaScript support without the TypeScript toolchain: a small lexer
 * that finds module specifiers, and a resolver that maps them to repository files
 * using relative paths, tsconfig `paths` / `baseUrl` (following local `extends`),
 * and workspace packages (any package.json with a name).
 */

export const TS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export function isTsFile(path: string): boolean {
  return TS_EXTS.some((e) => path.endsWith(e)) && !path.endsWith(".min.js");
}

export function isTsTest(path: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || path.includes("/__tests__/");
}

export interface TsImport {
  spec: string;
  /** `import type` / `export type` (erased at runtime) */
  typeOnly: boolean;
}

/* ---------------- lexer ---------------- */

type Tok = { t: "id"; v: string } | { t: "str"; v: string } | { t: "p"; v: string };

// a `/` after one of these starts a regex literal, not a division
const REGEX_AFTER_KEYWORD = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await",
]);

function* tokenize(src: string): Generator<Tok> {
  let i = 0;
  const n = src.length;
  let prev: Tok | null = null;
  // template literal nesting: each entry is the brace depth at which a `${` was opened
  const tpl: number[] = [];
  let depth = 0;

  // after an operand (identifier, number, string, closing bracket, regex, template) a `/` divides
  const OPERAND_END = new Set([")", "]", "}", "num", "regex", "`"]);
  const regexAllowed = () =>
    prev === null || (prev.t === "p" && !OPERAND_END.has(prev.v)) || (prev.t === "id" && REGEX_AFTER_KEYWORD.has(prev.v));

  const readTemplate = () => {
    // at a template body (after ` or after the } closing a ${...}); returns when reaching ` or ${
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        i += 2;
      } else if (c === "`") {
        i++;
        return;
      } else if (c === "$" && src[i + 1] === "{") {
        i += 2;
        tpl.push(depth);
        depth++;
        return;
      } else i++;
    }
  };

  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v" || c === "﻿") {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let v = "";
      while (j < n && src[j] !== c && src[j] !== "\n") {
        if (src[j] === "\\") {
          v += src[j + 1] ?? "";
          j += 2;
        } else v += src[j++];
      }
      i = j + 1;
      yield (prev = { t: "str", v });
      continue;
    }
    if (c === "`") {
      i++;
      readTemplate();
      yield (prev = { t: "p", v: "`" }); // opaque: never a specifier
      continue;
    }
    if (c === "/" && regexAllowed()) {
      let j = i + 1;
      let cls = false;
      while (j < n && src[j] !== "\n") {
        const d = src[j];
        if (d === "\\") j += 2;
        else if (d === "[") (cls = true), j++;
        else if (d === "]") (cls = false), j++;
        else if (d === "/" && !cls) break;
        else j++;
      }
      i = j + 1;
      while (i < n && /[a-z]/i.test(src[i])) i++; // flags
      yield (prev = { t: "p", v: "regex" });
      continue;
    }
    if (/[A-Za-z_$]/.test(c) || c.charCodeAt(0) > 127) {
      let j = i + 1;
      while (j < n && (/[A-Za-z0-9_$]/.test(src[j]) || src.charCodeAt(j) > 127)) j++;
      yield (prev = { t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9a-zA-Z_.]/.test(src[j])) j++;
      i = j;
      yield (prev = { t: "p", v: "num" });
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      if (tpl.length && tpl[tpl.length - 1] === depth - 1) {
        // end of a ${...} inside a template literal: continue the template body
        tpl.pop();
        depth--;
        i++;
        readTemplate();
        yield (prev = { t: "p", v: "`" });
        continue;
      }
      depth--;
    }
    i++;
    yield (prev = { t: "p", v: c });
  }
}

/** Module specifiers referenced by a TS/JS source (static imports, re-exports, import(), require()). */
export function parseTsImports(src: string): TsImport[] {
  const toks = [...tokenize(src)];
  const out: TsImport[] = [];
  const at = (k: number) => toks[k];
  const isP = (k: number, v: string) => at(k)?.t === "p" && at(k)!.v === v;
  const isId = (k: number, v: string) => at(k)?.t === "id" && at(k)!.v === v;
  const afterDot = (k: number) => isP(k - 1, "."); // obj.import / obj?.require

  /** From an import/export clause start, find `from "<spec>"` before the statement ends. */
  const findFrom = (k: number): { spec: string; end: number } | null => {
    let braces = 0;
    for (let j = k; j < toks.length && j < k + 400; j++) {
      const tk = toks[j];
      // the next statement started without a `from`: no specifier here (no semicolons / ASI)
      if (braces === 0 && j > k && tk.t === "id" && (tk.v === "import" || tk.v === "export") && !isP(j - 1, ".")) return null;
      if (tk.t === "p") {
        if (tk.v === "{") braces++;
        else if (tk.v === "}") braces--;
        else if (braces === 0 && (tk.v === ";" || tk.v === "(" || tk.v === "=" || tk.v === "`")) return null;
      }
      if (braces === 0 && tk.t === "id" && tk.v === "from" && at(j + 1)?.t === "str") return { spec: at(j + 1)!.v, end: j + 1 };
    }
    return null;
  };

  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    if (tk.t !== "id" || afterDot(k)) continue;

    if (tk.v === "import") {
      if (isP(k + 1, ".")) continue; // import.meta
      if (isP(k + 1, "(")) {
        if (at(k + 2)?.t === "str") out.push({ spec: at(k + 2)!.v, typeOnly: false });
        continue;
      }
      if (at(k + 1)?.t === "str") {
        out.push({ spec: at(k + 1)!.v, typeOnly: false }); // import "side-effect"
        continue;
      }
      const typeOnly = isId(k + 1, "type") && !isP(k + 2, ",") && !isId(k + 2, "from");
      // `import x = require("y")` is handled by the require branch
      const f = findFrom(k + 1);
      if (f) {
        out.push({ spec: f.spec, typeOnly });
        k = f.end;
      }
      continue;
    }

    if (tk.v === "export") {
      const typeOnly = isId(k + 1, "type") && (isP(k + 2, "{") || isP(k + 2, "*"));
      if (!(isP(k + 1, "{") || isP(k + 1, "*") || typeOnly)) continue;
      const f = findFrom(k + 1);
      if (f) {
        out.push({ spec: f.spec, typeOnly });
        k = f.end;
      }
      continue;
    }

    if (tk.v === "require" && isP(k + 1, "(") && at(k + 2)?.t === "str" && isP(k + 3, ")")) {
      out.push({ spec: at(k + 2)!.v, typeOnly: false });
      continue;
    }
  }
  return out;
}

/* ---------------- resolver ---------------- */

/** Parses tsconfig-style JSON (comments and trailing commas allowed). */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

interface TsConfig {
  dir: string;
  /** absolute-in-repo dir that `paths` targets are relative to */
  pathsBase: string | null;
  paths: [string, string[]][];
  /** repo dir for non-relative lookups (`baseUrl`), if set */
  baseUrl: string | null;
}

export interface TsProject {
  files: Set<string>;
  configs: TsConfig[];
  /** workspace package name -> { dir, entry candidates } */
  packages: Map<string, { dir: string; entries: string[] }>;
}

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, m.replace(/^node:/, "")]));

/**
 * Builds the resolver context from a snapshot: every TS/JS file path, every
 * tsconfig/jsconfig (with local `extends` merged), and every named package.json.
 */
export function buildTsProject(files: Set<string>, configTexts: Map<string, string>, packageTexts: Map<string, string>): TsProject {
  const raw = new Map<string, Record<string, unknown>>();
  for (const [p, text] of configTexts) {
    try {
      const v = parseJsonc(text);
      if (v && typeof v === "object") raw.set(p, v as Record<string, unknown>);
    } catch {
      /* unreadable config: ignore */
    }
  }

  const effective = (p: string, seen = new Set<string>()): { baseUrl?: [string, string]; paths?: [string, Record<string, string[]>] } => {
    if (seen.has(p)) return {};
    seen.add(p);
    const c = raw.get(p);
    if (!c) return {};
    let inherited: ReturnType<typeof effective> = {};
    const ext = c.extends;
    for (const e of Array.isArray(ext) ? ext : ext ? [ext] : []) {
      if (typeof e !== "string" || !e.startsWith(".")) continue; // configs from npm packages are not in the repo
      let target = posix.normalize(posix.join(posix.dirname(p), e));
      if (!target.endsWith(".json")) target += ".json";
      const parent = effective(target, seen);
      inherited = { ...inherited, ...Object.fromEntries(Object.entries(parent).filter(([, v]) => v !== undefined)) };
    }
    const co = (c.compilerOptions ?? {}) as Record<string, unknown>;
    const dir = dirOf(p);
    const res = { ...inherited };
    if (typeof co.baseUrl === "string") res.baseUrl = [dir, co.baseUrl];
    if (co.paths && typeof co.paths === "object") res.paths = [dir, co.paths as Record<string, string[]>];
    return res;
  };

  const configs: TsConfig[] = [];
  for (const p of raw.keys()) {
    const name = posix.basename(p);
    if (name !== "tsconfig.json" && name !== "jsconfig.json") continue; // the project-defining configs
    const e = effective(p);
    const baseUrl = e.baseUrl ? posix.normalize(posix.join(e.baseUrl[0], e.baseUrl[1])) : null;
    const pathsBase = e.paths ? (baseUrl ?? e.paths[0]) : null;
    configs.push({
      dir: dirOf(p),
      baseUrl: baseUrl === "." ? "" : baseUrl,
      pathsBase: pathsBase === "." ? "" : pathsBase,
      paths: e.paths ? Object.entries(e.paths[1]).filter(([, v]) => Array.isArray(v)) : [],
    });
  }
  configs.sort((a, b) => b.dir.length - a.dir.length);

  const packages = new Map<string, { dir: string; entries: string[] }>();
  for (const [p, text] of packageTexts) {
    try {
      const pkg = JSON.parse(text) as Record<string, unknown>;
      if (typeof pkg.name !== "string") continue;
      const entries: string[] = [];
      const exp = pkg.exports as unknown;
      const pick = (v: unknown): string | undefined => {
        if (typeof v === "string") return v;
        if (v && typeof v === "object") {
          const o = v as Record<string, unknown>;
          return pick(o["."]) ?? pick(o.types) ?? pick(o.import) ?? pick(o.default) ?? pick(o.require);
        }
        return undefined;
      };
      for (const v of [pick(exp), pkg.types, pkg.typings, pkg.module, pkg.main, pkg.source]) if (typeof v === "string") entries.push(v);
      entries.push("src/index", "index");
      packages.set(pkg.name, { dir: dirOf(p), entries });
    } catch {
      /* ignore */
    }
  }
  return { files, configs, packages };
}

function dirOf(p: string): string {
  const d = posix.dirname(p);
  return d === "." ? "" : d;
}

const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};
const TRY_EXTS = [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Resolves a path (without guessing beyond extensions and index files) to a repository file. */
function resolveFile(files: Set<string>, base: string): string | null {
  const p = posix.normalize(base).replace(/^\.\//, "").replace(/\/$/, "");
  if (p.startsWith("..")) return null;
  if (files.has(p)) return p;
  const ext = posix.extname(p);
  for (const alt of JS_TO_TS[ext] ?? []) {
    const cand = p.slice(0, -ext.length) + alt;
    if (files.has(cand)) return cand;
  }
  for (const e of TRY_EXTS) if (files.has(p + e)) return p + e;
  for (const e of TRY_EXTS) if (files.has(`${p}/index${e}`)) return `${p}/index${e}`;
  return null;
}

export type TsResolution = { kind: "file"; path: string } | { kind: "external"; name: string } | { kind: "builtin" } | { kind: "unresolved" };

/** Package name of a bare specifier ("@scope/pkg/sub" -> "@scope/pkg"). */
export function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export function resolveTsImport(project: TsProject, fromFile: string, spec: string): TsResolution {
  if (spec.startsWith("node:")) return { kind: "builtin" };
  // strip query / hash (e.g. vite "?raw")
  const clean = spec.replace(/[?#].*$/, "");
  if (clean === "") return { kind: "unresolved" };

  if (clean.startsWith(".") || clean.startsWith("/")) {
    const target = clean.startsWith("/") ? clean.slice(1) : posix.join(dirOf(fromFile), clean);
    const f = resolveFile(project.files, target);
    return f ? { kind: "file", path: f } : { kind: "unresolved" };
  }

  // tsconfig of the importing file (nearest enclosing project)
  const cfg = project.configs.find((c) => c.dir === "" || fromFile.startsWith(c.dir + "/"));
  if (cfg && cfg.pathsBase !== null) {
    let best: { prefixLen: number; targets: string[]; star: string } | null = null;
    for (const [pattern, targets] of cfg.paths) {
      const star = pattern.indexOf("*");
      if (star === -1) {
        if (pattern === clean && (!best || pattern.length > best.prefixLen)) best = { prefixLen: pattern.length, targets, star: "" };
      } else {
        const pre = pattern.slice(0, star);
        const suf = pattern.slice(star + 1);
        if (clean.startsWith(pre) && clean.endsWith(suf) && clean.length >= pre.length + suf.length && (!best || pre.length > best.prefixLen)) {
          best = { prefixLen: pre.length, targets, star: clean.slice(pre.length, clean.length - suf.length) };
        }
      }
    }
    if (best) {
      for (const t of best.targets) {
        const f = resolveFile(project.files, posix.join(cfg.pathsBase, t.replace("*", best.star)));
        if (f) return { kind: "file", path: f };
      }
    }
  }
  if (cfg && cfg.baseUrl !== null) {
    const f = resolveFile(project.files, posix.join(cfg.baseUrl, clean));
    if (f) return { kind: "file", path: f };
  }

  // Node built-ins (checked after tsconfig so a `baseUrl` folder named like one still resolves)
  if (BUILTINS.has(clean) || BUILTINS.has(clean.split("/")[0])) return { kind: "builtin" };

  // workspace packages
  const name = packageName(clean);
  const pkg = project.packages.get(name);
  if (pkg) {
    const sub = clean.slice(name.length).replace(/^\//, "");
    if (sub) {
      const f = resolveFile(project.files, posix.join(pkg.dir, sub)) ?? resolveFile(project.files, posix.join(pkg.dir, "src", sub));
      if (f) return { kind: "file", path: f };
    } else {
      for (const e of pkg.entries) {
        const f = resolveFile(project.files, posix.join(pkg.dir, e));
        if (f) return { kind: "file", path: f };
      }
    }
  }
  return { kind: "external", name };
}
