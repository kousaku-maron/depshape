import type { Edge, EdgeStatus, FileNode } from "../../src/types";
import { baseName, dirStatus, folderEdgeStatus, parentDir, shortDir, type Model, type TreeDir } from "./model";

/*
 * Data for the dependency panel: the pinned / hovered items ("sources") on the
 * left, the packages they import ("targets") on the right, and the links between.
 *
 * Source ids follow the tree's node ids:
 *   f:<file>   one file
 *   d:<dir>    a folder, i.e. every file under it (imports inside the folder are skipped)
 *   r:<dir>    the unchanged files directly in a folder (the tree's "ほか N ファイル" row)
 *   p:<dir>    the files directly in a folder, i.e. one Go package (pinned from a package row)
 *
 * Targets are laid out as a folder tree, like dependency-cruiser's folder clusters:
 *   g:<dir>    a folder grouping imported folders below it; folded, it stands for all of them
 *   d:<dir>    an imported folder (a Go package, or the folder of imported TS files);
 *              when imported folders sit below it too, TS lists its imported files right in the
 *              group (like dependency-cruiser's file nodes inside a folder cluster) and Go shows
 *              a "<name>（パッケージ）" row
 *   t:<file>   one imported file (TS only)
 *   x:<name>   an external package
 *
 * Dependents (who imports the sources) are a third column on the far left, laid out the same way;
 * their ids carry an "i:" prefix: i:g:<dir>, i:d:<dir> (importing files directly in the folder),
 * i:f:<file>. A dependent link goes from such a row to a source (L:i:f:a.ts>f:b.ts).
 */

export interface PanelSource {
  id: string;
  kind: "file" | "dir" | "rest" | "package";
  label: string;
  /** repo-relative path shown on hover */
  path: string;
  status: "added" | "removed" | "modified" | "unchanged";
  files: FileNode[];
  pinned: boolean;
  /** text after the path that is not part of it (" のほか N ファイル", "（パッケージ）") */
  suffix?: string;
  /** imports into this folder are internal and not drawn (a folder source, and everything opened from it) */
  scope?: string;
  /** nesting level: rows opened from a folder sit under it */
  depth: number;
  parent?: string;
  /** folders (and "変更のない N ファイル" rows) open in place into what they stand for */
  canOpen?: boolean;
  open?: boolean;
}

export interface PanelTarget {
  id: string;
  kind: "group" | "dir" | "file" | "external";
  /** folder of the target (for a file, the folder it sits in) */
  dir: string;
  /** text on the row (relative to the row above it) */
  label: string;
  /** path below the panel's common folder, for tooltips */
  fullLabel: string;
  external: boolean;
  /** nesting level in the target tree */
  depth: number;
  /** the row this one sits under */
  parent?: string;
  /** file rows: the imported file */
  file?: string;
  /** Go: a package row for a folder that also has imported packages below it */
  self?: boolean;
  /** group rows, and folder rows with imported files (TS), can be opened and folded */
  canOpen?: boolean;
  open?: boolean;
  /** folder rows: distinct files imported from the folder by the shown sources (0 for Go) */
  fileCount?: number;
  /** group rows: imported folders below (a Go package row counts as one) */
  folderCount?: number;
  /** group rows (TS): files imported directly from the group's folder */
  directFileCount?: number;
}

export interface PanelLink {
  from: string;
  to: string;
  /** files importing the target before / after the change */
  before: number;
  after: number;
  added: number;
  removed: number;
  status: EdgeStatus;
  /** TS: every import behind this link is type-only */
  typeOnly?: boolean;
  /** TS: the exact files imported in the target (status across all sources of the link) */
  files?: { path: string; status: EdgeStatus; typeOnly?: boolean }[];
}

export const fileTargetId = (path: string) => `t:${path}`;

