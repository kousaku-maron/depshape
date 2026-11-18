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
}

/** Something another module asked this one to show (fileshape: a file path); `seq` tells two asks for the same thing apart */
export interface OpenRequest {
  target: string;
  seq: number;
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
}
