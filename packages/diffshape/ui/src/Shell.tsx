import { copyText, CopyIcon, loadJSON, RefreshIcon, saveJSON, type AiBatch, type AiPlaced, type CommentReport, type OpenRequest, type ShapeModule } from "@diffshape/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commentsPrompt } from "./ai";
import { AiControl } from "./AiControl";
import { MODULES } from "./modules";

/*
 * The diffshape app: an icon rail to switch modules, a header with the comparison, the reload, the
 * AI copy of every module's comments and the AI review and fix, and the modules' views. Views stay mounted while hidden, so a
 * module keeps where it was (open boxes, the selected table, a half-written comment).
 */

interface Info {
  repoRoot: string;
  targetLabel: string;
  baseLabel: string;
  baseRev: string | null;
  modules: string[];
  /** An id of the server's run when it was started with --clean */
  clean: string | null;
}

const CLEANED_KEY = "diffshape.cleaned";

/**
 * --clean: clears this comparison's comments and reviewed marks in every module, once per server run
 * (the id is kept, so reloading the page keeps what was written since). Runs before any view mounts,
 * as the views read their saved state when they mount.
 */
function cleanOnce(info: Info) {
  if (!info.clean || loadJSON<string>(CLEANED_KEY, "") === info.clean) return;
  for (const m of MODULES) if (info.modules.includes(m.id)) m.clearReview(info);
  saveJSON(CLEANED_KEY, info.clean);
}

type Loaded = { state: "loading" } | { state: "ready"; data: unknown } | { state: "error"; error: string };

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}

