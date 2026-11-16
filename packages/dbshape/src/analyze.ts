import { listFiles, readFiles, resolveSources, type CompareOptions, type Source } from "@diffshape/core";
import { loadModule, parseSync } from "libpg-query";
import { diffSchemas } from "./diff.js";
import type { DbShapeResult } from "./model.js";
import { buildSchema, type Schema, type SqlFile } from "./schema.js";
import { atlasConfigs, atlasSources, expandSource, matchGlobs } from "./sources.js";

export type { CompareOptions } from "@diffshape/core";

export interface AnalyzeOptions extends CompareOptions {
  /** Glob patterns of schema files; when empty, the `src` of atlas.hcl is used */
  schema?: string[];
}

interface SideFiles {
  files: string[];
  configs: string[];
}

/** The schema files on one side, in the order Atlas (or the sorted glob) gives them. */
async function schemaFiles(root: string, source: Source, opts: AnalyzeOptions): Promise<SideFiles> {
  const all = await listFiles(root, source);
  if (opts.schema?.length) return { files: matchGlobs(opts.schema, all), configs: [] };
  const configs = atlasConfigs(all);
  const contents = await readFiles(root, source, configs);
  const files: string[] = [];
  for (const c of configs) {
    for (const src of atlasSources(c, contents.get(c) ?? "")) {
      for (const f of expandSource(src, all)) if (!files.includes(f)) files.push(f);
    }
  }
  return { files, configs };
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

export async function analyze(cwd: string, opts: AnalyzeOptions): Promise<DbShapeResult> {
  const { root, target, base, targetLabel, baseLabel } = await resolveSources(cwd, opts);
  const [t, b] = await Promise.all([schemaFiles(root, target, opts), schemaFiles(root, base, opts)]);
  // a file added or removed in the change is read on both sides (and is simply missing on one)
  const files = [...t.files, ...b.files.filter((f) => !t.files.includes(f))];
  if (files.length === 0) {
    throw new Error(
      opts.schema?.length
        ? `--schema に一致する SQL ファイルがありません（${opts.schema.join(", ")}）`
        : "スキーマの SQL ファイルが見つかりません。atlas.hcl の src を読めなかったので、--schema 'db/**/*.sql' のように指定してください",
    );
  }
  const parse = await parser();
  const [afterFiles, beforeFiles] = await Promise.all([readSide(root, target, files), readSide(root, base, files)]);
  const after = buildSchema(afterFiles, parse);
  const before = buildSchema(beforeFiles, parse);

  const warnings: string[] = [];
  for (const [side, s] of [["比較元", before], ["変更後", after]] as const) {
    for (const [file, err] of s.errors) warnings.push(`${side}の ${file} を解析できませんでした（このファイルのテーブルは比較から外しています）: ${err}`);
  }
  warnings.push(...after.notes.map((n) => `変更後: ${n}`), ...before.notes.map((n) => `比較元: ${n}`));

  return {
    repoRoot: root,
    generatedAt: new Date().toISOString(),
    base: { label: baseLabel, files: beforeFiles.map((f) => f.path) },
    target: { label: targetLabel, files: afterFiles.map((f) => f.path) },
    schemaFrom: opts.schema?.length ? { kind: "option", patterns: opts.schema } : { kind: "atlas", configs: [...new Set([...t.configs, ...b.configs])] },
    diff: diffSchemas(before, after),
    ignored: ignoredList(after),
    warnings,
  };
}
