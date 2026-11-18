/*
 * The module's own endpoints on the diffshape server (packages/fileshape/src/api.ts): a file's whole
 * content and an image's bytes.
 */

import type { PlainFile } from "../../src/types";

export type Side = "old" | "new";

const query = (path: string, side: Side) => `path=${encodeURIComponent(path)}&side=${side}`;

export async function fetchContent(path: string, side: Side): Promise<string[]> {
  const res = await fetch(`/api/module/file/content?${query(path, side)}`);
  if (!res.ok) throw new Error(await res.text());
  return ((await res.json()) as { lines: string[] }).lines;
}

/** Every file on the target side (the tree's "全体" view) */
export async function fetchFileList(): Promise<string[]> {
  const res = await fetch("/api/module/file/files");
  if (!res.ok) throw new Error(await res.text());
  return ((await res.json()) as { paths: string[] }).paths;
}

/** A file that is not in the diff; null when the repository has no such file (any more) */
export async function fetchPlain(path: string): Promise<PlainFile | null> {
  const res = await fetch(`/api/module/file/plain?path=${encodeURIComponent(path)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as PlainFile;
}

/** `version` changes on every reload, so the browser asks for the bytes again */
export const rawUrl = (path: string, side: Side, version: number) => `/api/module/file/raw?${query(path, side)}&v=${version}`;

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;

export const isImage = (path: string) => IMAGE.test(path);

export const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);
