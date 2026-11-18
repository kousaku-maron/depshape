import { ChangeCounts, ChevronIcon, CommentCount, CopyIcon, copyText, StatusMark } from "@diffshape/ui";
import { memo, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { DiffFile } from "../../src/types";
import { isImage, isMarkdown } from "./api";
import type { ReviewComment } from "./comments";
import { Card } from "./CommentViews";
import { DiffTable, type ViewMode } from "./DiffTable";
import { highlightFile } from "./highlight";
import { ImagePreview } from "./ImagePreview";
import { MarkdownPreview } from "./MarkdownPreview";
import { buildRows, lineCount, type Expansion, type Gap } from "./model";

/*
 * One file of the diff: a header that sticks to the top while its lines scroll by (fold, path, counts,
 * the diff / preview switch for Markdown and images, reviewed), then its lines or its preview. A file's
 * lines are drawn once it comes near the screen, so a large diff opens quickly.
 */


/** Files with more lines than this start folded */
export const LARGE_LINES = 1500;

export type FileViewKind = "diff" | "preview";

/** What a file can show besides its lines, and what it shows first */
export function previewOf(file: DiffFile): { label: string; first: FileViewKind } | undefined {
  if (isImage(file.path)) return { label: "画像", first: file.binary ? "preview" : "diff" };
  if (isMarkdown(file.path) && !file.binary && !file.large) return { label: "プレビュー", first: "diff" };
  return undefined;
}

interface Props {
  file: DiffFile;
  mode: ViewMode;
  open: boolean;
  reviewed: boolean;
  /** The target side's whole content, once loaded (lines around the hunks) */
  content: string[] | undefined;
  expansion: Expansion;
  view: FileViewKind;
  /** Changes on every reload (so images are read again) */
  version: number;
  /** Comments of the file by the line they are shown under */
  byLine: Map<string, ReviewComment[]>;
  /** Comments of the file whose lines are no longer in the diff */
  orphans: ReviewComment[];
  commentCount: number;
  scrollRoot: HTMLElement | null;
  onToggle: (path: string) => void;
  onReviewed: (path: string, on: boolean) => void;
  onExpand: (path: string, gap: Gap, dir: "up" | "down" | "all") => void;
  onView: (path: string, view: FileViewKind) => void;
  register: (path: string, el: HTMLElement | null) => void;
  /** An unchanged file opened from the tree: takes it out of the list (undefined while comments keep it there) */
  onClose?: (path: string) => void;
}

export const FileBlock = memo(function FileBlock(p: Props) {
  const { file } = p;
  const ref = useRef<HTMLElement>(null);
  const near = useNear(ref, p.scrollRoot);
  const [copied, setCopied] = useState(false);
  const lines = lineCount(file);
  const preview = previewOf(file);
  const view = preview ? p.view : "diff";

  const rows = useMemo(() => buildRows(file, p.content, p.expansion), [file, p.content, p.expansion]);
  const tokens = useMemo(() => (near ? highlightFile(file, p.content) : undefined), [file, p.content, near]);

  useEffect(() => {
    p.register(file.path, ref.current);
    return () => p.register(file.path, null);
  }, [file.path, p.register]);

  const copyPath = async () => {
    await copyText(file.path);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  const plain = !!file.unchanged;
  const note = plain ? plainNote(file) : diffNote(file);

  const body = () => {
    if (view === "preview") {
      if (!near) return <div className="fs-placeholder" style={{ height: 240 }} />;
      return isImage(file.path) ? <ImagePreview file={file} version={p.version} /> : <MarkdownPreview file={file} split={p.mode === "split"} version={p.version} />;
    }
    if (note) return <div className="fs-note">{note}</div>;
    if (!near) return <div className="fs-placeholder" style={{ height: (lines + file.chunks.length) * 20 }} />;
    return <DiffTable file={file} mode={plain ? "unified" : p.mode} rows={rows} tokens={tokens} byLine={p.byLine} onExpand={(g, dir) => p.onExpand(file.path, g, dir)} />;
  };

  return (
    <section ref={ref} className={`fs-file${p.reviewed ? " reviewed" : ""}${plain ? " unchanged" : ""}`} data-path={file.path}>
      <header className="fs-file-head">
        <button className={`fs-fold${p.open ? " open" : ""}`} onClick={() => p.onToggle(file.path)} aria-label={p.open ? "折りたたむ" : "開く"} aria-expanded={p.open}>
          <ChevronIcon size={14} />
        </button>
        <StatusMark status={plain ? "unchanged" : file.status} />
        <span className="fs-file-path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path} onClick={() => p.onToggle(file.path)}>
          {file.oldPath && (
            <>
              <span className="fs-old-path">{file.oldPath}</span>
              <span className="ds-muted"> → </span>
            </>
          )}
          {file.path}
        </span>
        <button className="fs-icon-btn" onClick={() => void copyPath()} title={copied ? "コピーしました" : "パスをコピー"} aria-label="パスをコピー">
          <CopyIcon size={13} />
        </button>
        {file.generated && <span className="fs-tag" title="ロックファイルや生成されたコード（最初は折りたたんでいます）">生成</span>}
        {plain && (
          <span className="fs-tag" title="ツリーの「全体」から開いた、変更していないファイル">
            変更なし
          </span>
        )}
        <span className="ds-spacer" />
        {preview && !(isImage(file.path) && file.binary) && (
          <span className="ds-seg fs-view-seg" role="radiogroup" aria-label="表示">
            {(
              [
                ["diff", "差分"],
                ["preview", preview.label],
              ] as const
            ).map(([v, label]) => (
              <button key={v} role="radio" aria-checked={view === v} className={view === v ? "on" : ""} onClick={() => p.onView(file.path, v)}>
                {label}
              </button>
            ))}
          </span>
        )}
        {p.commentCount > 0 && <CommentCount n={p.commentCount} title={`コメント ${p.commentCount}`} />}
        {plain ? (
          p.onClose && (
            <button className="ds-btn" onClick={() => p.onClose!(file.path)} title="一覧から外す（ツリーの「全体」からまた開けます）">
              閉じる
            </button>
          )
        ) : (
          <>
            <ChangeCounts stats={{ added: file.additions, removed: file.deletions }} title={`追加 ${file.additions} 行・削除 ${file.deletions} 行`} />
            <label className="ds-check fs-viewed" title="確認済みにすると折りたたみます（このファイルがまた変わると外れます）">
              <input type="checkbox" checked={p.reviewed} onChange={(e) => p.onReviewed(file.path, e.target.checked)} />
              確認済み
            </label>
          </>
        )}
      </header>
      {p.open && (
        <div className="fs-file-body">
          {p.orphans.length > 0 && (
            <div className="fs-orphans">
              <div className="ds-muted">差分からなくなった行へのコメント</div>
              {p.orphans.map((c) => (
                <Card key={c.id} c={c} showWhere />
              ))}
            </div>
          )}
          {body()}
        </div>
      )}
      {!p.open && (file.generated || lines > LARGE_LINES) && !p.reviewed && (
        <div className="fs-folded">
          {file.generated ? "生成されたファイルのため折りたたんでいます" : `大きな差分（${lines} 行）のため折りたたんでいます`}
          <button className="ds-link" onClick={() => p.onToggle(file.path)}>
            表示する
          </button>
        </div>
      )}
    </section>
  );
});

/** Why a changed file shows no lines, or undefined */
function diffNote(file: DiffFile): string | undefined {
  if (file.binary) return "バイナリファイルのため、行の差分はありません";
  if (file.large) return "大きすぎるため、行の差分を表示していません";
  if (file.chunks.length > 0) return undefined;
  if (file.modeChange) return `ファイルのモードだけが変わりました（${file.modeChange}）`;
  return file.status === "renamed" ? "名前だけが変わりました（内容の変更はありません）" : "空のファイルです";
}

/** Why an unchanged file shows no lines, or undefined */
function plainNote(file: DiffFile): string | undefined {
  if (file.loading) return "読み込み中…";
  if (file.binary) return "バイナリファイルです";
  if (file.large) return "大きすぎるため、内容を表示していません";
  return file.chunks.length === 0 ? "空のファイルです" : undefined;
}

/** Becomes true once the element comes within a screen or so of the visible area, and stays true */
function useNear(ref: RefObject<HTMLElement>, root: HTMLElement | null): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (near || !el || !root) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { root, rootMargin: "1200px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, root, near]);
  return near;
}
