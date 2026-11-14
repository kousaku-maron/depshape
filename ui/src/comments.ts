import type { FileNode } from "../../src/types";
import { moduleOf, type Model, type TreeDir } from "./model";
import { resolveSource, sourceLinks, type PanelLink } from "./panel";
import { pathOf } from "./view";

/*
 * Review comments on the dependency view, difit-style: attach a note to one or
 * more dependencies (panel links) and/or tree rows, then copy everything as a
 * prompt for an AI agent.
 *
 * Targets are stored as string keys so they survive re-analysis:
 *   L:<sourceId>><targetId>   a dependency drawn in the panel (e.g. L:f:a/b.go>d:lib/hoge)
 *   I:<nodeId>                a tree row (f:<file>, d:<dir>, r:<dir>)
 */

export interface ReviewComment {
  id: string;
  targets: string[];
  body: string;
  createdAt: number;
  /** changed files that had no same-name _test.go when the comment was written */
  noTestAtCreation: string[];
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

export function testFileOf(model: Model, f: FileNode): FileNode | undefined {
  const t = model.fileByPath.get(f.path.replace(/\.go$/, "_test.go"));
  return t && t.status !== "removed" ? t : undefined;
}

/** A changed (not removed) source file without a same-name _test.go. */
export function lacksTest(model: Model, f: FileNode): boolean {
  return !f.isTest && f.status !== "unchanged" && f.status !== "removed" && !testFileOf(model, f);
}

/** Files referenced by the comment targets that currently lack a test (stored at creation). */
export function noTestSnapshot(model: Model, targets: string[]): string[] {
  const out: string[] = [];
  for (const k of targets) {
    const t = parseKey(k);
    const id = t.kind === "item" ? t.id : t.from;
    if (!id.startsWith("f:")) continue;
    const f = model.fileByPath.get(pathOf(id));
    if (f && lacksTest(model, f) && !out.includes(f.path)) out.push(f.path);
  }
  return out;
}

export function linkFor(model: Model, tree: Map<string, TreeDir>, from: string, to: string): PanelLink | null {
  const s = resolveSource(model, tree, from, false);
  if (!s) return null;
  return sourceLinks(model, s, true).get(to)?.link ?? null;
}

/**
 * Whether one target still needs attention after re-analysis:
 * a dependency that no longer exists, a file that is gone, or a file that got its
 * missing test counts as resolved.
 */
export function targetState(model: Model, tree: Map<string, TreeDir>, c: ReviewComment, key: string): TargetState {
  const t = parseKey(key);
  if (t.kind === "link") {
    const l = linkFor(model, tree, t.from, t.to);
    return !l || l.after === 0 ? "resolved" : "open";
  }
  if (t.id.startsWith("f:")) {
    const f = model.fileByPath.get(pathOf(t.id));
    if (!f || f.status === "removed") return "resolved";
    if (c.noTestAtCreation.includes(f.path) && testFileOf(model, f)) return "resolved";
    return "open";
  }
  return tree.has(pathOf(t.id)) ? "open" : "resolved";
}

export function commentState(model: Model, tree: Map<string, TreeDir>, c: ReviewComment): CommentState {
  const states = c.targets.map((k) => targetState(model, tree, c, k));
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

function describeSource(model: Model, tree: Map<string, TreeDir>, id: string): string {
  const p = pathOf(id);
  if (id.startsWith("f:")) return p;
  if (id.startsWith("d:")) return `${p}/ 配下`;
  const d = tree.get(p);
  const n = d ? d.files.filter((f) => f.status === "unchanged").length : 0;
  return `${p}/ の変更のないファイル ${n} 個`;
}

function describeTarget(model: Model, id: string): string {
  return id.startsWith("x:") ? `${id.slice(2)}（外部パッケージ）` : importPath(model, id.slice(2));
}

function linkStatusText(l: PanelLink | null, fromId: string): string {
  if (!l || l.after === 0) return "現在は存在しない（解消済み？）";
  if (fromId.startsWith("f:")) return l.status === "added" ? "今回追加した import" : "既存の import";
  const parts = [`import しているファイル 変更前 ${l.before} → 変更後 ${l.after}`];
  if (l.added) parts.push(`今回追加 ${l.added}`);
  if (l.removed) parts.push(`今回削除 ${l.removed}`);
  return parts.join("、");
}

/** Where the unchanged files of a folder usually go: the existing pattern to compare against. */
export function folderPattern(model: Model, tree: Map<string, TreeDir>, dir: string, top = 3): string | null {
  const s = resolveSource(model, tree, `r:${dir}`, false);
  if (!s || s.files.length === 0) return null;
  const links = [...sourceLinks(model, s, false).values()]
    .filter(({ link }) => link.before > 0)
    .sort((a, b) => b.link.before - a.link.before)
    .slice(0, top);
  if (links.length === 0) return `${dir}/ の変更のないファイル ${s.files.length} 個は、このリポジトリ内のパッケージを import していません`;
  const list = links.map(({ target, link }) => `${importPath(model, target.dir)} (${link.before})`).join(", ");
  return `${dir}/ の変更のないファイル ${s.files.length} 個の主な依存先: ${list}`;
}

export function formatPrompt(
  model: Model,
  tree: Map<string, TreeDir>,
  comments: ReviewComment[],
  opts: { includeResolved?: boolean } = {},
): { text: string; included: number; skipped: number } {
  const open = opts.includeResolved ? comments : comments.filter((c) => commentState(model, tree, c) !== "resolved");
  const g = model.graph;
  const out: string[] = [
    "以下は、依存関係の差分ビューア depshape で付けたレビューコメントです。各指摘に対応してください。",
    `リポジトリ: ${g.repoRoot}`,
    `比較: ${g.targetLabel} と ${g.baseLabel} の差分`,
    "",
  ];
  open.forEach((c, i) => {
    const links = c.targets.map(parseKey).filter((t): t is { kind: "link"; from: string; to: string } => t.kind === "link");
    const items = c.targets.map(parseKey).filter((t): t is { kind: "item"; id: string } => t.kind === "item");
    const lines: string[] = [];
    if (links.length) {
      lines.push(links.length === 1 ? "依存:" : `依存（${links.length}件）:`);
      for (const t of links) {
        const l = linkFor(model, tree, t.from, t.to);
        lines.push(`  - ${describeSource(model, tree, t.from)} → ${describeTarget(model, t.to)}（${linkStatusText(l, t.from)}）`);
      }
    }
    if (items.length) {
      lines.push(items.length === 1 ? "対象:" : `対象（${items.length}件）:`);
      for (const t of items) {
        const p = pathOf(t.id);
        if (t.id.startsWith("f:")) {
          const f = model.fileByPath.get(p);
          const notes: string[] = [];
          if (!f || f.status === "removed") notes.push("現在は存在しない");
          else {
            if (f.status === "added") notes.push("今回追加");
            if (f.status === "modified") notes.push("今回変更");
            if (lacksTest(model, f)) notes.push("同じ名前の _test.go なし");
          }
          lines.push(`  - ファイル ${p}${notes.length ? `（${notes.join("、")}）` : ""}`);
        } else lines.push(`  - ${t.id.startsWith("d:") ? `フォルダ ${p}/` : describeSource(model, tree, t.id)}`);
      }
    }
    // for dependency comments: where the existing files of the same folder usually go
    const dirs = new Set<string>();
    for (const t of links) if (t.from.startsWith("f:")) dirs.add(model.fileByPath.get(pathOf(t.from))?.dir ?? "");
    const refs = [...dirs].filter(Boolean).map((d) => folderPattern(model, tree, d)).filter((x): x is string => !!x);
    for (const r of refs) lines.push(`参考: ${r}`);
    const state = commentState(model, tree, c);
    out.push(`${i + 1}.${state === "partial" ? "（一部は解消済み）" : state === "resolved" ? "（解消済み？）" : ""}`);
    out.push(...lines.map((l) => `   ${l}`));
    out.push(`   コメント: ${c.body.trim().replace(/\n/g, "\n   ")}`);
    out.push("");
  });
  return { text: out.join("\n").trimEnd() + "\n", included: open.length, skipped: comments.length - open.length };
}
