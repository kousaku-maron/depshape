import { AiIcon, copyText, loadJSON, saveJSON, type AiBatch, type AiComment, type AiPlaced, type CommentReport, type ShapeModule } from "@diffshape/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { effortsOf, elapsed, fixPrompt, NO_PREFS, pick, plainReport, readPrefs, reviewOutcome, reviewPrompt, settle, type AgentInfo, type AgentJob, type AgentState, type AiPrefs, type Choice, type Compared, type JobKind, type Scope, type Section } from "./ai";

/*
 * The AI button of the header: a review by the agent the user has (its comments go to the modules,
 * like the user's own), a fix of the open comments by an agent, or one after the other.
 * Shown only where it can run: a comparison with the working tree, with Claude Code or Codex installed.
 *
 * The server runs one job at a time and keeps it, so a page opened again finds the job it started.
 */

const PREFS_KEY = "diffshape.ai";
// the last job this tab acted on, so a reload does not add a review's comments twice
const SEEN_KEY = "diffshape.ai.seen";

const KIND_LABEL: Record<JobKind, string> = { review: "レビュー", fix: "修正" };

interface Props {
  info: Compared;
  modules: ShapeModule[];
  current: ShapeModule;
  reports: Record<string, CommentReport>;
  /** What each module did with the last review handed to it */
  acks: Record<string, AiPlaced>;
  /** Hands a review's comments to the modules */
  onBatch: (batch: AiBatch) => void;
  /** Reads the repository again (after a fix) */
  onReload: () => Promise<void>;
  /** Whether a fix is editing the working tree right now */
  onFixing: (fixing: boolean) => void;
  flash: (text: string) => void;
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function AiControl({ info, modules, current, reports, acks, onBatch, onReload, onFixing, flash }: Props) {
  const [state, setState] = useState<AgentState | null>(null);
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState<AiPrefs>(() => readPrefs(loadJSON<unknown>(PREFS_KEY, NO_PREFS)));
  const [error, setError] = useState<string | null>(null);
  /** What the last job came to */
  const [outcome, setOutcome] = useState<string | null>(null);
  /** A review whose comments the modules are placing; `chain` goes on to a fix */
  const [placing, setPlacing] = useState<{ seq: number; ids: string[]; other: number; chain: boolean } | null>(null);
  const chain = useRef(false);

  const change = (next: AiPrefs) => {
    setPrefs(next);
    saveJSON(PREFS_KEY, next);
  };

  // ---- the server's state: asked once, then every second while a job runs
  const poll = useCallback(() => request<AgentState>("/api/agent").then(setState, () => {}), []);
  useEffect(() => void poll(), [poll]);
  const job = state?.job ?? null;
  const running = job?.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = window.setTimeout(() => void poll(), 1000);
    return () => window.clearTimeout(t);
  }, [running, state, poll]);
  useEffect(() => onFixing(running && job?.kind === "fix"), [running, job?.kind, onFixing]);

  // ---- what can be reviewed and fixed here
  const reviewers = useMemo(() => modules.filter((m) => reports[m.id]?.review), [modules, reports]);
  const inScope = (list: ShapeModule[]) => (prefs.scope === "all" ? list : list.filter((m) => m === current));
  const toReview = inScope(reviewers);
  const toFix = inScope(modules.filter((m) => (reports[m.id]?.open ?? 0) > 0));
  const openCount = toFix.reduce((n, m) => n + reports[m.id].open, 0);
  const section = (m: ShapeModule): Section => ({ id: m.id, heading: m.heading, review: reports[m.id]?.review?.(), comments: (reports[m.id]?.open ?? 0) > 0 ? reports[m.id].prompt() : "" });

  const agents = state?.agents ?? [];
  const chosen = { review: settle(prefs.review, agents), fix: settle(prefs.fix, agents) };

  const start = async (kind: JobKind, prompt: string) => {
    const c = chosen[kind];
    if (!c) return;
    setError(null);
    setOutcome(null);
    try {
      const started = await request<AgentJob>("/api/agent/start", { kind, agent: c.agent.id, prompt, model: c.model, effort: c.effort });
      setState((s) => (s ? { ...s, job: started } : s));
    } catch (e) {
      chain.current = false;
      setError(message(e));
    }
  };
  const review = (thenFix: boolean) => {
    // a module where nothing changed (no dependency, no schema change) has nothing to review
    const sections = toReview.map(section).filter((s) => s.review?.trim());
    if (sections.length === 0) return setError("レビューする変更がありません");
    chain.current = thenFix;
    void start("review", reviewPrompt(info, sections));
  };
  const fix = () => void start("fix", fixPrompt(info, toFix.map(section)));
  // the effects below run it with what the latest render knows (the comments a review just added)
  const fixNow = useRef(fix);
  fixNow.current = fix;
  const cancel = () => {
    chain.current = false;
    void request("/api/agent/cancel", {}).then(poll, (e) => setError(message(e)));
  };

  // ---- a job that ended: its comments go to the modules; after a fix the repository is read again
  const seen = useRef(loadJSON<string>(SEEN_KEY, ""));
  useEffect(() => {
    if (!job || job.status === "running") return;
    const key = `${job.id}:${job.startedAt}`;
    if (seen.current === key) return;
    seen.current = key;
    const who = agents.find((a) => a.id === job.agent)?.label ?? job.agent;
    const say = (text: string) => {
      setOutcome(text);
      flash(text);
    };
    if (job.kind === "review") {
      const then = chain.current;
      chain.current = false;
      if (job.status !== "done") {
        saveJSON(SEEN_KEY, key);
        return say(job.status === "cancelled" ? "レビューを中止しました" : `レビューできませんでした: ${job.error ?? ""}`);
      }
      const items = (job.comments ?? []) as AiComment[];
      const ids = reviewers.map((m) => m.id);
      // a page opened again while the review ran: wait until its modules are there to take the comments
      if (ids.length === 0) {
        seen.current = "";
        chain.current = then;
        return;
      }
      saveJSON(SEEN_KEY, key);
      onBatch({ seq: job.startedAt, agent: who, items });
      setPlacing({ seq: job.startedAt, ids, other: items.filter((i) => !ids.includes(i.module)).length, chain: then });
      return;
    }
    saveJSON(SEEN_KEY, key);
    const changed = job.changedFiles?.length ?? 0;
    const end = job.status === "done" ? "修正が終わりました" : job.status === "cancelled" ? "修正を中止しました" : `修正できませんでした: ${job.error ?? ""}`;
    // a fix that failed or was stopped may have edited files too
    void (changed || job.status === "done" ? onReload() : Promise.resolve()).then(() => say(`${end}（変更 ${changed} ファイル）`));
  }, [job, agents, reviewers, onBatch, onReload, flash]);

  // every module has placed its comments (and reported them): say what came of it, then fix if asked.
  // A module that does not answer (its view is gone after a reload that failed) is not waited for long.
  const [waited, setWaited] = useState(0);
  useEffect(() => {
    if (!placing) return;
    const t = window.setTimeout(() => setWaited(placing.seq), 10000);
    return () => window.clearTimeout(t);
  }, [placing]);
  useEffect(() => {
    if (!placing) return;
    const done = placing.ids.filter((id) => acks[id]?.seq === placing.seq);
    if (done.length < placing.ids.length && waited !== placing.seq) return;
    setPlacing(null);
    const placed = done.reduce((n, id) => n + acks[id].placed, 0);
    const dropped = done.reduce((n, id) => n + acks[id].dropped, 0) + placing.other;
    const text = reviewOutcome(placed, dropped);
    if (placing.chain && openCount > 0) {
      flash(text);
      fixNow.current();
    } else {
      const none = placing.chain ? "。直すコメントがないので、修正はしていません" : "";
      setOutcome(text + none);
      flash(text + none);
    }
  }, [placing, acks, waited, openCount, flash]);

  // ---- the panel closes on a click outside it, and on Esc
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  if (!state?.available) return null;

  const busy = running || !!placing;
  const time = job && running ? elapsed(Date.now() - job.startedAt) : "";
  const noReview = toReview.length === 0 ? (prefs.scope === "current" ? `${current.title}の画面は、まだ AI レビューに対応していません` : "AI レビューに対応した画面がありません") : undefined;
  const noFix = openCount === 0 ? "未対応のコメントがありません" : undefined;

  return (
    <div className="ai" ref={root}>
      <button className={`ds-btn${open ? " on" : ""}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} title="AI にレビューや修正をさせる（Claude Code / Codex）">
        <AiIcon size={13} className={running ? "ai-pulse" : undefined} />
        {running && job ? `AI ${KIND_LABEL[job.kind]}中 ${time}` : "AI"}
      </button>
      {open && (
        <div className="ai-panel" role="dialog" aria-label="AI レビューと修正">
          {modules.length > 1 && (
            <div className="ai-row">
              <span className="ai-label">範囲</span>
              <div className="ds-seg" role="radiogroup" aria-label="範囲">
                {(
                  [
                    ["current", `この画面（${current.title}）`],
                    ["all", "すべて"],
                  ] as [Scope, string][]
                ).map(([s, label]) => (
                  <button key={s} role="radio" aria-checked={prefs.scope === s} className={prefs.scope === s ? "on" : ""} disabled={busy} onClick={() => change({ ...prefs, scope: s })}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <AgentRow label="レビュー" agents={agents} choice={prefs.review} disabled={busy} onChange={(c) => change({ ...prefs, review: c })} />
          <AgentRow label="修正" agents={agents} choice={prefs.fix} disabled={busy} onChange={(c) => change({ ...prefs, fix: c })} />
          <div className="ai-actions">
            <button className="ds-btn" disabled={busy || !!noReview} title={noReview ?? "差分を読んでコメントを付けます（ファイルは変えません）"} onClick={() => review(false)}>
              レビュー
            </button>
            <button className="ds-btn" disabled={busy || !!noFix} title={noFix ?? "未対応のコメントに対応するよう、作業ディレクトリのファイルを編集します"} onClick={fix}>
              修正{openCount > 0 ? `（${openCount}）` : ""}
            </button>
            <button className="ds-btn ds-btn-primary" disabled={busy || !!noReview} title={noReview ?? "レビューして、付いたコメントを続けて修正します"} onClick={() => review(true)}>
              レビューして修正
            </button>
          </div>
          {error && <div className="ai-error">{error}</div>}
          {running && job && (
            <div className="ai-run">
              <div className="ai-run-head">
                <span>
                  {agents.find((a) => a.id === job.agent)?.label ?? job.agent} が{KIND_LABEL[job.kind]}中… {time}
                </span>
                <span className="shell-spacer" />
                <button className="ds-btn" onClick={cancel}>
                  中止
                </button>
              </div>
              <Log lines={job.log} />
            </div>
          )}
          {!running && placing && <div className="ai-outcome">コメントを置いています…</div>}
          {!busy && outcome && (
            <div className="ai-outcome">
              <div>{outcome}</div>
              {job?.kind === "fix" && job.text && <div className="ai-said">{plainReport(job.text)}</div>}
              {job?.kind === "fix" && job.snapshot && (job.changedFiles?.length ?? 0) > 0 && <Snapshot command={`diffshape . ${job.snapshot}`} />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One job's agent, with the model and the effort it runs with */
function AgentRow({ label, agents, choice, disabled, onChange }: { label: string; agents: AgentInfo[]; choice: Choice; disabled: boolean; onChange: (c: Choice) => void }) {
  const c = settle(choice, agents);
  if (!c) return null;
  const efforts = effortsOf(c.agent, c.model);
  return (
    <div className="ai-row">
      <span className="ai-label">{label}</span>
      <select className="ds-select" aria-label={`${label}のエージェント`} value={c.agent.id} disabled={disabled || agents.length < 2} onChange={(e) => onChange(pick(choice, e.target.value, {}))}>
        {agents.map((a) => (
          <option key={a.id} value={a.id} title={a.version ? `${a.label} ${a.version}` : a.label}>
            {a.label}
          </option>
        ))}
      </select>
      <select
        className="ds-select ai-model"
        aria-label={`${label}のモデル`}
        value={c.model}
        disabled={disabled || c.agent.models.length === 0}
        title={c.agent.models.find((m) => m.id === c.model)?.description ?? `${c.agent.label}${c.agent.version ? ` ${c.agent.version}` : ""} の設定どおり`}
        // an effort the new model does not take falls back to the default (see settle)
        onChange={(e) => onChange(pick(choice, c.agent.id, { model: e.target.value }))}
      >
        <option value="">既定のモデル</option>
        {c.agent.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      <select className="ds-select" aria-label={`${label}の Effort`} value={c.effort} disabled={disabled || efforts.length === 0} title="考える深さ（Effort）" onChange={(e) => onChange(pick(choice, c.agent.id, { effort: e.target.value }))}>
        <option value="">既定の Effort</option>
        {efforts.map((e) => (
          <option key={e} value={e}>
            {e}
          </option>
        ))}
      </select>
    </div>
  );
}

/** What the agent is doing: the last lines, the newest at the bottom */
function Log({ lines }: { lines: string[] }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (el.current) el.current.scrollTop = el.current.scrollHeight;
  }, [lines.length]);
  return (
    <div className="ai-log" ref={el}>
      {lines.length === 0 ? <div className="shell-muted">開始しています…</div> : lines.map((l, i) => <div key={i}>{l}</div>)}
    </div>
  );
}

/** The working tree as it was before the fix is kept: the command that shows the fix alone */
function Snapshot({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ai-snapshot">
      <span className="shell-muted">AI の変更だけを見る:</span>
      <code>{command}</code>
      <button
        className="ds-link"
        onClick={() =>
          void copyText(command).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          })
        }
      >
        {copied ? "コピーしました" : "コピー"}
      </button>
    </div>
  );
}