export interface PanelData {
  sources: PanelSource[];
  /** rows of the target tree, top to bottom */
  targets: PanelTarget[];
  links: PanelLink[];
  /** folder shared by every internal target, stripped from their labels ("" = none) */
  targetPrefix: string;
  /** the same for the sources on the left (rows opened from a folder keep just their name) */
  sourcePrefix: string;
  /** who imports the sources: rows of a folder tree (kinds group / dir / file) */
  dependents: PanelTarget[];
  /** links from dependent rows to sources */
  inLinks: PanelLink[];
  dependentPrefix: string;
}

/** Deepest folder containing the parents of all `dirs` (so every label keeps at least its own name). */
export function commonParent(dirs: string[]): string {
  if (dirs.length === 0) return "";
  const split = dirs.map((d) => (parentDir(d) ? parentDir(d).split("/") : []));
  const out: string[] = [];
  for (let i = 0; ; i++) {
    const seg = split[0][i];
    if (seg === undefined || split.some((p) => p[i] !== seg)) break;
    out.push(seg);
  }
  return out.join("/");
}

function filesUnder(d: TreeDir): FileNode[] {
  return [...d.files, ...d.dirs.flatMap(filesUnder)];
}

export function resolveSource(model: Model, tree: Map<string, TreeDir>, id: string, pinned: boolean): PanelSource | null {
  const path = id.slice(2);
  if (id.startsWith("f:")) {
    const f = model.fileByPath.get(path);
    if (!f) return null;
    return { id, kind: "file", label: `${baseName(f.dir)}/${baseName(f.path)}`, path, status: f.status, files: [f], pinned, depth: 0 };
  }
  if (id.startsWith("d:")) {
    const d = tree.get(path);
    if (!d) return null;
    return { id, kind: "dir", label: `${d.name}/`, path, status: dirStatus(d.stats), files: filesUnder(d), pinned, scope: path, depth: 0 };
  }
  if (id.startsWith("r:")) {
    const d = tree.get(path);
    if (!d) return null;
    const files = d.files.filter((f) => f.status === "unchanged");
    return { id, kind: "rest", label: `${d.name}/`, suffix: ` のほか ${files.length} ファイル`, path, status: "unchanged", files, pinned, depth: 0 };
  }
  if (id.startsWith("p:")) {
    const d = tree.get(path);
    if (!d) return null;
    const stats = { added: 0, modified: 0, removed: 0, total: d.files.length };
    for (const f of d.files) if (f.status !== "unchanged") stats[f.status]++;
    return { id, kind: "package", label: d.name, suffix: "（パッケージ）", path, status: dirStatus(stats), files: d.files, pinned, depth: 0 };
  }
  return null;
}

const within = (dir: string, under: string) => under === "" || dir === under || dir.startsWith(under + "/");

/** A source's imports, without a folder's imports of its own subfolders (those are internal to it). */
function sourceEdges(model: Model, s: PanelSource, includeExternal: boolean): Edge[] {
  const out: Edge[] = [];
  for (const f of s.files) {
    for (const e of model.edgesByFrom.get(f.path) ?? []) {
      if (e.external && !includeExternal) continue;
      if (s.scope !== undefined && !e.external && within(e.to, s.scope)) continue;
      out.push(e);
    }
  }
  return out;
}

const emptyLink = (from: string, to: string): PanelLink => ({ from, to, before: 0, after: 0, added: 0, removed: 0, status: "unchanged" });

function count(l: PanelLink, status: EdgeStatus) {
  if (status !== "added") l.before++;
  if (status !== "removed") l.after++;
  if (status === "added") l.added++;
  if (status === "removed") l.removed++;
}

