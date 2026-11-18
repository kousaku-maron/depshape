import { AreaDivider, BarCounts, BarLabel, BarSep, BarSpacer, ChangeCounts, CheckIcon, CommentCount, CommentIcon, ModuleBar, ReviewProgress, StatusCounts, useWidth, type AiBatch, type AiPlaced, type CommentReport } from "@diffshape/ui";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { schemaFromText } from "../../src/names";
import type { DbShapeResult, DomainChange, EnumChange, TableChange } from "../../src/model";
import { commentState, formatPrompt, loadComments, newComment, saveComments, targetId, targetLabel, type CommentTarget, type ReviewComment } from "./comments";
import { CommentsContext, STATE_LABEL, type CommentsApi } from "./CommentViews";
import { Details, type Selection } from "./Details";
import { ErDiagram, type ErDiagramHandle } from "./ErDiagram";
import type { Mode } from "./erLayout";
import { clampLayout, DEFAULT_LAYOUT, gridColumns, loadLayout, saveLayout, type Layout } from "./layout";
import { reviewList, toComments } from "./review";
import { comparisonScope, loadReviewed, saveReviewed } from "./reviewed";
import { changeTitle, hashOf, matchesFilter, tableStats, valueChips, valueTarget, type Status } from "./view";

/** Reviewed marks are kept per repository and comparison */
const scopeOf = (d: DbShapeResult) => comparisonScope({ repoRoot: d.repoRoot, baseLabel: d.base.label, targetLabel: d.target.label }) + d.database.id;

const GROUPS: { status: Status; title: string }[] = [
  { status: "added", title: "新規テーブル" },
  { status: "modified", title: "変更したテーブル" },
  { status: "removed", title: "削除したテーブル" },
];

interface Props {
  data: DbShapeResult;
  /** Shown: the module is shown and this is the selected database */
  active: boolean;
  onComments: (r: CommentReport) => void;
  /** The latest AI review, or null; the comments whose target starts with `aiPrefix` are for this database */
  ai: AiBatch | null;
  /** "" for the only database, "1/", "2/" … when the repository has several */
  aiPrefix: string;
  /** Says how many of the review's comments this database kept (`dropped` is counted by the module) */
  onAi: (placed: AiPlaced) => void;
  /** The database switcher, at the start of the first row (when the repository has several) */
  switcher?: ReactNode;
}

