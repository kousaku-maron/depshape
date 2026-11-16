import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { CommentSidebar, type Draft } from "./CommentViews";
import { commentState, itemKey, parseKey, type ReviewComment } from "./comments";
import { DepPanel } from "./DepPanel";
import { PinIcon } from "@diffshape/ui";
import { unhide } from "./hide";
import { clampLayout, DEFAULT_SIDE, gridColumns, loadLayout, saveLayout, type Layout } from "./layout";
import { parentDir, type Model, type TreeDir } from "./model";
import { buildAllView, buildChangesView, type MapMode, type View, type ViewNode } from "./view";

/*
 * The dependency map: a file tree on the left (no arrows), and a panel on the
 * right that draws the dependencies of whatever is pinned or hovered.
 */

export interface DepMapProps {
  model: Model;
  root: TreeDir;
  tree: Map<string, TreeDir>;
  mode: MapMode;
  onModeChange: (m: MapMode) => void;
  /** "all" mode: open folders. "changes" mode: folders revealed in full. */
  open: Set<string>;
  onToggle: (dir: string) => void;
  /** "changes" mode: folders folded away by the user */
  collapsed: Set<string>;
  onCollapseToggle: (dir: string) => void;
  onExpandAll: () => void;
  onExpandChanged: () => void;
  onCollapseAll: () => void;
  pins: string[];
  onTogglePin: (id: string) => void;
  onClearPins: () => void;
  /** pin several items at once (used to show a comment's dependencies) */
  onPin: (ids: string[]) => void;
  includeExternal: boolean;
  comments: ReviewComment[];
  onCommentsChange: (next: ReviewComment[]) => void;
  /** the comment sidebar (opened from the header, or automatically when something is selected) */
  sidebarOpen: boolean;
  onSidebarOpen: (open: boolean) => void;
}

interface Mark {
  added: number;
  removed: number;
}

const isAdditive = (e: MouseEvent) => e.metaKey || e.ctrlKey || e.shiftKey;

/** Added / removed imports per visible row (folders and rest rows sum up the files they stand for). */
function depMarks(model: Model, view: View): Map<string, Mark> {
  const marks = new Map<string, Mark>();
  for (const e of model.graph.edges) {
    if (e.external || e.status === "unchanged") continue;
    const rep = view.fileRep.get(e.from);
    if (!rep) continue;
    let m = marks.get(rep);
    if (!m) marks.set(rep, (m = { added: 0, removed: 0 }));
    m[e.status]++;
  }
  return marks;
}

function badges(d: TreeDir): { cls: string; text: string }[] {
  const s = d.stats;
  const out: { cls: string; text: string }[] = [];
  if (s.added) out.push({ cls: "added", text: `+${s.added}` });
  if (s.modified) out.push({ cls: "modified", text: `~${s.modified}` });
  if (s.removed) out.push({ cls: "removed", text: `−${s.removed}` });
  return out;
}

const stop = (fn: () => void) => (e: MouseEvent) => {
  e.stopPropagation();
  fn();
};