/** The URL says which module is shown and, after a slash, what it shows (#dep, #file/src/app.ts) */
function fromHash(): { module: string; target: string | null } {
  const h = window.location.hash.replace(/^#\/?/, "");
  const i = h.indexOf("/");
  if (i < 0) return { module: h, target: null };
  let target: string;
  try {
    target = decodeURIComponent(h.slice(i + 1));
  } catch {
    target = h.slice(i + 1);
  }
  return { module: h.slice(0, i), target: target || null };
}
const toHash = (module: string, target: string) => `${module}/${target.split("/").map(encodeURIComponent).join("/")}`;

export function Shell() {
  const [info, setInfo] = useState<Info | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const [reloading, setReloading] = useState(false);
  const [active, setActive] = useState(() => fromHash().module);
  // what each module was last asked to show (by another module, or by the URL it was opened with)
  const [requests, setRequests] = useState<Record<string, OpenRequest>>(() => {
    const h = fromHash();
    return h.target ? { [h.module]: { target: h.target, seq: 1 } } : {};
  });
  const [reports, setReports] = useState<Record<string, CommentReport>>({});
  const [note, setNote] = useState<string | null>(null);

  const modules = useMemo(() => (info ? MODULES.filter((m) => info.modules.includes(m.id)) : []), [info]);

  const load = useCallback(async (refresh: boolean) => {
    try {
      const i = await getJSON<Info>(`/api/info${refresh ? "?refresh=1" : ""}`);
      cleanOnce(i);
      setInfo(i);
      setFatal(null);
      // a module already shown keeps its view (and its state) until the new data arrives
      setLoaded((prev) => Object.fromEntries(i.modules.map((id) => [id, prev[id]?.state === "ready" ? prev[id] : ({ state: "loading" } as Loaded)])));
      // each module shows up as soon as its own analysis is done
      await Promise.all(
        i.modules.map(async (id) => {
          let next: Loaded;
          try {
            const r = await getJSON<{ data: unknown } | { error: string }>(`/api/module/${id}`);
            next = "error" in r ? { state: "error", error: r.error } : { state: "ready", data: r.data };
          } catch (e) {
            next = { state: "error", error: e instanceof Error ? e.message : String(e) };
          }
          setLoaded((prev) => ({ ...prev, [id]: next }));
        }),
      );
    } catch (e) {
      setFatal(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  // the shown module follows the URL (#dep, #db, #file/<path>), so a reload, a shared link or the
  // back button opens the same one, at the same thing
  const followHash = useCallback(() => {
    const h = fromHash();
    setActive(h.module);
    if (h.target) {
      const target = h.target;
      setRequests((prev) => ({ ...prev, [h.module]: { target, seq: (prev[h.module]?.seq ?? 0) + 1 } }));
    }
  }, []);
  useEffect(() => {
    window.addEventListener("hashchange", followHash);
    return () => window.removeEventListener("hashchange", followHash);
  }, [followHash]);
  const current = modules.find((m) => m.id === active) ?? modules[0];
  const show = (id: string) => {
    window.location.hash = id;
    setActive(id);
  };
  const openIn = useCallback(
    (module: string, target: string) => {
      const next = toHash(module, target);
      // the same link again (the user scrolled away since) fires no hashchange: ask again by hand
      if (window.location.hash.replace(/^#\/?/, "") === next) followHash();
      else window.location.hash = next;
    },
    [followHash],
  );
  const moduleIds = useMemo(() => modules.map((m) => m.id), [modules]);

  // one stable callback per module, so a view's effect does not run on every shell render
  const reporters = useRef(new Map<string, (r: CommentReport) => void>());
  const reporter = (id: string) => {
    let f = reporters.current.get(id);
    if (!f) reporters.current.set(id, (f = (r: CommentReport) => setReports((prev) => ({ ...prev, [id]: r }))));
    return f;
  };

  const reload = useCallback(async () => {
    setReloading(true);
    await load(true);
    setReloading(false);
  }, [load]);

  const flash = useCallback((text: string) => {
    setNote(text);
    window.setTimeout(() => setNote((n) => (n === text ? null : n)), 4000);
  }, []);

  // an AI review's comments go to every module; each says what it kept (see AiControl)
  const [aiBatch, setAiBatch] = useState<AiBatch | null>(null);
  const [aiAcks, setAiAcks] = useState<Record<string, AiPlaced>>({});
  const ackers = useRef(new Map<string, (p: AiPlaced) => void>());
  const acker = (id: string) => {
    let f = ackers.current.get(id);
    if (!f) ackers.current.set(id, (f = (p: AiPlaced) => setAiAcks((prev) => ({ ...prev, [id]: p }))));
    return f;
  };
  const [fixing, setFixing] = useState(false);
  const withComments = modules.filter((m) => (reports[m.id]?.open ?? 0) > 0);
  const openTotal = withComments.reduce((n, m) => n + reports[m.id].open, 0);
  const copyAll = async () => {
    if (!info || openTotal === 0) return;
    await copyText(commentsPrompt(info, withComments.map((m) => ({ id: m.id, description: m.description, comments: reports[m.id].prompt() }))));
    flash(`${openTotal} 件をコピーしました`);
  };

  if (fatal) return <div className="shell-message">読み込めませんでした: {fatal}</div>;
  if (!info || !current) return <div className="shell-message shell-muted">解析中…</div>;

  return (
    <div className={`shell ${modules.length > 1 ? "with-rail" : ""}`}>
      {modules.length > 1 && (
        <nav className="rail" aria-label="モジュール">
          {modules.map((m) => (
            <RailButton key={m.id} module={m} loaded={loaded[m.id]} active={m === current} comments={reports[m.id]?.open ?? 0} onClick={() => show(m.id)} />
          ))}
        </nav>
      )}
      <header className="shell-head">
        <span className="shell-brand">diffshape</span>
        {modules.length === 1 && <span className="shell-module">{current.title}</span>}
        <span className="shell-compare" title={`${info.repoRoot}\n${info.baseLabel} → ${info.targetLabel}`}>
          <span className="ds-ref">{info.baseLabel}</span>
          <span className="shell-muted">→</span>
          <span className="ds-ref">{info.targetLabel}</span>
        </span>
        <span className="shell-spacer" />
        {note && <span className="shell-note">{note}</span>}
        <button
          className="ds-btn ds-btn-note"
          onClick={() => void copyAll()}
          disabled={openTotal === 0}
          title={openTotal ? `未対応のコメント（${withComments.map((m) => `${m.title} ${reports[m.id].open}`).join("、")}）を AI 用のプロンプトとしてコピー` : "未対応のコメントはありません"}
        >
          <CopyIcon size={13} />
          AI 用にコピー{openTotal > 0 ? `（${openTotal}）` : ""}
        </button>
        <AiControl info={info} modules={modules} current={current} reports={reports} acks={aiAcks} onBatch={setAiBatch} onReload={reload} onFixing={setFixing} flash={flash} />
        <button className="ds-btn" onClick={() => void reload()} disabled={reloading || fixing} title={fixing ? "AI が修正しています（終わると自動で読み直します）" : "リポジトリを読み直して比較し直す"}>
          <RefreshIcon size={13} className={reloading ? "shell-spin" : undefined} />
          {reloading ? "解析中…" : "再読み込み"}
        </button>
      </header>
      <main className="shell-body">
        {modules.map((m) => {
          const l = loaded[m.id] ?? { state: "loading" };
          const on = m === current;
          return (
            <section key={m.id} className="shell-module-root" data-module={m.id} hidden={!on}>
              {l.state === "loading" && <div className="shell-message shell-muted">解析中…</div>}
              {l.state === "error" && (
                <div className="shell-message">
                  <p>{m.description}</p>
                  <p className="shell-error">{l.error}</p>
                </div>
              )}
              {/* a new comparison (say, main moved on) starts the view again; a plain reload keeps its state */}
              {l.state === "ready" && (
                <m.View
                  key={`${info.targetLabel}|${info.baseLabel}`}
                  data={l.data}
                  active={on}
                  onComments={reporter(m.id)}
                  modules={moduleIds}
                  openIn={openIn}
                  request={requests[m.id] ?? null}
                  ai={aiBatch}
                  onAi={acker(m.id)}
                />
              )}
            </section>
          );
        })}
      </main>
    </div>
  );
}

function RailButton({ module: m, loaded, active, comments, onClick }: { module: ShapeModule; loaded?: Loaded; active: boolean; comments: number; onClick: () => void }) {
  const badge = loaded?.state === "ready" ? m.badge?.(loaded.data) : undefined;
  const Icon = m.icon;
  return (
    <button
      className={`rail-btn ${active ? "on" : ""} ${loaded?.state === "error" ? "unavailable" : ""}`}
      onClick={onClick}
      title={`${m.description}${badge ? `\n変更 ${badge}` : ""}${comments ? `\n未対応のコメント ${comments}` : ""}`}
      aria-label={m.title}
      aria-current={active ? "page" : undefined}
    >
      <Icon size={20} />
      <span className="rail-label">{m.title}</span>
      {badge !== undefined && <span className="rail-badge">{badge > 99 ? "99+" : badge}</span>}
      {comments > 0 && <span className="rail-dot" />}
    </button>
  );
}
