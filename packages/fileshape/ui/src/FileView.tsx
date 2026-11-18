import { AreaDivider, BarCounts, BarLabel, BarSep, BarSpacer, ChangeCounts, DIVIDER_W, loadJSON, loadPref, ModuleBar, ReviewProgress, saveJSON, savePref, StatusCounts, type AiPlaced, type ModuleViewProps } from "@diffshape/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiffFile, FileShapeRun } from "../../src/types";
import { fetchContent, fetchFileList, fetchPlain } from "./api";
import { commentState, fileOf, formatPrompt, inHunks, loadComments, locate, newComment, saveComments, type LineTarget, type ReviewComment } from "./comments";
import { Card, CommentsContext, targetKey, type CommentsApi } from "./CommentViews";
import type { ViewMode } from "./DiffTable";
import { FileBlock, LARGE_LINES, previewOf, type FileViewKind } from "./FileBlock";
import { FileTree, type TreeMode } from "./FileTree";
import { loadReviewed, reviewedFiles, reviewScope, reviewTargets, saveReviewed } from "./reviewed";
import { buildTree, canExpand, countLines, countStatus, expand, filesInTreeOrder, gapsOf, lineCount, oldToNew, reveal, unchangedFile, type Expansion, type Gap } from "./model";
import { fileFor, placeItem, reviewSection } from "./review";

/*
 * The file module: the line diff of every changed file. The changed files as a tree on the left,
 * every file's lines on the right (unified or split), line comments, and files marked reviewed.
 * The tree's "全体" view lists the whole repository; an unchanged file opened from it joins the list.
 */

const TREE_W_KEY = "fileshape.treeWidth";
const TREE_W = 280;
const NO_EXPANSION: Expansion = {};