export function DepMap(props: DepMapProps) {
  const { model, root, tree, open, mode, pins } = props;
  const [hovered, setHovered] = useState<string | null>(null);
  const clearTimer = useRef<number | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  // area widths: dragged on the dividers, saved for next time
  const bodyRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout>(loadLayout);
  const [bodyW, setBodyW] = useState(0);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBodyW(el.clientWidth));
    ro.observe(el);
    setBodyW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const anchor = useRef<{ id: string; top: number } | null>(null);

  const openKey = useMemo(() => [...open].sort().join("|"), [open]);
  const collapsedKey = useMemo(() => [...props.collapsed].sort().join("|"), [props.collapsed]);
  const view = useMemo(
    () => (mode === "all" ? buildAllView(root, open) : buildChangesView(model, root, tree, open, props.collapsed)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, root, tree, mode, openKey, collapsedKey],
  );
  const marks = useMemo(() => depMarks(model, view), [model, view]);
  const pinned = useMemo(() => new Set(pins), [pins]);
  // rows of the panel's target tree the user opened or folded
  const [targetOpen, setTargetOpen] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const toggleTarget = (id: string, open: boolean) => setTargetOpen((prev) => new Map(prev).set(id, open));
  // source folders opened in the panel
  const [sourceOpen, setSourceOpen] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const toggleSource = (id: string, open: boolean) => setSourceOpen((prev) => new Map(prev).set(id, open));
  // panel rows whose lines are set aside for now (not saved)
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());

  // ---- comments: what is selected, the draft being written, and two-way highlighting ----
  const [selection, setSelection] = useState<string[]>([]);
  const [draft, setDraft] = useState<Draft>({ editingId: null, body: "" });
  const [litKeys, setLitKeys] = useState<Set<string> | null>(null); // a comment card under the mouse
  const [hoveredKeys, setHoveredKeys] = useState<string[] | null>(null); // the link under the mouse (a folded box's link: several)
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const selected = useMemo(() => new Set(selection), [selection]);
  const { comments, sidebarOpen, onSidebarOpen } = props;
  const openComments = useMemo(() => comments.filter((c) => commentState(model, tree, c) !== "resolved"), [comments, model, tree]);
  const commentCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of openComments) for (const k of c.targets) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  }, [openComments]);

  // focus right away when the sidebar is already open, otherwise once it has rendered
  const focusInput = () => {
    if (inputRef.current) inputRef.current.focus();
    else window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  /** Plain click replaces the selection (or clears it when clicking the same thing again); ⌘/Shift toggles. */
  const selectKeys = (keys: string[], additive: boolean) => {
    if (keys.length === 0) return;
    let next: string[] = [];
    setSelection((prev) => {
      if (additive) {
        const all = keys.every((k) => prev.includes(k));
        next = all ? prev.filter((k) => !keys.includes(k)) : [...prev, ...keys.filter((k) => !prev.includes(k))];
      } else {
        const same = prev.length === keys.length && keys.every((k) => prev.includes(k));
        next = same ? [] : keys;
      }
      return next;
    });
    // selecting something to comment on brings the sidebar out
    if (keys.length) onSidebarOpen(true);
  };
  const resetDraft = () => {
    setSelection([]);
    setDraft({ editingId: null, body: "" });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement;
      if (typing) return;
      if (e.key === "Escape") setSelection([]);
      if (e.key === "c" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onSidebarOpen(true);
        focusInput();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveComment = () => {
    if (!draft.body.trim() || selection.length === 0) return;
    const next = draft.editingId
      ? comments.map((c) => (c.id === draft.editingId ? { ...c, targets: selection, body: draft.body.trim() } : c))
      : [
          ...comments,
          {
            id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            targets: selection,
            body: draft.body.trim(),
            createdAt: Date.now(),
          },
        ];
    props.onCommentsChange(next);
    resetDraft();
  };

  /** Bring a comment back into view: pin the files its dependencies start from and select its targets. */
  const showComment = (c: ReviewComment) => {
    const links = c.targets.map(parseKey).flatMap((t) => (t.kind === "link" ? [t] : []));
    // a dependent link (from the left column) ends at the shown item; others start at it
    // (a box is not a pin: it shows up with the files pinned in its folder)
    const shown = links.map((t) => (t.from.startsWith("i:") ? t.to : t.from));
    // a commented line set aside is drawn again
    setHidden((prev) => {
      let next = new Set(prev);
      for (const t of links) {
        const inbound = t.from.startsWith("i:");
        next = unhide(unhide(next, inbound ? "I" : "S", t.from), inbound ? "S" : "T", t.to);
      }
      return next;
    });
    props.onPin(shown.filter((id) => !id.startsWith("c:")));
    // and open the boxes those files sit in, so each commented link is drawn
    setSourceOpen((prev) => {
      const next = new Map(prev);
      for (const id of shown) if (id.startsWith("f:")) next.set(`c:${parentDir(id.slice(2))}`, true);
      return next;
    });
    // unfold the panel's trees down to each commented dependency
    setTargetOpen((prev) => {
      const next = new Map(prev);
      for (const t of links) {
        if (t.from.startsWith("i:")) {
          const id = t.from.slice(2);
          const dir = id.startsWith("f:") ? parentDir(id.slice(2)) : id.slice(2);
          for (let a = parentDir(dir); a; a = parentDir(a)) next.set(`i:g:${a}`, true);
          if (id.startsWith("f:")) next.set(`i:d:${dir}`, true).set(`i:g:${dir}`, true);
          else if (id.startsWith("d:")) next.set(`i:d:${dir}`, false).set(`i:g:${dir}`, true);
          else next.set(`i:g:${dir}`, false);
          continue;
        }
        if (t.to.startsWith("x:")) continue;
        const target = t.to.slice(2);
        const dir = t.to.startsWith("t:") ? parentDir(target) : target;
        for (let a = parentDir(dir); a; a = parentDir(a)) next.set(`g:${a}`, true);
        if (t.to.startsWith("t:")) next.set(`d:${dir}`, true).set(`g:${dir}`, true);
        else if (t.to.startsWith("d:")) next.set(`d:${dir}`, false).set(`g:${dir}`, true);
        else next.set(`g:${dir}`, false);
      }
      return next;
    });
    setSelection(c.targets);
  };
  const editComment = (c: ReviewComment) => {
    showComment(c);
    setDraft({ editingId: c.id, body: c.body });
    focusInput();
  };

  // a row shows in the panel only while the mouse is on it; the short delay only bridges the gap
  // between two rows so the panel does not flash empty while moving down the tree
  const hover = (id: string) => {
    window.clearTimeout(clearTimer.current);
    setHovered(id);
  };
  const releaseHover = () => {
    window.clearTimeout(clearTimer.current);
    clearTimer.current = window.setTimeout(() => setHovered(null), 80);
  };

  const rowEl = (id: string) => scrollRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`) ?? null;
  const offsetIn = (el: HTMLElement, sc: HTMLElement) => el.getBoundingClientRect().top - sc.getBoundingClientRect().top;

  // keep the toggled row where it was
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (!sc || !anchor.current) return;
    const el = rowEl(anchor.current.id);
    if (el) sc.scrollTop += offsetIn(el, sc) - anchor.current.top;
    anchor.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const toggle = (n: ViewNode) => {
    const sc = scrollRef.current;
    const el = rowEl(n.id);
    if (sc && el) anchor.current = { id: n.id, top: offsetIn(el, sc) };
    // in the changes view a folder header folds / unfolds the folder; one opened only by revealing it closes instead
    if (mode === "changes" && n.kind === "open" && !n.revealedOnly) props.onCollapseToggle(n.path);
    else props.onToggle(n.path);
  };

  const abs = (p: string) => (p ? `${model.graph.repoRoot}/${p}` : model.graph.repoRoot);

  const rowTitle = (n: ViewNode): string => {
    switch (n.kind) {
      case "file":
        return `${abs(n.path)}\n${n.file!.linesAfter ?? n.file!.linesBefore} 行`;
      case "dir":
        return `${abs(n.path)}\n${n.dir!.stats.total} ファイル（クリックで開く）`;
      case "open":
        return `${abs(n.path)}\n${n.dir!.stats.total} ファイル（${n.collapsed ? "クリックで開く" : "クリックで閉じる"}）`;
      case "rest": {
        const list = [...(n.hiddenDirs ?? []).map((d) => d.name + "/"), ...(n.hiddenFiles ?? []).map((f) => f.path.slice(f.path.lastIndexOf("/") + 1))];
        if (n.full) return `${abs(n.path)} の中で変更のないもの（クリックで閉じる）`;
        return [`${abs(n.path)} の中で変更のないもの（クリックで開く）`, ...list.slice(0, 12), ...(list.length > 12 ? [`…ほか ${list.length - 12} 件`] : [])].join("\n");
      }
    }
  };

  const row = (n: ViewNode) => {
    const icon =
      n.kind === "open" ? (n.collapsed ? "▸" : "▾") : n.kind === "rest" ? (n.full ? "▾" : "▸") : n.kind === "dir" ? "▸" : "";
    const text = n.kind === "file" || n.kind === "rest" ? n.label : `${n.label}/`;
    const m = (n.kind === "open" && !n.collapsed) || (n.kind === "rest" && n.full) ? undefined : marks.get(n.id);
    const isPinned = pinned.has(n.id);
    const cls = [
      "trow",
      n.kind,
      n.status,
      n.file?.isTest ? "test" : "",
      isPinned ? "pinned" : "",
      hovered === n.id ? "hovered" : "",
      selected.has(itemKey(n.id)) ? "picked" : "",
      litKeys?.has(itemKey(n.id)) ? "lit" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <div
        className={cls}
        data-id={n.id}
        title={rowTitle(n)}
        onMouseEnter={() => (n.kind === "rest" ? releaseHover() : hover(n.id))}
        onMouseLeave={releaseHover}
        onClick={(e) => {
          if (isAdditive(e)) selectKeys([itemKey(n.id)], true);
          else if (n.kind !== "file") toggle(n);
        }}
      >
        <span className="ticon">{icon}</span>
        <span className="tlabel">{text}</span>
        {n.kind === "file" && n.status !== "unchanged" && <span className={`tdot ${n.status}`}>●</span>}
        {n.dir &&
          badges(n.dir).map((b) => (
            <span key={b.cls} className={`tbadge ${b.cls}`}>
              {b.text}
            </span>
          ))}
        <span className="tspacer" />
        {m && m.added > 0 && (
          <span className="tmark added" title="今回増えた import">
            +{m.added} 依存
          </span>
        )}
        {m && m.removed > 0 && (
          <span className="tmark removed" title="今回なくなった import">
            −{m.removed} 依存
          </span>
        )}
        {(commentCounts.get(itemKey(n.id)) ?? 0) > 0 && (
          <span className="tcomment" title="この行へのコメント">
            💬 {commentCounts.get(itemKey(n.id))}
          </span>
        )}
        <button
          className="tbtn"
          onClick={stop(() => {
            setSelection([itemKey(n.id)]);
            onSidebarOpen(true);
            focusInput();
          })}
          title="この行にコメントを書く（⌘ / Shift + クリックで複数選択）"
        >
          💬
        </button>
        {n.kind === "rest" ? (
          // "ほか N フォルダ・M ファイル" is a fold in the tree, not a thing to compare; pin the folder and open it instead
          <span className="tbtn-space" />
        ) : (
          <button
            className={`tbtn tpin${isPinned ? " on" : ""}`}
            onClick={stop(() => props.onTogglePin(n.id))}
            title={isPinned ? "パネルにピン留め中（クリックでピン留めを外す）" : "パネルにピン留めする（表示し続ける）"}
          >
            <PinIcon on={isPinned} />
          </button>
        )}
      </div>
    );
  };

  const renderNodes = (nodes: ViewNode[]) =>
    nodes.map((n) =>
      n.kind === "open" ? (
        <div key={n.id} className={`tgroup ${n.status}${n.full ? "" : " pruned"}${n.collapsed ? " collapsed" : ""}`}>
          {row(n)}
          {!n.collapsed && <div className="tchildren">{renderNodes(n.children)}</div>}
        </div>
      ) : n.kind === "rest" && n.full ? (
        <div key={n.id} className="tgroup rest-group">
          {row(n)}
          <div className="tchildren">{renderNodes(n.children)}</div>
        </div>
      ) : (
        <div key={n.id}>{row(n)}</div>
      ),
    );

  return (
    <div className="map">
      <div className="map-toolbar">
        <div className="segmented" role="group" aria-label="表示範囲">
          <button className={mode === "changes" ? "on" : ""} onClick={() => props.onModeChange("changes")} title="変更したファイルと、その依存先だけを表示">
            変更まわり
          </button>
          <button className={mode === "all" ? "on" : ""} onClick={() => props.onModeChange("all")} title="リポジトリ全体のツリーを表示">
            全体
          </button>
        </div>
        {mode === "all" ? (
          <>
            <button onClick={props.onExpandChanged}>変更箇所をすべて開く</button>
            <button onClick={props.onCollapseAll}>すべて閉じる</button>
          </>
        ) : (
          <>
            <button onClick={props.onExpandAll} disabled={props.collapsed.size === 0} title="閉じたフォルダをすべて開く">
              すべて開く
            </button>
            <button onClick={props.onCollapseAll} disabled={open.size === 0} title="「ほか N ファイル」で開いたものを閉じる">
              変更まわりだけに戻す
            </button>
          </>
        )}
      </div>
      <div
        className={`map-body${sidebarOpen ? " with-sidebar" : ""}`}
        ref={bodyRef}
        style={{ gridTemplateColumns: gridColumns(bodyW ? clampLayout(layout, bodyW, sidebarOpen) : layout, sidebarOpen) }}
      >
        <div className="map-scroll tree" ref={scrollRef} onMouseLeave={releaseHover}>
          {renderNodes(view.roots)}
        </div>
        <Divider
          title="ドラッグでツリーとパネルの幅を変える（ダブルクリックで元に戻す）"
          start={() => scrollRef.current?.getBoundingClientRect().width ?? 0}
          onDrag={(w0, dx) => setLayout((l) => clampLayout({ ...l, tree: w0 + dx }, bodyW, sidebarOpen))}
          onEnd={() => setLayout((l) => (saveLayout(l), l))}
          onReset={() => setLayout((l) => (saveLayout({ ...l, tree: undefined }), { ...l, tree: undefined }))}
        />
        <DepPanel
          model={model}
          tree={tree}
          pins={pins}
          hovered={hovered && !pinned.has(hovered) ? hovered : null}
          onTogglePin={props.onTogglePin}
          onClearPins={props.onClearPins}
          includeExternal={props.includeExternal}
          selection={selected}
          litKeys={litKeys}
          commentCounts={commentCounts}
          onSelectKeys={selectKeys}
          onHoverKey={setHoveredKeys}
          targetOpen={targetOpen}
          sourceOpen={sourceOpen}
          onToggleSource={toggleSource}
          onToggleTarget={toggleTarget}
          hidden={hidden}
          onHiddenChange={setHidden}
        />
        {sidebarOpen && (
          <Divider
            title="ドラッグでコメントの幅を変える（ダブルクリックで元に戻す）"
            start={() => clampLayout(layout, bodyW, true).side}
            onDrag={(w0, dx) => setLayout((l) => clampLayout({ ...l, side: w0 - dx }, bodyW, true))}
            onEnd={() => setLayout((l) => (saveLayout(l), l))}
            onReset={() => setLayout((l) => (saveLayout({ ...l, side: DEFAULT_SIDE }), { ...l, side: DEFAULT_SIDE }))}
          />
        )}
        {sidebarOpen && (
          <CommentSidebar
            ref={inputRef}
            model={model}
            tree={tree}
            comments={comments}
            selection={selection}
            draft={draft}
            onDraft={setDraft}
            onSave={saveComment}
            onCancel={resetDraft}
            onRemoveTarget={(k) => setSelection((prev) => prev.filter((x) => x !== k))}
            onClose={() => onSidebarOpen(false)}
            onShow={showComment}
            onEdit={editComment}
            onDelete={(id) => {
              props.onCommentsChange(comments.filter((c) => c.id !== id));
              if (draft.editingId === id) resetDraft();
            }}
            hoveredKeys={hoveredKeys}
            onHoverComment={(keys) => setLitKeys(keys ? new Set(keys) : null)}
          />
        )}
      </div>
      <div className="legend">
        <span className="muted">
          行にホバーすると右のパネルに依存先が出ます ・ ピンのアイコンでピン留めし、複数並べて比べられます ・ 矢印や箱のクリック（⌘ / Shift で複数）・行の 💬 でコメント（c キーで入力欄へ）・ 「+n 依存」= 今回増えた import ・
          {mode === "changes" ? " 「ほか N ファイル」= 変更のない既存ファイル（クリックで展開）" : " フォルダをクリックで開閉"}
        </span>
      </div>
    </div>
  );
}

/** A draggable line between two areas: `start` reads the width being changed, `onDrag` gets it plus the move. */
function Divider(props: { title: string; start: () => number; onDrag: (w0: number, dx: number) => void; onEnd: () => void; onReset: () => void }) {
  return (
    <div
      className="area-divider"
      role="separator"
      aria-orientation="vertical"
      title={props.title}
      onDoubleClick={props.onReset}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const el = e.currentTarget;
        const x0 = e.clientX;
        const w0 = props.start();
        el.setPointerCapture(e.pointerId);
        el.classList.add("dragging");
        document.body.classList.add("resizing");
        const move = (ev: PointerEvent) => props.onDrag(w0, ev.clientX - x0);
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
          el.classList.remove("dragging");
          document.body.classList.remove("resizing");
          props.onEnd();
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
      }}
    />
  );
}
