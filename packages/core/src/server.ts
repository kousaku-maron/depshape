import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";
import { HttpError, RawBody } from "./module.js";

/*
 * The local server each tool runs: the built UI as static files plus a few JSON endpoints.
 * It listens on 127.0.0.1 by default and only answers requests addressed to a loopback name.
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * When listening on loopback, only answer requests addressed to loopback names.
 * This stops a web page from reading the repository structure through DNS rebinding.
 */
export function hostAllowed(listenHost: string, hostHeader: string | undefined): boolean {
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

export interface ServeOptions {
  /** Folder of the built UI (index.html and assets) */
  uiDir: string;
  host: string;
  /** First port to try; the next ones are tried while it is in use */
  port: number;
  /** JSON endpoints by path, e.g. { "/api/graph": (url) => analyze(...) } */
  api: Record<string, (url: URL) => Promise<unknown>>;
}

export async function startServer(opts: ServeOptions): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    try {
      if (!hostAllowed(opts.host, req.headers.host)) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("forbidden host");
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const handler = opts.api[url.pathname];
      if (handler) {
        const body = await handler(url);
        if (body instanceof RawBody) {
          // repository files (an SVG can hold scripts): never run anything, even when opened on its own
          res.writeHead(200, { "content-type": body.type, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
          res.end(body.body);
          return;
        }
        res.writeHead(200, { "content-type": MIME[".json"], "cache-control": "no-store" });
        res.end(JSON.stringify(body));
        return;
      }
      const rel = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^([/\\])+/, "");
      if (rel.includes("..")) {
        res.writeHead(400).end();
        return;
      }
      const body = await readFile(join(opts.uiDir, rel)).catch(() => null);
      if (!body) {
        res.writeHead(404).end("not found");
        return;
      }
      // index.html names the hashed assets of the current build, so it is always checked again
      const cache = rel === "index.html" ? { "cache-control": "no-cache" } : {};
      res.writeHead(200, { "content-type": MIME[extname(rel)] ?? "application/octet-stream", ...cache });
      res.end(body);
    } catch (e) {
      res.writeHead(e instanceof HttpError ? e.status : 500, { "content-type": "text/plain; charset=utf-8" });
      res.end(e instanceof Error ? e.message : String(e));
    }
  });

  const port = await listen(server, opts.host, opts.port);
  return { server, url: `http://${opts.host}:${port}` };
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

export function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const cmdArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, cmdArgs, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}
