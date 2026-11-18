/*
 * Reads git's patch into files, chunks and lines. A file starts at "diff --git"; its paths come from the
 * rename / --- / +++ lines (or the "diff --git" line for binary and mode-only changes), then each @@ hunk
 * gives its lines with their numbers on both sides.
 */

import type { DiffChunk, DiffFile, DiffLine, FileStatus } from "./types.js";

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  for (const block of text.split(/^diff --git /m).slice(1)) {
    const file = parseFileBlock(`diff --git ${block}`);
    if (file) files.push(file);
  }
  return files;
}

function parseFileBlock(block: string): DiffFile | null {
  const lines = block.split("\n");
  // the extended header ends at the first hunk
  const firstHunk = lines.findIndex((l) => l.startsWith("@@"));
  const head = firstHunk === -1 ? lines : lines.slice(0, firstHunk);
  const find = (prefix: string) => head.find((l) => l.startsWith(prefix));

  const minus = find("--- ");
  const plus = find("+++ ");
  const fromHeader = parseHeaderPaths(lines[0]);
  const newPath = pathAfter(find("rename to "), "rename to ", false) ?? pathAfter(plus, "+++ ") ?? fromHeader?.newPath;
  const oldPath = pathAfter(find("rename from "), "rename from ", false) ?? pathAfter(minus, "--- ") ?? fromHeader?.oldPath;
  const path = newPath ?? oldPath;
  if (!path) return null;

  let status: FileStatus = "modified";
  if (find("new file mode") || minus === "--- /dev/null") status = "added";
  else if (find("deleted file mode") || plus === "+++ /dev/null") status = "removed";
  else if (oldPath && oldPath !== path) status = "renamed";

  const chunks = firstHunk === -1 ? [] : parseChunks(lines.slice(firstHunk));
  let additions = 0;
  let deletions = 0;
  for (const c of chunks)
    for (const l of c.lines) {
      if (l.type === "add") additions++;
      else if (l.type === "delete") deletions++;
    }

  const file: DiffFile = { path, status, additions, deletions, chunks };
  if (status === "renamed") file.oldPath = oldPath;
  if (head.some((l) => l.startsWith("Binary files ") || l === "GIT binary patch")) file.binary = true;
  const oldMode = find("old mode ")?.slice(9);
  const newMode = find("new mode ")?.slice(9);
  if (oldMode && newMode) file.modeChange = `${oldMode} → ${newMode}`;
  return file;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function parseChunks(lines: string[]): DiffChunk[] {
  const chunks: DiffChunk[] = [];
  let chunk: DiffChunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of lines) {
    if (raw.startsWith("@@")) {
      const m = raw.match(HUNK);
      if (!m) continue;
      oldLine = Number(m[1]);
      newLine = Number(m[3]);
      chunk = { section: m[5].trim(), oldStart: oldLine, oldLines: Number(m[2] ?? "1"), newStart: newLine, newLines: Number(m[4] ?? "1"), lines: [] };
      chunks.push(chunk);
      continue;
    }
    if (!chunk) continue;
    const sign = raw[0];
    // "\ No newline at end of file" and the empty string after the last newline
    if (sign !== "+" && sign !== "-" && sign !== " ") continue;
    const content = raw.slice(1).replace(/\r$/, "");
    let line: DiffLine;
    if (sign === "+") line = { type: "add", content, newLine: newLine++ };
    else if (sign === "-") line = { type: "delete", content, oldLine: oldLine++ };
    else line = { type: "normal", content, oldLine: oldLine++, newLine: newLine++ };
    chunk.lines.push(line);
  }
  return chunks;
}

/** One chunk with every line of a new file, for files git does not know yet (untracked) */
export function addedFile(path: string, content: string): DiffFile {
  if (content.includes("\0")) return { path, status: "added", additions: 0, deletions: 0, chunks: [], binary: true };
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const chunks: DiffChunk[] = lines.length
    ? [{ section: "", oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l, i) => ({ type: "add", content: l.replace(/\r$/, ""), newLine: i + 1 })) }]
    : [];
  return { path, status: "added", additions: lines.length, deletions: 0, chunks };
}

// ---- paths

function pathAfter(line: string | undefined, prefix: string, stripPrefix = true): string | undefined {
  return line?.startsWith(prefix) ? decodeGitPath(line.slice(prefix.length), stripPrefix) : undefined;
}

/** The two paths of "diff --git a/x b/y" (used when there are no ---/+++ lines: binary, mode only) */
function parseHeaderPaths(header: string): { oldPath?: string; newPath?: string } | null {
  const raw = header.slice("diff --git ".length);
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"' && raw[i - 1] !== "\\") quoted = !quoted;
    if (ch === " " && !quoted) {
      if (cur) parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) parts.push(cur);
  if (parts.length !== 2) {
    // unquoted paths with spaces: "a/x y b/x y" splits evenly when both sides are the same path
    const m = raw.match(/^a\/(.+) b\/\1$/);
    return m ? { oldPath: m[1], newPath: m[1] } : null;
  }
  return { oldPath: decodeGitPath(parts[0]), newPath: decodeGitPath(parts[1]) };
}

const ESCAPES: Record<string, number> = { t: 0x09, n: 0x0a, r: 0x0d, b: 0x08, f: 0x0c, v: 0x0b, a: 0x07, "\\": 0x5c, '"': 0x22 };

/** A path as git prints it: maybe quoted with C escapes (octal bytes for non-ASCII), with an a/ b/ prefix */
export function decodeGitPath(raw: string, stripPrefix = true): string | undefined {
  const tab = raw.indexOf("\t");
  let s = tab === -1 ? raw : raw.slice(0, tab);
  const quoted = s.startsWith('"') && s.endsWith('"') && s.length >= 2;
  if (quoted) s = s.slice(1, -1);
  if (stripPrefix && (s.startsWith("a/") || s.startsWith("b/"))) s = s.slice(2);
  if (s === "/dev/null" || s === "dev/null") return undefined;
  if (!quoted) return s;
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length) {
      const oct = s.slice(i + 1).match(/^[0-7]{1,3}/);
      if (oct) {
        bytes.push(parseInt(oct[0], 8));
        i += oct[0].length;
        continue;
      }
      const next = s[i + 1];
      if (next in ESCAPES) bytes.push(ESCAPES[next]);
      else bytes.push(...Buffer.from(next, "utf8"));
      i++;
      continue;
    }
    bytes.push(...Buffer.from(ch, "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}
