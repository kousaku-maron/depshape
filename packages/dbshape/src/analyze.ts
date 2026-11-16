import { posix } from "node:path";
import { listFiles, readFiles, resolveSources, type CompareOptions, type ResolvedSources, type Source } from "@diffshape/core";
import { loadModule, parseSync } from "libpg-query";
import { diffSchemas } from "./diff.js";
import { erTables } from "./er.js";
import type { DbShapeResult, DbShapeRun, SchemaFrom, SourceLocation } from "./model.js";
import { buildSchema, schemaLocations, type Schema, type SqlFile } from "./schema.js";
import { atlasConfigs, atlasDatabases, matchGlobs, schemaPatterns } from "./sources.js";

export type { CompareOptions } from "@diffshape/core";

export interface SchemaOptions {
  /** Glob patterns of schema files ("name=glob" for several databases); when empty, the `src` of every atlas.hcl is used */
  schema?: string[];
}

export interface AnalyzeOptions extends CompareOptions, SchemaOptions {}

/** One database found on one side: its schema files in the order Atlas (or the sorted glob) gives them */
interface Database {
  id: string;
  name: string;
  files: string[];
  schemaFrom: SchemaFrom;
}

const dirName = (config: string) => (posix.dirname(config) === "." ? "(ルート)" : posix.dirname(config));

/** The databases on one side: one per group of envs in each atlas.hcl, or one per --schema name */
async function findDatabases(root: string, source: Source, opts: SchemaOptions): Promise<Database[]> {
  const all = await listFiles(root, source);
  if (opts.schema?.length) {
    return [...schemaPatterns(opts.schema)].map(([name, globs]) => ({
      id: `schema:${name}`,
      name: name || globs.join(" "),
      files: matchGlobs(globs, all),
      schemaFrom: { kind: "option", patterns: globs },
    }));
  }
  const configs = atlasConfigs(all);
  const contents = await readFiles(root, source, configs);
  const out: Database[] = [];
  for (const c of configs) {
    const groups = atlasDatabases(c, contents.get(c) ?? "", all);
    for (const g of groups) {
      // several databases in one file: tell them apart by their envs
      const several = groups.length > 1;
      const envs = g.envs.filter(Boolean);
      out.push({
        id: several ? `${c}#${[...g.envs].sort().join(",")}` : c,
        name: several && envs.length ? `${dirName(c)}（${envs.join(", ")}）` : dirName(c),
        files: g.files,
        schemaFrom: { kind: "atlas", configs: [c], ...(envs.length && { envs }) },
      });
    }
  }
  return out;
}

async function readSide(root: string, source: Source, files: string[]): Promise<SqlFile[]> {
  const contents = await readFiles(root, source, files);
  return files.filter((f) => contents.has(f)).map((f) => ({ path: f, sql: contents.get(f)! }));
}

let loaded: Promise<void> | undefined;

/** Loads the PostgreSQL parser (WebAssembly) once. */
export async function parser(): Promise<(sql: string) => unknown> {
  loaded ??= loadModule();
  await loaded;
  return parseSync;
}

function ignoredList(s: Schema) {
  return [...s.ignored].map(([statement, count]) => ({ statement, count })).sort((a, b) => b.count - a.count || a.statement.localeCompare(b.statement));
}

/** Definition places on the target side, plus the base side for what was removed */
export function locations(before: Schema, after: Schema): Record<string, SourceLocation> {
  const out: Record<string, SourceLocation> = {};
  for (const [k, l] of schemaLocations(after)) out[k] = { file: l.file, line: l.line };
  for (const [k, l] of schemaLocations(before)) if (!(k in out)) out[k] = { file: l.file, line: l.line, base: true };
  return out;
}

export async function analyze(cwd: string, opts: AnalyzeOptions): Promise<DbShapeRun> {
  return analyzeSources(await resolveSources(cwd, opts), opts);
}

/** The schema diff of every database in one resolved comparison */
export async function analyzeSources({ root, target, base, targetLabel, baseLabel }: ResolvedSources, opts: SchemaOptions = {}): Promise<DbShapeRun> {
  const [t, b] = await Promise.all([findDatabases(root, target, opts), findDatabases(root, base, opts)]);
  // a database is matched by id on the two sides; a file added or removed in the change is read on both
  // sides (and is simply missing on one)
  const ids = [...new Set([...t.map((d) => d.id), ...b.map((d) => d.id)])];
  const pairs = ids.map((id) => {
    const after = t.find((d) => d.id === id);
    const before = b.find((d) => d.id === id);
    const main = (after ?? before)!;
    const files = [...(after?.files ?? []), ...(before?.files ?? []).filter((f) => !after?.files.includes(f))];
    return { ...main, files };
  });
  if (pairs.every((p) => p.files.length === 0)) {
    throw new Error(
      opts.schema?.length
        ? `--schema に一致する SQL ファイルがありません（${opts.schema.join(", ")}）`
        : "スキーマの SQL ファイルが見つかりません。atlas.hcl の src を読めなかったので、--schema 'db/**/*.sql' のように指定してください",
    );
  }
  const parse = await parser();
  const generatedAt = new Date().toISOString();
  const databases = await Promise.all(
    pairs
      .filter((p) => p.files.length > 0)
      .sort((x, y) => x.name.localeCompare(y.name))
      .map(async (db): Promise<DbShapeResult> => {
        const [afterFiles, beforeFiles] = await Promise.all([readSide(root, target, db.files), readSide(root, base, db.files)]);
        const after = buildSchema(afterFiles, parse);
        const before = buildSchema(beforeFiles, parse);
        const diff = diffSchemas(before, after);
        const warnings: string[] = [];
        for (const [side, s] of [
          ["比較元", before],
          ["変更後", after],
        ] as const) {
          for (const [file, err] of s.errors) warnings.push(`${side}の ${file} を解析できませんでした（このファイルのテーブルは比較から外しています）: ${err}`);
        }
        warnings.push(...after.notes.map((n) => `変更後: ${n}`), ...before.notes.map((n) => `比較元: ${n}`));
        return {
          database: { id: db.id, name: db.name },
          repoRoot: root,
          generatedAt,
          base: { label: baseLabel, files: beforeFiles.map((f) => f.path) },
          target: { label: targetLabel, files: afterFiles.map((f) => f.path) },
          schemaFrom: db.schemaFrom,
          diff,
          er: erTables(before, after, diff),
          locations: locations(before, after),
          ignored: ignoredList(after),
          warnings,
        };
      }),
  );
  return { repoRoot: root, generatedAt, targetLabel, baseLabel, databases };
}
