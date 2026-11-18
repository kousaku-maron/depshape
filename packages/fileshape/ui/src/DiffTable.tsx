import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DiffFile, DiffLine } from "../../src/types";
import type { ReviewComment, LineTarget, Side } from "./comments";
import { targetKey, CommentThread, useComments } from "./CommentViews";
import type { Token } from "./highlight";
import { EXPAND_STEP, markRanges, pairLines, wordDiffs, type Gap, type Ranges, type Row } from "./model";

/*
 * The lines of one file, unified (one column, like `git diff`) or split (base on the left, target on
 * the right):
 *   - a hunk header opens the lines git left out around it (20 at a time, or all)
 *   - the words that changed inside a changed line are marked
 *   - a line number starts a comment; Shift+click or a drag over the numbers makes it a range
 */

export type ViewMode = "unified" | "split";

interface Props {
  file: DiffFile;
  mode: ViewMode;
  rows: Row[];
  tokens: Map<string, Token[]> | undefined;
  /** Comments of this file by the line they are shown under ("new:12") */
  byLine: Map<string, ReviewComment[]>;
  onExpand: (gap: Gap, dir: "up" | "down" | "all") => void;
}

interface Selection {
  side: Side;
  a: number;
  b: number;
}

const lo = (s: Selection) => Math.min(s.a, s.b);
const hi = (s: Selection) => Math.max(s.a, s.b);

const numOf = (side: Side, l: DiffLine) => (side === "old" ? (l.type !== "add" ? l.oldLine : undefined) : l.type !== "delete" ? l.newLine : undefined);

