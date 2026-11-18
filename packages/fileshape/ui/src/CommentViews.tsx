import { CommentCard, CommentComposer, copyText } from "@diffshape/ui";
import { createContext, useContext, useState } from "react";
import type { FileShapeRun } from "../../src/types";
import { fileOf, formatPrompt, linesLabel, locate, where, type ReviewComment, type LineTarget } from "./comments";

/* The comments under a line of the diff, and the box for a new one. */

export interface CommentsApi {
  run: FileShapeRun;
  comments: ReviewComment[];
  /** Files whose whole target-side content is loaded (to place comments on opened lines) */
  contents: Map<string, string[]>;
  /** The lines whose new comment is being written */
  composing: LineTarget | null;
  /** id of the comment being edited */
  editing: string | null;
  compose: (t: LineTarget | null) => void;
  edit: (id: string | null) => void;
  add: (t: LineTarget, body: string) => void;
  update: (id: string, body: string) => void;
  remove: (id: string) => void;
}

export const CommentsContext = createContext<CommentsApi | null>(null);

export const useComments = () => useContext(CommentsContext)!;

export const targetKey = (side: "old" | "new", line: number) => `${side}:${line}`;

/** Comments shown under one row, and the composer when it is for one of the row's lines */
export function CommentThread({ comments, composing }: { comments: ReviewComment[]; composing?: LineTarget }) {
  const api = useComments();
  return (
    <div className="fs-thread">
      {comments.map((c) =>
        api.editing === c.id ? (
          <Composer key={c.id} initial={c.body} label={linesLabel(c.side, c.line, c.endLine, c.unchanged)} onSave={(b) => api.update(c.id, b)} onCancel={() => api.edit(null)} />
        ) : (
          <Card key={c.id} c={c} />
        ),
      )}
      {composing && <Composer initial="" label={linesLabel(composing.side, composing.line, composing.endLine, !!fileOf(api.run, composing.path)?.unchanged)} onSave={(b) => api.add(composing, b)} onCancel={() => api.compose(null)} />}
    </div>
  );
}

export function Card({ c, showWhere }: { c: ReviewComment; showWhere?: boolean }) {
  const api = useComments();
  const at = locate(fileOf(api.run, c.path), c, api.contents.get(c.path));
  if (showWhere && api.editing === c.id) return <Composer initial={c.body} label={where(c.path, c.side, c.line, c.endLine)} onSave={(b) => api.update(c.id, b)} onCancel={() => api.edit(null)} />;
  const many = c.endLine !== undefined && c.endLine !== c.line;
  return (
    <CommentCard
      body={c.body}
      state={at.state}
      top={
        showWhere ? (
          <span className="fs-comment-where">
            {where(c.path, c.side, c.line, c.endLine)} <code>{c.code.split("\n")[0].trim() || "（空行）"}</code>
            {many && <span className="ds-muted"> ほか</span>}
          </span>
        ) : many ? (
          <span className="ds-muted">{linesLabel(c.side, at.line ?? c.line, at.line !== undefined ? at.endLine : c.endLine, c.unchanged)}</span>
        ) : undefined
      }
      stateTitle={at.state === "updated" ? `コメントしたときは: ${c.code.trim()}` : at.state === "resolved" ? "この行は差分からなくなりました" : undefined}
      onCopy={() => copyText(formatPrompt(api.run, [c], { includeResolved: true, contents: api.contents }).text)}
      onEdit={() => api.edit(c.id)}
      onDelete={() => api.remove(c.id)}
    />
  );
}

function Composer({ initial, label, onSave, onCancel }: { initial: string; label: string; onSave: (body: string) => void; onCancel: () => void }) {
  const [body, setBody] = useState(initial);
  return (
    <CommentComposer
      autoFocus
      editing={initial !== ""}
      top={
        <span className="ds-muted">
          {label}
          {initial === "" && "（行番号を Shift+クリックかドラッグすると範囲になります）"}
        </span>
      }
      value={body}
      placeholder="気になる点や直してほしいこと"
      onChange={setBody}
      onSave={() => body.trim() && onSave(body.trim())}
      onCancel={onCancel}
    />
  );
}
