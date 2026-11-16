import { describe, expect, it } from "vitest";
import { clampLayout, gridColumns, MIN_CANVAS, MIN_PANEL, MIN_SIDE } from "../ui/src/layout";

describe("area widths", () => {
  it("keeps every area at least its minimum width", () => {
    expect(clampLayout({ side: 50, panel: 440 }, 1600, true).side).toBe(MIN_SIDE);
    // the list cannot squeeze the diagram below its minimum
    expect(clampLayout({ side: 1500, panel: 440 }, 1600, true).side).toBe(1600 - 12 - 440 - MIN_CANVAS);
    expect(clampLayout({ side: 260, panel: 100 }, 1600, true).panel).toBe(MIN_PANEL);
    expect(clampLayout({ side: 260, panel: 1500 }, 1600, true).panel).toBe(1600 - 12 - MIN_SIDE - MIN_CANVAS);
    // without the panel, its width does not limit the list
    expect(clampLayout({ side: 1000, panel: 440 }, 1600, false).side).toBe(1000);
  });

  it("gives the diagram what is left", () => {
    expect(gridColumns({ side: 260, panel: 440 }, false)).toBe("260px 6px minmax(0, 1fr)");
    expect(gridColumns({ side: 300, panel: 500 }, true)).toBe("300px 6px minmax(0, 1fr) 6px 500px");
  });
});
