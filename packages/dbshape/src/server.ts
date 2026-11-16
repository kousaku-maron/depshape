import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { startServer as serve } from "@diffshape/core";
import { analyze, type AnalyzeOptions } from "./analyze.js";

const UI_DIR = fileURLToPath(new URL("./ui/", import.meta.url));

export async function startServer(cwd: string, opts: AnalyzeOptions, host: string, preferredPort: number): Promise<{ server: Server; url: string }> {
  // Analyze once up front so CLI errors (bad revision, no schema files) surface before the browser opens.
  let cached = await analyze(cwd, opts);
  return serve({
    uiDir: UI_DIR,
    host,
    port: preferredPort,
    api: {
      "/api/diff": async (url) => {
        if (url.searchParams.get("refresh") === "1") cached = await analyze(cwd, opts);
        return cached;
      },
    },
  });
}
