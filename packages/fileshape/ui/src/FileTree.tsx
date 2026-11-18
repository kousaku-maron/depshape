import { ChevronIcon, CommentCount, StatusMark } from "@diffshape/ui";
import { useEffect, useMemo, useState } from "react";
import { changedFolders, filterTree, folderPaths, type TreeNode } from "./model";

/*
 * The sidebar: the shown files as a tree. A click scrolls the diff to the file; the check box marks it
 * reviewed. The file being read is lit. "全体" adds every other file of the repository: a click opens
 * one in the list, unchanged.
 */

export type TreeMode = "changes" | "all";

interface Props {
  mode: TreeMode;
  onMode: (mode: TreeMode) => void;
  /** The shown files, plus (in "全体") the rest of the repository; null while the repository is listed */
  tree: TreeNode | null;
  /** Why the repository could not be listed */
  error: string | null;
  current: string | null;
  reviewed: Set<string>;
  commentCounts: Map<string, number>;
  onSelect: (path: string) => void;
  onReviewed: (path: string, on: boolean) => void;
}

const flip = (set: Set<string>, path: string) => {
  const next = new Set(set);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
};

export function FileTree({ mode, onMode, tree, error, current, reviewed, commentCounts, onSelect, onReviewed }: Props) {
  const [query, setQuery] = useState("");
  const all = mode === "all";
  // "変更": every folder starts open (the user closes some). "全体": only the folders with a change start open
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState<Set<string> | null>(null);
  const changed = useMemo(() => (all && tree ? changedFolders(tree) : null), [all, tree]);
  useEffect(() => {
    if (changed && opened === null) setOpened(changed);
  }, [changed, opened]);
  const shown = useMemo(() => (tree ? filterTree(tree, query) : null), [tree, query]);
  const allFolders = useMemo(() => (tree && !all ? folderPaths(tree) : []), [tree, all]);

  const isOpen = (path: string) => query.trim() !== "" || (all ? (opened ?? changed)?.has(path) === true : !closed.has(path));
  const toggle = (path: string) => (all ? setOpened((prev) => flip(prev ?? changed ?? new Set(), path)) : setClosed((prev) => flip(prev, path)));

  const row = (node: TreeNode, depth: number) => {
    const pad = { paddingLeft: 8 + depth * 12 };
    if (node.plain || node.file?.unchanged) {
      // a file without changes: in the list once opened (lit while it is read), otherwise opened by the click
      return (
        <div key={node.path} className={`fs-tree-row file plain${current === node.path ? " current" : ""}${node.file ? " shown" : ""}`} style={pad} onClick={() => onSelect(node.path)} title={`${node.path}（変更なし）`}>
          <span className="fs-tree-check-space" />
          <StatusMark status="unchanged" small />
          <span className="fs-tree-name">{node.name}</span>
          {(commentCounts.get(node.path) ?? 0) > 0 && <CommentCount n={commentCounts.get(node.path)!} />}
        </div>
      );
    }
    if (node.file) {
      const f = node.file;
      const n = commentCounts.get(f.path) ?? 0;
      const done = reviewed.has(f.path);
      return (
        <div key={node.path} className={`fs-tree-row file${current === f.path ? " current" : ""}${done ? " reviewed" : ""}`} style={pad} onClick={() => onSelect(f.path)} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
          <input
            type="checkbox"
            className="fs-tree-check"
            checked={done}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onReviewed(f.path, e.target.checked)}
            aria-label={`${f.path} を確認済みにする`}
            title="確認済み"
          />
          <StatusMark status={f.status} small />
          <span className="fs-tree-name">{node.name}</span>
          {n > 0 && <CommentCount n={n} />}
          <span className="fs-tree-counts">
            {f.additions > 0 && <span className="added">+{f.additions}</span>}
            {f.deletions > 0 && <span className="removed">−{f.deletions}</span>}
          </span>
        </div>
      );
    }
    const open = isOpen(node.path);
    return (
      <div key={node.path}>
        <div className={`fs-tree-row dir${all && changed && !changed.has(node.path) ? " plain" : ""}`} style={pad} onClick={() => toggle(node.path)} title={node.path}>
          <span className={`fs-fold small${open ? " open" : ""}`}>
            <ChevronIcon size={12} />
          </span>
          <span className="fs-tree-name">{node.name}</span>
        </div>
        {open && node.children.map((c) => row(c, depth + 1))}
      </div>
    );
  };

  return (
    <aside className="fs-tree">
      <div className="fs-tree-head">
        <div className="ds-seg fs-tree-mode" role="radiogroup" aria-label="ツリーに出すファイル">
          {(
            [
              ["changes", "変更", "変更したファイルだけ"],
              ["all", "全体", "リポジトリのすべてのファイル（変更していないファイルはクリックで開きます）"],
            ] as const
          ).map(([m, label, title]) => (
            <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? "on" : ""} onClick={() => onMode(m)} title={title}>
              {label}
            </button>
          ))}
        </div>
        {all ? (
          <button
            className="fs-icon-btn"
            disabled={!changed}
            onClick={() => setOpened((opened ?? changed)?.size ? new Set() : changed)}
            title={(opened ?? changed)?.size ? "すべてのフォルダを閉じる" : "変更のあるフォルダを開く"}
          >
            {(opened ?? changed)?.size ? "−" : "＋"}
          </button>
        ) : (
          allFolders.length > 0 && (
            <button className="fs-icon-btn" onClick={() => setClosed(closed.size ? new Set() : new Set(allFolders))} title={closed.size ? "すべてのフォルダを開く" : "すべてのフォルダを閉じる"}>
              {closed.size ? "＋" : "−"}
            </button>
          )
        )}
        <input className="fs-filter" type="search" placeholder="ファイルを絞り込む" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="fs-tree-body">
        {error ? (
          <div className="fs-tree-empty ds-muted">リポジトリのファイルを読めませんでした: {error}</div>
        ) : !shown ? (
          <div className="fs-tree-empty ds-muted">読み込み中…</div>
        ) : shown.children.length > 0 ? (
          shown.children.map((c) => row(c, 0))
        ) : (
          <div className="fs-tree-empty ds-muted">{query ? "一致するファイルはありません" : all ? "ファイルはありません" : "変更されたファイルはありません"}</div>
        )}
      </div>
    </aside>
  );
}
