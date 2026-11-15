import { describe, expect, it } from "vitest";
import { covers, hideKey, isHidden, unhide } from "../ui/src/hide";

describe("hidden rows", () => {
  it("a folded group hides the rows opened from it; a folder row only its direct files", () => {
    const group = new Set([hideKey("T", "g:lib")]);
    expect(isHidden(group, "T", "g:lib")).toBe(true);
    expect(isHidden(group, "T", "d:lib/hoge")).toBe(true);
    expect(isHidden(group, "T", "t:lib/hoge/h.ts")).toBe(true);
    expect(isHidden(group, "T", "d:libx")).toBe(false);
    // the same path in another column is not hidden
    expect(isHidden(group, "I", "i:g:lib")).toBe(false);

    const pkg = new Set([hideKey("T", "d:lib")]);
    expect(isHidden(pkg, "T", "t:lib/a.ts")).toBe(true);
    expect(isHidden(pkg, "T", "d:lib/hoge")).toBe(false);
    expect(isHidden(pkg, "T", "g:lib")).toBe(false);
  });

  it("dependents and shown items follow the same rules", () => {
    const h = new Set([hideKey("I", "i:g:tests"), hideKey("S", "c:app/b")]);
    expect(isHidden(h, "I", "i:f:tests/x/a_test.go")).toBe(true);
    expect(isHidden(h, "S", "f:app/b/z.go")).toBe(true);
    expect(isHidden(h, "S", "f:app/a/x.go")).toBe(false);
    expect(covers(hideKey("S", "d:app"), "S", "f:app/b/z.go")).toBe(true);
    expect(isHidden(new Set([hideKey("T", "x:react")]), "T", "x:react")).toBe(true);
  });

  it("showing a row drops every key that hides it", () => {
    const h = new Set([hideKey("I", "i:g:tests"), hideKey("I", "i:f:tests/a.go"), hideKey("T", "d:lib")]);
    expect([...unhide(h, "I", "i:f:tests/a.go")]).toEqual([hideKey("T", "d:lib")]);
  });
});
