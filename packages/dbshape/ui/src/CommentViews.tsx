import { COMMENT_STATE_LABEL, CommentCard, CommentComposer, copyText } from "@diffshape/ui";
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
}

export const CommentsContext = createContext<CommentsApi | null>(null);

const useComments = () => useContext(CommentsContext);

export const STATE_LABEL: Record<CommentState, string> = COMMENT_STATE_LABEL;

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
      {list.map((c) => (api.editing === c.id ? <Composer key={c.id} initial={c.body} onSave={(body) => api.update(c.id, body)} onCancel={() => api.edit(null)} /> : <Card key={c.id} c={c} />))}
      {composing && <Composer initial="" onSave={(body) => api.add(target, body)} onCancel={() => api.compose(null)} />}
    </div>
  );
}

function Card({ c }: { c: ReviewComment }) {
  const api = useComments()!;
  const state = commentState(api.data, c);
  return (
    <CommentCard
      body={c.body}
      state={state}
      stateTitle={state === "updated" ? `コメントしたときは: ${c.snapshot ?? "変更なし"}` : state === "resolved" ? "対象がなくなったか、比較元と同じに戻りました" : undefined}
      onCopy={() => copyText(formatPrompt(api.data, [c], { includeResolved: true }).text)}
      onEdit={() => api.edit(c.id)}
      onDelete={() => api.remove(c.id)}
    />
  );
}

function Composer({ initial, onSave, onCancel }: { initial: string; onSave: (body: string) => void; onCancel: () => void }) {
  const [body, setBody] = useState(initial);
  return (
    <CommentComposer
      autoFocus
      editing={initial !== ""}
      value={body}
      placeholder="気になる点や直してほしいこと"
      onChange={setBody}
      onSave={() => body.trim() && onSave(body.trim())}
      onCancel={onCancel}
    />
  );
}
