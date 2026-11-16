// The server side of the dbshape module: PostgreSQL schema diffs read from the SQL files in the repo.
import type { Analyzer } from "@diffshape/core";
import { analyzeSources, type SchemaOptions } from "./analyze.js";
import type { DbShapeRun } from "./model.js";

export { analyze, analyzeSources, type AnalyzeOptions, type SchemaOptions } from "./analyze.js";
export { COLORS, formatRunSummary, formatSummary, PLAIN } from "./format.js";
export type { DbShapeResult, DbShapeRun } from "./model.js";

export const dbAnalyzer = (opts: SchemaOptions = {}): Analyzer<DbShapeRun> => ({ id: "db", analyze: (s) => analyzeSources(s, opts) });
