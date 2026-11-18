import { AreaDivider, BarCounts, BarLabel, BarSep, BarSpacer, ChangeCounts, DIVIDER_W, loadJSON, loadPref, ModuleBar, ReviewProgress, saveJSON, savePref, StatusCounts, type ModuleViewProps } from "@diffshape/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileShapeRun } from "../../src/types";
import { fetchContent } from "./api";
import { commentState, fileOf, formatPrompt, inHunks, loadComments, locate, newComment, saveComments, type LineTarget, type ReviewComment } from "./comments";
import { Card, CommentsContext, targetKey, type CommentsApi } from "./CommentViews";
import type { ViewMode } from "./DiffTable";
import { FileBlock, LARGE_LINES, previewOf, type FileViewKind } from "./FileBlock";
import { FileTree } from "./FileTree";
import { loadReviewed, reviewedFiles, reviewScope, reviewTargets, saveReviewed } from "./reviewed";
import { buildTree, countLines, countStatus, expand, filesInTreeOrder, gapsOf, lineCount, oldToNew, reveal, type Expansion, type Gap } from "./model";

/*
 * The file module: the line diff of every changed file. The changed files as a tree on the left,
 * every file's lines on the right (unified or split), line comments, and files marked reviewed.
 */

const TREE_W_KEY = "fileshape.treeWidth";
const TREE_W = 280;
const NO_EXPANSION: Expansion = {};

