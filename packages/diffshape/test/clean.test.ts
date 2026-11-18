import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODULES } from "../ui/src/modules";

/*
 * --clean: every module removes the comments and the reviewed marks of one comparison, and leaves
 * other comparisons and the view preferences alone.
 */

class MemoryStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  keys() {
    return [...this.m.keys()].sort();
  }
}

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
});
afterEach(() => vi.unstubAllGlobals());

describe("clearReview", () => {
  it("clears this comparison in every module and keeps the rest", () => {
    const c = { repoRoot: "/repo", targetLabel: "作業ディレクトリ", baseLabel: "HEAD" };
    const kept = [
      "fileshape.comments:/repo|作業ディレクトリ|main",
      "depshape.reviewed:/other|作業ディレクトリ|HEAD",
      "dbshape.comments:/repo|main|作業ディレクトリ|default",
      "depshape.pins:/repo",
      "fileshape.treeWidth",
    ];
    const cleared = [
      "fileshape.comments:/repo|作業ディレクトリ|HEAD",
      "fileshape.reviewed:/repo|作業ディレクトリ|HEAD",
      "depshape.comments:/repo|作業ディレクトリ|HEAD",
      "depshape.reviewed:/repo|作業ディレクトリ|HEAD",
      // dbshape keeps one per database, base first
      "dbshape.comments:/repo|HEAD|作業ディレクトリ|default",
      "dbshape.comments:/repo|HEAD|作業ディレクトリ|billing",
      "dbshape.reviewed:/repo|HEAD|作業ディレクトリ|default",
    ];
    for (const k of [...kept, ...cleared]) storage.setItem(k, "[]");
    for (const m of MODULES) m.clearReview(c);
    expect(storage.keys()).toEqual([...kept].sort());
  });
});