/** Adds the imported files of one edge; a file still imported by anyone stays, added only if nobody imported it before. */
function mergeFiles(l: PanelLink, files: Edge["files"]) {
  if (!files) return;
  const byPath = new Map((l.files ?? []).map((f) => [f.path, f]));
  for (const f of files) {
    const prev = byPath.get(f.path);
    if (!prev) byPath.set(f.path, { ...f });
    else {
      if (prev.status !== f.status) prev.status = "unchanged";
      if (!f.typeOnly) delete prev.typeOnly;
    }
  }
  l.files = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export interface SourceLink {
  target: { id: string; dir: string; label: string; external: boolean };
  link: PanelLink;
  /** TS: the same dependency split per imported file (keyed by t:<file>) */
  fileLinks: Map<string, PanelLink>;
}

/** Every package a source imports, with before/after counts per target (keyed by d:<dir> / x:<name>). */
export function sourceLinks(model: Model, s: PanelSource, includeExternal: boolean): Map<string, SourceLink> {
  const out = new Map<string, SourceLink>();
  for (const e of sourceEdges(model, s, includeExternal)) {
    const tid = e.external ? `x:${e.to}` : `d:${e.to}`;
    let entry = out.get(tid);
    if (!entry) {
      entry = {
        target: { id: tid, dir: e.to, label: e.external ? e.to : shortDir(model.graph.modules, e.to), external: e.external },
        link: emptyLink(s.id, tid),
        fileLinks: new Map(),
      };
      out.set(tid, entry);
    }
    const l = entry.link;
    count(l, e.status);
    if (e.typeOnly !== undefined) l.typeOnly = (l.typeOnly ?? true) && e.typeOnly;
    for (const f of e.files ?? []) {
      const id = fileTargetId(f.path);
      let fl = entry.fileLinks.get(id);
      if (!fl) entry.fileLinks.set(id, (fl = emptyLink(s.id, id)));
      count(fl, f.status);
      fl.typeOnly = (fl.typeOnly ?? true) && !!f.typeOnly;
    }
    mergeFiles(l, e.files);
  }
  for (const { link, fileLinks } of out.values()) {
    link.status = folderEdgeStatus(link.before, link.after);
    for (const fl of fileLinks.values()) {
      fl.status = folderEdgeStatus(fl.before, fl.after);
      if (!fl.typeOnly) delete fl.typeOnly;
    }
  }
  return out;
}

/**
 * One link standing for every import of `s` into `dir` and the folders below it (a folded group).
 * Counted per importing file, so a file that imports two subfolders counts once.
 */
export function groupLink(model: Model, s: PanelSource, dir: string, id = `g:${dir}`): PanelLink | null {
  const l = emptyLink(s.id, id);
  const per = new Map<string, { before: boolean; after: boolean }>();
  let typeOnly = true;
  for (const e of sourceEdges(model, s, false)) {
    if (e.external || !within(e.to, dir)) continue;
    const p = per.get(e.from) ?? { before: false, after: false };
    if (e.status !== "added") p.before = true;
    if (e.status !== "removed") p.after = true;
    per.set(e.from, p);
    typeOnly &&= e.typeOnly === true;
    mergeFiles(l, e.files);
  }
  if (per.size === 0) return null;
  for (const p of per.values()) {
    if (p.before) l.before++;
    if (p.after) l.after++;
    if (!p.before && p.after) l.added++;
    if (p.before && !p.after) l.removed++;
  }
  l.status = folderEdgeStatus(l.before, l.after);
  if (typeOnly) l.typeOnly = true;
  return l;
}

/**
 * What a source opens into: its subfolders, then the files directly in it, like the tree on the left
 * (changed files stand out by their colour). Only rows that draw a link are kept; imports inside the
 * opened folder stay hidden.
 */
export function sourceChildren(model: Model, tree: Map<string, TreeDir>, s: PanelSource, includeExternal: boolean): PanelSource[] {
  const mk = (id: string) => {
    const c = resolveSource(model, tree, id, s.pinned);
    if (!c) return null;
    c.scope = s.scope ?? c.scope;
    if (c.kind === "file") c.label = baseName(c.path);
    return c;
  };
  let kids: (PanelSource | null)[] = [];
  if (s.kind === "dir") {
    const d = tree.get(s.path);
    if (!d) return [];
    kids = [...d.dirs.map((sub) => mk(`d:${sub.path}`)), ...d.files.map((f) => mk(`f:${f.path}`))];
  } else if (s.kind === "rest" || s.kind === "package") {
    kids = s.files.map((f) => mk(`f:${f.path}`));
  }
  return kids.filter((c): c is PanelSource => c !== null && sourceEdges(model, c, includeExternal).length > 0);
}

/** The link a comment key points at: a folder / package, a folded group, or one file of an opened folder. */
export interface DependentFile {
  before: boolean;
  after: boolean;
  typeOnly: boolean;
}

/**
 * Files importing a source, before and after the change: for TS the files that import one of its
 * files, for Go the files that import its package. Files of the source itself (and, for a folder,
 * files inside it) are not dependents.
 */
export function dependentFiles(model: Model, s: PanelSource): Map<string, DependentFile> {
  const own = new Set(s.files.map((f) => f.path));
  const dirs = new Set(s.files.map((f) => f.dir));
  const out = new Map<string, DependentFile>();
  for (const e of model.graph.edges) {
    if (e.external || own.has(e.from)) continue;
    if (s.scope !== undefined && within(parentDir(e.from), s.scope)) continue;
    let hit: DependentFile;
    if (e.files) {
      const hits = e.files.filter((f) => own.has(f.path));
      if (!hits.length) continue;
      hit = { before: hits.some((f) => f.status !== "added"), after: hits.some((f) => f.status !== "removed"), typeOnly: hits.every((f) => !!f.typeOnly) };
    } else {
      if (!dirs.has(e.to)) continue;
      hit = { before: e.status !== "added", after: e.status !== "removed", typeOnly: false };
    }
    const prev = out.get(e.from);
    if (!prev) out.set(e.from, hit);
    else {
      prev.before ||= hit.before;
      prev.after ||= hit.after;
      prev.typeOnly &&= hit.typeOnly;
    }
  }
  return out;
}

/** One link standing for some importing files (each counted once). */
function dependentLink(from: string, to: string, files: DependentFile[]): PanelLink | null {
  if (!files.length) return null;
  const l = emptyLink(from, to);
  for (const f of files) {
    if (f.before) l.before++;
    if (f.after) l.after++;
    if (!f.before && f.after) l.added++;
    if (f.before && !f.after) l.removed++;
  }
  l.status = folderEdgeStatus(l.before, l.after);
  if (files.every((f) => f.typeOnly)) l.typeOnly = true;
  return l;
}

/** Which importing files a dependent row stands for. */
function dependentMatch(id: string): (file: string) => boolean {
  const p = id.slice(4);
  if (id.startsWith("i:f:")) return (f) => f === p;
  if (id.startsWith("i:d:")) return (f) => parentDir(f) === p;
  return (f) => within(parentDir(f), p);
}

export function findLink(model: Model, tree: Map<string, TreeDir>, from: string, to: string): PanelLink | null {
  if (from.startsWith("i:")) {
    const src = resolveSource(model, tree, to, false);
    if (!src) return null;
    const match = dependentMatch(from);
    return dependentLink(from, to, [...dependentFiles(model, src)].filter(([f]) => match(f)).map(([, v]) => v));
  }
  const s = resolveSource(model, tree, from, false);
  if (!s) return null;
  if (to.startsWith("g:")) return groupLink(model, s, to.slice(2), to);
  const links = sourceLinks(model, s, true);
  if (!to.startsWith("t:")) return links.get(to)?.link ?? null;
  return links.get(`d:${parentDir(to.slice(2))}`)?.fileLinks.get(to) ?? null;
}

/* ---------------- the target tree ---------------- */

interface TrieNode {
  dir: string;
  target: boolean;
  children: Map<string, TrieNode>;
}

type TreeItem = { kind: "group"; dir: string; label: string; children: TreeItem[] } | { kind: "dir"; dir: string; label: string; self: boolean };

/** Folder tree of the imported folders; chains of single folders are joined into one row ("features/invoices"). */
function targetTree(dirs: string[], prefix: string): TreeItem[] {
  const root: TrieNode = { dir: prefix, target: false, children: new Map() };
  // the repo root itself (files at the top level) has no folder name to nest under
  const atRoot = dirs.includes(prefix);
  for (const d of dirs) {
    if (d === prefix) continue;
    let n = root;
    for (const seg of (prefix ? d.slice(prefix.length + 1) : d).split("/")) {
      const dir = n.dir ? `${n.dir}/${seg}` : seg;
      let c = n.children.get(seg);
      if (!c) n.children.set(seg, (c = { dir, target: false, children: new Map() }));
      n = c;
    }
    n.target = true;
  }
  const items = (n: TrieNode, label: string): TreeItem[] => {
    const kids = [...n.children.values()];
    if (!n.target && kids.length === 1) return items(kids[0], `${label}/${baseName(kids[0].dir)}`);
    if (kids.length === 0) return [{ kind: "dir", dir: n.dir, label, self: false }];
    const children = kids.flatMap((k) => items(k, baseName(k.dir)));
    if (n.target) children.push({ kind: "dir", dir: n.dir, label: `${baseName(n.dir)}（パッケージ）`, self: true });
    return [{ kind: "group", dir: n.dir, label, children }];
  };
  const out = [...root.children.values()].flatMap((k) => items(k, baseName(k.dir)));
  if (atRoot) out.push({ kind: "dir", dir: prefix, label: prefix ? `${baseName(prefix)}（パッケージ）` : "(ルート)", self: true });
  return out;
}

/**
 * @param targetOpen rows the user opened or folded; by default groups are open and folders folded
 */
export function buildPanel(
  model: Model,
  tree: Map<string, TreeDir>,
  pins: string[],
  hovered: string | null,
  includeExternal: boolean,
  targetOpen: ReadonlyMap<string, boolean> = new Map(),
  sourceOpen: ReadonlyMap<string, boolean> = new Map(),
): PanelData {
  const ids = hovered && !pins.includes(hovered) ? [...pins, hovered] : pins;
  // pins in pin order; an opened folder is followed by what it opens into (each item shown once)
  const sources: PanelSource[] = [];
  const seen = new Set<string>();
  const addSource = (s: PanelSource, depth: number, parent: string | undefined) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    const kids = s.kind === "file" ? [] : sourceChildren(model, tree, s, includeExternal);
    Object.assign(s, { depth, parent, canOpen: kids.length > 0, open: kids.length > 0 && (sourceOpen.get(s.id) ?? false) });
    sources.push(s);
    if (s.open) for (const k of kids) addSource(k, depth + 1, s.id);
  };
  for (const id of ids) {
    const s = resolveSource(model, tree, id, pins.includes(id));
    if (s) addSource(s, 0, undefined);
  }
  // like the targets: the folder all pins share is shown once, and each pin is labelled with its path below it
  const tops = sources.filter((s) => s.depth === 0);
  const sourcePrefix = commonParent(tops.map((s) => s.path));
  for (const s of tops) {
    const p = sourcePrefix ? s.path.slice(sourcePrefix.length + 1) : s.path;
    s.label = s.kind === "dir" || s.kind === "rest" ? `${p}/` : p;
  }
  // an opened row draws nothing itself: its links come from the rows under it
  const bySource = sources.map((s) => (s.open ? new Map<string, SourceLink>() : sourceLinks(model, s, includeExternal)));

  const internal = new Set<string>();
  const external = new Map<string, SourceLink["target"]>();
  for (const sl of bySource)
    for (const { target } of sl.values()) {
      if (target.external) external.set(target.id, target);
      else internal.add(target.dir);
    }

  // targets usually live under one folder (e.g. api/internal); show that once instead of on every row
  const targetPrefix = commonParent([...internal]);
  const rel = (p: string) => (targetPrefix ? p.slice(targetPrefix.length + 1) : p);

  // siblings are ordered by the average row of the sources pointing into them, which keeps crossings low
  const bary = (match: (tid: string) => boolean) => {
    let sum = 0;
    let n = 0;
    bySource.forEach((sl, i) => {
      for (const tid of sl.keys())
        if (match(tid)) {
          sum += i;
          n++;
        }
    });
    return n ? sum / n : 0;
  };
  const itemBary = (it: TreeItem) => bary((tid) => tid.startsWith("d:") && (it.kind === "group" ? within(tid.slice(2), it.dir) : tid.slice(2) === it.dir));
  const sortItems = (items: TreeItem[]) =>
    [...items].sort((a, b) => {
      // like the tree on the left: folders first, then what sits directly in the folder
      const sa = a.kind === "dir" && a.self ? 1 : 0;
      const sb = b.kind === "dir" && b.self ? 1 : 0;
      return sa - sb || itemBary(a) - itemBary(b) || a.label.localeCompare(b.label);
    });

  const rows: PanelTarget[] = [];
  const links: PanelLink[] = [];
  /** per-file links of a folder target across all sources (TS) */
  const filesOf = (id: string) => {
    const fileLinks = bySource.flatMap((sl) => [...(sl.get(id)?.fileLinks.values() ?? [])]);
    return { fileLinks, files: [...new Set(fileLinks.map((l) => l.to))] };
  };
  const emit = (it: TreeItem, depth: number, parent: string | undefined) => {
    if (it.kind === "group") {
      const id = `g:${it.dir}`;
      const open = targetOpen.get(id) ?? true;
      const below = [...internal].filter((d) => d !== it.dir && within(d, it.dir)).length;
      const direct = internal.has(it.dir) ? filesOf(`d:${it.dir}`).files.length : 0;
      const isPackage = internal.has(it.dir) && direct === 0;
      rows.push({
        id,
        kind: "group",
        dir: it.dir,
        label: it.label,
        fullLabel: rel(it.dir),
        external: false,
        depth,
        parent,
        canOpen: true,
        open,
        folderCount: below + (isPackage ? 1 : 0),
        directFileCount: direct,
      });
      if (open) for (const c of sortItems(it.children)) emit(c, depth + 1, id);
      else
        for (const s of sources) {
          if (s.open) continue;
          const l = groupLink(model, s, it.dir, id);
          if (l) links.push(l);
        }
      return;
    }
    const id = `d:${it.dir}`;
    const { fileLinks, files } = filesOf(id);
    const fileBary = (f: string) => bary((tid) => tid === id && bySource.some((sl) => sl.get(tid)?.fileLinks.has(f)));
    const fileRows = (d: number, under: string | undefined) => {
      files.sort((a, b) => fileBary(a) - fileBary(b) || a.localeCompare(b));
      for (const fid of files) {
        const path = fid.slice(2);
        rows.push({ id: fid, kind: "file", dir: it.dir, label: baseName(path), fullLabel: rel(path), external: false, depth: d, parent: under, file: path });
      }
      links.push(...fileLinks);
    };
    // TS: the files imported straight from a group's folder sit right in the group, next to its subfolders
    if (it.self && files.length > 0) {
      fileRows(depth, parent);
      return;
    }
    const open = files.length > 0 && (targetOpen.get(id) ?? false);
    rows.push({
      id,
      kind: "dir",
      dir: it.dir,
      label: it.label,
      fullLabel: it.self ? `${rel(it.dir)}（パッケージ）` : rel(it.dir),
      external: false,
      depth,
      parent,
      self: it.self,
      canOpen: files.length > 0,
      open,
      fileCount: files.length,
    });
    if (!open) {
      for (const sl of bySource) {
        const l = sl.get(id)?.link;
        if (l) links.push(l);
      }
      return;
    }
    fileRows(depth + 1, id);
  };
  for (const it of sortItems(targetTree([...internal], targetPrefix))) emit(it, 0, undefined);

  const ext = [...external.values()].sort((a, b) => bary((t) => t === a.id) - bary((t) => t === b.id) || a.label.localeCompare(b.label));
  for (const t of ext) {
    rows.push({ id: t.id, kind: "external", dir: t.dir, label: t.label, fullLabel: t.label, external: true, depth: 0 });
    for (const sl of bySource) {
      const l = sl.get(t.id)?.link;
      if (l) links.push(l);
    }
  }
  // ---- dependents: who imports the sources, as a folder tree like the targets ----
  const depBy = sources.map((s) => (s.open ? new Map<string, DependentFile>() : dependentFiles(model, s)));
  const importers = new Set(depBy.flatMap((m) => [...m.keys()]));
  const depDirs = new Set([...importers].map(parentDir));
  const dependentPrefix = commonParent([...depDirs]);
  const depRel = (p: string) => (dependentPrefix ? p.slice(dependentPrefix.length + 1) : p);
  const depBary = (match: (f: string) => boolean) => {
    let sum = 0;
    let n = 0;
    depBy.forEach((m, i) => {
      for (const f of m.keys())
        if (match(f)) {
          sum += i;
          n++;
        }
    });
    return n ? sum / n : 0;
  };
  const depLinks = (rowId: string) => {
    const match = dependentMatch(rowId);
    sources.forEach((s, i) => {
      const l = dependentLink(rowId, s.id, [...depBy[i]].filter(([f]) => match(f)).map(([, v]) => v));
      if (l) inLinks.push(l);
    });
  };
  const dependents: PanelTarget[] = [];
  const inLinks: PanelLink[] = [];
  const fileRowsIn = (dir: string, depth: number, parent: string | undefined) => {
    const files = [...importers].filter((f) => parentDir(f) === dir);
    files.sort((a, b) => depBary((f) => f === a) - depBary((f) => f === b) || a.localeCompare(b));
    for (const f of files) {
      const id = `i:f:${f}`;
      dependents.push({ id, kind: "file", dir, label: baseName(f), fullLabel: depRel(f), external: false, depth, parent, file: f });
      depLinks(id);
    }
  };
  const emitDep = (it: TreeItem, depth: number, parent: string | undefined) => {
    if (it.kind === "group") {
      const id = `i:g:${it.dir}`;
      const open = targetOpen.get(id) ?? true;
      dependents.push({
        id,
        kind: "group",
        dir: it.dir,
        label: it.label,
        fullLabel: depRel(it.dir),
        external: false,
        depth,
        parent,
        canOpen: true,
        open,
        folderCount: [...depDirs].filter((d) => d !== it.dir && within(d, it.dir)).length,
        directFileCount: [...importers].filter((f) => parentDir(f) === it.dir).length,
      });
      if (!open) depLinks(id);
      else
        for (const c of [...it.children].sort(
          (a, b) =>
            Number(a.kind === "dir" && a.self) - Number(b.kind === "dir" && b.self) ||
            depBary((f) => (a.kind === "group" ? within(parentDir(f), a.dir) : parentDir(f) === a.dir)) -
              depBary((f) => (b.kind === "group" ? within(parentDir(f), b.dir) : parentDir(f) === b.dir)) ||
            a.label.localeCompare(b.label),
        ))
          emitDep(c, depth + 1, id);
      return;
    }
    // importing files sitting right in a group's folder are listed in the group
    if (it.self) return fileRowsIn(it.dir, depth, parent);
    const id = `i:d:${it.dir}`;
    const count = [...importers].filter((f) => parentDir(f) === it.dir).length;
    const open = targetOpen.get(id) ?? false;
    dependents.push({ id, kind: "dir", dir: it.dir, label: it.label, fullLabel: depRel(it.dir), external: false, depth, parent, canOpen: true, open, fileCount: count });
    if (open) fileRowsIn(it.dir, depth + 1, id);
    else depLinks(id);
  };
  const depItems = targetTree([...depDirs], dependentPrefix);
  const itemDepBary = (it: TreeItem) => depBary((f) => (it.kind === "group" ? within(parentDir(f), it.dir) : parentDir(f) === it.dir));
  for (const it of [...depItems].sort((a, b) => itemDepBary(a) - itemDepBary(b) || a.label.localeCompare(b.label))) emitDep(it, 0, undefined);

  return { sources, targets: rows, links, targetPrefix, sourcePrefix, dependents, inLinks, dependentPrefix };
}
