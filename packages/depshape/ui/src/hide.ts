import { parentDir } from "./model";

/*
 * Rows of the panel whose lines the user set aside for now (right-click → 依存の線を隠す).
 * Remembered by path, so a hidden folder keeps the rows opened from it hidden, and a row stays hidden
 * while the shown items change. Not saved: a reload shows everything again.
 *
 * Keys are "<column>|<what>|<path>":
 *   column  S = shown (middle), T = targets (right), I = dependents (left)
 *   what    tree = a folder and everything below it
 *           dir  = what sits directly in a folder (a Go package, a folder's imported / importing files)
 *           file = one file
 *           ext  = an external package
 */

export type Column = "S" | "T" | "I";
type What = "tree" | "dir" | "file" | "ext";

/** What a panel row (or link end) stands for, from its id. */
function refOf(col: Column, id: string): { what: What; path: string } {
  const raw = id.startsWith("i:") ? id.slice(2) : id;
  const path = raw.slice(2);
  switch (raw[0]) {
    case "f":
    case "t":
      return { what: "file", path };
    case "g":
      return { what: "tree", path };
    case "d":
      // a shown folder stands for everything under it; a target / dependent folder row for its direct files
      return { what: col === "S" ? "tree" : "dir", path };
    case "x":
      return { what: "ext", path };
    default:
      // p: (package), r: (rest of a folder), c: (box of shown files)
      return { what: "dir", path };
  }
}

export const hideKey = (col: Column, id: string) => {
  const r = refOf(col, id);
  return `${col}|${r.what}|${r.path}`;
};

const within = (p: string, d: string) => d === "" || p === d || p.startsWith(`${d}/`);

/** Whether hidden key `key` covers the row `id` of column `col`. */
export function covers(key: string, col: Column, id: string): boolean {
  const [kc, kw, ...rest] = key.split("|");
  if (kc !== col) return false;
  const kp = rest.join("|");
  const r = refOf(col, id);
  switch (kw) {
    case "tree":
      return r.what !== "ext" && within(r.path, kp);
    case "dir":
      return (r.what === "dir" && r.path === kp) || (r.what === "file" && parentDir(r.path) === kp);
    default:
      return kw === r.what && kp === r.path;
  }
}

export const isHidden = (hidden: ReadonlySet<string>, col: Column, id: string) => [...hidden].some((k) => covers(k, col, id));

/** `hidden` without the keys that hide the row `id` (to show it again). */
export function unhide(hidden: ReadonlySet<string>, col: Column, id: string): Set<string> {
  return new Set([...hidden].filter((k) => !covers(k, col, id)));
}
