import type { ComponentType } from "react";

/*
 * The screen side of a diffshape module. The shell (packages/diffshape) loads each module's data,
 * shows the comparison, the reload and the combined AI copy in its header, and switches between the
 * modules with the icon rail; a module only draws its own view below that.
 */

/** What a module tells the shell about its review comments */
export interface CommentReport {
  /** Comments that still need attention */
  open: number;
  /** Those comments as a prompt section, without the shared header (repository, comparison) */
  prompt: () => string;
  /**
   * What an AI reviewer needs to review this module: what changed, what a comment can point at and how
   * to answer it. Left out by a module that can not place an AI's comments (yet).
   */
  review?: () => string;
}

/**
 * One comment of an AI review, as the agent answers it (the server's `ReviewItem`). A module reads
 * the fields its prompt section asked for: fileshape `path` / `side` / `line` / `endLine` / `code`,
 * the others `target`.
 */
export interface AiComment {
  /** The id of the module the comment is for ("file", "dep", "db") */
  module: string;
  body: string;
  target: string | null;
  path: string | null;
  side: "old" | "new" | null;
  line: number | null;
  endLine: number | null;
  code: string | null;
}

/** The comments of one AI review, handed to every module; `seq` tells two reviews apart */
export interface AiBatch {
  seq: number;
  /** Who wrote them, for the mark on the comment ("Claude Code") */
  agent: string;
  items: AiComment[];
}

/** What a module did with a batch: how many of its comments it placed, and how many pointed at nothing it has */
export interface AiPlaced {
  seq: number;
  placed: number;
  dropped: number;
}

/** Something another module asked this one to show (fileshape: a file path); `seq` tells two asks for the same thing apart */
export interface OpenRequest {
  target: string;
  seq: number;
}

/** The comparison a run is about; comments and reviewed marks are saved per repository and comparison */
export interface Comparison {
  repoRoot: string;
  targetLabel: string;
  baseLabel: string;
}

export interface ModuleViewProps<D> {
  data: D;
  /** Whether this module is the one shown; hidden modules stay mounted and keep their state */
  active: boolean;
  onComments: (report: CommentReport) => void;
  /** Ids of the modules in this run, so a view only offers to open what is there */
  modules: readonly string[];
  /** Switches to another module and asks it to show `target` (the URL becomes #<module>/<target>) */
  openIn: (module: string, target: string) => void;
  /** The latest ask to this module, or null; a view shows it when it arrives */
  request: OpenRequest | null;
  /** The latest AI review, or null: a module with `review` keeps the comments that are for it … */
  ai: AiBatch | null;
  /** … and says so once they are saved (after it reported its comments again) */
  onAi: (placed: AiPlaced) => void;
}

export interface ShapeModule<D = any> {
  /** Same id as the server-side analyzer ("dep", "db") */
  id: string;
  /** Short name on the rail and in the copied prompt */
  title: string;
  /** Longer description for the tooltip */
  description: string;
  icon: ComponentType<{ size?: number }>;
  View: ComponentType<ModuleViewProps<D>>;
  /** Number shown on the rail icon (how much changed), or undefined for none */
  badge?: (data: D) => number | undefined;
  /** Removes the comments and the reviewed marks saved for this comparison (--clean); called before the view mounts */
  clearReview: (c: Comparison) => void;
}
