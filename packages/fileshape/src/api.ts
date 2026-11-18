import { HttpError, listFiles, RawBody, readBlob, type Analyzer, type ResolvedSources } from "@diffshape/core";
import type { FileShapeRun, PlainFile } from "./types.js";

/*
 * What the screen asks for after the diff: a file's whole content (to show the lines around a hunk and
 * the Markdown preview), and an image's bytes (the image preview, and images inside a Markdown file).
 * The whole tree's paths and an unchanged file's lines, too, for the tree's "全体" view.
 * Files of the diff and files on the target side are served, and images by their path in the repository.
 */

/** Unchanged files larger than this are opened without their lines (like untracked files in the diff) */
const MAX_PLAIN = 2 * 1024 * 1024;

export type Side = "old" | "new";

export const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

export const imageType = (path: string) => IMAGE_TYPES[path.split(".").pop()?.toLowerCase() ?? ""];

/** A path inside the repository, or an error (no "..", not absolute) */
export function safePath(raw: string | null): string {
  const p = (raw ?? "").replace(/\\/g, "/");
  if (!p || p.startsWith("/") || /^[a-zA-Z]:/.test(p) || p.split("/").some((s) => s === ".." || s === "")) throw new HttpError(400, "bad path");
  return p;
}

const sideOf = (url: URL): Side => {
  const s = url.searchParams.get("side");
  if (s !== "old" && s !== "new") throw new HttpError(400, "side must be old or new");
  return s;
};

// the target side's paths, listed once per analysis (a reload makes a new `data`)
const listings = new WeakMap<FileShapeRun, Promise<Set<string>>>();
function targetFiles(sources: ResolvedSources, data: FileShapeRun): Promise<Set<string>> {
  let p = listings.get(data);
  if (!p) {
    p = listFiles(sources.root, sources.target).then((paths) => new Set(paths));
    p.catch(() => listings.delete(data));
    listings.set(data, p);
  }
  return p;
}

/** A file on the target side that is not in the diff (an unchanged file), or an error */
async function plainPath(sources: ResolvedSources, data: FileShapeRun, path: string): Promise<string> {
  if (!(await targetFiles(sources, data)).has(path)) throw new HttpError(404, `not in the repository: ${path}`);
  return path;
}

const linesOf = (blob: Buffer) => {
  const lines = blob.toString("utf8").split("\n").map((l) => l.replace(/\r$/, ""));
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/** Like git: a NUL byte near the start means binary */
const isBinary = (blob: Buffer) => blob.subarray(0, 8000).includes(0);

/**
 * The path of a file on one side: a diff file (a renamed file has its old path on the base side), or an
 * unchanged file, the same on both sides
 */
async function diffPath(sources: ResolvedSources, data: FileShapeRun, path: string, side: Side): Promise<string> {
  const f = data.files.find((x) => x.path === path);
  if (!f) return plainPath(sources, data, path);
  if ((side === "old" && f.status === "added") || (side === "new" && f.status === "removed")) throw new HttpError(404, `${path} is not on the ${side} side`);
  return side === "old" ? (f.oldPath ?? f.path) : f.path;
}

export const fileApi: NonNullable<Analyzer<FileShapeRun>["api"]> = {
  /** `?path=&side=` → { lines } of a file of the diff */
  async content(url, { sources, data }) {
    const side = sideOf(url);
    const path = await diffPath(sources, data, safePath(url.searchParams.get("path")), side);
    const blob = await readBlob(sources.root, side === "old" ? sources.base : sources.target, path);
    if (!blob) throw new HttpError(404, `not found: ${path}`);
    return { lines: linesOf(blob) };
  },

  /** → { paths } of every file on the target side (the tree's "全体" view) */
  async files(_url, { sources, data }) {
    return { paths: [...(await targetFiles(sources, data))].sort() };
  },

  /** `?path=` → a file that is not in the diff, as a PlainFile */
  async plain(url, { sources, data }): Promise<PlainFile> {
    const path = await plainPath(sources, data, safePath(url.searchParams.get("path")));
    const blob = await readBlob(sources.root, sources.target, path);
    if (!blob) throw new HttpError(404, `not found: ${path}`);
    if (isBinary(blob)) return { binary: true };
    if (blob.length > MAX_PLAIN) return { large: true };
    return { lines: linesOf(blob) };
  },

  /** `?path=&side=` → the bytes of an image in the repository */
  async raw(url, { sources }) {
    const side = sideOf(url);
    const path = safePath(url.searchParams.get("path"));
    const type = imageType(path);
    if (!type) throw new HttpError(400, "only images");
    const blob = await readBlob(sources.root, side === "old" ? sources.base : sources.target, path);
    if (!blob) throw new HttpError(404, `not found: ${path}`);
    return new RawBody(blob, type);
  },
};
