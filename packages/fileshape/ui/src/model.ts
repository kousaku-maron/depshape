import { hashOf } from "@diffshape/ui";
import type { DiffChunk, DiffFile, DiffLine, PlainFile } from "../../src/types";

/*
 * What the screen derives from the diff: the file tree of the sidebar (folders with one child folder
 * joined into one row), the rows of a file with the lines around each hunk that were opened,
 * the lines side by side for the split view, and the words that changed inside a changed line.
 */

export interface TreeNode {
  name: string;
  /** Full path ("" for the root) */
  path: string;
  children: TreeNode[];
  /** A file shown in the list (a change, or an unchanged file opened from the tree) */
  file?: DiffFile;
  /** A file of the repository that is not shown (the tree's "全体" view): selecting it opens it */
  plain?: boolean;
}

const isLeaf = (n: TreeNode) => !!n.file || !!n.plain;

/**
 * The tree of the shown files, plus (the "全体" view) every other path of the repository as a plain
 * file. A whole repository has many files: each folder keeps its children by name while it is built.
 */
export function buildTree(files: DiffFile[], plain: readonly string[] = []): TreeNode {
  const root: TreeNode = { name: "", path: "", children: [] };
  const folders = new Map<TreeNode, Map<string, TreeNode>>([[root, new Map()]]);
  const shown = new Set(files.map((f) => f.path));
  const add = (path: string, leaf: Pick<TreeNode, "file" | "plain">) => {
    const parts = path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const kids = folders.get(node)!;
      let child = kids.get(parts[i]);
      if (!child) {
        child = { name: parts[i], path: parts.slice(0, i + 1).join("/"), children: [] };
        node.children.push(child);
        kids.set(parts[i], child);
        folders.set(child, new Map());
      }
      node = child;
    }
    node.children.push({ name: parts[parts.length - 1], path, children: [], ...leaf });
  };
  for (const file of files) add(file.path, { file });
  for (const path of plain) if (!shown.has(path)) add(path, { plain: true });
  return sortTree(joinSingleFolders(root));
}

/** "src" with only "app" inside becomes one row "src/app" */
function joinSingleFolders(node: TreeNode): TreeNode {
  let n = { ...node, children: node.children.map(joinSingleFolders) };
  while (n.path !== "" && !isLeaf(n) && n.children.length === 1 && !isLeaf(n.children[0])) {
    const only = n.children[0];
    n = { ...only, name: `${n.name}/${only.name}` };
  }
  return n;
}

/** Folders first, then files, each by name (the order GitHub shows) */
function sortTree(node: TreeNode): TreeNode {
  const children = node.children.map(sortTree).sort((a, b) => (isLeaf(a) !== isLeaf(b) ? (isLeaf(a) ? 1 : -1) : a.name.localeCompare(b.name)));
  return { ...node, children };
}

/** The files in the order the tree shows them, so the diff list reads the same way */
export function filesInTreeOrder(node: TreeNode): DiffFile[] {
  return node.file ? [node.file] : node.children.flatMap(filesInTreeOrder);
}

export function folderPaths(node: TreeNode): string[] {
  return isLeaf(node) ? [] : [...(node.path ? [node.path] : []), ...node.children.flatMap(folderPaths)];
}

/** Folders with a changed file somewhere inside (the "全体" view opens these at first) */
export function changedFolders(node: TreeNode): Set<string> {
  const out = new Set<string>();
  const walk = (n: TreeNode): boolean => {
    if (isLeaf(n)) return !!n.file && !n.file.unchanged;
    let any = false;
    for (const c of n.children) if (walk(c)) any = true;
    if (any && n.path) out.add(n.path);
    return any;
  };
  walk(node);
  return out;
}

/** The tree with only the files whose path contains `query` (case-insensitive) */
export function filterTree(node: TreeNode, query: string): TreeNode | null {
  const q = query.trim().toLowerCase();
  if (!q) return node;
  if (node.file) return node.file.path.toLowerCase().includes(q) || (node.file.oldPath ?? "").toLowerCase().includes(q) ? node : null;
  if (node.plain) return node.path.toLowerCase().includes(q) ? node : null;
  const children = node.children.map((c) => filterTree(c, q)).filter((c): c is TreeNode => c !== null);
  return children.length || node.path === "" ? { ...node, children } : null;
}

