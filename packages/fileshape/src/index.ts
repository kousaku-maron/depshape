// The server side of the fileshape module: the plain line diff of every changed file.
import type { Analyzer } from "@diffshape/core";
import { analyzeFiles } from "./analyze.js";
import { fileApi } from "./api.js";
import type { FileShapeRun } from "./types.js";

export { analyzeFiles } from "./analyze.js";
export { parseUnifiedDiff } from "./diff.js";
export type { DiffChunk, DiffFile, DiffLine, FileShapeRun, FileStatus } from "./types.js";

export const fileAnalyzer: Analyzer<FileShapeRun> = { id: "file", analyze: analyzeFiles, api: fileApi };
