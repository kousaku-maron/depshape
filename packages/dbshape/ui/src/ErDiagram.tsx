import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { ErTable } from "../../src/model";
import { buildDiagram, edgePath, FOOTER_H, HEADER_H, ROW_H, rowText, STATUS_MARK, type DiagramTable, type Mode } from "./erLayout";

interface Props {
  tables: ErTable[];
  mode: Mode;
  /** Value changes by "schema.table.column", shown when hovering the row */
  values: ReadonlyMap<string, string>;
  selected: string | null;
  reviewed: ReadonlySet<string>;
  /** Open comments per table, and the columns ("schema.table.column") that have one */
  comments: { tables: ReadonlyMap<string, number>; columns: ReadonlySet<string> };
  onSelect: (table: string | null) => void;
}

export interface ErDiagramHandle {
  fit: () => void;
  zoom: (factor: number) => void;
  focus: (table: string) => void;
}

const FONT = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
const FONT_BOLD = `600 ${FONT}`;

function useMeasure() {
  return useMemo(() => {
    const ctx = document.createElement("canvas").getContext("2d");
    return (text: string, bold?: boolean) => {
      if (!ctx) return text.length * 7.4;
      ctx.font = bold ? FONT_BOLD : FONT;
      return ctx.measureText(text).width;
    };
  }, []);
}

interface View {
  x: number;
  y: number;
  k: number;
}

export const ErDiagram = forwardRef<ErDiagramHandle, Props>(function ErDiagram({ tables, mode, values, selected, reviewed, comments, onSelect }, ref) {
  const measure = useMeasure();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [hovered, setHovered] = useState<string | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean; target: Element } | null>(null);

  const diagram = useMemo(() => buildDiagram(tables, mode, expanded, measure), [tables, mode, expanded, measure]);
  const byName = useMemo(() => new Map(diagram.tables.map((t) => [t.table.name, t])), [diagram]);

  const fit = useCallback(() => {
    const el = box.current;
    if (!el || diagram.width === 0) return;
    const k = Math.min(1.2, Math.max(0.2, Math.min(el.clientWidth / diagram.width, el.clientHeight / diagram.height)));
    setView({ k, x: (el.clientWidth - diagram.width * k) / 2, y: Math.max(0, (el.clientHeight - diagram.height * k) / 2) });
  }, [diagram]);

  // fit when the set of shown tables changes (first load, mode switch, reload), not when a table is expanded
  const shownKey = diagram.tables.map((t) => t.table.name).join("|");
  useEffect(() => {
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey]);

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setView((v) => {
      const k = Math.min(3, Math.max(0.15, v.k * factor));
      return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
    });
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      fit,
      zoom: (f) => {
        const el = box.current;
        if (el) zoomAt(f, el.clientWidth / 2, el.clientHeight / 2);
      },
      focus: (name) => {
        const t = byName.get(name);
        const el = box.current;
        if (!t || !el) return;
        setView((v) => ({ ...v, x: el.clientWidth / 2 - (t.x + t.width / 2) * v.k, y: el.clientHeight / 3 - (t.y + Math.min(t.height, 200) / 2) * v.k }));
      },
    }),
    [fit, zoomAt, byName],
  );

  // wheel: pan, ⌘ / Ctrl + wheel (and trackpad pinch): zoom; a native listener so preventDefault works
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const lit = (name: string) => hovered === name || selected === name;

  return (
    <div
      ref={box}
      className="er"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        // remember what was pressed: with pointer capture, the release event targets this container
        drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, target: e.target as Element };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
        if (d.moved) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (d && !d.moved) {
          // a click: on a table selects it, on the background clears the selection
          const target = d.target.closest("[data-table]");
          const more = d.target.closest("[data-more]");
          if (more) {
            const name = more.getAttribute("data-more")!;
            setExpanded((s) => {
              const n = new Set(s);
              if (n.has(name)) n.delete(name);
              else n.add(name);
              return n;
            });
          } else onSelect(target ? target.getAttribute("data-table") : null);
        }
      }}
    >
      {diagram.tables.length === 0 ? (
        <div className="er-empty">表示するテーブルはありません</div>
      ) : (
        <svg width="100%" height="100%">
          <defs>
            {(["added", "removed", "modified", "unchanged"] as const).map((s) => (
              <marker key={s} id={`arrow-${s}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className={`arrow ${s}`} />
              </marker>
            ))}
          </defs>
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {diagram.groups.map((g) => (
              <g key={g.schema} className="er-group">
                <rect x={g.x} y={g.y} width={g.width} height={g.height} rx={8} />
                <text x={g.x + 10} y={g.y + 17}>
                  {g.schema}
                </text>
              </g>
            ))}
            {diagram.edges.map((e) => {
              const on = lit(e.from) || lit(e.to);
              return (
                <path
                  key={`${e.from}:${e.fk.name}`}
                  d={edgePath(e.points)}
                  className={`er-edge ${e.fk.status} ${on ? "lit" : ""} ${hovered || selected ? (on ? "" : "dim") : ""}`}
                  markerEnd={`url(#arrow-${e.fk.status})`}
                >
                  <title>
                    {e.fk.name}: {e.from}.{e.fk.columns.join(", ")} → {e.to}.{e.fk.refColumns.join(", ")}
                  </title>
                </path>
              );
            })}
            {diagram.tables.map((t) => (
              <TableNode
                key={t.table.name}
                t={t}
                values={values}
                selected={selected === t.table.name}
                reviewed={reviewed.has(t.table.name)}
                comments={comments.tables.get(t.table.name) ?? 0}
                commented={comments.columns}
                expanded={expanded.has(t.table.name)}
                onHover={setHovered}
              />
            ))}
          </g>
        </svg>
      )}
    </div>
  );
});

