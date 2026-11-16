import { posix } from "node:path";

/*
 * Which files hold the schema. Either the `src` of an Atlas project file (atlas.hcl), read as text
 * without running Atlas, or glob patterns given with --schema.
 */

/** An atlas.hcl without comments, so a commented-out src does not count */
const stripComments = (content: string) => content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])(#|\/\/).*$/gm, "$1");

/** `file://` paths in the `src` attributes of a piece of atlas.hcl, relative to the repo root. */
function srcPaths(configPath: string, text: string): string[] {
  const dir = posix.dirname(configPath);
  const out: string[] = [];
  for (const m of text.matchAll(/\bsrc\s*=\s*(\[[^\]]*\]|"[^"]*")/g)) {
    for (const f of m[1].matchAll(/"file:\/\/([^"]+)"/g)) {
      const p = posix
        .normalize(posix.join(dir === "." ? "" : dir, f[1]))
        .replace(/^\.\//, "")
        .replace(/\/$/, "");
      if (!out.includes(p)) out.push(p);
    }
  }
  return out;
}

/** `file://` paths listed in the `src` attributes of an atlas.hcl (every env), relative to the repo root. */
export function atlasSources(configPath: string, content: string): string[] {
  return srcPaths(configPath, stripComments(content));
}

export interface AtlasEnv {
  /** The env's name ("" for a src outside any env block) */
  name: string;
  sources: string[];
}

/** The `src` of each `env` block of an atlas.hcl (a src outside the env blocks counts as env ""). */
export function atlasEnvs(configPath: string, content: string): AtlasEnv[] {
  const text = stripComments(content);
  const envs: AtlasEnv[] = [];
  let outside = "";
  let last = 0;
  for (const m of text.matchAll(/\benv\s*(?:"([^"]*)"\s*)?\{/g)) {
    const start = m.index!;
    if (start < last) continue; // inside the previous block
    // the block runs to its matching brace
    let depth = 0;
    let end = start + m[0].length - 1;
    for (; end < text.length; end++) {
      if (text[end] === "{") depth++;
      else if (text[end] === "}" && --depth === 0) break;
    }
    outside += text.slice(last, start);
    envs.push({ name: m[1] ?? "", sources: srcPaths(configPath, text.slice(start, end + 1)) });
    last = end + 1;
  }
  outside += text.slice(last);
  const top = srcPaths(configPath, outside);
  if (top.length) envs.unshift({ name: "", sources: top });
  return envs.filter((e) => e.sources.length > 0);
}

/**
 * The databases one atlas.hcl describes: envs whose schema files overlap are the same database (dev /
 * ci / prod usually share the src), envs with separate files are separate databases.
 */
export function atlasDatabases(configPath: string, content: string, files: string[]): { envs: string[]; files: string[] }[] {
  const groups: { envs: string[]; files: string[] }[] = [];
  for (const env of atlasEnvs(configPath, content)) {
    const own: string[] = [];
    for (const src of env.sources) for (const f of expandSource(src, files)) if (!own.includes(f)) own.push(f);
    if (!own.length) continue;
    // merge with every group that shares a file
    const shared = groups.filter((g) => g.files.some((f) => own.includes(f)));
    const merged = { envs: [...shared.flatMap((g) => g.envs), env.name], files: [...shared.flatMap((g) => g.files)] };
    for (const f of own) if (!merged.files.includes(f)) merged.files.push(f);
    for (const g of shared) groups.splice(groups.indexOf(g), 1);
    groups.push(merged);
  }
  return groups;
}

/** `--schema name=glob` (or a plain glob, which goes to the unnamed database "") */
export function schemaPatterns(patterns: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of patterns) {
    const m = /^([\w.-]+)=(.+)$/.exec(p);
    const [name, glob] = m ? [m[1], m[2]] : ["", p];
    out.set(name, [...(out.get(name) ?? []), glob]);
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
