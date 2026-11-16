import { createContext, useContext, useState } from "react";
import type { DbShapeResult } from "../../src/model";
import { commentState, formatPrompt, shortLabel, targetId, type CommentState, type CommentTarget, type ReviewComment } from "./comments";

/* Comment buttons and threads shown under the rows of the detail panel. */

export interface CommentsApi {
  data: DbShapeResult;
  comments: ReviewComment[];
  /** targetId of the row whose new comment is being written */
  composing: string | null;
  /** id of the comment being edited */
  editing: string | null;
  compose: (t: CommentTarget | null) => void;
  edit: (id: string | null) => void;
  add: (t: CommentTarget, body: string) => void;
  update: (id: string, body: string) => void;
  remove: (id: string) => void;
  copy: (text: string, note: string) => void;
}

export const CommentsContext = createContext<CommentsApi | null>(null);

const useComments = () => useContext(CommentsContext);

export const STATE_LABEL: Record<CommentState, string> = { open: "未対応", updated: "コメント後に変更あり", resolved: "解消済み？" };

/** 💬 on a row: starts a comment, and shows how many there are */
export function CommentButton({ target, label }: { target: CommentTarget; label?: string }) {
  const api = useComments();
  if (!api) return null;
  const id = targetId(target);
  const n = api.comments.filter((c) => targetId(c.target) === id).length;
  return (
    <button
      className={`cbtn ${n ? "has" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        api.compose(target);
      }}
      title={`${label ?? shortLabel(target)} にコメントする`}
      aria-label="コメントする"
    >
      💬{n > 0 && <span className="cnum">{n}</span>}
    </button>
  );
}

/** The comments on one target, and the box for a new one; `colSpan` renders it as a table row */
export function CommentThread({ target, colSpan }: { target: CommentTarget; colSpan?: number }) {
  const api = useComments();
  if (!api) return null;
  const id = targetId(target);
  const list = api.comments.filter((c) => targetId(c.target) === id);
  const composing = api.composing === id;
  if (!list.length && !composing) return null;
  if (colSpan) {
    return (
      <tr className="thread-row">
        <td colSpan={colSpan}>
          <CommentThread target={target} />
        </td>
      </tr>
    );
  }
  return (
    <div className="thread" id={`c-${id}`}>
      {list.map((c) => (api.editing === c.id ? <Composer key={c.id} initial={c.body} onSave={(body) => api.update(c.id, body)} onCancel={() => api.edit(null)} /> : <CommentCard key={c.id} c={c} />))}
      {composing && <Composer initial="" onSave={(body) => api.add(target, body)} onCancel={() => api.compose(null)} />}
    </div>
  );
}

function CommentCard({ c }: { c: ReviewComment }) {
  const api = useComments()!;
  const state = commentState(api.data, c);
  return (
    <div className={`ccard ${state}`}>
      <div className="cbody">{c.body}</div>
      <div className="cfoot">
        {state !== "open" && (
          <span className={`cstate ${state}`} title={state === "updated" ? `コメントしたときは: ${c.snapshot ?? "変更なし"}` : "対象がなくなったか、比較元と同じに戻りました"}>
            {STATE_LABEL[state]}
          </span>
        )}
        <span className="spacer" />
        <button className="link" onClick={() => api.copy(formatPrompt(api.data, [c], { includeResolved: true }).text, "コピーしました")} title="このコメントだけ AI 用にコピー">
          コピー
        </button>
        <button className="link" onClick={() => api.edit(c.id)}>
          編集
        </button>
        <button className="link danger" onClick={() => api.remove(c.id)}>
          削除
        </button>
      </div>
    </div>
  );
}

function Composer({ initial, onSave, onCancel }: { initial: string; onSave: (body: string) => void; onCancel: () => void }) {
  const [body, setBody] = useState(initial);
  const save = () => body.trim() && onSave(body.trim());
  return (
    <div className="composer">
      <textarea
        autoFocus
        value={body}
        placeholder="気になる点や直してほしいこと（⌘ / Ctrl + Enter で保存）"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="cfoot">
        <span className="spacer" />
        <button className="btn" onClick={onCancel}>
          キャンセル
        </button>
        <button className="btn primary" onClick={save} disabled={!body.trim()}>
          保存
        </button>
      </div>
    </div>
  );
}
