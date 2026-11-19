import type { FileNode } from "../../src/types";
import { ancestorsOf, baseName, dirStatus, type Model, type TreeDir } from "./model";

/*
 * What the dependency map shows, before any coordinates are assigned.
 *
 * - "all" mode: the whole repository tree; folders open/close via `expanded`.
 * - "changes" mode (like fileshape's 変更 tree and a GitHub PR): only the changed files and the
 *   folders they sit in. Unchanged files are seen in "all" mode, and what a file imports in the panel.
 */

export type MapMode = "changes" | "all";
export type ViewKind = "open" | "dir" | "file";

export interface ViewNode {
  id: string;
  kind: ViewKind;
  /** folder path for open/dir, file path for files */
  path: string;
  label: string;
  status: "added" | "removed" | "modified" | "unchanged";
  dir?: TreeDir;
  file?: FileNode;
  /** open folders: every child is shown (false = pruned to the changes) */
  full?: boolean;
  /** changes view: an open folder the user folded away (shown as one row) */
  collapsed?: boolean;
  children: ViewNode[];
}

export interface View {
  roots: ViewNode[];
  /** file path -> id of the node that stands for it (absent = not shown) */
  fileRep: Map<string, string>;
  /** package dir -> id of the node that stands for it (absent = not shown) */
  pkgRep: Map<string, string>;
}

export const dirId = (p: string) => (p === "" ? "root" : `d:${p}`);
export const fileId = (p: string) => `f:${p}`;
export const pathOf = (id: string) => (id === "root" ? "" : id.slice(2));

function dirNode(d: TreeDir, kind: "open" | "dir", children: ViewNode[], full: boolean): ViewNode {
  return { id: dirId(d.path), kind, path: d.path, label: d.name, status: dirStatus(d.stats), dir: d, full, children };
}

function fileNode(f: FileNode): ViewNode {
  return { id: fileId(f.path), kind: "file", path: f.path, label: baseName(f.path), status: f.status, file: f, children: [] };
}

export function buildAllView(root: TreeDir, expanded: Set<string>): View {
  const walk = (d: TreeDir): ViewNode[] => {
    const out: ViewNode[] = [];
    for (const sub of d.dirs) {
      const open = expanded.has(sub.path);
      out.push(dirNode(sub, open ? "open" : "dir", open ? walk(sub) : [], true));
    }
    if (d.path === "" || expanded.has(d.path)) for (const f of d.files) out.push(fileNode(f));
    return out;
  };
  return withReps(walk(root));
}

export function buildChangesView(model: Model, root: TreeDir, collapsed: Set<string> = new Set()): View {
  const base = changesFolders(model, "changes")!;
  const walk = (d: TreeDir): ViewNode[] => {
    const out: ViewNode[] = [];
    for (const sub of d.dirs) {
      if (!base.has(sub.path)) continue;
      out.push(collapsed.has(sub.path) ? { ...dirNode(sub, "open", [], false), collapsed: true } : compress(dirNode(sub, "open", walk(sub), false)));
    }
    for (const f of d.files) if (f.status !== "unchanged") out.push(fileNode(f));
    return out;
  };
  return withReps(walk(root));
}

/**
 * Folds a chain of folders that hold nothing but one shown folder into one row,
 * e.g. "apps/api/internal/", like GitHub's file tree.
 */
function compress(n: ViewNode): ViewNode {
  if (n.kind !== "open" || n.full || n.collapsed || n.children.length !== 1) return n;
  const c = n.children[0];
  if (c.kind !== "open") return n;
  return { ...c, label: `${n.label}/${c.label}` };
}

function withReps(roots: ViewNode[]): View {
  const fileRep = new Map<string, string>();
  const pkgRep = new Map<string, string>();
  const cover = (d: TreeDir, id: string) => {
    pkgRep.set(d.path, id);
    for (const f of d.files) fileRep.set(f.path, id);
    for (const s of d.dirs) cover(s, id);
  };
  const visit = (n: ViewNode) => {
    switch (n.kind) {
      case "file":
        fileRep.set(n.path, n.id);
        break;
      case "dir":
        cover(n.dir!, n.id);
        break;
      case "open":
        // a folded folder stands for everything inside it, like a closed one
        if (n.collapsed) cover(n.dir!, n.id);
        else pkgRep.set(n.path, n.id);
        break;
    }
    n.children.forEach(visit);
  };
  roots.forEach(visit);
  return { roots, fileRep, pkgRep };
}

/** Something ⌘F found in the tree: a folder or a file whose name holds the query */
export interface FindItem {
  kind: "dir" | "file";
  path: string;
  /** The folders to open so its row shows (in "changes" mode: to unfold) */
  reveal: string[];
}

/**
 * The folders and files whose name holds the query, in the tree's order. "changes" looks among what that
 * view can show (the changed files and their folders), "all" through the whole repository.
 */
export function findItems(model: Model, root: TreeDir, mode: MapMode, query: string, caseSensitive: boolean, limit = Infinity): FindItem[] {
  const out: FindItem[] = [];
  if (!query) return out;
  const q = caseSensitive ? query : query.toLowerCase();
  const has = (name: string) => (caseSensitive ? name : name.toLowerCase()).includes(q);
  const shows = changesFolders(model, mode);
  const walk = (d: TreeDir, above: string[]) => {
    const inside = d.path === "" ? above : [...above, d.path];
    for (const sub of d.dirs) {
      if (out.length >= limit) return;
      if (shows && !shows.has(sub.path)) continue;
      if (has(sub.name)) out.push({ kind: "dir", path: sub.path, reveal: inside });
      walk(sub, inside);
    }
    for (const f of d.files) {
      if (out.length >= limit) return;
      if (mode === "changes" && f.status === "unchanged") continue;
      if (has(baseName(f.path))) out.push({ kind: "file", path: f.path, reveal: inside });
    }
  };
  walk(root, []);
  return out;
}

/** "changes": the folders a changed file sits in, and the folders above them; undefined for "all" */
function changesFolders(model: Model, mode: MapMode): Set<string> | undefined {
  if (mode === "all") return undefined;
  const out = new Set<string>([""]);
  for (const f of model.graph.files) {
    if (f.status === "unchanged") continue;
    out.add(f.dir);
    for (const a of ancestorsOf(f.dir)) out.add(a);
  }
  return out;
}

/**
 * The row that shows each folder and file of a view, and where the folder's name starts in that row's
 * text: a chain of folders folded into one row ("apps/api/") shows each of them.
 */
export function rowsOf(view: View): Map<string, { id: string; offset: number }> {
  const out = new Map<string, { id: string; offset: number }>();
  const visit = (n: ViewNode) => {
    if (n.kind === "file") out.set(fileId(n.path), { id: n.id, offset: 0 });
    else {
      const names = n.label.split("/");
      const parts = n.path.split("/");
      let offset = 0;
      names.forEach((name, i) => {
        out.set(dirId(parts.slice(0, parts.length - names.length + i + 1).join("/")), { id: n.id, offset });
        offset += name.length + 1;
      });
    }
    n.children.forEach(visit);
  };
  view.roots.forEach(visit);
  return out;
}
