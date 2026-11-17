import { ChangeCounts, CommentIcon, loadCommentList, loadJSON, saveCommentList, saveJSON, useStoredSet, StatusCounts, type ModuleViewProps } from "@diffshape/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DiffGraph, Edge, FileNode } from "../../src/types";
import { commentState, formatPrompt, type ReviewComment } from "./comments";
import { DepMap } from "./DepMap";
import { ancestorsOf, buildModel, buildTree } from "./model";
import { loadPref, savePref } from "./prefs";
import { loadReviewed, reviewedFiles, reviewScope, reviewTargets, saveReviewed } from "./reviewed";
import { DEP_TITLE } from "./depTitle";
import type { MapMode } from "./view";

export function DepView({ data: graph, active, onComments }: ModuleViewProps<DiffGraph>) {
  const repo = graph.repoRoot;
  // what is open / revealed / folded / pinned is kept per repository
  const [expanded, setExpanded] = useStoredSet(`depshape.expanded:${repo}`);
  const [revealed, setRevealed] = useStoredSet(`depshape.revealed:${repo}`);
  const [collapsed, setCollapsed] = useStoredSet(`depshape.collapsed:${repo}`);
  const pinKey = `depshape.pins:${repo}`;
  const [pins, setPins] = useState<string[]>(() => stringList(loadJSON<unknown>(pinKey, [])));
  useEffect(() => saveJSON(pinKey, pins), [pinKey, pins]);
  // review comments (per repository and comparison, like difit); they survive re-analysis
  const commentKey = `depshape.comments:${repo}|${graph.targetLabel}|${graph.baseLabel}`;
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
  const targets = useMemo(() => reviewTargets(graph.edges), [graph]);
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

  // tell the shell how many comments are open, and how to copy them
  useEffect(() => {
    const open = comments.filter((c) => commentState(model, tree.byPath, c) !== "resolved").length;
    onComments({ open, prompt: () => formatPrompt(model, tree.byPath, comments, { header: false }).text });
  }, [comments, model, tree, onComments]);

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

  const toggleDir = useCallback(
    (dir: string) => {
      const flip = (prev: Set<string>) => {
        const next = new Set(prev);
        if (next.has(dir)) {
          // closing a box also closes everything inside it
          for (const d of [...next]) if (d === dir || d.startsWith(dir + "/")) next.delete(d);
        } else {
          next.add(dir);
        }
        return next;
      };
      if (mapMode === "all") setExpanded(flip);
      else setRevealed(flip);
    },
    [mapMode, setExpanded, setRevealed],
  );

  const counts = countFiles(model.graph.files);
  const openCount = comments.filter((c) => commentState(model, tree.byPath, c) !== "resolved").length;
  const depCounts = countDeps(model.graph.edges);

  return (
    <div className="app">
      <header className="topbar">
        <div className="summary">
          <span className="slabel">ファイル</span>
          <StatusCounts stats={counts} unit="ファイル" showZero />
          <span className="sep" />
          <span className="slabel">依存</span>
          <ChangeCounts stats={depCounts} title={DEP_TITLE(depCounts)} showZero />
        </div>
        <div className="controls">
          {targets.size > 0 && (
            <span className="ds-progress" title="確認済みにした、依存が変わったファイル（依存がまた変わると外れます）">
              <span>
                確認済み {reviewed.size} / {targets.size}
              </span>
              <span className="ds-progress-bar">
                <span style={{ width: `${(reviewed.size / targets.size) * 100}%` }} />
              </span>
            </span>
          )}
          <button className={`ds-btn${sidebarOpen ? " on" : ""}`} onClick={() => setSidebarOpen(!sidebarOpen)} title="コメントのサイドバーを開閉">
            <CommentIcon size={13} />
            コメント {comments.length}
            {comments.length > 0 && <span className="muted">（未対応 {openCount}）</span>}
          </button>
        </div>
      </header>
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
          open={mapMode === "all" ? expanded : revealed}
          onToggle={toggleDir}
          collapsed={collapsed}
          onCollapseToggle={toggleCollapsed}
          onExpandAll={() => setCollapsed(new Set())}
          onExpandChanged={() => {
            const next = new Set(expanded);
            for (const d of model.changedDirs) for (const a of ancestorsOf(d)) next.add(a);
            setExpanded(next);
          }}
          onCollapseAll={() => (mapMode === "all" ? setExpanded(new Set()) : setRevealed(new Set()))}
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
