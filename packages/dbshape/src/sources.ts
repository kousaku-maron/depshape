import { posix } from "node:path";

/*
 * Which files hold the schema. Either the `src` of an Atlas project file (atlas.hcl), read as text
 * without running Atlas, or glob patterns given with --schema.
 */

/** `file://` paths listed in the `src` attributes of an atlas.hcl, relative to the repo root. */
export function atlasSources(configPath: string, content: string): string[] {
  const dir = posix.dirname(configPath);
  const out: string[] = [];
  // drop comments so a commented-out src does not count
  const text = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])(#|\/\/).*$/gm, "$1");
  for (const m of text.matchAll(/\bsrc\s*=\s*(\[[^\]]*\]|"[^"]*")/g)) {
    for (const f of m[1].matchAll(/"file:\/\/([^"]+)"/g)) {
      const p = posix.normalize(posix.join(dir === "." ? "" : dir, f[1])).replace(/^\.\//, "").replace(/\/$/, "");
      if (!out.includes(p)) out.push(p);
    }
  }
  return out;
}

/** atlas.hcl files in the repo (outside node_modules and hidden folders). */
export function atlasConfigs(files: string[]): string[] {
  return files.filter((f) => {
    const segs = f.split("/");
    return segs.at(-1) === "atlas.hcl" && !segs.some((s) => s === "node_modules" || (s.startsWith(".") && s.length > 1));
  });
}

/**
 * The .sql files an Atlas `src` path stands for: the file itself, or the .sql files directly in that
 * folder (like Atlas does), in name order.
 */
export function expandSource(src: string, files: string[]): string[] {
  if (files.includes(src)) return src.endsWith(".sql") ? [src] : [];
  const prefix = `${src}/`;
  return files.filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes("/") && f.endsWith(".sql")).sort();
}

/** A glob (`*`, `**`, `?`, `{a,b}`) as a regular expression over repo-relative paths. */
export function globRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += `(?:${glob
          .slice(i + 1, end)
          .split(",")
          .map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
          .join("|")})`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchGlobs(patterns: string[], files: string[]): string[] {
  const res = patterns.map((p) => globRegex(p.replace(/^\.\//, "")));
  return files.filter((f) => res.some((r) => r.test(f))).sort();
}
