import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, type CompareOptions } from "./analyze.js";

const UI_DIR = fileURLToPath(new URL("./ui/", import.meta.url));

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * When listening on loopback, only answer requests addressed to loopback names.
 * This stops a web page from reading the repository structure through DNS rebinding.
 */
function hostAllowed(listenHost: string, hostHeader: string | undefined): boolean {
  if (!LOOPBACK.has(listenHost)) return true; // explicitly exposed with --host
  if (!hostHeader) return false;
  try {
    return LOOPBACK.has(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

export async function startServer(
  cwd: string,
  opts: CompareOptions,
  host: string,
  preferredPort: number,
): Promise<{ server: Server; url: string }> {
  // Analyze once up front so CLI errors (bad revision etc.) surface before the browser opens.
  let cached = await analyze(cwd, opts);

  const server = createServer(async (req, res) => {
    try {
      if (!hostAllowed(host, req.headers.host)) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("forbidden host");
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/api/graph") {
        if (url.searchParams.get("refresh") === "1") cached = await analyze(cwd, opts);
        res.writeHead(200, { "content-type": MIME[".json"], "cache-control": "no-store" });
        res.end(JSON.stringify(cached));
        return;
      }
      const rel = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^([/\\])+/, "");
      if (rel.includes("..")) {
        res.writeHead(400).end();
        return;
      }
      const body = await readFile(join(UI_DIR, rel)).catch(() => null);
      if (!body) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": MIME[extname(rel)] ?? "application/octet-stream" });
      res.end(body);
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(e instanceof Error ? e.message : String(e));
    }
  });

  const port = await listen(server, host, preferredPort);
  return { server, url: `http://${host}:${port}` };
}

function listen(server: Server, host: string, port: number, attempts = 20): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (err.code === "EADDRINUSE" && attempts > 1) {
        resolve(listen(server, host, port + 1, attempts - 1));
      } else {
        reject(err);
      }
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}
