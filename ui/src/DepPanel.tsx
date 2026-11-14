import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { linkKey } from "./comments";
import { EyeIcon } from "./icons";
import { shortDir, type Model, type TreeDir } from "./model";
import { buildPanel, type PanelLink, type PanelSource, type PanelTarget } from "./panel";

const CHAR_W = 7.3; // monospace 12px
const ROW_H = 28;
const ROW_GAP = 8;
const PAD = 10;
const CAPTION_H = 18;
const MIN_LABEL_W = 120;
const EYE_W = 20;

const FONT = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
let measureCtx: CanvasRenderingContext2D | null | undefined;
/** Rendered width of `s` in the panel's label font (falls back to an estimate). */
function textW(s: string): number {
  if (measureCtx === undefined) {
    measureCtx = document.createElement("canvas").getContext("2d");
    if (measureCtx) measureCtx.font = FONT;
  }
  if (measureCtx) return measureCtx.measureText(s).width;
  let n = 0;
  for (const ch of s) n += /[　-鿿＀-￯]/.test(ch) ? 2 : 1;
  return n * CHAR_W;
}

/** Trims a label to fit `maxW` pixels, keeping the end (the most specific part of a path). */
function fit(s: string, maxW: number): string {
  if (textW(s) <= maxW) return s;
  const chars = [...s];
  let i = 0;
  while (i < chars.length && textW("…" + chars.slice(i).join("")) > maxW) i++;
  return "…" + chars.slice(i).join("");
}

/** Point on a cubic Bézier at `t`. */
function bez(t: number, a: number, b: number, c: number, d: number): number {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}

function linkWidth(l: PanelLink): number {
  const n = Math.max(l.before, l.after, 1);
  return 1.6 + Math.min(3.2, Math.log2(n) * 0.8) + (l.status === "unchanged" ? 0 : 0.5);
}

export interface DepPanelProps {
  model: Model;
  tree: Map<string, TreeDir>;
  pins: string[];
  hovered: string | null;
  onTogglePin: (id: string) => void;
  onClearPins: () => void;
  includeExternal: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  /** comment-target keys currently selected (links are L:<from>><to>) */
  selection: Set<string>;
  /** targets of the comment card under the mouse */
  litKeys: Set<string> | null;
  /** a link under the mouse (its comments light up in the sidebar) */
  onHoverKey: (key: string | null) => void;
  /** open comments per link key */
  commentCounts: Map<string, number>;
  /** select dependencies; additive = ⌘/Shift held (toggle into the selection) */
  onSelectKeys: (keys: string[], additive: boolean) => void;
}

const additive = (e: MouseEvent) => e.metaKey || e.ctrlKey || e.shiftKey;

