import { createHash } from "node:crypto";
import { posix } from "node:path";
import { listFiles, mergeBase, readFiles, repoRoot, resolveRev, type Source } from "./git.js";
import { isStdlib, parseGoImports, parseGoModModulePath } from "./go.js";
import { buildTsProject, isTsFile, isTsTest, parseTsImports, resolveTsImport } from "./ts.js";
import type { DiffGraph, Edge, FileNode, GoModule } from "./types.js";

export interface CompareOptions {
  /** ".", "staged", "working", or any git revision. Default "." */
  target?: string;
  /** Git revision to compare with. Default depends on target. */
  base?: string;
  /** Use `git merge-base base target` as the base (like a GitHub PR). */
  mergeBase?: boolean;
}

interface SnapshotImport {
  to: string;
  external: boolean;
  typeOnly?: boolean;
  /** TS: imported files inside `to` */
  files?: string[];
  /** TS: the subset of `files` imported only with `import type` */
  typeOnlyFiles?: string[];
}

interface Snapshot {
  modules: GoModule[];
  files: Map<string, { hash: string; lines: number; imports: SnapshotImport[] }>;
}

type FileKind = "go" | "gomod" | "ts" | "tsconfig" | "package";

/** What a path is to the analysis (null = ignored). Exclusions differ per language. */
export function fileKind(path: string): FileKind | null {
  const segs = path.split("/");
  const name = segs[segs.length - 1];
  const hidden = segs.some((s) => s === "node_modules" || (s.startsWith(".") && s.length > 1));
  if (hidden) return null;
  if (name === "go.mod" || name.endsWith(".go")) {
    // Go ignores vendor/, testdata/ and _-prefixed directories
    if (segs.some((s) => s === "vendor" || s === "testdata" || s.startsWith("_"))) return null;
    return name === "go.mod" ? "gomod" : "go";
  }
  if (/^(tsconfig[^/]*|jsconfig)\.json$/.test(name)) return "tsconfig";
  if (name === "package.json") return "package";
  if (isTsFile(name)) return "ts";
  return null;
}

function countLines(c: string): number {
  return c.length === 0 ? 0 : c.split("\n").length - (c.endsWith("\n") ? 1 : 0);
}

export async function resolveSources(
  cwd: string,
  opts: CompareOptions,
): Promise<{ root: string; target: Source; base: Source; targetLabel: string; baseLabel: string }> {
  const root = await repoRoot(cwd);
  const targetArg = opts.target ?? ".";

  let target: Source;
  let defaultBase: string | Source;
  let targetLabel: string;
  if (targetArg === "." ) {
    target = { kind: "worktree" };
    defaultBase = "HEAD";
    targetLabel = "作業ディレクトリ（未コミットの変更を含む）";
  } else if (targetArg === "staged") {
    target = { kind: "index" };
    defaultBase = "HEAD";
    targetLabel = "ステージ済みの変更";
  } else if (targetArg === "working") {
    target = { kind: "worktree" };
    defaultBase = { kind: "index" };
    targetLabel = "未ステージの変更";
  } else {
    const rev = targetArg === "@" ? "HEAD" : targetArg;
    target = { kind: "rev", rev: await resolveRev(root, rev) };
    defaultBase = `${rev}^`;
    targetLabel = rev;
  }

  let base: Source;
  let baseLabel: string;
  if (opts.base) {
    const baseRev = opts.base === "@" ? "HEAD" : opts.base;
    if (opts.mergeBase) {
      const other = target.kind === "rev" ? target.rev : "HEAD";
      base = { kind: "rev", rev: await mergeBase(root, baseRev, other) };
      baseLabel = `${baseRev} との分岐点（merge-base: ${base.rev.slice(0, 8)}）`;
    } else {
      base = { kind: "rev", rev: await resolveRev(root, baseRev) };
      baseLabel = baseRev;
    }
  } else if (typeof defaultBase === "string") {
    base = { kind: "rev", rev: await resolveRev(root, defaultBase) };
    baseLabel = defaultBase;
  } else {
    base = defaultBase;
    baseLabel = "ステージ済みの状態";
  }

  return { root, target, base, targetLabel, baseLabel };
}

