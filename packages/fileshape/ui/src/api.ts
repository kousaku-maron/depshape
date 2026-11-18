/*
 * The module's own endpoints on the diffshape server (packages/fileshape/src/api.ts): a file's whole
 * content and an image's bytes.
 */

export type Side = "old" | "new";

const query = (path: string, side: Side) => `path=${encodeURIComponent(path)}&side=${side}`;

export async function fetchContent(path: string, side: Side): Promise<string[]> {
  const res = await fetch(`/api/module/file/content?${query(path, side)}`);
  if (!res.ok) throw new Error(await res.text());
  return ((await res.json()) as { lines: string[] }).lines;
}

/** `version` changes on every reload, so the browser asks for the bytes again */
export const rawUrl = (path: string, side: Side, version: number) => `/api/module/file/raw?${query(path, side)}&v=${version}`;

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;

export const isImage = (path: string) => IMAGE.test(path);

export const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);
