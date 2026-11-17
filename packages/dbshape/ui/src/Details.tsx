import type { DomainChange, EnumChange, ErTable, TableChange, ValueChange } from "../../src/model";
import { tableTarget, type CommentTarget } from "./comments";
import { CommentButton, CommentThread } from "./CommentViews";
import { PlainColumn, TableCard } from "./TableCard";
import { STATUS_LABEL, valueChips, valueTarget } from "./view";

/* The panel on the right: details of the selected table (or type), which the ER diagram can not show. */

export type Selection = { kind: "table"; name: string } | { kind: "type"; name: string };

interface Props {
  selection: Selection;
  change?: TableChange;
  erTable?: ErTable;
  values: ValueChange[];
  type?: { kind: "ENUM 型" | "DOMAIN"; change: EnumChange | DomainChange };
  reviewed: boolean;
  onReviewed: (on: boolean) => void;
  known: ReadonlySet<string>;
  onJump: (table: string) => void;
  onClose: () => void;
}

export function Details(p: Props) {
  return (
    <aside className="panel">
      <div className="panel-head">
        <span className="panel-title">{p.selection.name}</span>
        <button className="ds-btn ds-btn-icon" onClick={p.onClose} aria-label="閉じる" title="閉じる（Esc）">
          ×
        </button>
      </div>
      <div className="panel-body">
        {p.selection.kind === "type" && p.type && <TypeRow kind={p.type.kind} change={p.type.change} />}
        {p.selection.kind === "table" &&
          (p.change ? (
            <TableCard key={p.change.name} table={p.change} reviewed={p.reviewed} onReviewed={p.onReviewed} known={p.known} onJump={p.onJump} highlighted={false} alwaysOpen />
          ) : p.erTable ? (
            <Unchanged t={p.erTable} />
          ) : null)}
        {p.values.length > 0 && (
          <div className="panel-section">
            <div className="section-title">値の変化</div>
            {p.values.map((v, i) => (
              <ValueRow key={i} v={v} />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function Unchanged({ t }: { t: ErTable }) {
  const target = tableTarget(t.name);
  return (
    <div className="unchanged-table">
      <p className="muted unchanged-note">
        このテーブルは変更されていません。
        <CommentButton target={target} label="テーブル全体" />
      </p>
      <CommentThread target={target} />
      <table className="cols">
        <tbody>
          {t.columns.map((c) => (
            <PlainColumn
              key={c.name}
              table={t.name}
              c={{ name: c.name, type: c.type, notNull: c.notNull }}
              badges={{
                primary: c.primary,
                unique: false,
                references: t.foreignKeys.filter((f) => f.columns.length === 1 && f.columns[0] === c.name).map((f) => ({ table: f.table, columns: f.refColumns })),
              }}
              known={new Set()}
              onJump={() => {}}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ValueRow({ v }: { v: ValueChange }) {
  const target = valueTarget(v);
  const chips = valueChips(v.before, v.after);
  const ct: CommentTarget = v.source === "check" ? { kind: "value", table: v.table, name: v.column ?? "" } : { kind: "type", name: v.type ?? "" };
  return (
    <div className="value-row commentable">
      <CommentButton target={ct} label={v.source === "check" ? `${v.column} の値` : undefined} />
      <div className="value-head">
        <span className="vname">{target.label}</span>
        <span className="tag kind">{v.source === "check" ? "CHECK" : v.source === "enum" ? "ENUM 型" : "DOMAIN"}</span>
        {v.constraint && <span className="muted">{v.constraint}</span>}
        {v.status === "added" && <span className="note">値の制限が付きました</span>}
        {v.status === "removed" && <span className="note">値の制限がなくなりました</span>}
      </div>
      <div className="chips">
        {chips.map((c) => (
          <span key={c.value} className={`chip ${v.status === "added" ? "same" : c.status}`}>
            {v.status === "modified" && c.status === "added" ? "+" : c.status === "removed" ? "−" : ""}
            {c.value}
          </span>
        ))}
      </div>
      {v.usedBy && v.usedBy.length > 0 && <div className="muted used">使用しているカラム: {v.usedBy.join(", ")}</div>}
      <CommentThread target={ct} />
    </div>
  );
}

function TypeRow({ kind, change: c }: { kind: "ENUM 型" | "DOMAIN"; change: EnumChange | DomainChange }) {
  const before = c.before && "values" in c.before ? c.before.values : undefined;
  const after = c.after && "values" in c.after ? c.after.values : undefined;
  const dom = (c.after ?? c.before) as DomainChange["after"];
  const ct: CommentTarget = { kind: "type", name: c.name };
  return (
    <div className="value-row commentable">
      <CommentButton target={ct} />
      <div className="value-head">
        <span className={`badge ${c.status}`}>{STATUS_LABEL[c.status]}</span>
        <span className="vname">{c.name}</span>
        <span className="tag kind">{kind}</span>
      </div>
      {kind === "ENUM 型" ? (
        <div className="chips">
          {valueChips(c.status === "added" ? undefined : before, c.status === "removed" ? before : after).map((ch) => (
            <span key={ch.value} className={`chip ${c.status === "modified" ? ch.status : "same"}`}>
              {c.status === "modified" && ch.status === "added" ? "+" : ch.status === "removed" && c.status === "modified" ? "−" : ""}
              {ch.value}
            </span>
          ))}
        </div>
      ) : (
        dom && (
          <div className="domain">
            {c.status === "modified" && c.before && c.after && "type" in c.before && "type" in c.after ? (
              <span className="change-block">
                <del>
                  {c.before.type}
                  {c.before.notNull ? " NOT NULL" : ""}
                  {c.before.checks.map((k) => ` ${k.definition}`).join("")}
                </del>
                <ins>
                  {c.after.type}
                  {c.after.notNull ? " NOT NULL" : ""}
                  {c.after.checks.map((k) => ` ${k.definition}`).join("")}
                </ins>
              </span>
            ) : (
              <code>
                {dom.type}
                {dom.notNull ? " NOT NULL" : ""}
                {dom.checks.map((k) => ` ${k.definition}`).join("")}
              </code>
            )}
          </div>
        )
      )}
      <CommentThread target={ct} />
    </div>
  );
}
