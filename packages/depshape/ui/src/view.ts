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
  // the folders a changed file sits in, and the folders above them
  const base = new Set<string>([""]);
  for (const f of model.graph.files) {
    if (f.status === "unchanged") continue;
    base.add(f.dir);
    for (const a of ancestorsOf(f.dir)) base.add(a);
  }
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
