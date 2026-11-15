import { describe, expect, it } from "vitest";
import { clampLayout, gridColumns, MIN_PANEL, MIN_SIDE, MIN_TREE } from "../ui/src/layout";

describe("area widths", () => {
  it("keeps every area at least its minimum width", () => {
    expect(clampLayout({ tree: 50, side: 340 }, 1600, true).tree).toBe(MIN_TREE);
    // the tree cannot squeeze the panel below its minimum
    expect(clampLayout({ tree: 1500, side: 340 }, 1600, true).tree).toBe(1600 - 12 - 340 - MIN_PANEL);
    expect(clampLayout({ side: 100 }, 1600, true).side).toBe(MIN_SIDE);
    expect(clampLayout({ side: 1500 }, 1600, true).side).toBe(1600 - 12 - MIN_TREE - MIN_PANEL);
  });

  it("uses the default split until the tree is dragged", () => {
    expect(gridColumns({ side: 340 }, false)).toBe("minmax(0, 1fr) 6px minmax(0, 1.15fr)");
    expect(gridColumns({ tree: 500, side: 300 }, true)).toBe("500px 6px minmax(0, 1fr) 6px 300px");
  });
});