export function DepPanel(props: DepPanelProps) {
  const { model, tree, pins, hovered, includeExternal } = props;
  const data = useMemo(() => buildPanel(model, tree, pins, hovered, includeExternal), [model, tree, pins, hovered, includeExternal]);
  const [focus, setFocus] = useState<string | null>(null);
  const outCount = (s: PanelSource) => data.links.filter((l) => l.from === s.id).length;

  // fit the drawing to the panel's width: the gap and both columns share it
  const scrollRef = useRef<HTMLDivElement>(null);
  const [panelW, setPanelW] = useState(600);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPanelW(el.clientWidth));
    ro.observe(el);
    setPanelW(el.clientWidth);
    return () => ro.disconnect();
  }, [data.sources.length > 0]);
  const COL_GAP = Math.round(Math.min(120, Math.max(48, panelW * 0.13)));
  const colMax = Math.max(MIN_LABEL_W, (panelW - PAD * 2 - COL_GAP - 4) / 2);
  const SRC_EXTRA = 44; // padding + pin button
  const TGT_EXTRA = 24 + EYE_W; // padding + eye button
  const srcText = (s: PanelSource) => s.label + (outCount(s) === 0 ? " 依存なし" : "");
  const wantLeft = Math.max(MIN_LABEL_W, ...data.sources.map((s) => SRC_EXTRA + textW(srcText(s))));
  const wantRight = Math.max(MIN_LABEL_W, ...data.targets.map((t) => TGT_EXTRA + textW(t.label)));
  // give one column's unused room to the other
  const leftW = Math.min(wantLeft, Math.max(colMax, colMax * 2 - Math.min(wantRight, colMax)));
  const rightW = Math.min(wantRight, colMax * 2 - leftW);
  const leftText = leftW - SRC_EXTRA;
  const rightText = rightW - TGT_EXTRA;
  const colH = (n: number) => (n ? n * (ROW_H + ROW_GAP) - ROW_GAP : 0);
  const top = PAD + (data.targetPrefix ? CAPTION_H : 0);
  const innerH = Math.max(colH(data.sources.length), colH(data.targets.length));
  const leftTop = top + (innerH - colH(data.sources.length)) / 2;
  const rightTop = top + (innerH - colH(data.targets.length)) / 2;
  const rightX = PAD + leftW + COL_GAP;
  const width = rightX + rightW + PAD;
  const height = top + innerH + PAD;

  const sy = new Map(data.sources.map((s, i) => [s.id, leftTop + i * (ROW_H + ROW_GAP)]));
  const ty = new Map(data.targets.map((t, i) => [t.id, rightTop + i * (ROW_H + ROW_GAP)]));
  const isActive = (l: PanelLink) => focus !== null && (l.from === focus || l.to === focus);
  // while some drawn link is selected, the others fade so the selection stands out
  const selecting = data.links.some((l) => props.selection.has(linkKey(l.from, l.to)));
  const keysFrom = (id: string) => data.links.filter((l) => l.from === id).map((l) => linkKey(l.from, l.to));
  const keysTo = (id: string) => data.links.filter((l) => l.to === id).map((l) => linkKey(l.from, l.to));
  const order = { unchanged: 0, removed: 1, added: 2 } as const;
  const links = [...data.links].sort((a, b) => order[a.status] - order[b.status]);
  const abs = (p: string) => (p ? `${model.graph.repoRoot}/${p}` : model.graph.repoRoot);

  const linkTitle = (l: PanelLink, s: PanelSource, t: PanelTarget) => {
    const lines = [`${s.label} → ${t.label}`];
    if (s.kind === "file") lines.push(l.status === "added" ? "今回追加した import" : l.status === "removed" ? "今回削除した import" : "既存の import");
    else {
      const total = s.files.filter((f) => f.status !== "removed").length;
      lines.push(`import しているファイル: 変更前 ${l.before} → 変更後 ${l.after}（${total} ファイル中）`);
      if (l.added || l.removed) lines.push(`うち 今回追加 ${l.added} / 今回削除 ${l.removed}`);
    }
    return lines.join("\n");
  };

  return (
    <div className="dep-panel" onMouseEnter={props.onMouseEnter} onMouseLeave={props.onMouseLeave}>
      <div className="dep-panel-head">
        <strong>依存の可視化</strong>
        <span className="muted">
          {pins.length ? `表示中 ${pins.length}` : ""}
          {hovered ? `${pins.length ? " ＋ " : ""}ホバー中 1` : ""}
        </span>
        <span className="tspacer" />
        <button onClick={props.onClearPins} disabled={pins.length === 0}>
          すべて非表示
        </button>
      </div>
      {data.sources.length === 0 ? (
        <div className="dep-panel-empty">
          左のツリーの行にホバーすると、ここにその依存先が出ます。
          <br />
          目のアイコンで表示し続けられるので、複数並べて依存の形を比べられます。
        </div>
      ) : (
        <div className="dep-panel-scroll" ref={scrollRef}>
          <svg
            width={width}
            height={height}
            className={`panel-svg${focus || props.litKeys ? " hovering" : ""}${selecting ? " selecting" : ""}`}
          >
            <defs>
              {(["unchanged", "added", "removed"] as const).map((s) => (
                <marker
                  key={s}
                  id={`parrow-${s}`}
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="8"
                  markerHeight="8"
                  markerUnits="userSpaceOnUse"
                  orient="auto"
                >
                  <path d="M0,0 L8,4 L0,8 z" className={`arrowhead ${s}`} />
                </marker>
              ))}
            </defs>

            {data.targetPrefix && (
              <text x={rightX} y={PAD + 10} className="pcaption">
                <title>{abs(data.targetPrefix)}</title>
                {fit(`${shortDir(model.graph.modules, data.targetPrefix)}/ 以下`, rightW)}
              </text>
            )}

            {links.map((l) => {
              const s = data.sources.find((x) => x.id === l.from)!;
              const t = data.targets.find((x) => x.id === l.to)!;
              const x1 = PAD + leftW;
              const y1 = sy.get(l.from)! + ROW_H / 2;
              const x2 = rightX - 1;
              const y2 = ty.get(l.to)! + ROW_H / 2;
              const c = COL_GAP / 2;
              const showCount = s.kind !== "file";
              const key = linkKey(l.from, l.to);
              const selected = props.selection.has(key);
              const lit = props.litKeys?.has(key) ?? false;
              const comments = props.commentCounts.get(key) ?? 0;
              const d = `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`;
              return (
                <g
                  key={l.from + l.to}
                  className={`plink${isActive(l) || lit ? " active" : ""}${selected ? " selected" : ""}`}
                  onClick={(e) => props.onSelectKeys([key], additive(e))}
                  onMouseEnter={() => props.onHoverKey(key)}
                  onMouseLeave={() => props.onHoverKey(null)}
                >
                  {(selected || lit) && <path d={d} className={lit ? "psel lit" : "psel"} style={{ strokeWidth: linkWidth(l) + 7 }} />}
                  <path
                    d={d}
                    className={`medge ${l.status}${isActive(l) || selected || lit ? " active" : ""}`}
                    style={{ strokeWidth: linkWidth(l) }}
                    markerEnd={`url(#parrow-${l.status})`}
                  />
                  {/* wide invisible stroke so thin links are easy to click */}
                  <path d={d} className="phit">
                    <title>{`${linkTitle(l, s, t)}\nクリックで選択（⌘ / Shift で追加）`}</title>
                  </path>
                  {comments > 0 && (
                    <g className="pcomment">
                      <circle cx={bez(0.5, x1, x1 + c, x2 - c, x2)} cy={bez(0.5, y1, y1, y2, y2)} r={7} />
                      <text x={bez(0.5, x1, x1 + c, x2 - c, x2)} y={bez(0.5, y1, y1, y2, y2) + 3.5} textAnchor="middle">
                        {comments}
                      </text>
                    </g>
                  )}
                  {showCount && (
                    // near the target end, where links from one source have already fanned out
                    <text x={bez(0.8, x1, x1 + c, x2 - c, x2)} y={bez(0.8, y1, y1, y2, y2) - 4} textAnchor="middle" className="pcount">
                      {l.before !== l.after ? `${l.before}→${l.after}` : l.after}
                    </text>
                  )}
                </g>
              );
            })}

            {data.sources.map((s) => {
              const y = sy.get(s.id)!;
              const n = outCount(s);
              return (
                <g
                  key={s.id}
                  className={`pnode source ${s.kind} ${s.status}${s.pinned ? " pinned" : " temp"}`}
                  onMouseEnter={() => setFocus(s.id)}
                  onMouseLeave={() => setFocus(null)}
                  onClick={(e) => props.onSelectKeys(keysFrom(s.id), additive(e))}
                >
                  <title>{`${abs(s.path)}${s.kind === "file" ? "" : `\n${s.files.length} ファイル`}\n依存先 ${n}\nクリックでここから出る依存をすべて選択`}</title>
                  <rect x={PAD} y={y} width={leftW} height={ROW_H} rx={6} />
                  <text x={PAD + 10} y={y + ROW_H / 2 + 4} className="plabel">
                    {fit(s.label, leftText - (n === 0 ? textW(" 依存なし") : 0))}
                    {n === 0 && <tspan className="pnone"> 依存なし</tspan>}
                  </text>
                  <g
                    className="pbtn"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onTogglePin(s.id);
                    }}
                  >
                    <title>{s.pinned ? "表示中（クリックで非表示）" : "ホバー中（クリックで表示し続ける）"}</title>
                    <rect x={PAD + leftW - 26} y={y + 4} width={20} height={ROW_H - 8} rx={4} />
                    <EyeIcon on={s.pinned} x={PAD + leftW - 23} y={y + ROW_H / 2 - 7} />
                  </g>
                </g>
              );
            })}

            {data.targets.map((t) => {
              const y = ty.get(t.id)!;
              const pinnedTarget = pins.includes(t.id);
              const allNew = data.links.filter((l) => l.to === t.id).every((l) => l.status === "added");
              return (
                <g
                  key={t.id}
                  className={`pnode target${t.external ? " external" : ""}${allNew ? " new" : ""}${pinnedTarget ? " pinned" : ""}`}
                  onMouseEnter={() => setFocus(t.id)}
                  onMouseLeave={() => setFocus(null)}
                  onClick={(e) => props.onSelectKeys(keysTo(t.id), additive(e))}
                >
                  <title>{`${t.external ? `${t.dir}（外部パッケージ）` : abs(t.dir)}\nクリックでここに入る依存をすべて選択`}</title>
                  <rect x={rightX} y={y} width={rightW} height={ROW_H} rx={6} />
                  <text x={rightX + 10} y={y + ROW_H / 2 + 4} className="plabel">
                    {fit(t.label, rightText)}
                  </text>
                  {!t.external && (
                    <g
                      className={`pbtn${pinnedTarget ? " on" : ""}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onTogglePin(t.id);
                      }}
                    >
                      <title>{pinnedTarget ? "左にも表示中（クリックで非表示）" : "左にも表示して、この先の依存をたどる"}</title>
                      <rect x={rightX + rightW - 26} y={y + 4} width={20} height={ROW_H - 8} rx={4} />
                      <EyeIcon on={pinnedTarget} x={rightX + rightW - 23} y={y + ROW_H / 2 - 7} />
                    </g>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      )}
    </div>
  );
}
