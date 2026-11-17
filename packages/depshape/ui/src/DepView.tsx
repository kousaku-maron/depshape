import { CommentIcon, loadCommentList, loadJSON, saveCommentList, saveJSON, useStoredSet, type ModuleViewProps } from "@diffshape/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DiffGraph, FileNode } from "../../src/types";
import { commentState, formatPrompt, type ReviewComment } from "./comments";
import { DepMap } from "./DepMap";
import { ancestorsOf, buildModel, buildTree, outgoing, type Model } from "./model";
import type { MapMode } from "./view";

function loadPref<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(`depshape.${key}`) as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}
function savePref(key: string, value: string) {
  try {
    localStorage.setItem(`depshape.${key}`, value);
  } catch {
    /* ignore */
  }
}

export function DepView({ data: graph, active, onComments }: ModuleViewProps<DiffGraph>) {
  const repo = graph.repoRoot;
  const [includeExternal, setIncludeExternal] = useState(loadPref<string>("external", "0") === "1");
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
  const edgeCounts = countEdges(model);

  return (
    <div className="app">
      <header className="topbar">
        <div className="summary">
          <span className="pill added">+{counts.added} ファイル</span>
          <span className="pill modified">~{counts.modified}</span>
          <span className="pill removed">−{counts.removed}</span>
          <span className="sep" />
          <span className="pill added">+{edgeCounts.added} 依存</span>
          <span className="pill removed">−{edgeCounts.removed} 依存</span>
        </div>
        <div className="controls">
          <button className={`ds-btn${sidebarOpen ? " on" : ""}`} onClick={() => setSidebarOpen(!sidebarOpen)} title="コメントのサイドバーを開閉">
            <CommentIcon size={13} />
            コメント {comments.length}
            {comments.length > 0 && <span className="muted">（未対応 {openCount}）</span>}
          </button>
          <label className="ds-check">
            <input
              type="checkbox"
              checked={includeExternal}
              onChange={(e) => {
                setIncludeExternal(e.target.checked);
                savePref("external", e.target.checked ? "1" : "0");
              }}
            />
            外部パッケージも表示
          </label>
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
          includeExternal={includeExternal}
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

function countEdges(model: Model) {
  // folder-level edges that appeared / disappeared, local only
  const c = { added: 0, removed: 0 };
  for (const dir of model.changedDirs) {
    for (const fe of outgoing(model, dir, false)) if (fe.status !== "unchanged") c[fe.status]++;
  }
  return c;
}
