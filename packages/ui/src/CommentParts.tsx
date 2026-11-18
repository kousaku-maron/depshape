import { forwardRef, useState, type ReactNode } from "react";
import { CommentInput } from "./CommentInput";
import { COMMENT_STATE_LABEL, type CommentStateName } from "./comments";
import "./comments.css";

/*
 * The comment card and the comment box, the same in every module. What a comment points at (shown in
 * `top`) and when it counts as resolved are up to the module.
 */

export interface CommentCardProps {
  body: string;
  state: CommentStateName;
  /** Tooltip on the state, e.g. what the change looked like when the comment was written */
  stateTitle?: string;
  /** Above the body: what the comment points at */
  top?: ReactNode;
  /** Next to the state, e.g. "2件" */
  meta?: ReactNode;
  /** The agent that wrote it in an AI review ("Claude Code"); a comment of the user has none */
  ai?: string;
  /** Lit from the outside (its target is hovered) */
  lit?: boolean;
  /** Being edited in a composer elsewhere */
  editing?: boolean;
  onCopy: () => void | Promise<void>;
  onEdit: () => void;
  onDelete: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export function CommentCard(p: CommentCardProps) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await p.onCopy();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <article className={`ds-comment ${p.state}${p.lit ? " lit" : ""}${p.editing ? " editing" : ""}`} onMouseEnter={p.onMouseEnter} onMouseLeave={p.onMouseLeave}>
      {p.top && <div className="ds-comment-top">{p.top}</div>}
      <div className="ds-comment-body">{p.body}</div>
      <div className="ds-comment-foot">
        <span className={`ds-comment-state ${p.state}`} title={p.stateTitle}>
          {COMMENT_STATE_LABEL[p.state]}
        </span>
        {p.ai && (
          <span className="ds-comment-ai" title={`${p.ai} のレビューが付けたコメント`}>
            AI
          </span>
        )}
        {p.meta && <span className="ds-muted">{p.meta}</span>}
        <span className="ds-spacer" />
        <button className="ds-link" onClick={() => void copy()} title="このコメントだけ AI 用にコピー">
          {copied ? "コピーしました" : "コピー"}
        </button>
        <button className="ds-link" onClick={p.onEdit}>
          編集
        </button>
        <button
          className="ds-link danger"
          onClick={() => {
            if (window.confirm("このコメントを削除しますか？")) p.onDelete();
          }}
        >
          削除
        </button>
      </div>
    </article>
  );
}

export interface CommentComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  /** Whether saving is possible (besides a non-empty text) */
  canSave?: boolean;
  /** Editing an existing comment ("更新") rather than writing a new one ("保存") */
  editing?: boolean;
  /** Show the cancel button (a composer that is always there hides it while empty) */
  showCancel?: boolean;
  /** Above the text box: what the comment will point at */
  top?: ReactNode;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
}

export const CommentComposer = forwardRef<HTMLTextAreaElement, CommentComposerProps>(function CommentComposer(p, ref) {
  const can = (p.canSave ?? true) && p.value.trim() !== "";
  return (
    <div className={`ds-composer${p.editing ? " editing" : ""}${p.className ? ` ${p.className}` : ""}`}>
      {p.top && <div className="ds-composer-top">{p.top}</div>}
      <CommentInput
        ref={ref}
        className="ds-composer-input"
        autoFocus={p.autoFocus}
        value={p.value}
        placeholder={p.placeholder}
        onChange={p.onChange}
        onSave={() => can && p.onSave()}
        onCancel={p.onCancel}
      />
      <div className="ds-composer-foot">
        <span className="ds-muted">⌘ / Ctrl + Enter で保存 ・ Esc でキャンセル</span>
        <span className="ds-spacer" />
        {(p.showCancel ?? true) && (
          <button className="ds-btn" onClick={p.onCancel}>
            キャンセル
          </button>
        )}
        <button className="ds-btn ds-btn-primary" onClick={p.onSave} disabled={!can}>
          {p.editing ? "更新" : "保存"}
        </button>
      </div>
    </div>
  );
});
