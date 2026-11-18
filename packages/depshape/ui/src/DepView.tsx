import { BarCounts, BarLabel, BarSep, BarSpacer, ChangeCounts, CommentIcon, loadCommentList, loadJSON, ModuleBar, ReviewProgress, saveCommentList, saveJSON, useStoredSet, StatusCounts, type AiPlaced, type ModuleViewProps } from "@diffshape/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiffGraph, Edge, FileNode } from "../../src/types";
import { commentState, formatPrompt, type ReviewComment } from "./comments";
import { DepMap } from "./DepMap";
import { ancestorsOf, buildModel, buildTree } from "./model";
import { loadPref, savePref } from "./prefs";
import { reviewSection, toComments } from "./review";
import { commentKey as commentKeyOf, loadReviewed, reviewedFiles, reviewScope, reviewTargets, saveReviewed } from "./reviewed";
import { DEP_TITLE } from "./depTitle";
import type { MapMode } from "./view";

export function DepView({ data: graph, active, onComments, modules, openIn, ai, onAi }: ModuleViewProps<DiffGraph>) {
  const repo = graph.repoRoot;
  // what is open / folded / pinned is kept per repository
  const [expanded, setExpanded] = useStoredSet(`depshape.expanded:${repo}`);
  const [collapsed, setCollapsed] = useStoredSet(`depshape.collapsed:${repo}`);
  const pinKey = `depshape.pins:${repo}`;
  const [pins, setPins] = useState<string[]>(() => stringList(loadJSON<unknown>(pinKey, [])));
  useEffect(() => saveJSON(pinKey, pins), [pinKey, pins]);
  // review comments (per repository and comparison, like difit); they survive re-analysis
  const commentKey = commentKeyOf(reviewScope(graph));
  const [comments, setComments] = useState<ReviewComment[]>(() => loadCommentList<ReviewComment>(commentKey));
  const [mapMode, setMapMode] = useState<MapMode>(loadPref<MapMode>("mapMode", "changes"));
  // the comment sidebar starts closed every time; selecting a link or a row opens it
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const model = useMemo(() => buildModel(graph), [graph]);
  const tree = useMemo(() => buildTree(model), [model]);

  // files marked reviewed (per repository and comparison); a mark falls off when the file's dependencies change again
  const scope = reviewScope(graph);
  const [marks, setMarks] = useState<Record<string, string>>(() => loadReviewed(scope));
  useEffect(() => setMarks(loadReviewed(scope)), [scope]);
  const targets = useMemo(() => reviewTargets(graph.files, graph.edges), [graph]);
  const reviewed = useMemo(() => reviewedFiles(targets, marks), [targets, marks]);
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
    },
    [targets, scope],
  );

  const updateComments = useCallback(
    (next: ReviewComment[]) => {
      setComments(next);
      saveCommentList(commentKey, next);
    },
    [commentKey],
  );

  // tell the shell how many comments are open, how to copy them, and what an AI reviewer is told
  useEffect(() => {
    const open = comments.filter((c) => commentState(model, tree.byPath, c) !== "resolved").length;
    onComments({ open, prompt: () => formatPrompt(model, tree.byPath, comments, { header: false }).text, review: () => reviewSection(model, tree.byPath) });
  }, [comments, model, tree, onComments]);

  // ---- an AI review: the comments for this module that point at a dependency or a file it has are
  // kept (the sidebar opens to show them); the rest is counted as dropped
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const aiSeen = useRef(0);
  const [aiPlaced, setAiPlaced] = useState<AiPlaced | null>(null);
  useEffect(() => {
    if (!ai || ai.seq === aiSeen.current) return;
    aiSeen.current = ai.seq;
    const items = ai.items.filter((i) => i.module === "dep");
    const added = toComments(items, model, tree.byPath, ai.agent);
    if (added.length) {
      updateComments([...commentsRef.current, ...added]);
      setSidebarOpen(true);
    }
    setAiPlaced({ seq: ai.seq, placed: added.length, dropped: items.length - added.length });
  }, [ai, model, tree, updateComments]);
  // after the report above, so the shell has the new comments when it hears they are placed
  useEffect(() => {
    if (aiPlaced) onAi(aiPlaced);
  }, [aiPlaced, onAi]);

  const toggleCollapsed = useCallback(
    (dir: string) =>
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(dir)) next.delete(dir);
        else next.add(dir);
        return next;
      }),
    [setCollapsed],
  );
  const pinMany = useCallback((ids: string[]) => setPins((prev) => [...prev, ...ids.filter((id) => !prev.includes(id))]), []);
  const togglePin = useCallback((id: string) => setPins((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id])), []);

  // the whole tree: open / close a folder (closing a box also closes everything inside it)
  const toggleDir = useCallback(
    (dir: string) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(dir)) {
          for (const d of [...next]) if (d === dir || d.startsWith(dir + "/")) next.delete(d);
        } else {
          next.add(dir);
        }
        return next;
      }),
    [setExpanded],
  );

  // every file opens in the file module (when that module is in this run): a changed one at its line
  // diff, an unchanged one as its whole content
  const hasFileModule = modules.includes("file");
  const openLabel = useCallback(
    (path: string) => {
      const f = model.fileByPath.get(path);
      if (!hasFileModule || !f) return undefined;
      return f.status === "unchanged" ? "ファイルを開く" : "差分を開く";
    },
    [model, hasFileModule],
  );
  const onOpenFile = useMemo(() => (hasFileModule ? (path: string) => openIn("file", path) : null), [hasFileModule, openIn]);

  // ---- folding, like fileshape's tree. "全体" opens the folders with changes when it is first shown
  // (and the fold button opens them again); "変更" starts with everything open
  const changedOpen = useMemo(() => {
    const out = new Set<string>();
    for (const d of model.changedDirs) {
      out.add(d);
      for (const a of ancestorsOf(d)) out.add(a);
    }
    return out;
  }, [model]);
  const seeded = useRef(false);
  useEffect(() => {
    if (mapMode !== "all" || seeded.current) return;
    seeded.current = true;
    if (expanded.size === 0) setExpanded(new Set(changedOpen));
  }, [mapMode, expanded, changedOpen, setExpanded]);
  const fold = (close: boolean, shown: string[]) => {
    if (mapMode === "all") setExpanded(close ? new Set() : new Set(changedOpen));
    else setCollapsed(close ? new Set(shown) : new Set());
  };

  const counts = countFiles(model.graph.files);
  const openCount = comments.filter((c) => commentState(model, tree.byPath, c) !== "resolved").length;
  const depCounts = countDeps(model.graph.edges);

  return (
    <div className="app">
      <ModuleBar>
        <BarCounts>
          <BarLabel>ファイル</BarLabel>
          <StatusCounts stats={counts} unit="ファイル" showZero />
          <BarSep />
          <BarLabel>依存</BarLabel>
          <ChangeCounts stats={depCounts} title={DEP_TITLE(depCounts)} showZero />
        </BarCounts>
        <BarSpacer />
        <ReviewProgress done={reviewed.size} total={targets.size} title="確認済みにした、変更したファイル（そのファイルの依存がまた変わると外れます）" />
        <button className={`ds-btn${sidebarOpen ? " on" : ""}`} onClick={() => setSidebarOpen(!sidebarOpen)} title="コメントのサイドバーを開閉">
            <CommentIcon size={13} />
            コメント {comments.length}
          {comments.length > 0 && <span className="muted">（未対応 {openCount}）</span>}
        </button>
      </ModuleBar>
      <main>
        <DepMap
          model={model}
          root={tree.root}
          tree={tree.byPath}
          mode={mapMode}
          onModeChange={(m) => {
            setMapMode(m);
            savePref("mapMode", m);
          }}
          open={expanded}
          onToggle={toggleDir}
          collapsed={collapsed}
          onCollapseToggle={toggleCollapsed}
          onFold={fold}
          pins={pins}
          onTogglePin={togglePin}
          onClearPins={() => setPins([])}
          onPin={pinMany}
          reviewTargets={targets}
          reviewed={reviewed}
          onReviewed={setReviewed}
          comments={comments}
          onCommentsChange={updateComments}
          sidebarOpen={sidebarOpen}
          onSidebarOpen={setSidebarOpen}
          active={active}
          openLabel={openLabel}
          onOpenFile={onOpenFile}
        />
      </main>
    </div>
  );
}

const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function countFiles(files: FileNode[]) {
  const c = { added: 0, modified: 0, removed: 0 };
  for (const f of files) if (f.status !== "unchanged") c[f.status]++;
  return c;
}

/** Imports that appeared / disappeared, counted like the tree rows (one per importing file and imported package), local only */
function countDeps(edges: Edge[]) {
  const c = { added: 0, removed: 0 };
  for (const e of edges) if (!e.external && e.status !== "unchanged") c[e.status]++;
  return c;
}