// ---- the lines around the hunks

/**
 * The unchanged lines git left out before hunk `index` (the last gap is after the last hunk), on the
 * target side, `from`..`to`. They are the same on the base side, `delta` lines further.
 */
export interface Gap {
  index: number;
  from: number;
  /** undefined: up to the end of the file, whose length is not known yet */
  to: number | undefined;
  delta: number;
}

/** The first / last line a chunk covers on one side (a side with no lines sits after its start line) */
const first = (start: number, count: number) => (count === 0 ? start + 1 : start);
const last = (start: number, count: number) => (count === 0 ? start : start + count - 1);

/** Whether the file has both sides, so there are lines around its hunks to open */
export const canExpand = (f: DiffFile) => !f.unchanged && f.status !== "added" && f.status !== "removed" && !f.binary && !f.large && f.chunks.length > 0;

/**
 * An unchanged file to show in the list: every line as context, in one hunk that starts at line 1.
 * `read` is undefined while its lines are being read.
 */
export function unchangedFile(path: string, read: PlainFile | undefined): DiffFile {
  const base = { path, status: "modified" as const, additions: 0, deletions: 0, unchanged: true };
  if (!read) return { ...base, chunks: [], loading: true };
  if (read.binary) return { ...base, chunks: [], binary: true };
  if (read.large || !read.lines) return { ...base, chunks: [], large: true };
  const n = read.lines.length;
  if (n === 0) return { ...base, chunks: [] };
  const lines: DiffLine[] = read.lines.map((content, i) => ({ type: "normal", content, oldLine: i + 1, newLine: i + 1 }));
  return { ...base, chunks: [{ section: "", oldStart: 1, oldLines: n, newStart: 1, newLines: n, lines }] };
}

export function gapsOf(file: DiffFile, total?: number): Gap[] {
  if (!canExpand(file)) return [];
  const cs = file.chunks;
  return Array.from({ length: cs.length + 1 }, (_, i) => {
    const prev = cs[i - 1];
    const next = cs[i];
    const from = prev ? last(prev.newStart, prev.newLines) + 1 : 1;
    const to = next ? first(next.newStart, next.newLines) - 1 : total;
    const delta = prev ? last(prev.oldStart, prev.oldLines) - last(prev.newStart, prev.newLines) : first(next.oldStart, next.oldLines) - first(next.newStart, next.newLines);
    return { index: i, from, to, delta };
  });
}

/** How many lines of a gap are opened: below the hunk before it, and above the hunk after it */
export interface Opened {
  top: number;
  bottom: number;
}

export type Expansion = Record<number, Opened>;

/** Lines opened per click, like GitHub */
export const EXPAND_STEP = 20;

export const hiddenCount = (g: Gap, o: Opened | undefined) => (g.to === undefined ? undefined : Math.max(0, g.to - g.from + 1 - (o?.top ?? 0) - (o?.bottom ?? 0)));

export type Row =
  /** The line between two parts of the file: the hunk header and how many lines it leaves out */
  | { kind: "gap"; gap: Gap; hidden: number | undefined; chunk?: DiffChunk }
  | { kind: "line"; line: DiffLine; opened?: boolean };

/**
 * The rows of one file: each hunk's lines, with the lines opened around them (from the target side's
 * content). A gap that is fully opened disappears, and its hunks read as one.
 */
