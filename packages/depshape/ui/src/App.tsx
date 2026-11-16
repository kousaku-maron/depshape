import { useCallback, useEffect, useMemo, useState } from "react";
import { DepMap } from "./DepMap";
import type { MapMode } from "./view";
import { commentState, formatPrompt, type ReviewComment } from "./comments";
import { copyText } from "@diffshape/ui";
import type { DiffGraph, EdgeStatus, FileNode } from "../../src/types";
import { ancestorsOf, buildModel, buildTree, outgoing, type Model } from "./model";

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

export function App() {
  const [graph, setGraph] = useState<DiffGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [includeExternal, setIncludeExternal] = useState(loadPref<string>("external", "0") === "1");
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const [revealed, setRevealed] = useState<Set<string> | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string> | null>(null);
  const [pins, setPins] = useState<string[] | null>(null);
  const [comments, setComments] = useState<ReviewComment[] | null>(null);
  const [mapMode, setMapMode] = useState<MapMode>(loadPref<MapMode>("mapMode", "changes"));
  // the comment sidebar starts closed every time; selecting a link or a row opens it
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [copyNote, setCopyNote] = useState<string | null>(null);

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/graph${refresh ? "?refresh=1" : ""}`);
      if (!res.ok) throw new Error(await res.text());
      setGraph(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  const model = useMemo(() => (graph ? buildModel(graph) : null), [graph]);
  const tree = useMemo(() => (model ? buildTree(model) : null), [model]);
  const expandKey = graph ? `expanded:${graph.repoRoot}` : null;

  // restore / persist which boxes are open (per repository)
  useEffect(() => {
    if (!expandKey || expanded) return;
    let initial: string[] = [];
    try {
      initial = JSON.parse(localStorage.getItem(`depshape.${expandKey}`) ?? "[]");
    } catch {
      /* ignore */
    }
    setExpanded(new Set(initial));
  }, [expandKey, expanded]);
  useEffect(() => {
    if (expandKey && expanded) savePref(expandKey, JSON.stringify([...expanded]));
  }, [expandKey, expanded]);

  // folders revealed in full in the "changes" view (per repository)
  const revealKey = graph ? `revealed:${graph.repoRoot}` : null;
  useEffect(() => {
    if (!revealKey || revealed) return;
    let initial: string[] = [];
    try {
      initial = JSON.parse(localStorage.getItem(`depshape.${revealKey}`) ?? "[]");
    } catch {
      /* ignore */
    }
    setRevealed(new Set(initial));
  }, [revealKey, revealed]);
  useEffect(() => {
    if (revealKey && revealed) savePref(revealKey, JSON.stringify([...revealed]));
  }, [revealKey, revealed]);

  // folders folded away in the "changes" view (per repository)
  const collapseKey = graph ? `collapsed:${graph.repoRoot}` : null;
  useEffect(() => {
    if (!collapseKey || collapsed) return;
    let initial: string[] = [];
    try {
      initial = JSON.parse(localStorage.getItem(`depshape.${collapseKey}`) ?? "[]");
    } catch {
      /* ignore */
    }
    setCollapsed(new Set(Array.isArray(initial) ? initial : []));
  }, [collapseKey, collapsed]);
  useEffect(() => {
    if (collapseKey && collapsed) savePref(collapseKey, JSON.stringify([...collapsed]));
  }, [collapseKey, collapsed]);
  const toggleCollapsed = useCallback(
    (dir: string) =>
      setCollapsed((prev) => {
        const next = new Set(prev ?? []);
        if (next.has(dir)) next.delete(dir);
        else next.add(dir);
        return next;
      }),
    [],
  );

  // items pinned to the dependency panel (per repository, in pin order)
  const pinKey = graph ? `pins:${graph.repoRoot}` : null;
  useEffect(() => {
    if (!pinKey || pins) return;
    let initial: string[] = [];
    try {
      initial = JSON.parse(localStorage.getItem(`depshape.${pinKey}`) ?? "[]");
    } catch {
      /* ignore */
    }
    setPins(Array.isArray(initial) ? initial : []);
  }, [pinKey, pins]);
  useEffect(() => {
    if (pinKey && pins) savePref(pinKey, JSON.stringify(pins));
  }, [pinKey, pins]);
  // review comments (per repository and comparison, like difit); they survive re-analysis
  const commentKey = graph ? `comments:${graph.repoRoot}|${graph.targetLabel}|${graph.baseLabel}` : null;
  const [loadedCommentKey, setLoadedCommentKey] = useState<string | null>(null);
  useEffect(() => {
    if (!commentKey || loadedCommentKey === commentKey) return;
    let initial: ReviewComment[] = [];
    try {
      initial = JSON.parse(localStorage.getItem(`depshape.${commentKey}`) ?? "[]");
    } catch {
      /* ignore */
    }
    setComments(Array.isArray(initial) ? initial : []);
    setLoadedCommentKey(commentKey);
  }, [commentKey, loadedCommentKey]);
  const updateComments = useCallback(
    (next: ReviewComment[]) => {
      setComments(next);
      if (commentKey) savePref(commentKey, JSON.stringify(next));
    },
    [commentKey],
  );
  const pinMany = useCallback(
    (ids: string[]) => setPins((prev) => [...(prev ?? []), ...ids.filter((id) => !(prev ?? []).includes(id))]),
    [],
  );

  const togglePin = useCallback(
    (id: string) => setPins((prev) => ((prev ?? []).includes(id) ? (prev ?? []).filter((p) => p !== id) : [...(prev ?? []), id])),
    [],
  );

  const toggleDir = useCallback((dir: string) => {
    const flip = (prev: Set<string> | null) => {
      const next = new Set(prev ?? []);
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
  }, [mapMode]);

  if (error) return <div className="fatal">読み込みに失敗しました: {error}</div>;
  if (!model || !tree || !expanded || !revealed || !collapsed || !pins || !comments) return <div className="fatal">解析中…</div>;

  const counts = countFiles(model.graph.files);
  const openCount = comments.filter((c) => commentState(model, tree.byPath, c) !== "resolved").length;
  const copyAll = async () => {
    const { text, included, skipped } = formatPrompt(model, tree.byPath, comments);
    if (included === 0) return;
    await copyText(text);
    setCopyNote(`${included} 件をコピーしました${skipped ? `（解消済み？の ${skipped} 件は除外）` : ""}`);
    window.setTimeout(() => setCopyNote(null), 2500);
  };
  const edgeCounts = countEdges(model);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">depshape</div>
        <div className="compare">
          <span className="label">比較</span>
          <span className="rev">{model.graph.targetLabel}</span>
          <span className="arrow">←</span>
          <span className="rev">{model.graph.baseLabel}</span>
        </div>
        <div className="summary">
          <span className="pill added">+{counts.added} ファイル</span>
          <span className="pill modified">~{counts.modified}</span>
          <span className="pill removed">−{counts.removed}</span>
          <span className="sep" />
          <span className="pill added">+{edgeCounts.added} 依存</span>
          <span className="pill removed">−{edgeCounts.removed} 依存</span>
        </div>
        <div className="controls">
          <button
            className={sidebarOpen ? "on" : ""}
            onClick={() => setSidebarOpen(!sidebarOpen)}
            title="コメントのサイドバーを開閉"
          >
            💬 {comments.length}
            {comments.length > 0 && <span className="muted">（未対応 {openCount}）</span>}
          </button>
          <span className="copy-all">
            <button className="primary" onClick={copyAll} disabled={openCount === 0} title="未対応のコメントを AI 用のプロンプトとしてコピー">
              AI 用にすべてコピー
            </button>
            {copyNote && <span className="copy-note">{copyNote}</span>}
          </span>
          <label className="toggle">
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
          <button onClick={() => load(true)} disabled={loading}>
            {loading ? "再解析中…" : "再読み込み"}
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
          includeExternal={includeExternal}
          comments={comments}
          onCommentsChange={updateComments}
          sidebarOpen={sidebarOpen}
          onSidebarOpen={setSidebarOpen}
        />
      </main>
    </div>
  );
}

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
