import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { startServer as serve } from "@diffshape/core";
import type { App } from "./app.js";

const UI_DIR = fileURLToPath(new URL("./ui/", import.meta.url));

/**
 * The app's local server: the shell UI, `/api/info` (the comparison and the modules; `?refresh=1`
 * re-reads the repository and starts every module again), `/api/module/<id>` (one module's data) and
 * `/api/module/<id>/<name>` (a module's own endpoints, such as a file's content).
 */
export function startServer(app: App, host: string, port: number): Promise<{ server: Server; url: string }> {
  const api: Record<string, (url: URL) => Promise<unknown>> = {
    "/api/info": async (url) => (url.searchParams.get("refresh") === "1" ? app.refresh() : app.info()),
  };
  for (const a of app.analyzers) {
    api[`/api/module/${a.id}`] = () => app.result(a.id);
    for (const name of Object.keys(a.api ?? {})) api[`/api/module/${a.id}/${name}`] = (url) => app.call(a.id, name, url);
  }
  return serve({ uiDir: UI_DIR, host, port, api });
}
