import type { DiffGraph, Edge, EdgeStatus, FileNode, GoModule } from "../../src/types";

export interface FolderEdge {
  from: string;
  to: string;
  external: boolean;
  before: number;
  after: number;
  status: EdgeStatus;
}

export interface Model {
  graph: DiffGraph;
  filesByDir: Map<string, FileNode[]>;
  edgesByFrom: Map<string, Edge[]>;
  edgesByTo: Map<string, Edge[]>;
  fileByPath: Map<string, FileNode>;
  dirs: string[];
  changedDirs: string[];
}

export function buildModel(graph: DiffGraph): Model {
  const filesByDir = new Map<string, FileNode[]>();
  const fileByPath = new Map<string, FileNode>();
  for (const f of graph.files) {
    fileByPath.set(f.path, f);
    const list = filesByDir.get(f.dir) ?? [];
    list.push(f);
    filesByDir.set(f.dir, list);
  }
  const edgesByFrom = new Map<string, Edge[]>();
  const edgesByTo = new Map<string, Edge[]>();
  for (const e of graph.edges) {
    push(edgesByFrom, e.from, e);
    push(edgesByTo, e.to, e);
  }
  const dirs = [...filesByDir.keys()].sort();
  const changed = new Set<string>();
  for (const f of graph.files) if (f.status !== "unchanged") changed.add(f.dir);
  return { graph, filesByDir, edgesByFrom, edgesByTo, fileByPath, dirs, changedDirs: [...changed].sort() };
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
}

export function folderEdgeStatus(before: number, after: number): EdgeStatus {
  if (before === 0 && after > 0) return "added";
  if (after === 0 && before > 0) return "removed";
  return "unchanged";
}

function aggregate(edges: Edge[], keyFrom: (e: Edge) => string, keyTo: (e: Edge) => string): FolderEdge[] {
  const m = new Map<string, FolderEdge>();
  for (const e of edges) {
    const from = keyFrom(e);
    const to = keyTo(e);
    const k = from + "\0" + to;
    let fe = m.get(k);
    if (!fe) {
      fe = { from, to, external: e.external, before: 0, after: 0, status: "unchanged" };
      m.set(k, fe);
    }
    if (e.status !== "added") fe.before++;
    if (e.status !== "removed") fe.after++;
  }
  for (const fe of m.values()) fe.status = folderEdgeStatus(fe.before, fe.after);
  return [...m.values()].sort((a, b) => a.to.localeCompare(b.to) || a.from.localeCompare(b.from));
}

/** Folder-level outgoing dependencies of `dir`. */
export function outgoing(model: Model, dir: string, includeExternal: boolean): FolderEdge[] {
  const edges = (model.filesByDir.get(dir) ?? []).flatMap((f) => model.edgesByFrom.get(f.path) ?? []);
  return aggregate(
    edges.filter((e) => (includeExternal || !e.external) && e.to !== dir),
    () => dir,
    (e) => e.to,
  );
}

export function moduleOf(modules: GoModule[], dir: string): GoModule | undefined {
  let best: GoModule | undefined;
  for (const m of modules) {
    if (m.dir === "" || dir === m.dir || dir.startsWith(m.dir + "/")) {
      if (!best || m.dir.length > best.dir.length) best = m;
    }
  }
  return best;
}

/** Path relative to its Go module dir, prefixed with the module dir when it differs from `contextDir`'s module. */
export function shortDir(modules: GoModule[], dir: string, contextDir?: string): string {
  const m = moduleOf(modules, dir);
  if (!m || m.dir === "") return dir || "(root)";
  const rel = dir === m.dir ? "." : dir.slice(m.dir.length + 1);
  const ctx = contextDir !== undefined ? moduleOf(modules, contextDir) : undefined;
  if (ctx && ctx.dir === m.dir) return rel;
  return `${m.dir.split("/").pop()}:${rel}`;
}

export function parentDir(dir: string): string {
  const i = dir.lastIndexOf("/");
  return i === -1 ? "" : dir.slice(0, i);
}

export function baseName(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

/* ---------------- Directory tree for the dependency map ---------------- */

export interface ChangeStats {
  added: number;
  modified: number;
  removed: number;
  total: number;
}

export interface TreeDir {
  path: string; // "" = repo root
  name: string;
  dirs: TreeDir[];
  files: FileNode[];
  stats: ChangeStats;
}

export function buildTree(model: Model): { root: TreeDir; byPath: Map<string, TreeDir> } {
  const byPath = new Map<string, TreeDir>();
  const get = (path: string): TreeDir => {
    let d = byPath.get(path);
    if (d) return d;
    d = { path, name: path === "" ? "(root)" : baseName(path), dirs: [], files: [], stats: { added: 0, modified: 0, removed: 0, total: 0 } };
    byPath.set(path, d);
    if (path !== "") get(parentDir(path)).dirs.push(d);
    return d;
  };
  get("");
  for (const f of model.graph.files) {
    get(f.dir).files.push(f);
    // accumulate stats on all ancestors
    let p: string | null = f.dir;
    while (p !== null) {
      const d = get(p);
      d.stats.total++;
      if (f.status !== "unchanged") d.stats[f.status]++;
      p = p === "" ? null : parentDir(p);
    }
  }
  for (const d of byPath.values()) {
    d.dirs.sort((a, b) => a.name.localeCompare(b.name));
    d.files.sort((a, b) => a.path.localeCompare(b.path));
  }
  return { root: get(""), byPath };
}

export function ancestorsOf(dir: string): string[] {
  const out: string[] = [];
  let p = dir;
  while (p !== "") {
    p = parentDir(p);
    if (p !== "") out.unshift(p);
  }
  return out;
}

export function dirStatus(s: ChangeStats): "added" | "removed" | "modified" | "unchanged" {
  if (s.added + s.modified + s.removed === 0) return "unchanged";
  if (s.added === s.total) return "added";
  if (s.removed === s.total) return "removed";
  return "modified";
}