async function loadSnapshot(root: string, source: Source): Promise<Snapshot> {
  const kinds = new Map<string, FileKind>();
  for (const p of await listFiles(root, source)) {
    const k = fileKind(p);
    if (k) kinds.set(p, k);
  }
  const contents = await readFiles(root, source, [...kinds.keys()]);
  // deleted in the working tree but still listed: drop
  for (const p of [...kinds.keys()]) if (!contents.has(p)) kinds.delete(p);

  const modules: GoModule[] = [];
  for (const [p, c] of contents) {
    if (posix.basename(p) !== "go.mod") continue;
    const modPath = parseGoModModulePath(c);
    if (modPath) modules.push({ dir: dirOf(p), path: modPath });
  }
  // longest module path first so nested modules win
  modules.sort((a, b) => b.path.length - a.path.length);

  const files: Snapshot["files"] = new Map();
  for (const [p, c] of contents) {
    if (!p.endsWith(".go")) continue;
    const imports: { to: string; external: boolean }[] = [];
    const seen = new Set<string>();
    for (const imp of parseGoImports(c)) {
      if (isStdlib(imp)) continue;
      const local = resolveLocal(modules, imp);
      const to = local ?? imp;
      if (seen.has(to)) continue;
      seen.add(to);
      imports.push({ to, external: local === null });
    }
    files.set(p, { hash: createHash("sha1").update(c).digest("hex"), lines: countLines(c), imports });
  }

  // TypeScript / JavaScript
  const tsFiles = new Set([...kinds].filter(([, k]) => k === "ts").map(([p]) => p));
  if (tsFiles.size > 0) {
    const pick = (kind: FileKind) => new Map([...kinds].filter(([, k]) => k === kind).map(([p]) => [p, contents.get(p)!]));
    const project = buildTsProject(tsFiles, pick("tsconfig"), pick("package"));
    for (const p of tsFiles) {
      const c = contents.get(p)!;
      // per target folder: imported files and whether each is imported for types only
      const byTo = new Map<string, { external: boolean; typeOnly: boolean; files: Map<string, boolean> }>();
      for (const imp of parseTsImports(c)) {
        const res = resolveTsImport(project, p, imp.spec);
        if (res.kind === "builtin" || res.kind === "unresolved") continue; // node built-ins, assets (css, svg), typos
        const to = res.kind === "file" ? dirOf(res.path) : res.name;
        let entry = byTo.get(to);
        if (!entry) byTo.set(to, (entry = { external: res.kind === "external", typeOnly: true, files: new Map() }));
        entry.typeOnly &&= imp.typeOnly;
        if (res.kind === "file" && res.path !== p) entry.files.set(res.path, (entry.files.get(res.path) ?? true) && imp.typeOnly);
      }
      const imports: SnapshotImport[] = [];
      for (const [to, e] of byTo) {
        if (!e.external && e.files.size === 0) continue; // only imported itself
        if (e.external) {
          imports.push({ to, external: true, typeOnly: e.typeOnly });
          continue;
        }
        const typeOnlyFiles = [...e.files].filter(([, t]) => t).map(([f]) => f);
        imports.push({ to, external: false, typeOnly: e.typeOnly, files: [...e.files.keys()].sort(), ...(typeOnlyFiles.length ? { typeOnlyFiles } : {}) });
      }
      files.set(p, { hash: createHash("sha1").update(c).digest("hex"), lines: countLines(c), imports });
    }
  }
  return { modules, files };
}

function dirOf(p: string): string {
  const d = posix.dirname(p);
  return d === "." ? "" : d;
}

function resolveLocal(modules: GoModule[], importPath: string): string | null {
  for (const m of modules) {
    if (importPath === m.path) return m.dir;
    if (importPath.startsWith(m.path + "/")) {
      return posix.join(m.dir, importPath.slice(m.path.length + 1));
    }
  }
  return null;
}

export function diffSnapshots(before: Snapshot, after: Snapshot): { files: FileNode[]; edges: Edge[]; modules: GoModule[] } {
  const files: FileNode[] = [];
  const edges: Edge[] = [];
  const all = new Set([...before.files.keys(), ...after.files.keys()]);

  for (const path of [...all].sort()) {
    const b = before.files.get(path);
    const a = after.files.get(path);
    const status = !b ? "added" : !a ? "removed" : a.hash === b.hash ? "unchanged" : "modified";
    files.push({
      path,
      dir: dirOf(path),
      status,
      linesBefore: b?.lines ?? null,
      linesAfter: a?.lines ?? null,
      isTest: path.endsWith("_test.go") || (isTsFile(path) && isTsTest(path)),
    });

    const bImports = new Map((b?.imports ?? []).map((i) => [i.to, i]));
    const aImports = new Map((a?.imports ?? []).map((i) => [i.to, i]));
    for (const to of new Set([...bImports.keys(), ...aImports.keys()])) {
      const ai = aImports.get(to);
      const bi = bImports.get(to);
      const edge: Edge = {
        from: path,
        to,
        external: (ai ?? bi)!.external,
        status: ai && bi ? "unchanged" : ai ? "added" : "removed",
      };
      const typeOnly = (ai ?? bi)!.typeOnly;
      if (typeOnly !== undefined) edge.typeOnly = typeOnly;
      if (ai?.files || bi?.files) {
        const bf = new Set(bi?.files ?? []);
        const af = new Set(ai?.files ?? []);
        const typeOnlyAfter = new Set(ai?.typeOnlyFiles ?? []);
        const typeOnlyBefore = new Set(bi?.typeOnlyFiles ?? []);
        edge.files = [...new Set([...bf, ...af])].sort().map((f) => {
          const status: Edge["status"] = af.has(f) && bf.has(f) ? "unchanged" : af.has(f) ? "added" : "removed";
          const typeOnly = af.has(f) ? typeOnlyAfter.has(f) : typeOnlyBefore.has(f);
          return typeOnly ? { path: f, status, typeOnly } : { path: f, status };
        });
      }
      edges.push(edge);
    }
  }

  const modules = new Map<string, GoModule>();
  for (const m of [...before.modules, ...after.modules]) modules.set(m.dir, m);
  return { files, edges, modules: [...modules.values()].sort((x, y) => x.dir.localeCompare(y.dir)) };
}

export async function analyze(cwd: string, opts: CompareOptions): Promise<DiffGraph> {
  const { root, target, base, targetLabel, baseLabel } = await resolveSources(cwd, opts);
  const [before, after] = await Promise.all([loadSnapshot(root, base), loadSnapshot(root, target)]);
  const { files, edges, modules } = diffSnapshots(before, after);
  return {
    repoRoot: root,
    targetLabel,
    baseLabel,
    modules,
    files,
    edges,
    generatedAt: new Date().toISOString(),
  };
}
