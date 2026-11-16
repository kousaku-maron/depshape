import { describe, expect, it } from "vitest";
import { fitPath } from "../ui/src/labels";

const w = (s: string) => [...s].length; // one unit per character
const fit = (label: string, max: number) => {
  const { dir, name } = fitPath(label, max, w);
  return dir + name;
};

describe("fitPath", () => {
  const page = "app/(market)/catalog/[item]/warehouses/edit/page.tsx";

  it("keeps the whole path when it fits", () => {
    expect(fitPath(page, 100, w)).toEqual({ dir: "app/(market)/catalog/[item]/warehouses/edit/", name: "page.tsx" });
  });

  it("drops folders from the middle, keeping the first one and the ones next to the name", () => {
    expect(fit(page, 40)).toBe("app/…/[item]/warehouses/edit/page.tsx");
    expect(fit(page, 30)).toBe("app/…/warehouses/edit/page.tsx");
    expect(fit(page, 20)).toBe("app/…/edit/page.tsx");
    expect(fit(page, 16)).toBe("…/edit/page.tsx");
    expect(fit(page, 14)).toBe("app/…/page.tsx");
    expect(fit(page, 12)).toBe("…/page.tsx");
  });

  it("keeps a folder's trailing slash with its name and cuts the name last", () => {
    expect(fitPath("features/invoices/components/", 100, w)).toEqual({ dir: "features/invoices/", name: "components/" });
    expect(fit("features/invoices/components/", 22)).toBe("…/invoices/components/");
    expect(fit("features/invoices/components/", 16)).toBe("…/components/");
    expect(fit("a-very-long-file-name.ts", 10)).toBe("a-very-lo…");
    expect(fit("lib/a-very-long-file-name.ts", 10)).toBe("…/a-very-…");
  });
});