export function FileView({ data: diff, active, onComments, request, ai, onAi }: ModuleViewProps<FileShapeRun>) {
  const scope = reviewScope(diff);
  const [comments, setComments] = useState<ReviewComment[]>(() => loadComments(scope));

  // ---- unchanged files in the list: the ones opened from the tree (kept per comparison) and the ones
  // commented while unchanged (so such a comment keeps its file); each is read once per analysis
  const openedKey = `fileshape.opened:${scope}`;
  const [opened, setOpened] = useState<string[]>(() => stringList(loadJSON<unknown>(openedKey, [])));
  useEffect(() => saveJSON(openedKey, opened), [openedKey, opened]);
  /** path → the file read (null: the repository has no such file) */
  const [plain, setPlain] = useState<ReadonlyMap<string, DiffFile | null>>(new Map());
  const reading = useRef(new Set<string>());
  const inDiff = useMemo(() => new Set(diff.files.map((f) => f.path)), [diff]);
  const wanted = useMemo(() => [...new Set([...opened, ...comments.filter((c) => c.unchanged).map((c) => c.path)])].filter((p) => !inDiff.has(p)), [opened, comments, inDiff]);
  useEffect(() => {
    for (const path of wanted) {
      if (plain.has(path) || reading.current.has(path)) continue;
      const batch = reading.current;
      batch.add(path);
      const done = (f: DiffFile | null) => {
        if (reading.current !== batch) return;
        batch.delete(path);
        setPlain((prev) => new Map(prev).set(path, f));
      };
      fetchPlain(path).then(
        (r) => done(r ? unchangedFile(path, r) : null),
        () => done(null),
      );
    }
  }, [wanted, plain]);
  // a file that is gone from the repository is not kept as opened
  useEffect(() => {
    if (opened.some((p) => plain.get(p) === null)) setOpened((prev) => prev.filter((p) => plain.get(p) !== null));
  }, [plain, opened]);
  const shownPlain = useMemo(() => wanted.filter((p) => plain.get(p) !== null).map((p) => plain.get(p) ?? unchangedFile(p, undefined)), [wanted, plain]);
  // what the list, the tree and the comments work on: the diff plus those files
  const run = useMemo<FileShapeRun>(() => (shownPlain.length ? { ...diff, files: [...diff.files, ...shownPlain] } : diff), [diff, shownPlain]);
  const commented = useMemo(() => new Set(comments.map((c) => c.path)), [comments]);
  const closePlain = useCallback((path: string) => setOpened((prev) => prev.filter((p) => p !== path)), []);

  const tree = useMemo(() => buildTree(run.files), [run]);
  const files = useMemo(() => filesInTreeOrder(tree), [tree]);

  // ---- the tree: the shown files, or the whole repository (listed when first asked, again after a reload)
  const [treeMode, setTreeMode] = useState<TreeMode>(() => loadPref<TreeMode>("fileshape", "treeMode", "changes"));
  const changeTreeMode = (m: TreeMode) => {
    setTreeMode(m);
    savePref("fileshape", "treeMode", m);
  };
  const [listing, setListing] = useState<{ diff: FileShapeRun; paths?: string[]; error?: string } | null>(null);
  useEffect(() => {
    if (treeMode !== "all" || listing?.diff === diff) return;
    let live = true;
    fetchFileList().then(
      (paths) => live && setListing({ diff, paths }),
      (e: unknown) => live && setListing({ diff, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [treeMode, diff, listing]);
  const allPaths = listing?.diff === diff ? listing.paths : undefined;
  const sideTree = useMemo(() => (treeMode === "changes" ? tree : allPaths ? buildTree(run.files, allPaths) : null), [treeMode, tree, run, allPaths]);

  const [mode, setMode] = useState<ViewMode>(() => loadPref<ViewMode>("fileshape", "mode", "unified"));
  const changeMode = (m: ViewMode) => {
    setMode(m);
    savePref("fileshape", "mode", m);
  };

  // ---- reviewed: per repository and comparison; a mark keeps the file's change and falls off when it changes again
  const [marks, setMarks] = useState<Record<string, string>>(() => loadReviewed(scope));
  useEffect(() => setMarks(loadReviewed(scope)), [scope]);
  const targets = useMemo(() => reviewTargets(diff.files), [diff]);
  const reviewed = useMemo(() => reviewedFiles(targets, marks), [targets, marks]);

  // ---- folding: a file's own choice wins; otherwise reviewed, generated and very large files start folded
  const [folds, setFolds] = useState<Record<string, boolean>>({});
  const isOpen = (path: string) => {
    if (path in folds) return folds[path];
    const f = fileOf(run, path);
    return !f || !(reviewed.has(path) || f.generated || lineCount(f) > LARGE_LINES);
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
    // unchanged files are read again too (one may have changed since, and so be in the diff now)
    reading.current = new Set();
    setPlain(new Map());
  }, [diff]);
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
        update([...comments, newComment(t, body, !!fileOf(run, t.path)?.unchanged)]);
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

  // tell the shell how many comments are open, how to copy them, and what an AI reviewer is told
  useEffect(() => {
    const open = comments.filter((c) => commentState(run, c, contents.get(c.path)) !== "resolved").length;
    onComments({ open, prompt: () => formatPrompt(run, comments, { header: false, contents }).text, review: () => reviewSection(diff) });
  }, [comments, run, contents, diff, onComments]);

  // ---- an AI review: each comment that is for this module goes to the lines whose code it quotes.
  // A file is read first when the comment is on lines outside its hunks, or on a file without changes.
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const aiSeen = useRef(0);
  const [aiPlaced, setAiPlaced] = useState<AiPlaced | null>(null);
  useEffect(() => {
    if (!ai || ai.seq === aiSeen.current) return;
    aiSeen.current = ai.seq;
    const items = ai.items.filter((i) => i.module === "file");
    void (async () => {
      const added: ReviewComment[] = [];
      for (const item of items) {
        if (!item.path) continue;
        let file = fileFor(diff, item.path);
        let unchanged = false;
        if (!file) {
          const read = await fetchPlain(item.path).catch(() => null);
          if (!read) continue; // no such file
          file = unchangedFile(item.path, read);
          unchanged = true;
        }
        let at = placeItem(file, item);
        if (!at?.exact && canExpand(file)) {
          const content = await ensureContent(file.path).catch(() => undefined);
          if (content) at = placeItem(file, item, content) ?? at;
        }
        if (at) added.push({ ...newComment(at.target, item.body, unchanged), ai: ai.agent });
      }
      if (added.length) update([...commentsRef.current, ...added]);
      setAiPlaced({ seq: ai.seq, placed: added.length, dropped: items.length - added.length });
    })();
  }, [ai, diff, ensureContent, update]);
  // after the report above, so the shell has the new comments when it hears they are placed
  useEffect(() => {
    if (aiPlaced) onAi(aiPlaced);
  }, [aiPlaced, onAi]);

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
        // the file's header sticks below the list's top padding: line the file up there, or the header covers its first line
        const off = el.getBoundingClientRect().top - root.getBoundingClientRect().top - (parseFloat(getComputedStyle(root).paddingTop) || 0);
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

  /** A file picked in the tree (or asked for by another module): scrolls to it, joining the list first if it is unchanged */
  const openFile = (path: string) => {
    if (!run.files.some((f) => f.path === path)) setOpened((prev) => (prev.includes(path) ? prev : [...prev, path]));
    select(path);
  };

  // another module asked for a file (depshape: "差分を開く"): jump to it once this view is shown.
  // A renamed file is found by either of its paths.
  const handled = useRef(0);
  useEffect(() => {
    if (!request || !active || !scrollRoot || request.seq === handled.current) return;
    handled.current = request.seq;
    const f = files.find((x) => x.path === request.target) ?? files.find((x) => x.oldPath === request.target);
    // not in the list: an unchanged file, opened like one picked in the tree (dropped if there is no such file)
    openFile(f ? f.path : request.target);
  });

  // ---- sidebar width
  const [treeW, setTreeW] = useState(() => loadJSON<number>(TREE_W_KEY, TREE_W));
  const rootRef = useRef<HTMLDivElement>(null);

  const status = countStatus(diff.files);
  const lines = countLines(diff.files);

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
        <FileTree
          mode={treeMode}
          onMode={changeTreeMode}
          tree={sideTree}
          error={treeMode === "all" && listing?.diff === diff ? (listing.error ?? null) : null}
          current={current}
          reviewed={reviewed}
          commentCounts={commentCounts}
          onSelect={openFile}
          onReviewed={setReviewed}
        />
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
                onClose={f.unchanged && !commented.has(f.path) ? closePlain : undefined}
              />
            );
          })}
        </main>
      </div>
    </CommentsContext.Provider>
  );
}

const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
