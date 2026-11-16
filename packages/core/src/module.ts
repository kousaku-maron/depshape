import type { ResolvedSources } from "./compare.js";

/**
 * The server side of a diffshape module (depshape, dbshape): it analyzes one comparison into the data
 * its screen shows. The app resolves the comparison once and hands it to every module.
 */
export interface Analyzer<D = unknown> {
  /** Short id used in the API path and the URL ("dep", "db") */
  id: string;
  analyze(sources: ResolvedSources): Promise<D>;
}