function TableNode({
  t,
  values,
  selected,
  reviewed,
  comments,
  commented,
  expanded,
  onHover,
}: {
  t: DiagramTable;
  values: ReadonlyMap<string, string>;
  selected: boolean;
  reviewed: boolean;
  comments: number;
  commented: ReadonlySet<string>;
  expanded: boolean;
  onHover: (n: string | null) => void;
}) {
  const s = t.table.status;
  return (
    <g
      className={`er-table ${s} ${t.neighbor ? "neighbor" : ""} ${selected ? "selected" : ""} ${reviewed ? "reviewed" : ""}`}
      data-table={t.table.name}
      transform={`translate(${t.x} ${t.y})`}
      onPointerEnter={() => onHover(t.table.name)}
      onPointerLeave={() => onHover(null)}
    >
      <rect className="er-box" width={t.width} height={t.height} rx={6} />
      <rect className="er-head" width={t.width} height={HEADER_H} rx={6} />
      <rect className="er-head-fill" y={HEADER_H - 6} width={t.width} height={6} />
      <text className="er-title" x={10} y={18}>
        {s !== "unchanged" && <tspan className={`er-mark ${s}`}>{STATUS_MARK[s]} </tspan>}
        <tspan className="er-schema">{t.table.schema}.</tspan>
        <tspan>{t.table.table}</tspan>
      </text>
      {reviewed && (
        <text className="er-check" x={t.width - (comments > 0 ? 24 : 10)} y={18} textAnchor="end">
          ✓
        </text>
      )}
      {t.rows.map((r, i) => {
        const y = HEADER_H + i * ROW_H;
        if (r.kind === "more") {
          return (
            <g key="more" className="er-more" data-more={t.table.name}>
              <rect y={y} width={t.width} height={ROW_H} />
              <text x={10} y={y + 14}>
                {expanded ? "▴ たたむ" : `▸ 他 ${r.hidden} カラム`}
              </text>
            </g>
          );
        }
        const c = r.column;
        const text = rowText(c);
        const value = values.get(`${t.table.name}.${c.name}`);
        return (
          <g key={c.name} className={`er-row ${c.status}`}>
            <rect y={y} width={t.width} height={ROW_H} />
            <text x={8} y={y + 14} className={`er-mark ${c.status}`}>
              {STATUS_MARK[c.status]}
            </text>
            <text x={20} y={y + 14} className="er-col">
              {c.primary && <tspan className="er-key">◆ </tspan>}
              {text.name}
            </text>
            <text x={t.width - 10} y={y + 14} textAnchor="end" className="er-type">
              {r.fk && <tspan className="er-fk">FK </tspan>}
              {c.values && <tspan className="er-values">値± </tspan>}
              {c.beforeType ? (
                <>
                  <tspan className="er-before">{c.beforeType}</tspan>
                  <tspan> → {c.type}</tspan>
                </>
              ) : (
                c.type
              )}
              {c.notNull ? "" : <tspan className="er-null">?</tspan>}
            </text>
            {commented.has(`${t.table.name}.${c.name}`) && <circle className="er-cdot" cx={t.width - 4} cy={y + ROW_H / 2} r={2.5} />}
            {value && <title>{value}</title>}
          </g>
        );
      })}
      {comments > 0 && (
        <g className="er-cbadge" transform={`translate(${t.width - 4} 0)`}>
          <title>コメント {comments} 件</title>
          <rect x={-16} y={-9} width={32} height={18} rx={9} />
          <text y={4} textAnchor="middle">
            💬{comments}
          </text>
        </g>
      )}
      {t.footer && (
        <text className="er-footer" x={10} y={t.height - FOOTER_H / 2 - 1}>
          {t.footer}
        </text>
      )}
    </g>
  );
}
