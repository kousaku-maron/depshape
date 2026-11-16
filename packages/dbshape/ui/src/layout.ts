import { DIVIDER_W, loadJSON, saveJSON } from "@diffshape/ui";

/*
 * Widths of the three areas (list | diagram | detail panel), set by dragging the lines between them.
 * The list and the panel have a width in px and the diagram takes what is left. Saved once for every
 * repository (a screen preference, not per project), like depshape's.
 */

export interface Layout {
  side: number;
  panel: number;
}

export const DEFAULT_LAYOUT: Layout = { side: 260, panel: 440 };
export const MIN_SIDE = 180;
export const MIN_CANVAS = 320;
export const MIN_PANEL = 320;

const KEY = "dbshape.layout";

export function loadLayout(): Layout {
  const v = loadJSON<Partial<Layout>>(KEY, {});
  return {
    side: typeof v.side === "number" && v.side > 0 ? v.side : DEFAULT_LAYOUT.side,
    panel: typeof v.panel === "number" && v.panel > 0 ? v.panel : DEFAULT_LAYOUT.panel,
  };
}

export const saveLayout = (l: Layout) => saveJSON(KEY, l);

/** Keeps every area at least its minimum width inside a body `total` px wide (the diagram gives way last). */
export function clampLayout(l: Layout, total: number, withPanel: boolean): Layout {
  const dividers = DIVIDER_W * (withPanel ? 2 : 1);
  let panel = l.panel;
  if (withPanel) panel = Math.max(MIN_PANEL, Math.min(panel, total - dividers - MIN_SIDE - MIN_CANVAS));
  const room = total - dividers - (withPanel ? panel : 0);
  const side = Math.max(MIN_SIDE, Math.min(l.side, room - MIN_CANVAS));
  return { side, panel: Math.max(MIN_PANEL, panel) };
}

/** grid-template-columns for the body */
export function gridColumns(l: Layout, withPanel: boolean): string {
  return [`${l.side}px`, `${DIVIDER_W}px`, "minmax(0, 1fr)", ...(withPanel ? [`${DIVIDER_W}px`, `${l.panel}px`] : [])].join(" ");
}
