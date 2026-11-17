import { describe, expect, it } from "vitest";
import type { Edge } from "../src/types";
import { folderReviewed, reviewedFiles, reviewTargets } from "../ui/src/reviewed";

const edge = (from: string, to: string, status: Edge["status"], external = false): Edge => ({ from, to, status, external });

describe("reviewTargets", () => {
  it("lists only files whose local imports appeared or disappeared", () => {
    const t = reviewTargets([
      edge("a/x.ts", "b", "added"),
      edge("a/y.ts", "b", "unchanged"),
      edge("a/z.ts", "react", "added", true),
      edge("c/w.ts", "a", "removed"),
    ]);
    expect([...t.keys()].sort()).toEqual(["a/x.ts", "c/w.ts"]);
  });

  it("gives the same hash whatever the order of the edges", () => {
    const one = reviewTargets([edge("a/x.ts", "b", "added"), edge("a/x.ts", "c", "removed")]);
    const two = reviewTargets([edge("a/x.ts", "c", "removed"), edge("a/x.ts", "b", "added")]);
    expect(one.get("a/x.ts")).toBe(two.get("a/x.ts"));
  });

  it("changes the hash when the file's dependency changes differ", () => {
    const before = reviewTargets([edge("a/x.ts", "b", "added")]);
    const after = reviewTargets([edge("a/x.ts", "b", "added"), edge("a/x.ts", "c", "added")]);
    expect(before.get("a/x.ts")).not.toBe(after.get("a/x.ts"));
  });
});

describe("reviewedFiles", () => {
  it("keeps a mark only while it matches the current changes", () => {
    const marked = reviewTargets([edge("a/x.ts", "b", "added"), edge("a/y.ts", "b", "added")]);
    const marks = Object.fromEntries(marked);
    // a/y.ts changed again after it was marked; a/gone.ts no longer has dependency changes
    const now = reviewTargets([edge("a/x.ts", "b", "added"), edge("a/y.ts", "c", "added")]);
    expect([...reviewedFiles(now, { ...marks, "a/gone.ts": "zzz" })]).toEqual(["a/x.ts"]);
  });
});

describe("folderReviewed", () => {
  const targets = reviewTargets([edge("a/x.ts", "b", "added"), edge("a/sub/y.ts", "b", "added"), edge("c/z.ts", "a", "added")]);

  it("is reviewed when every file to review inside it is reviewed", () => {
    expect(folderReviewed("a", targets, new Set(["a/x.ts", "a/sub/y.ts"]))).toBe(true);
    expect(folderReviewed("a", targets, new Set(["a/x.ts"]))).toBe(false);
  });

  it("is not reviewed when it holds nothing to review", () => {
    expect(folderReviewed("d", targets, new Set())).toBe(false);
  });

  it("does not take a folder with a similar name for a parent", () => {
    expect(folderReviewed("a/s", targets, new Set())).toBe(false);
  });

  it("treats the root as holding every file", () => {
    expect(folderReviewed("", targets, new Set(["a/x.ts", "a/sub/y.ts"]))).toBe(false);
    expect(folderReviewed("", targets, new Set(["a/x.ts", "a/sub/y.ts", "c/z.ts"]))).toBe(true);
  });
});
