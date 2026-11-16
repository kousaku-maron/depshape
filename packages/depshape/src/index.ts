// The server side of the depshape module: Go / TypeScript dependency diffs.
import type { Analyzer } from "@diffshape/core";
import { analyzeSources } from "./analyze.js";
import type { DiffGraph } from "./types.js";

export { analyze, analyzeSources, fileKind } from "./analyze.js";
export type { DiffGraph } from "./types.js";

export const depAnalyzer: Analyzer<DiffGraph> = { id: "dep", analyze: analyzeSources };