export function FileView({ data: run, active, onComments }: ModuleViewProps<FileShapeRun>) {
  const tree = useMemo(() => buildTree(run.files), [run]);
  const files = useMemo(() => filesInTreeOrder(tree), [tree]);
  const scope = reviewScope(run);

  const [mode, setMode] = useState<ViewMode>(() => loadPref<ViewMode>("fileshape", "mode", "unified"));
  const changeMode = (m: ViewMode) => {
    setMode(m);
    savePref("fileshape", "mode", m);
  };

  // ---- reviewed: per repository and comparison; a mark keeps the file's change and falls off when it changes again
  const [marks, setMarks] = useState<Record<string, string>>(() => loadReviewed(scope));
  useEffect(() => setMarks(loadReviewed(scope)), [scope]);
  const targets = useMemo(() => reviewTargets(run.files), [run]);
  const reviewed = useMemo(() => reviewedFiles(targets, marks), [targets, marks]);

  // ---- folding: a file's own choice wins; otherwise reviewed, generated and very large files start folded
  const [folds, setFolds] = useState<Record<string, boolean>>({});
  const isOpen = (path: string) => {
    if (path in folds) return folds[path];
    const f = fileOf(run, path)!;
    return !(reviewed.has(path) || f.generated || lineCount(f) > LARGE_LINES);
  };
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  const toggle = useCallback((path: string) => setFolds((prev) => ({ ...prev, [path]: !isOpenRef.current(path) })), []);

  // ---- whole files (target side), read when lines around a hunk are opened; read again after a reload
  const [contents, setContents] = useState<Map<string, string[]>>(new Map());
  const [expansions, setExpansions] = useState<Record<string, Expansion>>({});
  const [version, setVersion] = useState(0);
  const loading = useRef(new Map<string, Promise<string[]>>());
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    loading.current = new Map();
    setContents(new Map());
    setExpansions({});
    setVersion((v) => v + 1);
  }, [run]);
  const ensureContent = useCallback((path: string): Promise<string[]> => {
    let p = loading.current.get(path);
    if (!p) {
      const map = loading.current;
      p = fetchContent(path, "new").then((lines) => {
        if (loading.current === map) setContents((prev) => new Map(prev).set(path, lines));
        return lines;
      });
      p.catch(() => map.delete(path));
      map.set(path, p);
    }
    return p;
  }, []);
  const onExpand = useCallback(
    async (path: string, gap: Gap, dir: "up" | "down" | "all") => {
      const file = fileOf(run, path);
      if (!file) return;
      let lines: string[];
      try {
        lines = await ensureContent(path);
      } catch (e) {
        window.alert(`ファイルを読めませんでした: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      const g = gapsOf(file, lines.length)[gap.index];
      if (g) setExpansions((prev) => ({ ...prev, [path]: expand(prev[path] ?? {}, g, dir, lines.length) }));
    },
    [run, ensureContent],
  );

  // Markdown and images: the lines or the preview, per file
  const [views, setViews] = useState<Record<string, FileViewKind>>({});
  const onView = useCallback((path: string, v: FileViewKind) => setViews((prev) => ({ ...prev, [path]: v })), []);

  const blocks = useRef(new Map<string, HTMLElement>());
  const register = useCallback((path: string, el: HTMLElement | null) => {
    if (el) blocks.current.set(path, el);
    else blocks.current.delete(path);
  }, []);
  const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);

  const setReviewed = useCallback(
    (path: string, on: boolean) => {
      const hash = targets.get(path);
      if (!hash) return;
      setMarks((prev) => {
        const next = { ...prev };
        if (on) next[path] = hash;
        else delete next[path];
        saveReviewed(scope, next);
        return next;
      });
      // marking folds the file (like GitHub's "Viewed"); keep its header where the eye is
      setFolds((prev) => ({ ...prev, [path]: !on }));
      if (on) {
        const el = blocks.current.get(path);
        const root = scrollRoot;
        if (el && root && el.getBoundingClientRect().top < root.getBoundingClientRect().top) el.scrollIntoView({ block: "start" });
      }
    },
    [targets, scope, scrollRoot],
  );

  // ---- comments
  const [comments, setComments] = useState<ReviewComment[]>(() => loadComments(scope));
  const [composing, setComposing] = useState<LineTarget | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const update = useCallback(
    (next: ReviewComment[]) => {
      setComments(next);
      saveComments(scope, next);
    },
    [scope],
  );
  const api: CommentsApi = useMemo(
    () => ({
      run,
      comments,
      contents,
      composing,
      editing,
      compose: (t) => {
        setComposing(t);
        setEditing(null);
      },
      edit: (id) => {
        setEditing(id);
        setComposing(null);
      },
      add: (t, body) => {
        update([...comments, newComment(t, body)]);
        setComposing(null);
      },
      update: (id, body) => {
        update(comments.map((c) => (c.id === id ? { ...c, body } : c)));
        setEditing(null);
      },
      remove: (id) => update(comments.filter((c) => c.id !== id)),
    }),
    [run, comments, contents, composing, editing, update],
  );

  // where each comment is shown now
  const placed = useMemo(() => {
    const byFile = new Map<string, { byLine: Map<string, ReviewComment[]>; orphans: ReviewComment[] }>();
    const gone: ReviewComment[] = [];
    for (const c of comments) {
      const file = fileOf(run, c.path);
      if (!file) {
        gone.push(c);
        continue;
      }
      let entry = byFile.get(c.path);
      if (!entry) byFile.set(c.path, (entry = { byLine: new Map(), orphans: [] }));
      const at = locate(file, c, contents.get(c.path));
      if (at.line === undefined) entry.orphans.push(c);
      else {
        // under the last line of its range
        const key = targetKey(c.side, at.endLine ?? at.line);
        entry.byLine.set(key, [...(entry.byLine.get(key) ?? []), c]);
      }
    }
    return { byFile, gone };
  }, [comments, run, contents]);

  // comments on lines around the hunks: read those files and open the lines again
  useEffect(() => {
    for (const c of comments) {
      const file = fileOf(run, c.path);
      if (file && !inHunks(file, c) && !contents.has(c.path)) void ensureContent(c.path).catch(() => {});
    }
    setExpansions((prev) => {
      let next = prev;
      for (const c of comments) {
        const file = fileOf(run, c.path);
        const content = contents.get(c.path);
        if (!file || !content || inHunks(file, c)) continue;
        const at = locate(file, c, content);
        if (at.line === undefined) continue;
        const end = at.endLine ?? at.line;
        const [a, b] = c.side === "new" ? [at.line, end] : [oldToNew(file, at.line) ?? at.line, oldToNew(file, end) ?? end];
        const exp = reveal(file, content.length, next[c.path] ?? {}, a, b);
        if (exp !== (next[c.path] ?? {}) && JSON.stringify(exp) !== JSON.stringify(next[c.path] ?? {})) next = { ...next, [c.path]: exp };
      }
      return next;
    });
  }, [comments, contents, run, ensureContent]);
  const EMPTY = useMemo(() => ({ byLine: new Map<string, ReviewComment[]>(), orphans: [] as ReviewComment[] }), []);
  const commentCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of comments) m.set(c.path, (m.get(c.path) ?? 0) + 1);
    return m;
  }, [comments]);

  // tell the shell how many comments are open, and how to copy them
  useEffect(() => {
    const open = comments.filter((c) => commentState(run, c, contents.get(c.path)) !== "resolved").length;
    onComments({ open, prompt: () => formatPrompt(run, comments, { header: false, contents }).text });
  }, [comments, run, contents, onComments]);

  // ---- the file being read: the last one whose header has reached the top
  const [current, setCurrent] = useState<string | null>(files[0]?.path ?? null);
  useEffect(() => {
    if (!scrollRoot) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const top = scrollRoot.getBoundingClientRect().top + 8;
        let cur: string | null = files[0]?.path ?? null;
        for (const f of files) {
          const el = blocks.current.get(f.path);
          if (!el) continue;
          if (el.getBoundingClientRect().top <= top) cur = f.path;
          else break;
        }
        setCurrent(cur);
      });
    };
    scrollRoot.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scrollRoot.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [scrollRoot, files]);

  // jumping to a file: the files passed on the way are drawn as they come near and grow past their
  // placeholders, so the jump keeps its file at the top until the page stops moving (or the user scrolls)
  const pin = useRef<{ stop: () => void } | null>(null);
  const select = (path: string) => {
    if (!isOpen(path)) setFolds((prev) => ({ ...prev, [path]: true }));
    setCurrent(path);
    pin.current?.stop();
    const root = scrollRoot;
    if (!root) return;
    let frame = 0;
    let still = 0;
    const started = performance.now();
    const stop = () => {
      cancelAnimationFrame(frame);
      root.removeEventListener("wheel", stop);
      root.removeEventListener("touchmove", stop);
      root.removeEventListener("keydown", stop);
      pin.current = null;
    };
    const step = () => {
      const el = blocks.current.get(path);
      if (el) {
        const off = el.getBoundingClientRect().top - root.getBoundingClientRect().top;
        // the last files can not reach the top: stop once the scroll is at its end
        const atEnd = root.scrollTop + root.clientHeight >= root.scrollHeight - 1;
        if (Math.abs(off) > 1 && !(atEnd && off > 0)) {
          root.scrollTop += off;
          still = 0;
        } else still++;
      }
      if (still > 10 || performance.now() - started > 1500) return stop();
      frame = requestAnimationFrame(step);
    };
    root.addEventListener("wheel", stop, { passive: true });
    root.addEventListener("touchmove", stop, { passive: true });
    root.addEventListener("keydown", stop);
    pin.current = { stop };
    // after the fold opens
    frame = requestAnimationFrame(step);
  };
  useEffect(() => () => pin.current?.stop(), []);

  // ---- sidebar width
  const [treeW, setTreeW] = useState(() => loadJSON<number>(TREE_W_KEY, TREE_W));
  const rootRef = useRef<HTMLDivElement>(null);

  const status = countStatus(run.files);
  const lines = countLines(run.files);

  return (
    <CommentsContext.Provider value={api}>
      <div className="fs-app" ref={rootRef} style={{ gridTemplateColumns: `${treeW}px ${DIVIDER_W}px minmax(0, 1fr)` }} data-active={active || undefined}>
        <ModuleBar>
          <BarCounts>
            <BarLabel>ファイル</BarLabel>
            <StatusCounts stats={status} unit="ファイル" showZero />
            <BarSep />
            <BarLabel>行</BarLabel>
            <ChangeCounts stats={lines} title={`追加 ${lines.added} 行・削除 ${lines.removed} 行`} showZero />
          </BarCounts>
          <BarSpacer />
          <ReviewProgress done={reviewed.size} total={targets.size} title="確認済みにしたファイル（そのファイルがまた変わると外れます）" />
          <div className="ds-seg" role="radiogroup" aria-label="表示">
            {(
              [
                ["unified", "Unified"],
                ["split", "Split"],
              ] as const
            ).map(([m, label]) => (
              <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? "on" : ""} onClick={() => changeMode(m)}>
                {label}
              </button>
            ))}
          </div>
        </ModuleBar>
        <FileTree tree={tree} current={current} reviewed={reviewed} commentCounts={commentCounts} onSelect={select} onReviewed={setReviewed} />
        <AreaDivider
          title="ドラッグで幅を変更（ダブルクリックで戻す）"
          start={() => treeW}
          onDrag={(w0, dx) => setTreeW(Math.max(160, Math.min(w0 + dx, (rootRef.current?.clientWidth ?? 1200) - 320)))}
          onEnd={() => saveJSON(TREE_W_KEY, treeW)}
          onReset={() => {
            setTreeW(TREE_W);
            saveJSON(TREE_W_KEY, TREE_W);
          }}
        />
        <main className="fs-main" ref={setScrollRoot}>
          {placed.gone.length > 0 && (
            <div className="fs-orphans top">
              <div className="ds-muted">差分からなくなったファイルへのコメント</div>
              {placed.gone.map((c) => (
                <Card key={c.id} c={c} showWhere />
              ))}
            </div>
          )}
          {files.length === 0 && <div className="fs-empty">変更されたファイルはありません</div>}
          {files.map((f) => {
            const at = placed.byFile.get(f.path) ?? EMPTY;
            return (
              <FileBlock
                key={f.path}
                file={f}
                mode={mode}
                open={isOpen(f.path)}
                reviewed={reviewed.has(f.path)}
                content={contents.get(f.path)}
                expansion={expansions[f.path] ?? NO_EXPANSION}
                view={views[f.path] ?? previewOf(f)?.first ?? "diff"}
                version={version}
                byLine={at.byLine}
                orphans={at.orphans}
                commentCount={commentCounts.get(f.path) ?? 0}
                scrollRoot={scrollRoot}
                onToggle={toggle}
                onReviewed={setReviewed}
                onExpand={onExpand}
                onView={onView}
                register={register}
              />
            );
          })}
        </main>
      </div>
    </CommentsContext.Provider>
  );
}
