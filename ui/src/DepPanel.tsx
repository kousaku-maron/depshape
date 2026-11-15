import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { linkKey } from "./comments";
import { EyeIcon } from "./icons";
import type { Model, TreeDir } from "./model";
import { fitPath as fitPathWith } from "./labels";
import { buildPanel, type PanelLink, type PanelSource, type PanelTarget } from "./panel";

const CHAR_W = 7.3; // monospace 12px
const ROW_H = 28;
const ROW_GAP = 8;
const PAD = 10;
const CAPTION_H = 18;
const TITLE_H = 18;
const MIN_LABEL_W = 120;
const EYE_W = 20;
const INDENT = 16; // per level of a folder tree
const CHEV_W = 14;

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

const fitPath = (label: string, maxW: number) => fitPathWith(label, maxW, textW);

/** Point on a cubic Bézier at `t`. */
function bez(t: number, a: number, b: number, c: number, d: number): number {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}

function linkWidth(l: PanelLink): number {
  const n = Math.max(l.before, l.after, 1);
  return 1.6 + Math.min(3.2, Math.log2(n) * 0.8) + (l.status === "unchanged" ? 0 : 0.5);
}

/** Splits `total` between columns: each gets what it wants up to an even share, the rest goes to the wider ones. */
function allocate(wants: number[], total: number): number[] {
  const out = wants.map(() => 0);
  let left = [...wants.keys()];
  let room = total;
  while (left.length) {
    const share = room / left.length;
    const small = left.filter((i) => wants[i] <= share);
    if (!small.length) {
      for (const i of left) out[i] = Math.max(MIN_LABEL_W, share);
      break;
    }
    for (const i of small) {
      out[i] = wants[i];
      room -= wants[i];
    }
    left = left.filter((i) => !small.includes(i));
  }
  return out;
}

const parentsOf = (rows: { id: string; parent?: string }[]) => new Map(rows.map((r) => [r.id, r.parent]));
const under = (parents: Map<string, string | undefined>, id: string, ancestor: string) => {
  for (let p = parents.get(id); p; p = parents.get(p)) if (p === ancestor) return true;
  return false;
};

export interface DepPanelProps {
  model: Model;
  tree: Map<string, TreeDir>;
  pins: string[];
  hovered: string | null;
  onTogglePin: (id: string) => void;
  onClearPins: () => void;
  includeExternal: boolean;
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
  /** rows of the target / dependent trees the user opened or folded (groups start open, folders folded) */
  targetOpen: ReadonlyMap<string, boolean>;
  onToggleTarget: (id: string, open: boolean) => void;
  /** source folders opened in place (all start folded) */
  sourceOpen: ReadonlyMap<string, boolean>;
  onToggleSource: (id: string, open: boolean) => void;
}

const additive = (e: MouseEvent) => e.metaKey || e.ctrlKey || e.shiftKey;

