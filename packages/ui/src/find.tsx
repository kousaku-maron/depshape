import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import "./find.css";
import { SearchIcon } from "./icons";

/*
 * ⌘F / Ctrl+F inside a module. The browser's own search only sees what is drawn, and the modules draw
 * lazily (fileshape: files near the screen, depshape: open folders, dbshape: an SVG that pans), so each
 * module searches its own data instead and shows the match itself. This file has the shared parts:
 *   - useFind: the shortcut, the query and which match is current
 *   - FindBar: a box floating over the module's top right, just under its bar (Enter / Shift+Enter: next / previous, Esc: close)
 *   - useFindHighlight: marks the matches drawn on screen (CSS Custom Highlight API, so the text is
 *     not wrapped in new elements), the current one in its own color
 * ⌘F again while the box has focus goes to the browser's own search.
 */

/** More matches than this are counted as "N+" */
export const FIND_LIMIT = 5000;

export interface Find {
  open: boolean;
  query: string;
  caseSensitive: boolean;
  /** The current match (the module clamps it to its matches) */
  index: number;
  /** Changes on every move (a new query, next, previous), so the module shows the match again even when `index` stays */
  seq: number;
  input: RefObject<HTMLInputElement>;
  setQuery: (q: string) => void;
  toggleCase: () => void;
  /** Moves by `delta` among `count` matches, wrapping around */
  go: (delta: number, count: number) => void;
  close: () => void;
}

