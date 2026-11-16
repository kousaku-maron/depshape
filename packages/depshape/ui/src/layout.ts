import { DIVIDER_W } from "@diffshape/ui";

/*
 * Widths of the three areas (tree | panel | comment sidebar), set by dragging the dividers between them.
 * The tree and the sidebar have a width in px; the panel takes what is left. A missing tree width means
 * the default split. Saved once for every repository (it is a screen preference, not per project).
 */

export interface Layout {
  /** tree width in px; undefined = the default split with the panel */
  tree?: number;
  /** comment sidebar width in px */
  side: number;
}

export const DEFAULT_SIDE = 340;
export const MIN_TREE = 220;
export const MIN_PANEL = 360;
export const MIN_SIDE = 260;

const KEY = "depshape.layout";

export function loadLayout(): Layout {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Layout>;
    return {
      tree: typeof v.tree === "number" && v.tree > 0 ? v.tree : undefined,
      side: typeof v.side === "number" && v.side > 0 ? v.side : DEFAULT_SIDE,
    };
  } catch {
    return { side: DEFAULT_SIDE };
  }
}

export function saveLayout(l: Layout) {
  try {
    localStorage.setItem(KEY, JSON.stringify(l));
  } catch {
    /* ignore */
  }
}

/** Keeps every area at least its minimum width inside a body `total` px wide (the panel gives way last). */
export function clampLayout(l: Layout, total: number, sidebar: boolean): Layout {
  const dividers = DIVIDER_W * (sidebar ? 2 : 1);
  let side = l.side;
  if (sidebar) side = Math.max(MIN_SIDE, Math.min(side, total - dividers - MIN_TREE - MIN_PANEL));
  const room = total - dividers - (sidebar ? side : 0);
  const tree = l.tree === undefined ? undefined : Math.max(MIN_TREE, Math.min(l.tree, room - MIN_PANEL));
  return { tree, side: Math.max(MIN_SIDE, side) };
}

/** grid-template-columns for the body. */
export function gridColumns(l: Layout, sidebar: boolean): string {
  // the default split matches the old fixed layout: tree : panel = 1 : 1.15
  const tree = l.tree === undefined ? "minmax(0, 1fr)" : `${l.tree}px`;
  const panel = l.tree === undefined ? "minmax(0, 1.15fr)" : "minmax(0, 1fr)";
  return [tree, `${DIVIDER_W}px`, panel, ...(sidebar ? [`${DIVIDER_W}px`, `${l.side}px`] : [])].join(" ");
}