/** One database: the list, the ER diagram and the detail panel */
export function DbPane({ data, active, onComments, ai, aiPrefix, onAi, switcher }: Props) {
  const scope = scopeOf(data);
  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState<Mode>("changes");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [reviewed, setReviewed] = useState<Record<string, string>>(() => loadReviewed(scope));
  const [comments, setComments] = useState<ReviewComment[]>(() => loadComments(scope));
  const [composing, setComposing] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const diagram = useRef<ErDiagramHandle>(null);
  // area widths: dragged on the lines between them, saved for next time
  const bodyRef = useRef<HTMLDivElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  const bodyW = useWidth(bodyRef);
  const [layout, setLayout] = useState<Layout>(loadLayout);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      // Esc in a comment box only closes the box
      if (e.key === "Escape" && !(e.target instanceof HTMLElement && e.target.closest("textarea, input"))) setSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  // tell the shell how many comments are open, how to copy them, and what an AI reviewer is told
  useEffect(() => {
    const open = comments.filter((c) => commentState(data, c) !== "resolved").length;
    onComments({ open, prompt: () => formatPrompt(data, comments, { header: false }).text, review: () => reviewList(data, aiPrefix) });
  }, [data, comments, aiPrefix, onComments]);

  // ---- an AI review: the comments that name a part of this database's schema are kept
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const aiSeen = useRef(0);
  const [aiPlaced, setAiPlaced] = useState<AiPlaced | null>(null);
  useEffect(() => {
    if (!ai || ai.seq === aiSeen.current) return;
    aiSeen.current = ai.seq;
    const added = toComments(ai.items.filter((i) => i.module === "db"), data, aiPrefix, ai.agent);
    if (added.length) {
      const next = [...commentsRef.current, ...added];
      setComments(next);
      saveComments(scope, next);
    }
    setAiPlaced({ seq: ai.seq, placed: added.length, dropped: 0 });
  }, [ai, data, aiPrefix, scope]);
  // after the report above, so the module has the new comments when it hears they are placed
  useEffect(() => {
    if (aiPlaced) onAi(aiPlaced);
  }, [aiPlaced, onAi]);

  const tables = data.diff.tables;
  const known = useMemo(() => new Set(tables.map((t) => t.name)), [tables]);
  const isReviewed = (t: TableChange) => reviewed[t.name] === hashOf(t);
  const reviewedSet = useMemo(() => new Set(tables.filter((t) => reviewed[t.name] === hashOf(t)).map((t) => t.name)), [tables, reviewed]);

  // value changes as hover text on the diagram's column rows
  const valueText = useMemo(() => {
    const m = new Map<string, string>();
    for (const v of data.diff.values) {
      const text = valueChips(v.before, v.after)
        .map((c) => (c.status === "added" ? `+${c.value}` : c.status === "removed" ? `−${c.value}` : c.value))
        .join("  ");
      const cols = v.source === "check" ? [`${v.table}.${v.column}`] : (v.usedBy ?? []);
      for (const c of cols) m.set(c, `値: ${text}`);
    }
    return m;
  }, [data]);

  // open comments per table and per column, for the marks on the diagram
  const commentMarks = useMemo(() => {
    const tables = new Map<string, number>();
    const columns = new Set<string>();
    for (const c of comments) {
      if (commentState(data, c) === "resolved" || !c.target.table) continue;
      tables.set(c.target.table, (tables.get(c.target.table) ?? 0) + 1);
      if (c.target.kind === "column" || c.target.kind === "value") columns.add(`${c.target.table}.${c.target.name}`);
    }
    return { tables, columns };
  }, [data, comments]);

  const d = data.diff;
  const setTableReviewed = (t: TableChange, on: boolean) => {
    const next = { ...reviewed };
    if (on) next[t.name] = hashOf(t);
    else delete next[t.name];
    setReviewed(next);
    saveReviewed(scope, next);
  };

  const selectTable = (name: string, focus = true) => {
    setSelection({ kind: "table", name });
    // a table only shown in "all" (unchanged and not a neighbor) switches the view
    if (focus) window.setTimeout(() => diagram.current?.focus(name), 0);
  };

  const setAndSave = (next: ReviewComment[]) => {
    setComments(next);
    saveComments(scope, next);
  };
  const api: CommentsApi = {
    data,
    comments,
    composing,
    editing,
    compose: (t) => {
      setComposing(t ? targetId(t) : null);
      setEditing(null);
    },
    edit: (id) => {
      setEditing(id);
      setComposing(null);
    },
    add: (t, body) => {
      setAndSave([...comments, newComment(data, t, body)]);
      setComposing(null);
    },
    update: (id, body) => {
      setAndSave(comments.map((c) => (c.id === id ? { ...c, body } : c)));
      setEditing(null);
    },
    remove: (id) => setAndSave(comments.filter((c) => c.id !== id)),
  };
  /** Shows a comment: selects its table (or type) and scrolls the panel to it */
  const showComment = (t: CommentTarget) => {
    if (t.table) selectTable(t.table);
    else setSelection({ kind: "type", name: t.name });
    window.setTimeout(() => document.getElementById(`c-${targetId(t)}`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 50);
  };

  const shown = tables.filter((t) => matchesFilter(t, filter));
  const types = [
    ...d.enums.map((e) => ({ kind: "ENUM 型" as const, change: e as EnumChange | DomainChange })),
    ...d.domains.map((e) => ({ kind: "DOMAIN" as const, change: e as EnumChange | DomainChange })),
  ];
  const reviewedCount = tables.filter(isReviewed).length;
  const sel = selection;
  const selChange = sel?.kind === "table" ? tables.find((t) => t.name === sel.name) : undefined;
  const selEr = sel?.kind === "table" ? data.er.find((t) => t.name === sel.name) : undefined;
  const selValues = sel?.kind === "table" ? d.values.filter((v) => v.table === sel.name || v.usedBy?.some((u) => u.startsWith(`${sel.name}.`))) : [];
  const selType = sel?.kind === "type" ? types.find((t) => t.change.name === sel.name) : undefined;
  const empty = tables.length === 0 && d.values.length === 0 && types.length === 0;

  return (
    <CommentsContext.Provider value={api}>
      <div className="app">
        <ModuleBar>
          {switcher}
          <BarCounts>
            <BarLabel>テーブル</BarLabel>
            <StatusCounts
              stats={{
                added: tables.filter((t) => t.status === "added").length,
                modified: tables.filter((t) => t.status === "modified").length,
                removed: tables.filter((t) => t.status === "removed").length,
              }}
              unit="テーブル"
              showZero
            />
            <BarSep />
            <BarLabel>値の変化</BarLabel>
            <span className={`vcount${d.values.length ? "" : " zero"}`} title="CHECK や ENUM などの値の変化">
              {d.values.length}
            </span>
          </BarCounts>
          <BarSpacer />
          <ReviewProgress done={reviewedCount} total={tables.length} title="確認済みにしたテーブル（内容が変わると外れます）" />
        </ModuleBar>

        <div className={`body ${sel ? "with-panel" : ""}`} ref={bodyRef} style={{ gridTemplateColumns: gridColumns(bodyW ? clampLayout(layout, bodyW, !!sel) : layout, !!sel) }}>
          <nav className="side" ref={sideRef}>
            <input className="filter" placeholder="テーブル・カラムで絞り込み" value={filter} onChange={(e) => setFilter(e.target.value)} />
            {GROUPS.map((g) => {
              const items = shown.filter((t) => t.status === g.status);
              return (
                <div key={g.status} className="group">
                  <div className="group-title">
                    {g.title} <span className="muted">{items.length}</span>
                  </div>
                  {items.map((t) => {
                    const s = tableStats(t);
                    const n = commentMarks.tables.get(t.name) ?? 0;
                    const rev = isReviewed(t);
                    return (
                      <div key={t.name} className={`item-row tinted ${t.status}${rev ? " reviewed" : ""}${sel?.name === t.name ? " current" : ""}`}>
                        <button className="item" onClick={() => selectTable(t.name)} title={t.name}>
                          <span className="iname">
                            <span className="schema">{t.schema}.</span>
                            {t.table}
                          </span>
                          <ChangeCounts stats={s} title={changeTitle(s)} />
                          {n > 0 && <CommentCount n={n} title="このテーブルへの未対応のコメント" />}
                        </button>
                        <button
                          className={`ireview${rev ? " on" : ""}`}
                          onClick={() => setTableReviewed(t, !rev)}
                          title={rev ? "確認済み（クリックで外す）" : "確認済みにする（テーブルがまた変わると外れます）"}
                          aria-label={rev ? "確認済みを外す" : "確認済みにする"}
                          aria-pressed={rev}
                        >
                          <CheckIcon size={12} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              );
            })}
            <div className="group">
              <div className="group-title">
                値の変化 <span className="muted">{d.values.length}</span>
              </div>
              {d.values.map((v, i) => {
                const target = valueTarget(v);
                return (
                  <button key={i} className="item tinted values" onClick={() => (target.table ? selectTable(target.table) : v.type && setSelection({ kind: "type", name: v.type }))}>
                    <span className="iname">{target.label}</span>
                  </button>
                );
              })}
            </div>
            {comments.length > 0 && (
              <div className="group">
                <div className="group-title">
                  コメント <span className="muted">{comments.length}</span>
                </div>
                {comments.map((c) => {
                  const state = commentState(data, c);
                  return (
                    <div
                      key={c.id}
                      className={`item comment-item ${state}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => showComment(c.target)}
                      onKeyDown={(e) => e.key === "Enter" && showComment(c.target)}
                      title={`${targetLabel(c.target)}\n${c.body}`}
                    >
                      <span className="mark cmark">
                        <CommentIcon size={12} />
                      </span>
                      <span className="iname">
                        <span className="ctarget">{targetLabel(c.target)}</span>
                        <span className="cline">{c.body.split("\n")[0]}</span>
                      </span>
                      {state !== "open" && <span className={`cstate ${state}`}>{STATE_LABEL[state]}</span>}
                      <button
                        className="cdel"
                        aria-label="削除"
                        title="このコメントを削除"
                        onClick={(e) => {
                          e.stopPropagation();
                          api.remove(c.id);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {types.length > 0 && (
              <div className="group">
                <div className="group-title">
                  型 <span className="muted">{types.length}</span>
                </div>
                {types.map((t) => (
                  <button key={t.change.name} className={`item tinted ${t.change.status}${sel?.name === t.change.name ? " current" : ""}`} onClick={() => setSelection({ kind: "type", name: t.change.name })}>
                    <span className="iname">{t.change.name}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="side-foot muted">
              <div>変更のないテーブル {d.unchangedTables}</div>
              <details>
                <summary>
                  スキーマ {data.target.files.length} ファイル（{schemaFromText(data.schemaFrom)}）
                </summary>
                <ul>
                  {data.target.files.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </details>
              {data.ignored.length > 0 && (
                <details>
                  <summary>比較していない文 {data.ignored.reduce((n, i) => n + i.count, 0)}</summary>
                  <ul>
                    {data.ignored.map((i) => (
                      <li key={i.statement}>
                        {i.statement} {i.count}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </nav>
          <AreaDivider
            title="ドラッグで一覧と図の幅を変える（ダブルクリックで元に戻す）"
            start={() => sideRef.current?.getBoundingClientRect().width ?? layout.side}
            onDrag={(w0, dx) => setLayout((l) => clampLayout({ ...l, side: w0 + dx }, bodyW, !!sel))}
            onEnd={() => setLayout((l) => (saveLayout(l), l))}
            onReset={() => setLayout((l) => (saveLayout({ ...l, side: DEFAULT_LAYOUT.side }), { ...l, side: DEFAULT_LAYOUT.side }))}
          />

          <main className="canvas">
            <div className="toolbar">
              <div className="ds-seg">
                <button className={mode === "changes" ? "on" : ""} onClick={() => setMode("changes")} title="変更したテーブルと、その外部キーの参照先だけ">
                  変更まわり
                </button>
                <button className={mode === "all" ? "on" : ""} onClick={() => setMode("all")} title="すべてのテーブル">
                  全体
                </button>
              </div>
              <button className="ds-btn" onClick={() => diagram.current?.fit()} title="図全体を画面に収める">
                全体を表示
              </button>
              <button className="ds-btn ds-btn-icon" onClick={() => diagram.current?.zoom(1.25)} aria-label="拡大">
                +
              </button>
              <button className="ds-btn ds-btn-icon" onClick={() => diagram.current?.zoom(0.8)} aria-label="縮小">
                −
              </button>
              <span className="muted hint" title="スクロールでも移動できます。トラックパッドのピンチでも拡大縮小できます">
                ドラッグで移動・⌘ / Ctrl + スクロールで拡大・クリックで詳細
              </span>
            </div>
            {data.warnings.length > 0 && (
              <div className="warnings">
                {data.warnings.map((w, i) => (
                  <div key={i} className="warning">
                    {w}
                  </div>
                ))}
              </div>
            )}
            {empty && mode === "changes" ? (
              <div className="empty">スキーマの変更はありません（{data.target.files.length} ファイルを比較しました）</div>
            ) : (
              <ErDiagram
                ref={diagram}
                tables={data.er}
                mode={mode}
                values={valueText}
                selected={sel?.kind === "table" ? sel.name : null}
                reviewed={reviewedSet}
                comments={commentMarks}
                onSelect={(name) => (name ? selectTable(name, false) : setSelection(null))}
              />
            )}
          </main>

          {sel && (
            <AreaDivider
              title="ドラッグで図と詳細パネルの幅を変える（ダブルクリックで元に戻す）"
              start={() => clampLayout(layout, bodyW, true).panel}
              onDrag={(w0, dx) => setLayout((l) => clampLayout({ ...l, panel: w0 - dx }, bodyW, true))}
              onEnd={() => setLayout((l) => (saveLayout(l), l))}
              onReset={() => setLayout((l) => (saveLayout({ ...l, panel: DEFAULT_LAYOUT.panel }), { ...l, panel: DEFAULT_LAYOUT.panel }))}
            />
          )}
          {sel && (
            <Details
              selection={sel}
              change={selChange}
              erTable={selEr}
              values={selValues}
              type={selType}
              reviewed={selChange ? isReviewed(selChange) : false}
              onReviewed={(on) => selChange && setTableReviewed(selChange, on)}
              known={known}
              onJump={(name) => selectTable(name)}
              onClose={() => setSelection(null)}
            />
          )}
        </div>
      </div>
    </CommentsContext.Provider>
  );
}
