import { createHash } from "node:crypto";
import { posix } from "node:path";
import { listFiles, mergeBase, readFiles, repoRoot, resolveRev, type Source } from "./git.js";
import { isStdlib, parseGoImports, parseGoModModulePath } from "./go.js";
import type { DiffGraph, Edge, FileNode, GoModule } from "./types.js";

export interface CompareOptions {
  /** ".", "staged", "working", or any git revision. Default "." */
  target?: string;
  /** Git revision to compare with. Default depends on target. */
  base?: string;
  /** Use `git merge-base base target` as the base (like a GitHub PR). */
  mergeBase?: boolean;
}

interface Snapshot {
  modules: GoModule[];
  files: Map<string, { hash: string; lines: number; imports: { to: string; external: boolean }[] }>;
}

const EXCLUDED_SEGMENTS = new Set(["vendor", "testdata", "node_modules", ".git"]);

function isRelevant(path: string): boolean {
  const segs = path.split("/");
  if (segs.some((s) => EXCLUDED_SEGMENTS.has(s) || (s.startsWith(".") && s.length > 1) || s.startsWith("_"))) {
    return false;
  }
  const name = segs[segs.length - 1];
  return name === "go.mod" || name.endsWith(".go");
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
  const paths = (await listFiles(root, source)).filter(isRelevant);
  const contents = await readFiles(root, source, paths);

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
    files.set(p, {
      hash: createHash("sha1").update(c).digest("hex"),
      lines: c.length === 0 ? 0 : c.split("\n").length - (c.endsWith("\n") ? 1 : 0),
      imports,
    });
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
      isTest: path.endsWith("_test.go"),
    });

    const bImports = new Map((b?.imports ?? []).map((i) => [i.to, i]));
    const aImports = new Map((a?.imports ?? []).map((i) => [i.to, i]));
    for (const to of new Set([...bImports.keys(), ...aImports.keys()])) {
      const ai = aImports.get(to);
      const bi = bImports.get(to);
      edges.push({
        from: path,
        to,
        external: (ai ?? bi)!.external,
        status: ai && bi ? "unchanged" : ai ? "added" : "removed",
      });
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
