import { useState } from "react";
import type { ColumnChange, ColumnView, ConstraintChange, ConstraintView, IndexChange, IndexView, TableChange } from "../../src/model";
import { tableTarget, type CommentTarget } from "./comments";
import { CommentButton, CommentThread } from "./CommentViews";
import { columnBadges, columnParts, indexBody, sideConstraints, STATUS_LABEL, tableStats, valueChips, type ColumnBadges } from "./view";

interface Props {
  table: TableChange;
  reviewed: boolean;
  onReviewed: (on: boolean) => void;
  /** Tables that are in the diff, so references to them can jump there */
  known: ReadonlySet<string>;
  onJump: (table: string) => void;
  highlighted: boolean;
  /** In the detail panel: no folding */
  alwaysOpen?: boolean;
}

export function TableCard({ table: t, reviewed, onReviewed, known, onJump, highlighted, alwaysOpen }: Props) {
  const [open, setOpen] = useState(!reviewed);
  const [showContext, setShowContext] = useState(false);
  const stats = tableStats(t);
  const badges = columnBadges(sideConstraints(t));
  const isOpen = alwaysOpen || open;

  return (
    <section id={`table-${t.name}`} className={`card ${t.status} ${highlighted ? "highlighted" : ""} ${reviewed && !alwaysOpen ? "reviewed" : ""}`}>
      <header className="card-head">
        {!alwaysOpen && (
          <button className="fold" onClick={() => setOpen(!isOpen)} aria-label={isOpen ? "たたむ" : "開く"} aria-expanded={isOpen}>
            {isOpen ? "▾" : "▸"}
          </button>
        )}
        <span className={`badge ${t.status}`}>{STATUS_LABEL[t.status]}</span>
        <span className="tname">
          <span className="schema">{t.schema}.</span>
          {t.table}
        </span>
        {t.status === "modified" ? (
          <span className="stats">
            {stats.added > 0 && <span className="add">+{stats.added}</span>}
            {stats.removed > 0 && <span className="del">−{stats.removed}</span>}
            {stats.modified > 0 && <span className="mod">~{stats.modified}</span>}
          </span>
        ) : (
          <span className="stats muted">{t.columns.length} カラム</span>
        )}
        <span className="file" title={t.file}>
          {t.file}
        </span>
        <CommentButton target={tableTarget(t.name)} label="テーブル全体" />
        <label className="reviewed-box" title="確認済みにすると、図と一覧で薄く表示します（テーブルがまた変わると外れます）">
          <input
            type="checkbox"
            checked={reviewed}
            onChange={(e) => {
              onReviewed(e.target.checked);
              setOpen(!e.target.checked);
            }}
          />
          確認済み
        </label>
      </header>
      {isOpen && (
        <div className="card-body">
          <CommentThread target={tableTarget(t.name)} />
          {t.comment && <CommentRow before={t.comment.before} after={t.comment.after} status={t.status} />}
          {t.status === "modified" ? (
            <>
              <Section title="カラム" empty={t.columns.length === 0}>
                <table className="cols">
                  <tbody>
                    {t.columns.map((c) => (
                      <ColumnRow key={c.name} table={t.name} change={c} badges={badges.get(c.name)} known={known} onJump={onJump} />
                    ))}
                  </tbody>
                </table>
              </Section>
              <Section title="制約" empty={t.constraints.length === 0}>
                {t.constraints.map((c) => (
                  <ConstraintRow key={c.name} table={t.name} change={c} known={known} onJump={onJump} />
                ))}
              </Section>
              <Section title="インデックス" empty={t.indexes.length === 0}>
                {t.indexes.map((i) => (
                  <IndexRow key={i.name} table={t.name} change={i} />
                ))}
              </Section>
              {t.unchanged && (t.unchanged.columns.length > 0 || t.unchanged.constraints.length > 0 || t.unchanged.indexes.length > 0) && (
                <div className="context">
                  <button className="link" onClick={() => setShowContext(!showContext)}>
                    {showContext ? "▾" : "▸"} 変更のないカラム {t.unchanged.columns.length}・制約 {t.unchanged.constraints.length}・インデックス {t.unchanged.indexes.length}
                  </button>
                  {showContext && (
                    <div className="context-body">
                      <table className="cols">
                        <tbody>
                          {t.unchanged.columns.map((c) => (
                            <PlainColumn key={c.name} table={t.name} c={c} badges={badges.get(c.name)} known={known} onJump={onJump} />
                          ))}
                        </tbody>
                      </table>
                      {t.unchanged.constraints.map((c) => (
                        <PlainConstraint key={c.name} table={t.name} c={c} known={known} onJump={onJump} />
                      ))}
                      {t.unchanged.indexes.map((i) => (
                        <PlainIndex key={i.name} table={t.name} i={i} />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <table className="cols">
                <tbody>
                  {t.columns.map((c) => (
                    <PlainColumn key={c.name} table={t.name} c={(c.after ?? c.before)!} badges={badges.get(c.name)} known={known} onJump={onJump} />
                  ))}
                </tbody>
              </table>
              {t.constraints.length > 0 && (
                <Section title="制約">
                  {t.constraints.map((c) => (
                    <PlainConstraint key={c.name} table={t.name} c={(c.after ?? c.before)!} known={known} onJump={onJump} />
                  ))}
                </Section>
              )}
              {t.indexes.length > 0 && (
                <Section title="インデックス">
                  {t.indexes.map((i) => (
                    <PlainIndex key={i.name} table={t.name} i={(i.after ?? i.before)!} />
                  ))}
                </Section>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function Section(props: { title: string; empty?: boolean; children: React.ReactNode }) {
  if (props.empty) return null;
  return (
    <div className="section">
      <div className="section-title">{props.title}</div>
      {props.children}
    </div>
  );
}

const MARK = { added: "+", removed: "−", modified: "~" } as const;

function Badges({ b, known, onJump }: { b?: ColumnBadges; known: ReadonlySet<string>; onJump: (t: string) => void }) {
  if (!b) return null;
  return (
    <>
      {b.primary && <span className="tag key">PK</span>}
      {b.unique && <span className="tag">UNIQUE</span>}
      {b.references.map((r) => (
        <Ref key={r.table} table={r.table} columns={r.columns} known={known} onJump={onJump} />
      ))}
    </>
  );
}

function Ref({ table, columns, known, onJump }: { table: string; columns: string[]; known: ReadonlySet<string>; onJump: (t: string) => void }) {
  const text = `→ ${table}${columns.length ? ` (${columns.join(", ")})` : ""}`;
  return known.has(table) ? (
    <button className="tag ref link" onClick={() => onJump(table)} title="このテーブルの変更へ移動">
      {text}
    </button>
  ) : (
    <span className="tag ref">{text}</span>
  );
}

const columnTarget = (table: string, name: string): CommentTarget => ({ kind: "column", table, name });

export function PlainColumn({ table, c, badges, known, onJump }: { table: string; c: ColumnView; badges?: ColumnBadges; known: ReadonlySet<string>; onJump: (t: string) => void }) {
  const target = columnTarget(table, c.name);
  return (
    <>
      <tr className="plain">
        <td className="mark" />
        <td className="cname">{c.name}</td>
        <td>
          <code>{c.type}</code>
          {c.notNull && <span className="attr">NOT NULL</span>}
          {c.default !== undefined && <span className="attr">DEFAULT {c.default}</span>}
          {c.identity && <span className="attr">IDENTITY</span>}
          {c.generated && <span className="attr">GENERATED ({c.generated})</span>}
          <Badges b={badges} known={known} onJump={onJump} />
          {badges?.values && <Values values={badges.values} />}
          {c.comment && <span className="comment">{c.comment}</span>}
          <CommentButton target={target} />
        </td>
      </tr>
      <CommentThread target={target} colSpan={3} />
    </>
  );
}

function Values({ values }: { values: string[] }) {
  return (
    <span className="chips">
      {values.map((v) => (
        <span key={v} className="chip">
          {v}
        </span>
      ))}
    </span>
  );
}

function ColumnRow({ table, change: c, badges, known, onJump }: { table: string; change: ColumnChange; badges?: ColumnBadges; known: ReadonlySet<string>; onJump: (t: string) => void }) {
  const target = columnTarget(table, c.name);
  if (c.status !== "modified") {
    const v = (c.after ?? c.before)!;
    return (
      <>
        <tr className={c.status}>
          <td className="mark">{MARK[c.status]}</td>
          <td className="cname">{c.name}</td>
          <td>
            <code>{v.type}</code>
            {v.notNull && <span className="attr">NOT NULL</span>}
            {v.default !== undefined && <span className="attr">DEFAULT {v.default}</span>}
            {v.identity && <span className="attr">IDENTITY</span>}
            {v.generated && <span className="attr">GENERATED ({v.generated})</span>}
            {c.status === "added" && <Badges b={badges} known={known} onJump={onJump} />}
            {c.status === "added" && badges?.values && <Values values={badges.values} />}
            {v.comment && <span className="comment">{v.comment}</span>}
            <CommentButton target={target} />
          </td>
        </tr>
        <CommentThread target={target} colSpan={3} />
      </>
    );
  }
  const before = new Map(columnParts(c.before!).map((p) => [p.key, p.text]));
  const after = columnParts(c.after!);
  const changed = new Set<string>(c.changed ?? []);
  // NOT NULL / NULL both live under "notNull"; a removed default shows as removed
  const keys = [...new Set([...after.map((p) => p.key), ...before.keys()])];
  return (
    <>
      <tr className="modified">
        <td className="mark">~</td>
        <td className="cname">{c.name}</td>
        <td>
          {keys.map((k) => {
            const a = after.find((p) => p.key === k)?.text;
            const b = before.get(k);
            if (!changed.has(k))
              return a ? (
                <span key={k} className={k === "type" ? "attr type" : "attr"}>
                  {a}
                </span>
              ) : null;
            return (
              <span key={k} className="attr change">
                {b !== undefined && <del>{b}</del>}
                {b !== undefined && a !== undefined && <span className="arrow">→</span>}
                {a !== undefined && <ins>{a}</ins>}
              </span>
            );
          })}
          {changed.has("comment") && (
            <span className="attr change">
              <span className="muted">コメント </span>
              {c.before!.comment !== undefined && <del>{c.before!.comment}</del>}
              <span className="arrow">→</span>
              {c.after!.comment !== undefined ? <ins>{c.after!.comment}</ins> : <span className="muted">(なし)</span>}
            </span>
          )}
          <CommentButton target={target} />
        </td>
      </tr>
      <CommentThread target={target} colSpan={3} />
    </>
  );
}

const KIND: Record<ConstraintView["kind"], string> = { primary: "PK", unique: "UNIQUE", check: "CHECK", foreign: "FK", exclude: "EXCLUDE" };

/** A jump to a referenced table that is also in the diff */
function Jump({ table, known, onJump }: { table?: string; known: ReadonlySet<string>; onJump: (t: string) => void }) {
  if (!table || !known.has(table)) return null;
  return (
    <button className="jump link" onClick={() => onJump(table)} title={`${table} の変更へ移動`}>
      ↗ {table}
    </button>
  );
}

/** One constraint / index line: mark, kind, definition, and the name on the right */
function Line(props: { status?: "added" | "removed" | "modified"; kind: string; name: string; target?: CommentTarget; children: React.ReactNode }) {
  return (
    <>
      <div className={`row ${props.status ?? "plain"} ${props.target ? "commentable" : ""}`}>
        <span className="mark">{props.status ? MARK[props.status] : ""}</span>
        <span className="tag kind">{props.kind}</span>
        <span className="rbody">{props.children}</span>
        <span className="rname" title={props.name}>
          {props.name}
        </span>
        {props.target && <CommentButton target={props.target} />}
      </div>
      {props.target && <CommentThread target={props.target} />}
    </>
  );
}

const partTarget = (kind: "constraint" | "index", table: string, name: string): CommentTarget => ({ kind, table, name });

function PlainConstraint({ table, c, known, onJump }: { table: string; c: ConstraintView; known: ReadonlySet<string>; onJump: (t: string) => void }) {
  return (
    <Line kind={KIND[c.kind]} name={c.name} target={partTarget("constraint", table, c.name)}>
      <code>{c.definition}</code>
      <Jump table={c.references?.table} known={known} onJump={onJump} />
    </Line>
  );
}

function ConstraintRow({ table, change: c, known, onJump }: { table: string; change: ConstraintChange; known: ReadonlySet<string>; onJump: (t: string) => void }) {
  const v = (c.after ?? c.before)!;
  const chips = c.status === "modified" && c.before?.values && c.after?.values ? valueChips(c.before.values.values, c.after.values.values) : null;
  return (
    <Line status={c.status} kind={KIND[c.kind]} name={c.name} target={partTarget("constraint", table, c.name)}>
      {c.status !== "modified" ? (
        <code>{v.definition}</code>
      ) : chips ? (
        <>
          <code>{c.after!.values!.column}: </code>
          <span className="chips">
            {chips.map((ch) => (
              <span key={ch.value} className={`chip ${ch.status}`}>
                {ch.status === "added" ? "+" : ch.status === "removed" ? "−" : ""}
                {ch.value}
              </span>
            ))}
          </span>
        </>
      ) : (
        <span className="change-block">
          <del>{c.before!.definition}</del>
          <ins>{c.after!.definition}</ins>
        </span>
      )}
      {c.status !== "removed" && <Jump table={v.references?.table} known={known} onJump={onJump} />}
    </Line>
  );
}

function PlainIndex({ table, i }: { table: string; i: IndexView }) {
  return (
    <Line kind={i.unique ? "UNIQUE" : "INDEX"} name={i.name} target={partTarget("index", table, i.name)}>
      <code>{indexBody(i)}</code>
    </Line>
  );
}

function IndexRow({ table, change: i }: { table: string; change: IndexChange }) {
  const v = (i.after ?? i.before)!;
  return (
    <Line status={i.status} kind={v.unique ? "UNIQUE" : "INDEX"} name={i.name} target={partTarget("index", table, i.name)}>
      {i.status === "modified" ? (
        <span className="change-block">
          <del>
            {i.before!.unique ? "UNIQUE " : ""}
            {indexBody(i.before!)}
          </del>
          <ins>
            {i.after!.unique ? "UNIQUE " : ""}
            {indexBody(i.after!)}
          </ins>
        </span>
      ) : (
        <code>{indexBody(v)}</code>
      )}
    </Line>
  );
}

function CommentRow({ before, after, status }: { before?: string; after?: string; status: TableChange["status"] }) {
  if (status !== "modified") return <div className="table-comment">{after ?? before}</div>;
  return (
    <Line status="modified" kind="COMMENT" name="">
      <span className="change-block">
        {before !== undefined ? <del>{before}</del> : <span className="muted">(なし)</span>}
        {after !== undefined ? <ins>{after}</ins> : <span className="muted">(なし)</span>}
      </span>
    </Line>
  );
}
