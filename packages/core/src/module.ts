import type { ResolvedSources } from "./compare.js";

/*
 * The server side of a diffshape module (fileshape, depshape, dbshape): it analyzes one comparison into
 * the data its screen shows. The app resolves the comparison once and hands it to every module.
 */
// `any` by default: one list holds the analyzers of every module, each with its own data
export interface Analyzer<D = any> {
  /** Short id used in the API path and the URL ("file", "dep", "db") */
  id: string;
  analyze(sources: ResolvedSources): Promise<D>;
  /**
   * More endpoints the screen can ask for later, served at `/api/module/<id>/<name>` (say, a file's
   * whole content). Each gets the request URL, the comparison and this module's data.
   */
  api?: Record<string, (url: URL, ctx: { sources: ResolvedSources; data: D }) => Promise<unknown>>;
}

/** An endpoint's answer that is sent as it is (an image), not as JSON */
export class RawBody {
  constructor(
    readonly body: Buffer,
    readonly type: string,
  ) {}
}

/** An endpoint's answer for a request it can not serve (unknown file, bad path) */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
