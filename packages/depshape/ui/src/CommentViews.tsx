import { CommentCard, CommentComposer, copyText } from "@diffshape/ui";
import { forwardRef, useState } from "react";
import { commentState, formatPrompt, parseKey, targetState, type ReviewComment } from "./comments";
import { baseName, shortDir, type Model, type TreeDir } from "./model";
import { pathOf } from "./view";

function nodeLabel(tree: Map<string, TreeDir>, id: string): string {
  const p = pathOf(id);
  if (id.startsWith("f:")) {
    const dir = p.slice(0, p.lastIndexOf("/"));
    return `${baseName(dir)}/${baseName(p)}`;
  }
  const name = tree.get(p)?.name ?? baseName(p);
  return id.startsWith("r:") ? `${name}/ のほか` : `${name}/`;
}

/** Short human label for a comment target key. */
export function keyLabel(model: Model, tree: Map<string, TreeDir>, key: string): string {
  const t = parseKey(key);
  if (t.kind === "item") return nodeLabel(tree, t.id);
  const to = t.to.startsWith("x:") ? t.to.slice(2) : shortDir(model.graph.modules, t.to.slice(2));
  return `${nodeLabel(tree, t.from)} → ${to}`;
}

/** The tree node a comment hangs off (its first target's source), used to group the list. */
function anchorOf(c: ReviewComment): string {
  const t = parseKey(c.targets[0] ?? "I:root");
  return t.kind === "link" ? t.from : t.id;
}

export interface Draft {
  editingId: string | null;
  body: string;
}

export interface CommentSidebarProps {
  model: Model;
  tree: Map<string, TreeDir>;
  comments: ReviewComment[];
  selection: string[];
  draft: Draft;
  onDraft: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
  onRemoveTarget: (key: string) => void;
  onClose: () => void;
  onShow: (c: ReviewComment) => void;
  onEdit: (c: ReviewComment) => void;
  onDelete: (id: string) => void;
  /** a link/row hovered on the map: its comments light up here */
  hoveredKeys: string[] | null;
  /** the card under the mouse: its targets light up on the map */
  onHoverComment: (keys: string[] | null) => void;
}

export const CommentSidebar = forwardRef<HTMLTextAreaElement, CommentSidebarProps>(function CommentSidebar(props, inputRef) {
  const { model, tree, comments, selection, draft } = props;
  const [filter, setFilter] = useState<"open" | "all">("open");

  const withState = comments.map((c) => ({ c, state: commentState(model, tree, c) }));
  const visible = withState.filter((x) => filter === "all" || x.state !== "resolved");
  // group by the file / folder each comment hangs off, in path order (close to the tree's order)
  const groups = new Map<string, typeof visible>();
  for (const x of visible) {
    const a = anchorOf(x.c);
    groups.set(a, [...(groups.get(a) ?? []), x]);
  }
  const ordered = [...groups.entries()].sort((a, b) => pathOf(a[0]).localeCompare(pathOf(b[0])));

  const dirty = draft.editingId !== null || draft.body !== "" || selection.length > 0;

  return (
    <aside className="comment-sidebar">
      <div className="dep-panel-head">
        <strong>コメント</strong>
        <select value={filter} onChange={(e) => setFilter(e.target.value as "open" | "all")} title="表示するコメント">
          <option value="open">未対応のみ</option>
          <option value="all">すべて</option>
        </select>
        <span className="tspacer" />
        <button className="icon-btn" onClick={props.onClose} title="閉じる">
          ×
        </button>
      </div>

      <div className="comment-sidebar-list">
        {visible.length === 0 ? (
          <div className="dep-panel-empty">
            {comments.length === 0
              ? "まだコメントはありません。パネルの矢印や箱をクリック（⌘ / Shift で複数）するか、ツリーの行の 💬 から書けます。"
              : "未対応のコメントはありません。「すべて」に切り替えると解消済み？のものも見られます。"}
          </div>
        ) : (
          ordered.map(([anchor, items]) => (
            <section key={anchor} className="comment-group">
              <div className="comment-group-head" title={pathOf(anchor)}>
                {nodeLabel(tree, anchor)}
              </div>
              {items.map(({ c, state }) => (
                <CommentCard
                  key={c.id}
                  body={c.body}
                  state={state}
                  ai={c.ai}
                  meta={c.targets.length > 1 ? `${c.targets.length}件` : undefined}
                  lit={props.hoveredKeys?.some((k) => c.targets.includes(k))}
                  editing={draft.editingId === c.id}
                  onMouseEnter={() => props.onHoverComment(c.targets)}
                  onMouseLeave={() => props.onHoverComment(null)}
                  top={
                    <ul className="comment-targets" onClick={() => props.onShow(c)} title="クリックで図に表示">
                      {c.targets.map((k) => (
                        <li key={k} className={targetState(model, tree, k) === "resolved" ? "resolved" : ""}>
                          {keyLabel(model, tree, k)}
                        </li>
                      ))}
                    </ul>
                  }
                  onCopy={() => copyText(formatPrompt(model, tree, [c], { includeResolved: true }).text)}
                  onEdit={() => props.onEdit(c)}
                  onDelete={() => props.onDelete(c.id)}
                />
              ))}
            </section>
          ))
        )}
      </div>

      <CommentComposer
        ref={inputRef}
        className="comment-composer"
        editing={draft.editingId !== null}
        value={draft.body}
        placeholder="指摘を書く（例: usecase を経由する形にしてください）"
        onChange={(body) => props.onDraft({ ...draft, body })}
        onSave={props.onSave}
        onCancel={props.onCancel}
        canSave={selection.length > 0}
        showCancel={dirty}
        top={
          <div className="composer-targets">
            <span className="muted">{draft.editingId ? "編集中のコメント先:" : "コメント先:"}</span>
            {selection.length === 0 ? (
              <span className="muted">矢印や箱・行を選ぶとここに入ります（⌘ / Shift で複数）</span>
            ) : (
              selection.map((k) => (
                <span key={k} className={`chip${k.startsWith("L:") ? " link" : ""}`} title={k}>
                  {keyLabel(model, tree, k)}
                  <button onClick={() => props.onRemoveTarget(k)} title="外す">
                    ×
                  </button>
                </span>
              ))
            )}
          </div>
        }
      />
    </aside>
  );
});