export function buildRows(file: DiffFile, content: string[] | undefined, exp: Expansion): Row[] {
  // an unchanged file is its lines, with no hunk header above them
  if (file.unchanged) return file.chunks.flatMap((c) => c.lines.map((line): Row => ({ kind: "line", line })));
  const rows: Row[] = [];
  const gaps = gapsOf(file, content?.length);
  const opened = (g: Gap, a: number, b: number) => {
    if (!content) return;
    for (let n = a; n <= b; n++) if (content[n - 1] !== undefined) rows.push({ kind: "line", opened: true, line: { type: "normal", content: content[n - 1], oldLine: n + g.delta, newLine: n } });
  };
  file.chunks.forEach((chunk, i) => {
    const g = gaps[i];
    if (g) {
      const o = content ? exp[i] : undefined;
      const hidden = hiddenCount(g, o)!;
      const top = Math.min(o?.top ?? 0, g.to! - g.from + 1);
      opened(g, g.from, g.from + top - 1);
      if (hidden > 0 || i === 0) rows.push({ kind: "gap", gap: g, hidden, chunk });
      opened(g, g.from + top + hidden, g.to!);
    } else rows.push({ kind: "gap", gap: { index: i, from: 1, to: 0, delta: 0 }, hidden: 0, chunk });
    for (const line of chunk.lines) rows.push({ kind: "line", line });
  });
  const end = gaps[file.chunks.length];
  if (end) {
    const o = content ? exp[end.index] : undefined;
    const hidden = hiddenCount(end, o);
    if (content) opened(end, end.from, end.from + (o?.top ?? 0) - 1);
    if (hidden === undefined || hidden > 0) rows.push({ kind: "gap", gap: end, hidden });
  }
  return rows;
}

/** The expansion after a click: `dir` "down" opens below the hunk before, "up" above the hunk after */
export function expand(exp: Expansion, g: Gap, dir: "up" | "down" | "all", total: number): Expansion {
  const size = (g.to ?? total) - g.from + 1;
  const o = exp[g.index] ?? { top: 0, bottom: 0 };
  const left = Math.max(0, size - o.top - o.bottom);
  const next = dir === "all" ? { top: size - o.bottom, bottom: o.bottom } : dir === "down" ? { ...o, top: o.top + Math.min(EXPAND_STEP, left) } : { ...o, bottom: o.bottom + Math.min(EXPAND_STEP, left) };
  return { ...exp, [g.index]: next };
}

/** The expansion that shows target-side lines `a`..`b` (and a few around them), wherever they are */
export function reveal(file: DiffFile, total: number, exp: Expansion, a: number, b: number): Expansion {
  let out = exp;
  for (const g of gapsOf(file, total)) {
    const to = g.to ?? total;
    if (b < g.from || a > to) continue;
    const o = out[g.index] ?? { top: 0, bottom: 0 };
    const top = Math.min(to - g.from + 1, Math.max(o.top, Math.min(b, to) - g.from + 1 + 3));
    if (top !== o.top) out = { ...out, [g.index]: { ...o, top } };
  }
  return out;
}

/** The target-side number of a base-side line outside the hunks (the same text, `delta` lines away) */
export function oldToNew(file: DiffFile, oldLine: number): number | undefined {
  for (const g of gapsOf(file)) {
    const n = oldLine - g.delta;
    if (n >= g.from && (g.to === undefined || n <= g.to)) return n;
  }
  return undefined;
}

// ---- split view

export interface SplitRow {
  old?: DiffLine;
  new?: DiffLine;
}

/**
 * Lines side by side: a context line on both sides, and each run of
 * deleted lines paired with the added lines right after it.
 */
export function pairLines(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === "normal") {
      rows.push({ old: line, new: line });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    while (i < lines.length && lines[i].type === "delete") dels.push(lines[i++]);
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].type === "add") adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ old: dels[k], new: adds[k] });
  }
  return rows;
}

// ---- words that changed inside a line

/** [start, end) character ranges */
export type Ranges = [number, number][];

/** Longer lines are not compared word by word */
const MAX_WORD_DIFF = 500;

/** Words, runs of spaces, and single other characters (so "foo(1)" is "foo", "(", "1", ")") */
const tokenize = (s: string) => s.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? [];

/**
 * The changed words of a deleted line and the added line paired with it: the tokens outside their
 * longest common sequence. Only when the two lines still share much of their text; otherwise every
 * word would be marked and the marks would say nothing.
 */