export const DiffTable = memo(function DiffTable({ file, mode, rows, tokens, byLine, onExpand }: Props) {
  const api = useComments();
  const composing = api.composing?.path === file.path ? api.composing : null;

  const words = useMemo(() => {
    const m = new Map<string, Ranges>();
    for (const c of file.chunks) for (const [k, v] of wordDiffs(c.lines)) m.set(k, v);
    return m;
  }, [file]);

  // the text of each shown line, per side (to take the code of a range)
  const shown = useMemo(() => {
    const m = { old: new Map<number, string>(), new: new Map<number, string>() };
    for (const r of rows)
      if (r.kind === "line")
        for (const side of ["old", "new"] as const) {
          const n = numOf(side, r.line);
          if (n !== undefined) m[side].set(n, r.line.content);
        }
    return m;
  }, [rows]);

  /** The target for lines a..b of a side, cut where a line is not shown */
  const targetFor = (side: Side, a: number, b: number): LineTarget => {
    const from = Math.min(a, b);
    const to = Math.max(a, b);
    const code: string[] = [];
    let end = from;
    for (let n = from; n <= to; n++) {
      const t = shown[side].get(n);
      if (t === undefined) break;
      code.push(t);
      end = n;
    }
    return { path: file.path, side, line: from, ...(end > from ? { endLine: end } : {}), code: code.join("\n") };
  };

  // ---- choosing lines: a click, Shift+click from the line being commented, or a drag
  const [drag, setDrag] = useState<Selection | null>(null);
  const dragRef = useRef<Selection | null>(null);
  dragRef.current = drag;
  // the mouse can be released anywhere; the latest render's helpers finish the drag
  const finish = useRef(() => {});
  finish.current = () => {
    const d = dragRef.current;
    setDrag(null);
    if (d) api.compose(targetFor(d.side, d.a, d.b));
  };
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const up = () => finish.current();
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, [dragging]);

  const selected: Selection | null = drag ?? (composing ? { side: composing.side, a: composing.line, b: composing.endLine ?? composing.line } : null);
  const isSelected = (side: Side, n: number | undefined) => !!selected && n !== undefined && selected.side === side && n >= lo(selected) && n <= hi(selected);

  const num = (side: Side, l: DiffLine | undefined) => {
    const n = l ? numOf(side, l) : undefined;
    if (!l || n === undefined) return <td className="fs-num empty" />;
    return (
      <td
        className={`fs-num${isSelected(side, n) ? " selected" : ""}`}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          if (e.shiftKey && composing && composing.side === side) {
            api.compose(targetFor(side, composing.line, n));
            return;
          }
          setDrag({ side, a: n, b: n });
        }}
        onMouseEnter={() => {
          if (dragRef.current && dragRef.current.side === side) setDrag({ ...dragRef.current, b: n });
        }}
        title={`${side === "old" ? "変更前" : "変更後"}の ${n} 行目にコメントする（Shift+クリックかドラッグで範囲）`}
      >
        {n}
      </td>
    );
  };

  const code = (side: Side, l: DiffLine) => {
    const n = numOf(side, l)!;
    // a context line has the same text on both sides: the target side's tokens know the whole file
    const t = (l.type === "normal" ? (tokens?.get(targetKey("new", l.newLine!)) ?? tokens?.get(targetKey("old", l.oldLine!))) : tokens?.get(targetKey(side, n))) ?? [{ types: "", text: l.content }];
    const marked = markRanges(t, words.get(targetKey(side, n)) ?? []);
    return marked.map((tk, i) => {
      const cls = [tk.types ? `token ${tk.types}` : "", tk.mark ? `fs-word ${side}` : ""].filter(Boolean).join(" ");
      return cls ? (
        <span key={i} className={cls}>
          {tk.text}
        </span>
      ) : (
        <Fragment key={i}>{tk.text}</Fragment>
      );
    });
  };

  /** The thread row after a table row whose lines are `keys` */
  const thread = (keys: [Side, number][], colSpan: number): ReactNode => {
    const list = [...new Set(keys.flatMap(([s, n]) => byLine.get(targetKey(s, n)) ?? []))];
    const end = composing ? (composing.endLine ?? composing.line) : undefined;
    const c = composing && keys.some(([s, n]) => composing.side === s && end === n) ? composing : undefined;
    if (!list.length && !c) return null;
    return (
      <tr className="fs-thread-row">
        <td colSpan={colSpan}>
          <CommentThread comments={list} composing={c} />
        </td>
      </tr>
    );
  };

  const gapRow = (r: Extract<Row, { kind: "gap" }>, colSpan: number, key: number) => {
    const { gap, hidden, chunk } = r;
    const before = gap.index > 0;
    const after = !!chunk;
    const open = (dir: "up" | "down" | "all", label: string, title: string) => (
      <button className="fs-expand" onClick={() => onExpand(gap, dir)} title={title} aria-label={title}>
        {label}
      </button>
    );
    const canOpen = hidden === undefined || hidden > 0;
    return (
      <tr key={`g${key}`} className="fs-hunk">
        <td colSpan={colSpan}>
          <span className="fs-expanders">
            {canOpen &&
              (hidden !== undefined && hidden <= EXPAND_STEP && before && after
                ? open("all", "↕", `${hidden} 行をすべて表示`)
                : [
                    after && open("up", "↑", `上の ${Math.min(EXPAND_STEP, hidden ?? EXPAND_STEP)} 行を表示`),
                    before && open("down", "↓", hidden === undefined ? "下の行を表示" : `下の ${Math.min(EXPAND_STEP, hidden)} 行を表示`),
                    hidden !== undefined && hidden > EXPAND_STEP && open("all", "⇕", `${hidden} 行をすべて表示`),
                  ].filter(Boolean).map((b, i) => <Fragment key={i}>{b}</Fragment>))}
          </span>
          {chunk ? (
            <>
              @@ -{chunk.oldStart},{chunk.oldLines} +{chunk.newStart},{chunk.newLines} @@
              {chunk.section && <span className="fs-hunk-section"> {chunk.section}</span>}
            </>
          ) : (
            <span>{hidden === undefined ? "ファイルの残りを表示" : `残り ${hidden} 行`}</span>
          )}
        </td>
      </tr>
    );
  };

  if (mode === "unified") {
    return (
      <table className="fs-table unified">
        <colgroup>
          <col className="fs-col-num" />
          <col className="fs-col-num" />
          <col className="fs-col-sign" />
          <col />
        </colgroup>
        <tbody>
          {rows.map((r, i) => {
            if (r.kind === "gap") return gapRow(r, 4, i);
            const l = r.line;
            const side: Side = l.type === "delete" ? "old" : "new";
            const keys: [Side, number][] = l.type === "normal" ? [["old", l.oldLine!], ["new", l.newLine!]] : [[side, numOf(side, l)!]];
            const sel = keys.some(([s, n]) => isSelected(s, n));
            return (
              <Fragment key={i}>
                <tr className={`fs-line ${l.type}${r.opened ? " opened" : ""}${sel ? " selected" : ""}`}>
                  {num("old", l.type === "add" ? undefined : l)}
                  {num("new", l.type === "delete" ? undefined : l)}
                  <td className="fs-sign">{l.type === "add" ? "+" : l.type === "delete" ? "-" : " "}</td>
                  <td className="fs-code">{code(side, l)}</td>
                </tr>
                {thread(keys, 4)}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    );
  }

  // split: the lines between two gap rows are paired side by side
  const body: ReactNode[] = [];
  let run: DiffLine[] = [];
  let opened = new Set<DiffLine>();
  const flush = () => {
    pairLines(run).forEach((p, k) => {
      const keys: [Side, number][] = [];
      if (p.old) keys.push(["old", p.old.oldLine!]);
      if (p.new) keys.push(["new", p.new.newLine!]);
      const cls = (l: DiffLine | undefined, side: Side) => `${!l ? "empty" : l.type}${l && isSelected(side, numOf(side, l)) ? " selected" : ""}`;
      body.push(
        <Fragment key={`l${body.length}-${k}`}>
          <tr className={`fs-line${p.old && opened.has(p.old) ? " opened" : ""}`}>
            {num("old", p.old)}
            <td className={`fs-sign ${cls(p.old, "old")}`}>{p.old?.type === "delete" ? "-" : " "}</td>
            <td className={`fs-code ${cls(p.old, "old")}`}>{p.old && code("old", p.old)}</td>
            {num("new", p.new)}
            <td className={`fs-sign ${cls(p.new, "new")}`}>{p.new?.type === "add" ? "+" : " "}</td>
            <td className={`fs-code ${cls(p.new, "new")}`}>{p.new && code("new", p.new)}</td>
          </tr>
          {thread(keys, 6)}
        </Fragment>,
      );
    });
    run = [];
    opened = new Set();
  };
  rows.forEach((r, i) => {
    if (r.kind === "gap") {
      flush();
      body.push(gapRow(r, 6, i));
    } else {
      run.push(r.line);
      if (r.opened) opened.add(r.line);
    }
  });
  flush();

  return (
    <table className="fs-table split">
      <colgroup>
        <col className="fs-col-num" />
        <col className="fs-col-sign" />
        <col className="fs-col-half" />
        <col className="fs-col-num" />
        <col className="fs-col-sign" />
        <col className="fs-col-half" />
      </colgroup>
      <tbody>{body}</tbody>
    </table>
  );
});
