/*
 * The data of the fileshape module: the line diff of every changed file, as files, chunks and lines.
 * Shared by the server and the screen.
 */

/** How a file changed. "removed" (not "deleted") like the other modules' counts */
export type FileStatus = "added" | "modified" | "removed" | "renamed";

export interface DiffLine {
  /** "normal" is a context line, the same on both sides */
  type: "add" | "delete" | "normal";
  content: string;
  /** Line number on the base side (not for added lines) */
  oldLine?: number;
  /** Line number on the target side (not for deleted lines) */
  newLine?: number;
}

export interface DiffChunk {
  /** The text after the second "@@" (the enclosing function, when git finds one) */
  section: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  /** Path on the target side (the base side for a removed file) */
  path: string;
  /** Path on the base side, for a renamed file */
  oldPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  chunks: DiffChunk[];
  /** git shows no lines for it */
  binary?: boolean;
  /** An untracked file too large to show */
  large?: boolean;
  /** Lock files, build output, linguist-generated: folded at first */
  generated?: boolean;
  /** Only the file mode changed, e.g. "100644 → 100755" */
  modeChange?: string;
}

export interface FileShapeRun {
  repoRoot: string;
  targetLabel: string;
  baseLabel: string;
  files: DiffFile[];
}
