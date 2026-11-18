import { ChevronIcon, CommentCount } from "@diffshape/ui";
import { useMemo, useState } from "react";
import { filterTree, folderPaths, type TreeNode } from "./model";

/*
 * The sidebar: the changed files as a tree. A click scrolls the diff to the
 * file; the check box marks it reviewed. The file being read is lit.
 */

interface Props {
  tree: TreeNode;
  current: string | null;
  reviewed: Set<string>;
  commentCounts: Map<string, number>;
  onSelect: (path: string) => void;
  onReviewed: (path: string, on: boolean) => void;
}

const STATUS_MARK = { added: "A", modified: "M", removed: "D", renamed: "R" } as const;

export function FileTree({ tree, current, reviewed, commentCounts, onSelect, onReviewed }: Props) {
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const shown = useMemo(() => filterTree(tree, query), [tree, query]);
  const allFolders = useMemo(() => folderPaths(tree), [tree]);

  const toggle = (path: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const row = (node: TreeNode, depth: number) => {
    const pad = { paddingLeft: 8 + depth * 12 };
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
          <span className={`fs-st small ${f.status}`}>{STATUS_MARK[f.status]}</span>
          <span className="fs-tree-name">{node.name}</span>
          {n > 0 && <CommentCount n={n} />}
          <span className="fs-tree-counts">
            {f.additions > 0 && <span className="added">+{f.additions}</span>}
            {f.deletions > 0 && <span className="removed">−{f.deletions}</span>}
          </span>
        </div>
      );
    }
    const open = query.trim() !== "" || !closed.has(node.path);
    return (
      <div key={node.path}>
        <div className="fs-tree-row dir" style={pad} onClick={() => toggle(node.path)} title={node.path}>
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
        <input className="fs-filter" type="search" placeholder="ファイルを絞り込む" value={query} onChange={(e) => setQuery(e.target.value)} />
        {allFolders.length > 0 && (
          <button className="fs-icon-btn" onClick={() => setClosed(closed.size ? new Set() : new Set(allFolders))} title={closed.size ? "すべてのフォルダを開く" : "すべてのフォルダを閉じる"}>
            {closed.size ? "＋" : "−"}
          </button>
        )}
      </div>
      <div className="fs-tree-body">
        {shown && shown.children.length > 0 ? shown.children.map((c) => row(c, 0)) : <div className="fs-tree-empty ds-muted">{query ? "一致するファイルはありません" : "変更されたファイルはありません"}</div>}
      </div>
    </aside>
  );
}
