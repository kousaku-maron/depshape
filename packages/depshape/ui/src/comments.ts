import { joinEntries, promptEntry } from "@diffshape/ui";
import { moduleOf, type Model, type TreeDir } from "./model";
import { findLink, resolveSource, sourceLinks, type PanelLink } from "./panel";
import { pathOf } from "./view";

/*
 * Review comments on the dependency view, difit-style: attach a note to one or
 * more dependencies (panel links) and/or tree rows, then copy everything as a
 * prompt for an AI agent.
 *
 * Targets are stored as string keys so they survive re-analysis:
 *   L:<sourceId>><targetId>   a dependency drawn in the panel (e.g. L:f:a/b.go>d:lib/hoge;
 *                             targets may also be g:<dir> folded groups or t:<file> TS files)
 *   I:<nodeId>                a tree row (f:<file>, d:<dir>, r:<dir>)
 */

export interface ReviewComment {
  id: string;
  targets: string[];
  body: string;
  createdAt: number;
  /** The agent whose AI review wrote it ("Claude Code"); a comment of the user has none */
  ai?: string;
}

export type TargetState = "open" | "resolved";
export type CommentState = "open" | "partial" | "resolved";

export const linkKey = (from: string, to: string) => `L:${from}>${to}`;
export const itemKey = (id: string) => `I:${id}`;

export function parseKey(key: string): { kind: "link"; from: string; to: string } | { kind: "item"; id: string } {
  if (key.startsWith("L:")) {
    const body = key.slice(2);
    const i = body.indexOf(">");
    return { kind: "link", from: body.slice(0, i), to: body.slice(i + 1) };
  }
  return { kind: "item", id: key.slice(2) };
}

export const linkFor = findLink;

/**
 * Whether one target still needs attention after re-analysis:
 * a dependency, file or folder that no longer exists counts as resolved.
 */
export function targetState(model: Model, tree: Map<string, TreeDir>, key: string): TargetState {
  const t = parseKey(key);
  if (t.kind === "link") {
    const l = linkFor(model, tree, t.from, t.to);
    return !l || l.after === 0 ? "resolved" : "open";
  }
  if (t.id.startsWith("f:")) {
    const f = model.fileByPath.get(pathOf(t.id));
    return !f || f.status === "removed" ? "resolved" : "open";
  }
  return tree.has(pathOf(t.id)) ? "open" : "resolved";
}

export function commentState(model: Model, tree: Map<string, TreeDir>, c: ReviewComment): CommentState {
  const states = c.targets.map((k) => targetState(model, tree, k));
  const done = states.filter((s) => s === "resolved").length;
  if (done === 0) return "open";
  return done === states.length ? "resolved" : "partial";
}

/** Full Go import path of a repo folder, so an agent can grep for the import line. */
export function importPath(model: Model, dir: string): string {
  const m = moduleOf(model.graph.modules, dir);
  if (!m) return dir;
  const rel = m.dir === "" ? dir : dir === m.dir ? "" : dir.slice(m.dir.length + 1);
  return rel ? `${m.path}/${rel}` : m.path;
}

/** A folder as it is written in a prompt: its import path, or "." for the root of a repository without a Go module there */
const folderName = (model: Model, dir: string) => importPath(model, dir) || ".";

/** A repo folder written with a trailing "/": "." for the root ("./", "./*") */
const slashed = (dir: string) => `${dir || "."}/`;

/**
 * What a row of the panel stands for, as a path: a file, "dir/" for a folder and everything below it,
 * "dir/*" for the files right in it (a Go package).
 */
function sourceAddress(id: string): string {
  // a row of the panel's dependents column (who imports the shown item)
  if (id.startsWith("i:")) {
    const q = id.slice(4);
    return id.startsWith("i:f:") ? q : id.startsWith("i:d:") ? `${slashed(q)}*` : slashed(q);
  }
  const p = pathOf(id);
  if (id.startsWith("f:")) return p;
  if (id.startsWith("d:")) return slashed(p);
  if (id.startsWith("p:") || id.startsWith("c:")) return `${slashed(p)}*`;
  // r: the files of the folder this change left alone
  return `${slashed(p)}*（変更のないファイル）`;
}

/** What a dependency points at, as an agent greps for it: the import path, or the one file it imports (TS) */
function targetAddress(model: Model, id: string, l: PanelLink | null): string {
  if (id.startsWith("x:") || id.startsWith("t:")) return id.slice(2);
  const dir = id.slice(2);
  if (id.startsWith("g:")) return `${folderName(model, dir)}/`;
  const files = (l?.files ?? []).filter((f) => f.status !== "removed");
  return files.length === 1 ? files[0].path : folderName(model, dir);
}

export function describeTarget(model: Model, id: string, l: PanelLink | null): string {
  if (id.startsWith("x:")) return `${id.slice(2)}（外部パッケージ）`;
  if (id.startsWith("t:")) return id.slice(2); // one file of a TS folder
  const dir = id.slice(2);
  // a folded group in the panel stands for everything below the folder
  const name = id.startsWith("g:") ? `${folderName(model, dir)}/ 配下` : folderName(model, dir);
  // TS knows the exact files; list them so an agent can open them directly
  const files = (l?.files ?? []).filter((f) => f.status !== "removed").map((f) => (dir ? f.path.slice(dir.length + 1) : f.path));
  if (!files.length) return name;
  return id.startsWith("g:") ? `${name}（${files.join(", ")}）` : `${name}/（${files.join(", ")}）`;
}

/** Where the unchanged files of a folder usually go: the existing pattern to compare against. */
export function folderPattern(model: Model, tree: Map<string, TreeDir>, dir: string, top = 3): string | null {
  const s = resolveSource(model, tree, `r:${dir}`, false);
  if (!s || s.files.length === 0) return null;
  const links = [...sourceLinks(model, s, false).values()]
    .filter(({ link }) => link.before > 0)
    .sort((a, b) => b.link.before - a.link.before)
    .slice(0, top);
  if (links.length === 0) return `${slashed(dir)} の変更のないファイル ${s.files.length} 個は、このリポジトリ内のパッケージを import していません`;
  const list = links.map(({ target, link }) => `${folderName(model, target.dir)} (${link.before})`).join(", ");
  return `${slashed(dir)} の変更のないファイル ${s.files.length} 個の主な依存先: ${list}`;
}

/**
 * Comments as a list to hand to an AI, like difit's: what each one points at on one line (several
 * targets with ", "), then its body. A resolved comment is left out unless `includeResolved`.
 */
export function formatPrompt(
  model: Model,
  tree: Map<string, TreeDir>,
  comments: ReviewComment[],
  opts: { includeResolved?: boolean } = {},
): { text: string; included: number; skipped: number } {
  const list = opts.includeResolved ? comments : comments.filter((c) => commentState(model, tree, c) !== "resolved");
  const address = (key: string) => {
    const t = parseKey(key);
    if (t.kind === "item") return sourceAddress(t.id);
    // a dependent link points at a shown item, not at a package
    const to = t.from.startsWith("i:") ? sourceAddress(t.to) : targetAddress(model, t.to, linkFor(model, tree, t.from, t.to));
    return `${sourceAddress(t.from)} → ${to}`;
  };
  const entries = list.map((c) => promptEntry(c.targets.map(address).join(", "), c.body));
  return { text: joinEntries(entries), included: list.length, skipped: comments.length - list.length };
}