export function useFind(active: boolean): Find {
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [caseSensitive, setCase] = useState(false);
  const [pos, setPos] = useState({ index: 0, seq: 0 });
  const input = useRef<HTMLInputElement>(null);
  const openRef = useRef(open);
  openRef.current = open;
  // each ⌘F focuses the box (and selects its text) once it is drawn
  const [focusAsk, setFocusAsk] = useState(0);
  useEffect(() => {
    if (!focusAsk) return;
    input.current?.focus();
    input.current?.select();
  }, [focusAsk]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "f" && !e.shiftKey) {
        // a second ⌘F in the box: the browser's own search
        if (document.activeElement === input.current) return;
        e.preventDefault();
        setOpen(true);
        setFocusAsk((n) => n + 1);
      } else if (key === "g" && openRef.current) {
        // ⌘G / ⌘⇧G: next / previous, like the browser
        e.preventDefault();
        setPos((p) => ({ index: p.index + (e.shiftKey ? -1 : 1), seq: p.seq + 1 }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  const setQuery = useCallback((q: string) => {
    setQueryState(q);
    setPos((p) => ({ index: 0, seq: p.seq + 1 }));
  }, []);
  const toggleCase = useCallback(() => {
    setCase((c) => !c);
    setPos((p) => ({ index: 0, seq: p.seq + 1 }));
  }, []);
  const go = useCallback((delta: number, count: number) => {
    if (count === 0) return;
    setPos((p) => ({ index: (((p.index + delta) % count) + count) % count, seq: p.seq + 1 }));
  }, []);
  const close = useCallback(() => setOpen(false), []);

  return { open, query, caseSensitive, index: pos.index, seq: pos.seq, input, setQuery, toggleCase, go, close };
}

/** `index` (which may have been moved past either end by ⌘G) as a position among `count` matches */
export const findIndex = (find: Find, count: number) => (count === 0 ? -1 : ((find.index % count) + count) % count);

/** Where `query` starts in `text` (none for an empty query); no more than `limit` */
export function findAll(text: string, query: string, caseSensitive: boolean, limit = FIND_LIMIT): number[] {
  if (!query) return [];
  const t = caseSensitive ? text : text.toLowerCase();
  const q = caseSensitive ? query : query.toLowerCase();
  const out: number[] = [];
  for (let i = t.indexOf(q); i !== -1 && out.length < limit; i = t.indexOf(q, i + q.length)) out.push(i);
  return out;
}

export function FindBar({ find, count, placeholder }: { find: Find; count: number; placeholder: string }) {
  if (!find.open) return null;
  const capped = count >= FIND_LIMIT;
  const at = findIndex(find, count);
  return (
    <div className="ds-find" role="search">
      <SearchIcon size={14} className="ds-find-icon" />
      <input
        ref={find.input}
        className="ds-find-input"
        type="text"
        placeholder={placeholder}
        value={find.query}
        spellCheck={false}
        onChange={(e) => find.setQuery(e.target.value)}
        onKeyDown={(e) => {
          // Enter that confirms an IME conversion is not "next"
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") {
            e.preventDefault();
            find.go(e.shiftKey ? -1 : 1, count);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            find.close();
          }
        }}
      />
      <button className={`ds-find-btn ds-find-case${find.caseSensitive ? " on" : ""}`} onClick={find.toggleCase} title="大文字と小文字を区別する" aria-pressed={find.caseSensitive}>
        Aa
      </button>
      <span className={`ds-find-count${find.query && count === 0 ? " none" : ""}`}>{find.query ? (count === 0 ? "0 件" : `${at + 1} / ${count}${capped ? "+" : ""}`) : ""}</span>
      <button className="ds-find-btn" onClick={() => find.go(-1, count)} disabled={count === 0} title="前へ（Shift+Enter）" aria-label="前へ">
        ↑
      </button>
      <button className="ds-find-btn" onClick={() => find.go(1, count)} disabled={count === 0} title="次へ（Enter）" aria-label="次へ">
        ↓
      </button>
      <button className="ds-find-btn" onClick={find.close} title="閉じる（Esc）" aria-label="閉じる">
        ×
      </button>
    </div>
  );
}

/** The current match as drawn: the element that holds it and which occurrence of the query in its text it is */
export interface FindTarget {
  el: Element;
  nth: number;
}

const ALL = "ds-find";
const CURRENT = "ds-find-current";
/** The view that painted last (hidden modules stay mounted; only the shown one paints) */
let owner: object | null = null;
let marked: Element | null = null;

const canHighlight = () => typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";

/**
 * Marks every occurrence of the query in the elements under `root` that match `selector`, and the
 * current one (`current()`, read again whenever the drawing changes, since a match may be drawn later).
 * The current match's element also gets `data-find-current` (for a row tint).
 */
export function useFindHighlight(opts: {
  root: HTMLElement | null;
  selector: string;
  find: Find;
  on: boolean;
  current: () => FindTarget | null;
}) {
  const { root, selector, find, on } = opts;
  const currentRef = useRef(opts.current);
  currentRef.current = opts.current;
  const query = find.open && on ? find.query : "";
  const cs = find.caseSensitive;
  const seq = find.seq;
  useEffect(() => {
    if (!root || !query) return;
    const token = {};
    owner = token;
    let frame = 0;
    const paint = () => {
      if (owner !== token) return;
      const cur = currentRef.current();
      if (marked !== (cur?.el ?? null)) {
        marked?.removeAttribute("data-find-current");
        marked = cur?.el ?? null;
        marked?.setAttribute("data-find-current", "");
      }
      if (!canHighlight()) return;
      const all: Range[] = [];
      let current: Range | null = null;
      for (const el of root.querySelectorAll(selector)) {
        if (all.length >= FIND_LIMIT) break;
        const ranges = rangesIn(el, query, cs);
        all.push(...ranges);
        if (cur && el === cur.el) current = ranges[cur.nth] ?? null;
      }
      // the current match may be in an element the selector does not cover
      if (cur && !current) current = rangesIn(cur.el, query, cs)[cur.nth] ?? null;
      CSS.highlights.set(ALL, new Highlight(...all));
      if (current) CSS.highlights.set(CURRENT, new Highlight(current));
      else CSS.highlights.delete(CURRENT);
    };
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(paint);
    };
    paint();
    const mo = new MutationObserver(later);
    mo.observe(root, { subtree: true, childList: true, characterData: true });
    return () => {
      mo.disconnect();
      cancelAnimationFrame(frame);
      if (owner !== token) return;
      owner = null;
      marked?.removeAttribute("data-find-current");
      marked = null;
      if (canHighlight()) {
        CSS.highlights.delete(ALL);
        CSS.highlights.delete(CURRENT);
      }
    };
  }, [root, selector, query, cs, seq]);
}

/** A Range for each occurrence of the query in the text of `el`, which may be split over several text nodes */
function rangesIn(el: Element, query: string, caseSensitive: boolean): Range[] {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text);
    starts.push(text.length);
    text += (n as Text).data;
  }
  const out: Range[] = [];
  let k = 0;
  const at = (offset: number, end: boolean): [Text, number] => {
    // the text node holding `offset` (for an end: the one it closes)
    while (k + 1 < nodes.length && (end ? starts[k + 1] < offset : starts[k + 1] <= offset)) k++;
    return [nodes[k], offset - starts[k]];
  };
  for (const s of findAll(text, query, caseSensitive)) {
    const r = document.createRange();
    const [a, ao] = at(s, false);
    r.setStart(a, ao);
    const [b, bo] = at(s + query.length, true);
    r.setEnd(b, bo);
    out.push(r);
  }
  return out;
}
