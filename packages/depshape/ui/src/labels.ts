/* Shortening path labels to a width (measured by the caller, so this stays testable). */

type Measure = (s: string) => number;

/** Trims from the end, for a name that has to give way ("very-long-na…"). */
export function fitEnd(s: string, maxW: number, w: Measure): string {
  if (w(s) <= maxW) return s;
  const chars = [...s];
  let n = chars.length;
  while (n > 0 && w(chars.slice(0, n).join("") + "…") > maxW) n--;
  return chars.slice(0, n).join("") + "…";
}

/**
 * Splits a path label into its folders (drawn faint) and its name (drawn bold) and shortens it
 * folder by folder. The name always stays whole; the folder right before the name and the first
 * folder (which area of the repo) are kept the longest:
 *   app/(market)/catalog/[item]/warehouses/edit/page.tsx
 *   → app/…/warehouses/edit/page.tsx → app/…/edit/page.tsx → …/edit/page.tsx → app/…/page.tsx → …/page.tsx
 */
export function fitPath(label: string, maxW: number, w: Measure): { dir: string; name: string } {
  const slash = label.endsWith("/");
  const segs = (slash ? label.slice(0, -1) : label).split("/");
  const name = segs.pop()! + (slash ? "/" : "");
  const n = segs.length;
  const candidates: string[] = [];
  if (n) candidates.push(segs.join("/") + "/");
  // drop folders from the middle: keep the first one and as many next to the name as fit
  for (let keep = n - 2; keep >= 1; keep--) candidates.push(`${segs[0]}/…/${segs.slice(n - keep).join("/")}/`);
  if (n >= 2) candidates.push(`…/${segs[n - 1]}/`, `${segs[0]}/…/`);
  if (n) candidates.push("…/");
  for (const dir of candidates) if (w(dir) + w(name) <= maxW) return { dir, name };
  return { dir: n ? "…/" : "", name: fitEnd(name, maxW - (n ? w("…/") : 0), w) };
}