export function wordRanges(before: string, after: string): { old: Ranges; new: Ranges } | undefined {
  if (!before.trim() || !after.trim() || before === after || before.length > MAX_WORD_DIFF || after.length > MAX_WORD_DIFF) return undefined;
  const a = tokenize(before);
  const b = tokenize(after);
  // lengths of the longest common sequence of a[i..] and b[j..]
  const w = b.length + 1;
  const lcs = new Uint16Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
  const keepA = new Array<boolean>(a.length).fill(false);
  const keepB = new Array<boolean>(b.length).fill(false);
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) {
      keepA[i++] = true;
      keepB[j++] = true;
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) i++;
    else j++;
  }
  const solid = (t: string) => t.trim().length;
  const shared = a.reduce((n, t, i) => n + (keepA[i] ? solid(t) : 0), 0);
  const total = a.reduce((n, t) => n + solid(t), 0) + b.reduce((n, t) => n + solid(t), 0);
  if (total === 0 || (2 * shared) / total < 0.4) return undefined;
  return { old: changedRanges(a, keepA), new: changedRanges(b, keepB) };
}

/** Character ranges of the tokens not kept, joined when they touch or only a space is between them */
function changedRanges(tokens: string[], keep: boolean[]): Ranges {
  keep = keep.map((k, i) => k && !(i > 0 && i < tokens.length - 1 && !tokens[i].trim() && !keep[i - 1] && !keep[i + 1]));
  const out: Ranges = [];
  let pos = 0;
  tokens.forEach((t, i) => {
    const end = pos + t.length;
    if (!keep[i]) {
      const last = out[out.length - 1];
      if (last && last[1] === pos) last[1] = end;
      else out.push([pos, end]);
    }
    pos = end;
  });
  return out;
}

/** Changed words of every paired line in `lines`, keyed "old:<n>" / "new:<n>" */
export function wordDiffs(lines: DiffLine[]): Map<string, Ranges> {
  const m = new Map<string, Ranges>();
  for (const r of pairLines(lines)) {
    if (r.old?.type !== "delete" || r.new?.type !== "add") continue;
    const w = wordRanges(r.old.content, r.new.content);
    if (!w) continue;
    m.set(`old:${r.old.oldLine}`, w.old);
    m.set(`new:${r.new.newLine}`, w.new);
  }
  return m;
}

/** Cuts tokens at the ranges, marking the parts inside them */
export function markRanges<T extends { text: string }>(tokens: T[], ranges: Ranges): (T & { mark?: boolean })[] {
  if (!ranges.length) return tokens;
  const out: (T & { mark?: boolean })[] = [];
  let pos = 0;
  for (const t of tokens) {
    const end = pos + t.text.length;
    let at = pos;
    for (const [a, b] of ranges) {
      if (b <= at || a >= end) continue;
      if (a > at) out.push({ ...t, text: t.text.slice(at - pos, a - pos) });
      const stop = Math.min(b, end);
      out.push({ ...t, text: t.text.slice(Math.max(a, at) - pos, stop - pos), mark: true });
      at = stop;
    }
    if (at < end) out.push({ ...t, text: t.text.slice(at - pos) });
    pos = end;
  }
  return out;
}

// ---- reviewed marks and counts

/** A hash of what changed in a file, so a mark falls off when the file changes again */
export function changeHash(f: DiffFile): string {
  return hashOf([f.status, f.oldPath ?? "", f.modeChange ?? "", f.binary ? "binary" : "", f.chunks.map((c) => c.lines.filter((l) => l.type !== "normal").map((l) => `${l.type === "add" ? "+" : "-"}${l.content}`))]);
}

export const lineCount = (f: DiffFile) => f.chunks.reduce((n, c) => n + c.lines.length, 0);

export function countStatus(files: DiffFile[]) {
  const c = { added: 0, modified: 0, removed: 0 };
  for (const f of files) c[f.status === "renamed" ? "modified" : f.status]++;
  return c;
}

export function countLines(files: DiffFile[]) {
  return files.reduce((c, f) => ({ added: c.added + f.additions, removed: c.removed + f.deletions }), { added: 0, removed: 0 });
}