export function DepPanel(props: DepPanelProps) {
  const { model, tree, pins, hovered, includeExternal, targetOpen, sourceOpen } = props;
  const data = useMemo(
    () => buildPanel(model, tree, pins, hovered, includeExternal, targetOpen, sourceOpen),
    [model, tree, pins, hovered, includeExternal, targetOpen, sourceOpen],
  );
  // each column is a tree: a row stands for the rows under it
  const srcParent = useMemo(() => parentsOf(data.sources), [data]);
  const tgtParent = useMemo(() => parentsOf(data.targets), [data]);
  const depParent = useMemo(() => parentsOf(data.dependents), [data]);
  const srcUnder = (id: string, a: string) => under(srcParent, id, a);
  const tgtUnder = (id: string, a: string) => under(tgtParent, id, a);
  const depUnder = (id: string, a: string) => under(depParent, id, a);
  const indent = (r: { depth: number }) => r.depth * INDENT;
  const chevOf = (rows: { canOpen?: boolean }[]) => (rows.some((r) => r.canOpen) ? CHEV_W : 0);
  const srcChevW = chevOf(data.sources);
  const tgtChevW = chevOf(data.targets);
  const depChevW = chevOf(data.dependents);
  const groupContents = (t: PanelTarget) =>
    [t.folderCount ? `${t.folderCount} フォルダ` : "", t.directFileCount ? `${t.directFileCount} ファイル` : ""].filter(Boolean).join("・");
  const metaText = (t: PanelTarget) =>
    t.open ? "" : t.kind === "group" ? ` ${groupContents(t)}` : t.fileCount ? ` ${t.fileCount} ファイル` : "";
  const [focus, setFocus] = useState<string | null>(null);

  /** links leaving a source row (an opened folder's leave the rows under it) */
  const outgoing = (id: string) => data.links.filter((l) => l.from === id || srcUnder(l.from, id));
  const outCount = (s: PanelSource) => new Set(outgoing(s.id).map((l) => l.to)).size;
  /** links arriving at a target row (an opened folder's arrive at its files) */
  const incoming = (id: string) => data.links.filter((l) => l.to === id || tgtUnder(l.to, id));
  /** links leaving a dependent row */
  const depOutgoing = (id: string) => data.inLinks.filter((l) => l.from === id || depUnder(l.from, id));
  const keys = (ls: PanelLink[]) => ls.map((l) => linkKey(l.from, l.to));

  // fit the drawing to the panel's width: the gaps and the columns share it
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
  // the hovered row is added below the pins; bring it into view when the panel scrolls
  useEffect(() => {
    if (!hovered) return;
    scrollRef.current?.querySelector(`[data-src="${CSS.escape(hovered)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hovered, data]);

  const hasDeps = data.dependents.length > 0;
  const cols = hasDeps ? 3 : 2;
  const COL_GAP = Math.round(Math.min(110, Math.max(44, (panelW * 0.26) / cols)));
  const SRC_EXTRA = 44; // padding + pin button
  const TREE_EXTRA = 24 + EYE_W; // padding + eye button
  const srcText = (s: PanelSource) => s.label + (s.suffix ?? "") + (outCount(s) === 0 && !s.open ? " 依存なし" : "");
  const treeWant = (rows: PanelTarget[], chev: number) =>
    Math.max(MIN_LABEL_W, ...rows.map((t) => TREE_EXTRA + indent(t) + chev + textW(t.label + metaText(t))));
  const wantSrc = Math.max(MIN_LABEL_W, ...data.sources.map((s) => SRC_EXTRA + indent(s) + srcChevW + textW(srcText(s))));
  const wantTgt = treeWant(data.targets, tgtChevW);
  const wantDep = hasDeps ? treeWant(data.dependents, depChevW) : 0;
  const avail = Math.max(MIN_LABEL_W * cols, panelW - PAD * 2 - COL_GAP * (cols - 1) - 4);
  const [depW, srcW, tgtW] = hasDeps ? allocate([wantDep, wantSrc, wantTgt], avail) : [0, ...allocate([wantSrc, wantTgt], avail)];
  const depX = PAD;
  const srcX0 = hasDeps ? depX + depW + COL_GAP : PAD;
  const tgtX = srcX0 + srcW + COL_GAP;
  const width = tgtX + tgtW + PAD;

  const colH = (n: number) => (n ? n * (ROW_H + ROW_GAP) - ROW_GAP : 0);
  const titleH = hasDeps ? TITLE_H : 0;
  const captionY = PAD + titleH;
  const top = captionY + (data.targetPrefix || data.sourcePrefix || data.dependentPrefix ? CAPTION_H : 0);
  const innerH = Math.max(colH(data.sources.length), colH(data.targets.length), colH(data.dependents.length));
  const rowsY = <T extends { id: string }>(rows: T[]) => {
    const t0 = top + (innerH - colH(rows.length)) / 2;
    return new Map(rows.map((r, i) => [r.id, t0 + i * (ROW_H + ROW_GAP)]));
  };
  const sy = rowsY(data.sources);
  const ty = rowsY(data.targets);
  const dy = rowsY(data.dependents);
  const height = top + innerH + PAD;

  const isActive = (l: PanelLink, inbound: boolean) => {
    if (focus === null) return false;
    if (inbound) return l.from === focus || depUnder(l.from, focus) || l.to === focus || srcUnder(l.to, focus);
    return l.from === focus || srcUnder(l.from, focus) || l.to === focus || tgtUnder(l.to, focus);
  };
  // while some drawn link is selected, the others fade so the selection stands out
  const selecting = [...data.links, ...data.inLinks].some((l) => props.selection.has(linkKey(l.from, l.to)));
  const order = { unchanged: 0, removed: 1, added: 2 } as const;
  const byStatus = (ls: PanelLink[]) => [...ls].sort((a, b) => order[a.status] - order[b.status]);
  const abs = (p: string) => (p ? `${model.graph.repoRoot}/${p}` : model.graph.repoRoot);
  const srcName = (s: PanelSource) => `${s.label}${s.suffix ?? ""}`;
  const rowName = (t: PanelTarget) => (t.kind === "group" ? `${t.fullLabel}/ 配下` : t.kind === "dir" && !t.file && t.id.startsWith("i:") ? `${t.fullLabel}/ 直下` : t.fullLabel);

  const countLines = (l: PanelLink, single: boolean, total?: number) => {
    if (single) return [l.status === "added" ? "今回追加した import" : l.status === "removed" ? "今回削除した import" : "既存の import"];
    const lines = [`import しているファイル: 変更前 ${l.before} → 変更後 ${l.after}${total !== undefined ? `（${total} ファイル中）` : ""}`];
    if (l.added || l.removed) lines.push(`うち 今回追加 ${l.added} / 今回削除 ${l.removed}`);
    return lines;
  };
  const linkTitle = (l: PanelLink, s: PanelSource, t: PanelTarget) => {
    const lines = [`${srcName(s)} → ${rowName(t)}${l.typeOnly ? "（型のみの import）" : ""}`];
    lines.push(...countLines(l, s.kind === "file", s.files.filter((f) => f.status !== "removed").length));
    // TS: which files of the target folder are imported
    if (l.files?.length) {
      const mark = { added: "＋", removed: "−", unchanged: "・" } as const;
      lines.push("import しているファイル:");
      for (const f of l.files.slice(0, 12)) lines.push(`  ${mark[f.status]} ${f.path.slice(t.dir ? t.dir.length + 1 : 0)}`);
      if (l.files.length > 12) lines.push(`  …ほか ${l.files.length - 12} 件`);
    }
    return lines.join("\n");
  };
  const inLinkTitle = (l: PanelLink, d: PanelTarget, s: PanelSource) =>
    [`${rowName(d)} → ${srcName(s)}${l.typeOnly ? "（型のみの import）" : ""}`, ...countLines(l, d.kind === "file")].join("\n");

  /** One drawn dependency: a Bézier from (x1,y1) to (x2,y2) with its selection, comment and count marks. */
  const linkPath = (l: PanelLink, x1: number, y1: number, x2: number, y2: number, inbound: boolean, title: string, countAt: number | null) => {
    const c = COL_GAP / 2;
    const key = linkKey(l.from, l.to);
    const selected = props.selection.has(key);
    const lit = props.litKeys?.has(key) ?? false;
    const comments = props.commentCounts.get(key) ?? 0;
    const active = isActive(l, inbound);
    const d = `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`;
    const at = (t: number) => [bez(t, x1, x1 + c, x2 - c, x2), bez(t, y1, y1, y2, y2)] as const;
    return (
      <g
        key={`${l.from}>${l.to}`}
        className={`plink${active || lit ? " active" : ""}${selected ? " selected" : ""}`}
        onClick={(e) => props.onSelectKeys([key], additive(e))}
        onMouseEnter={() => props.onHoverKey(key)}
        onMouseLeave={() => props.onHoverKey(null)}
      >
        {(selected || lit) && <path d={d} className={lit ? "psel lit" : "psel"} style={{ strokeWidth: linkWidth(l) + 7 }} />}
        <path
          d={d}
          className={`medge ${l.status}${l.typeOnly ? " typeonly" : ""}${active || selected || lit ? " active" : ""}`}
          style={{ strokeWidth: linkWidth(l) }}
          markerEnd={`url(#parrow-${l.status})`}
        />
        {/* wide invisible stroke so thin links are easy to click */}
        <path d={d} className="phit">
          <title>{`${title}\nクリックで選択（⌘ / Shift で追加）`}</title>
        </path>
        {comments > 0 && (
          <g className="pcomment">
            <circle cx={at(0.5)[0]} cy={at(0.5)[1]} r={7} />
            <text x={at(0.5)[0]} y={at(0.5)[1] + 3.5} textAnchor="middle">
              {comments}
            </text>
          </g>
        )}
        {countAt !== null && (
          <text x={at(countAt)[0]} y={at(countAt)[1] - 4} textAnchor="middle" className="pcount">
            {l.before !== l.after ? `${l.before}→${l.after}` : l.after}
          </text>
        )}
      </g>
    );
  };

  const pathLabel = (label: string, room: number) => {
    const { dir, name } = fitPath(label, room);
    return (
      <>
        {dir && <tspan className="pdir">{dir}</tspan>}
        <tspan className="pname">{name}</tspan>
      </>
    );
  };

  /** A row of the target tree (right) or the dependent tree (left); both open, fold and pin alike. */
  const treeRow = (t: PanelTarget, side: "target" | "dependent") => {
    const isDep = side === "dependent";
    const y = (isDep ? dy : ty).get(t.id)!;
    const x0 = isDep ? depX : tgtX;
    const colW = isDep ? depW : tgtW;
    const chev = isDep ? depChevW : tgtChevW;
    const x = x0 + indent(t);
    const w = colW - indent(t);
    // the eye follows the dependency further: the folder or file is shown in the middle column too
    const pinId = t.file ? `f:${t.file}` : t.kind === "group" || isDep ? `d:${t.dir}` : t.self ? `p:${t.dir}` : t.id;
    const pinned = pins.includes(pinId);
    const ls = isDep ? depOutgoing(t.id) : incoming(t.id);
    const allNew = ls.length > 0 && ls.every((l) => l.status === "added");
    const fileStatus = t.file ? model.fileByPath.get(t.file)?.status : undefined;
    const meta = metaText(t);
    const verb = isDep ? "import している側の" : "import している ";
    const openWhat = t.kind === "group" ? groupContents(t) : `import している ${t.fileCount} ファイル`;
    const openHint = t.canOpen ? (t.open ? "\n▾ でまとめる" : `\n▸ で開いて、${openWhat}を表示`) : "";
    const what = t.external
      ? `${t.dir}（外部パッケージ）`
      : t.file
        ? `${abs(t.file)}${fileStatus === "added" ? "（今回追加したファイル）" : fileStatus === "modified" ? "（今回変更したファイル）" : ""}`
        : t.kind === "group"
          ? `${abs(t.dir)}/ 配下（${verb}${groupContents(t)}をまとめた行）`
          : isDep
            ? `${abs(t.dir)}/ 直下の、import しているファイル`
            : `${abs(t.dir)}${t.self ? "\nこのパッケージ（フォルダ直下のファイル）だけ。下のフォルダは含まない" : ""}`;
    const clickWhat = isDep ? "ここから出る依存" : "ここに入る依存";
    return (
      <g
        key={t.id}
        className={`pnode target ${t.kind}${isDep ? " dependent" : ""}${t.self ? " self" : ""}${t.open ? " open" : ""}${allNew ? " new" : ""}${pinned ? " pinned" : ""}${fileStatus && fileStatus !== "unchanged" ? ` f-${fileStatus}` : ""}`}
        onMouseEnter={() => setFocus(t.id)}
        onMouseLeave={() => setFocus(null)}
        onClick={(e) => props.onSelectKeys(keys(ls), additive(e))}
      >
        <title>{`${what}\nクリックで${clickWhat}をすべて選択${openHint}`}</title>
        <rect x={x} y={y} width={w} height={ROW_H} rx={6} />
        {t.canOpen && (
          <g
            className="pchev"
            onClick={(e) => {
              e.stopPropagation();
              props.onToggleTarget(t.id, !t.open);
            }}
          >
            <title>{t.open ? "まとめる" : `開いて、${openWhat}を表示`}</title>
            <rect x={x} y={y} width={10 + chev} height={ROW_H} />
            <text x={x + 8} y={y + ROW_H / 2 + 4}>
              {t.open ? "▾" : "▸"}
            </text>
          </g>
        )}
        <text x={x + 10 + chev} y={y + ROW_H / 2 + 4} className="plabel">
          {/* external package names ("@scope/pkg") are not paths */}
          {t.external
            ? fit(t.label, w - TREE_EXTRA - chev)
            : pathLabel(t.label, w - TREE_EXTRA - chev - (meta ? textW(meta) : 0))}
          {meta && <tspan className="pnone">{meta}</tspan>}
        </text>
        {!t.external && (
          <g
            className={`pbtn${pinned ? " on" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              props.onTogglePin(pinId);
            }}
          >
            <title>{pinned ? "真ん中にも表示中（クリックで非表示）" : "真ん中にも表示して、この先の依存をたどる"}</title>
            <rect x={x + w - 26} y={y + 4} width={20} height={ROW_H - 8} rx={4} />
            <EyeIcon on={pinned} x={x + w - 23} y={y + ROW_H / 2 - 7} />
          </g>
        )}
      </g>
    );
  };

  const caption = (prefix: string, x: number, w: number) =>
    prefix && (
      <text x={x} y={captionY + 10} className="pcaption">
        <title>{abs(prefix)}</title>
        {fit(`${prefix}/ 以下`, w)}
      </text>
    );

  return (
    <div className="dep-panel">
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
          左のツリーの行にホバーすると、ここに表示され、右に依存先（使っているもの）、左に依存元（使っている側）が出ます。
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

            {hasDeps && (
              <g className="ptitle">
                <text x={depX} y={PAD + 10}>
                  依存元（使っている側）
                </text>
                <text x={srcX0} y={PAD + 10}>
                  表示中
                </text>
                <text x={tgtX} y={PAD + 10}>
                  依存先（使っているもの）
                </text>
              </g>
            )}
            {caption(data.dependentPrefix, depX, depW)}
            {caption(data.sourcePrefix, srcX0, srcW)}
            {caption(data.targetPrefix, tgtX, tgtW)}

            {byStatus(data.inLinks).map((l) => {
              const d = data.dependents.find((x) => x.id === l.from)!;
              const s = data.sources.find((x) => x.id === l.to)!;
              return linkPath(
                l,
                depX + depW,
                dy.get(l.from)! + ROW_H / 2,
                srcX0 + indent(s) - 1,
                sy.get(l.to)! + ROW_H / 2,
                true,
                inLinkTitle(l, d, s),
                // near the dependent end, before links from one row fan in
                d.kind !== "file" ? 0.2 : null,
              );
            })}
            {byStatus(data.links).map((l) => {
              const s = data.sources.find((x) => x.id === l.from)!;
              const t = data.targets.find((x) => x.id === l.to)!;
              return linkPath(
                l,
                srcX0 + srcW,
                sy.get(l.from)! + ROW_H / 2,
                tgtX + indent(t) - 1,
                ty.get(l.to)! + ROW_H / 2,
                false,
                linkTitle(l, s, t),
                // near the target end, where links from one source have already fanned out
                s.kind !== "file" ? 0.8 : null,
              );
            })}

            {data.dependents.map((t) => treeRow(t, "dependent"))}

            {data.sources.map((s) => {
              const y = sy.get(s.id)!;
              const n = outCount(s);
              const x = srcX0 + indent(s);
              const w = srcW - indent(s);
              const none = n === 0 && !s.open;
              const what = s.kind === "file" ? "" : `\n${s.files.length} ファイル`;
              const openHint = s.canOpen ? (s.open ? "\n▾ でまとめる" : "\n▸ で開いて、中のフォルダ・ファイルごとに分ける") : "";
              return (
                <g
                  key={s.id}
                  data-src={s.id}
                  className={`pnode source ${s.kind} ${s.status}${s.pinned ? " pinned" : " temp"}${s.depth ? " child" : ""}${s.open ? " open" : ""}`}
                  onMouseEnter={() => setFocus(s.id)}
                  onMouseLeave={() => setFocus(null)}
                  onClick={(e) => props.onSelectKeys(keys(outgoing(s.id)), additive(e))}
                >
                  <title>{`${abs(s.path)}${what}\n依存先 ${n}\nクリックでここから出る依存をすべて選択${openHint}`}</title>
                  <rect x={x} y={y} width={w} height={ROW_H} rx={6} />
                  {s.canOpen && (
                    <g
                      className="pchev"
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onToggleSource(s.id, !s.open);
                      }}
                    >
                      <title>{s.open ? "まとめる" : "開いて、中のフォルダ・ファイルごとに分ける"}</title>
                      <rect x={x} y={y} width={10 + srcChevW} height={ROW_H} />
                      <text x={x + 8} y={y + ROW_H / 2 + 4}>
                        {s.open ? "▾" : "▸"}
                      </text>
                    </g>
                  )}
                  <text x={x + 10 + srcChevW} y={y + ROW_H / 2 + 4} className="plabel">
                    {pathLabel(s.label, w - SRC_EXTRA - srcChevW - textW(s.suffix ?? "") - (none ? textW(" 依存なし") : 0))}
                    {s.suffix && <tspan className="psuffix">{s.suffix}</tspan>}
                    {none && <tspan className="pnone"> 依存なし</tspan>}
                  </text>
                  {/* a hovered row lasts only while the mouse is on the tree, so only pins get the button */}
                  {s.depth === 0 && s.pinned && (
                    <g
                      className="pbtn"
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onTogglePin(s.id);
                      }}
                    >
                      <title>表示中（クリックで非表示）</title>
                      <rect x={srcX0 + srcW - 26} y={y + 4} width={20} height={ROW_H - 8} rx={4} />
                      <EyeIcon on={s.pinned} x={srcX0 + srcW - 23} y={y + ROW_H / 2 - 7} />
                    </g>
                  )}
                </g>
              );
            })}

            {data.targets.map((t) => treeRow(t, "target"))}
          </svg>
        </div>
      )}
    </div>
  );
}
