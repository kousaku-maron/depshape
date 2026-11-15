// Shared between the CLI/server and the browser UI.

export type FileStatus = "added" | "removed" | "modified" | "unchanged";
export type EdgeStatus = "added" | "removed" | "unchanged";

export interface FileNode {
  /** Repo-relative path, e.g. "apps/api/internal/handler/user.go" */
  path: string;
  /** Repo-relative directory (Go package dir / the folder of a TS file) */
  dir: string;
  status: FileStatus;
  linesBefore: number | null;
  linesAfter: number | null;
  isTest: boolean;
}

export interface Edge {
  /** Importing file (repo-relative path) */
  from: string;
  /**
   * Imported package: repo-relative dir for local packages (for TS, the folder of the
   * imported files), import path / npm package name for external ones
   */
  to: string;
  external: boolean;
  status: EdgeStatus;
  /** TS: every import into this folder is `import type` / `export type` */
  typeOnly?: boolean;
  /** TS: the exact files imported in that folder, each with its own change status */
  files?: { path: string; status: EdgeStatus; typeOnly?: boolean }[];
}

export interface GoModule {
  /** Repo-relative dir containing go.mod ("" for the repo root) */
  dir: string;
  path: string;
}

export interface DiffGraph {
  repoRoot: string;
  /** Human readable labels of what is compared */
  targetLabel: string;
  baseLabel: string;
  modules: GoModule[];
  files: FileNode[];
  edges: Edge[];
  generatedAt: string;
}
