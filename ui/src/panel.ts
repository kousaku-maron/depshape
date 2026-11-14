import type { EdgeStatus, FileNode } from "../../src/types";
import { baseName, dirStatus, folderEdgeStatus, parentDir, shortDir, type Model, type TreeDir } from "./model";

/*
 * Data for the dependency panel: the pinned / hovered items ("sources") on the
 * left, the packages they import ("targets") on the right, and the links between.
 *
 * Source ids follow the tree's node ids:
 *   f:<file>   one file
 *   d:<dir>    a folder, i.e. every file under it (imports inside the folder are skipped)
 *   r:<dir>    the unchanged files directly in a folder (the tree's "ほか N ファイル" row)
 */

export interface PanelSource {
  id: string;
  kind: "file" | "dir" | "rest";
  label: string;
  /** repo-relative path shown on hover */
  path: string;
  status: "added" | "removed" | "modified" | "unchanged";
  files: FileNode[];
  pinned: boolean;
}

export interface PanelTarget {
  id: string;
  dir: string;
  label: string;
  external: boolean;
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
}

export interface PanelData {
  sources: PanelSource[];
  targets: PanelTarget[];
  links: PanelLink[];
  /** folder shared by every internal target, stripped from their labels ("" = none) */
  targetPrefix: string;
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
    return { id, kind: "file", label: `${baseName(f.dir)}/${baseName(f.path)}`, path, status: f.status, files: [f], pinned };
  }
  if (id.startsWith("d:")) {
    const d = tree.get(path);
    if (!d) return null;
    return { id, kind: "dir", label: `${d.name}/`, path, status: dirStatus(d.stats), files: filesUnder(d), pinned };
  }
  if (id.startsWith("r:")) {
    const d = tree.get(path);
    if (!d) return null;
    const files = d.files.filter((f) => f.status === "unchanged");
    return { id, kind: "rest", label: `${d.name}/ のほか ${files.length} ファイル`, path, status: "unchanged", files, pinned };
  }
  return null;
}

/** Every package a source imports, with before/after counts per target (keyed by target id). */
export function sourceLinks(
  model: Model,
  s: PanelSource,
  includeExternal: boolean,
): Map<string, { target: PanelTarget; link: PanelLink }> {
  const out = new Map<string, { target: PanelTarget; link: PanelLink }>();
  const scope = s.kind === "dir" ? s.path : null;
  for (const f of s.files) {
    for (const e of model.edgesByFrom.get(f.path) ?? []) {
      if (e.external && !includeExternal) continue;
      // a folder's imports of its own subfolders are internal to it
      if (scope !== null && !e.external && (e.to === scope || e.to.startsWith(scope + "/"))) continue;
      const tid = e.external ? `x:${e.to}` : `d:${e.to}`;
      let entry = out.get(tid);
      if (!entry) {
        entry = {
          target: { id: tid, dir: e.to, label: e.external ? e.to : shortDir(model.graph.modules, e.to), external: e.external },
          link: { from: s.id, to: tid, before: 0, after: 0, added: 0, removed: 0, status: "unchanged" },
        };
        out.set(tid, entry);
      }
      const l = entry.link;
      if (e.status !== "added") l.before++;
      if (e.status !== "removed") l.after++;
      if (e.status === "added") l.added++;
      if (e.status === "removed") l.removed++;
    }
  }
  for (const { link } of out.values()) link.status = folderEdgeStatus(link.before, link.after);
  return out;
}

export function buildPanel(
  model: Model,
  tree: Map<string, TreeDir>,
  pins: string[],
  hovered: string | null,
  includeExternal: boolean,
): PanelData {
  const ids = hovered && !pins.includes(hovered) ? [...pins, hovered] : pins;
  const sources = ids
    .map((id) => resolveSource(model, tree, id, pins.includes(id)))
    .filter((s): s is PanelSource => s !== null);

  const targets = new Map<string, PanelTarget>();
  const links = new Map<string, PanelLink>();
  for (const s of sources) {
    for (const { target, link } of sourceLinks(model, s, includeExternal).values()) {
      if (!targets.has(target.id)) targets.set(target.id, target);
      links.set(s.id + "\0" + target.id, link);
    }
  }

  // targets usually live under one folder (e.g. api/internal); show that once instead of on every row
  const internal = [...targets.values()].filter((t) => !t.external);
  const targetPrefix = commonParent(internal.map((t) => t.dir));
  if (targetPrefix) for (const t of internal) t.label = t.dir.slice(targetPrefix.length + 1);

  // order targets by the average row of the sources pointing at them, which keeps crossings low
  const row = new Map(sources.map((s, i) => [s.id, i]));
  const bary = new Map<string, number>();
  for (const t of targets.keys()) {
    const rows = [...links.values()].filter((l) => l.to === t).map((l) => row.get(l.from)!);
    bary.set(t, rows.reduce((a, b) => a + b, 0) / rows.length);
  }
  const sorted = [...targets.values()].sort(
    (a, b) => bary.get(a.id)! - bary.get(b.id)! || Number(a.external) - Number(b.external) || a.label.localeCompare(b.label),
  );
  return { sources, targets: sorted, links: [...links.values()], targetPrefix };
}
