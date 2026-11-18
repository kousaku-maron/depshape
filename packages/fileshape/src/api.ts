import { HttpError, RawBody, readBlob, type Analyzer } from "@diffshape/core";
import type { FileShapeRun } from "./types.js";

/*
 * What the screen asks for after the diff: a file's whole content (to show the lines around a hunk and
 * the Markdown preview), and an image's bytes (the image preview, and images inside a Markdown file).
 * Only files of the diff are served, and images by their path in the repository.
 */

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

/** The path of a diff file on one side (a renamed file has its old path on the base side) */
function diffPath(data: FileShapeRun, path: string, side: Side): string {
  const f = data.files.find((x) => x.path === path);
  if (!f) throw new HttpError(404, `not in the diff: ${path}`);
  if ((side === "old" && f.status === "added") || (side === "new" && f.status === "removed")) throw new HttpError(404, `${path} is not on the ${side} side`);
  return side === "old" ? (f.oldPath ?? f.path) : f.path;
}

export const fileApi: NonNullable<Analyzer<FileShapeRun>["api"]> = {
  /** `?path=&side=` → { lines } of a file of the diff */
  async content(url, { sources, data }) {
    const side = sideOf(url);
    const path = diffPath(data, safePath(url.searchParams.get("path")), side);
    const blob = await readBlob(sources.root, side === "old" ? sources.base : sources.target, path);
    if (!blob) throw new HttpError(404, `not found: ${path}`);
    const text = blob.toString("utf8");
    const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
    if (lines[lines.length - 1] === "") lines.pop();
    return { lines };
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
