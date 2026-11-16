import type { FileNode } from "../../src/types";
import { ancestorsOf, baseName, dirStatus, type Model, type TreeDir } from "./model";

/*
 * What the dependency map shows, before any coordinates are assigned.
 *
 * - "all" mode: the whole repository tree; folders open/close via `expanded`.
 * - "changes" mode (like a GitHub PR): only changed files, the packages they
 *   (and their folder-mates) import, and the folders in between. Unchanged files
 *   of a shown folder collapse into one "ほか N ファイル" row whose edges stand
 *   for the existing pattern. Revealing a folder (`revealed`) shows everything
 *   directly inside it so new and existing files can be compared.
 */

export type MapMode = "changes" | "all";
export type ViewKind = "open" | "dir" | "file" | "rest";

export interface ViewNode {
  id: string;
  kind: ViewKind;
  /** folder path for open/dir/rest (rest = the folder whose items it hides), file path for files */
  path: string;
  label: string;
  status: "added" | "removed" | "modified" | "unchanged";
  dir?: TreeDir;
  file?: FileNode;
  /** open folders / rest groups: every child is shown (false = pruned to the changes) */
  full?: boolean;
  /** changes view: an open folder the user folded away (shown as one row) */
  collapsed?: boolean;
  /** changes view: a folder that is open only because the user revealed it (closing it un-reveals) */
  revealedOnly?: boolean;
  hiddenFiles?: FileNode[];
  hiddenDirs?: TreeDir[];
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
export const restId = (p: string) => `r:${p}`;
export const pathOf = (id: string) => (id === "root" ? "" : id.slice(2));

function dirNode(d: TreeDir, kind: "open" | "dir", children: ViewNode[], full: boolean): ViewNode {
  return { id: dirId(d.path), kind, path: d.path, label: d.name, status: dirStatus(d.stats), dir: d, full, children };
}

function fileNode(f: FileNode): ViewNode {
  return { id: fileId(f.path), kind: "file", path: f.path, label: baseName(f.path), status: f.status, file: f, children: [] };
}

export function restLabel(files: number, dirs: number): string {
  if (dirs && files) return `ほか ${dirs} フォルダ・${files} ファイル`;
  if (dirs) return `ほか ${dirs} フォルダ`;
  return `ほか ${files} ファイル`;
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

export function buildChangesView(
  model: Model,
  root: TreeDir,
  tree: Map<string, TreeDir>,
  revealed: Set<string>,
  collapsed: Set<string> = new Set(),
): View {
  // folders whose own files we look at: those with changes, and those the user revealed
  const primary = new Set<string>();
  for (const f of model.graph.files) if (f.status !== "unchanged") primary.add(f.dir);
  for (const d of revealed) if (tree.has(d)) primary.add(d);

  // packages imported by the changed files (the tree no longer draws edges, so packages used
  // only by revealed / existing files are not pulled in; the panel shows those on demand)
  const targets = new Set<string>();
  for (const f of model.graph.files) {
    if (f.status === "unchanged") continue;
    for (const e of model.edgesByFrom.get(f.path) ?? []) {
      if (!e.external && e.to !== f.dir && tree.has(e.to)) targets.add(e.to);
    }
  }

  // folders that are part of the change itself, and everything a revealed folder adds on top
  const base = new Set<string>([""]);
  for (const f of model.graph.files) {
    if (f.status === "unchanged") continue;
    base.add(f.dir);
    for (const a of ancestorsOf(f.dir)) base.add(a);
  }
  for (const t of targets) for (const a of ancestorsOf(t)) base.add(a);
  const containers = new Set(base);
  for (const d of primary) {
    containers.add(d);
    for (const a of ancestorsOf(d)) containers.add(a);
  }

  // Each folder shows its changed items first; the rest sit in one "ほか N" group that opens
  // and closes in place (open = the folder is revealed).
  const walk = (d: TreeDir): ViewNode[] => {
    const full = revealed.has(d.path);
    const out: ViewNode[] = [];
    const extra: ViewNode[] = [];
    const hiddenDirs: TreeDir[] = [];
    const hiddenFiles: FileNode[] = [];
    for (const sub of d.dirs) {
      const isBase = base.has(sub.path) || targets.has(sub.path);
      if (!isBase && !full) {
        hiddenDirs.push(sub);
        continue;
      }
      let node: ViewNode;
      if (!containers.has(sub.path)) node = dirNode(sub, "dir", [], false);
      else if (collapsed.has(sub.path) && base.has(sub.path)) node = { ...dirNode(sub, "open", [], revealed.has(sub.path)), collapsed: true };
      else node = compress({ ...dirNode(sub, "open", walk(sub), revealed.has(sub.path)), revealedOnly: !base.has(sub.path) });
      if (isBase) out.push(node);
      else {
        hiddenDirs.push(sub);
        extra.push(node);
      }
    }
    for (const f of d.files) {
      if (f.status !== "unchanged") out.push(fileNode(f));
      else {
        hiddenFiles.push(f);
        if (full) extra.push(fileNode(f));
      }
    }
    if (hiddenFiles.length || hiddenDirs.length) {
      out.push({
        id: restId(d.path),
        kind: "rest",
        path: d.path,
        label: restLabel(hiddenFiles.length, hiddenDirs.length),
        status: "unchanged",
        full,
        hiddenFiles,
        hiddenDirs,
        children: extra,
      });
    }
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
      case "rest":
        // an open rest group shows its items as rows of their own
        if (!n.full) for (const f of n.hiddenFiles ?? []) fileRep.set(f.path, n.id);
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
