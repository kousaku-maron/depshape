import Prism from "prismjs";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-go";
import "prismjs/components/prism-python";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-java";
import "prismjs/components/prism-kotlin";
import "prismjs/components/prism-swift";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-markup-templating";
import "prismjs/components/prism-php";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-scss";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-hcl";
import "prismjs/components/prism-graphql";
import "prismjs/components/prism-protobuf";
import "prismjs/components/prism-ini";
import "prismjs/components/prism-makefile";
import "prismjs/components/prism-lua";
import "prismjs/components/prism-dart";
import type { DiffChunk, DiffFile } from "../../src/types";

/*
 * Syntax highlighting with Prism. Each side of a chunk is tokenized as one text (so a block
 * comment or a template string over several lines stays right inside the chunk), then cut back into
 * lines. A token is its Prism types ("keyword", "string") and its text.
 */

export interface Token {
  types: string;
  text: string;
}

const BY_EXT: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  go: "go",
  py: "python",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  json: "json",
  jsonc: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  md: "markdown",
  mdx: "markdown",
  css: "css",
  scss: "scss",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  vue: "markup",
  hcl: "hcl",
  tf: "hcl",
  graphql: "graphql",
  gql: "graphql",
  proto: "protobuf",
  ini: "ini",
  lua: "lua",
  dart: "dart",
};

const BY_NAME: Record<string, string> = { Dockerfile: "docker", Makefile: "makefile", GNUmakefile: "makefile", ".env": "bash" };

export function languageOf(path: string): string | undefined {
  const name = path.split("/").pop() ?? "";
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.startsWith("Dockerfile")) return "docker";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const lang = BY_EXT[ext];
  return lang && Prism.languages[lang] ? lang : undefined;
}

/** Lines of text → tokens per line */
export function highlightLines(lines: string[], lang: string): Token[][] {
  const grammar = Prism.languages[lang];
  if (!grammar) return lines.map((text) => [{ types: "", text }]);
  const out: Token[][] = [[]];
  const push = (types: string, text: string) => {
    const parts = text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) out.push([]);
      if (part) out[out.length - 1].push({ types, text: part });
    });
  };
  const walk = (tokens: (string | Prism.Token)[], types: string) => {
    for (const t of tokens) {
      if (typeof t === "string") push(types, t);
      else {
        const own = [t.type, ...(t.alias ? (Array.isArray(t.alias) ? t.alias : [t.alias]) : [])].join(" ");
        const all = types ? `${types} ${own}` : own;
        if (typeof t.content === "string") push(all, t.content);
        else walk(Array.isArray(t.content) ? t.content : [t.content], all);
      }
    }
  };
  walk(Prism.tokenize(lines.join("\n"), grammar), "");
  while (out.length < lines.length) out.push([]);
  return out;
}

/** Files larger than this are shown without colors (tokenizing them would slow the page down) */
const MAX_LINES = 5000;
const MAX_LINE_LENGTH = 1000;

/**
 * Tokens for each line of a file, keyed "old:<n>" / "new:<n>"; undefined when it is not highlighted.
 * With the whole target-side content (once lines around a hunk were opened), that side is tokenized as
 * one text, which also gets a construct that started before the hunk right.
 */
export function highlightFile(file: DiffFile, content?: string[]): Map<string, Token[]> | undefined {
  const lang = languageOf(file.path);
  if (!lang) return undefined;
  let total = 0;
  for (const c of file.chunks) for (const l of c.lines) if (++total > MAX_LINES || l.content.length > MAX_LINE_LENGTH) return undefined;
  const map = new Map<string, Token[]>();
  for (const c of file.chunks) side(c, "old", lang, map), side(c, "new", lang, map);
  if (content && content.length <= MAX_LINES && content.every((l) => l.length <= MAX_LINE_LENGTH)) {
    highlightLines(content, lang).forEach((t, i) => map.set(`new:${i + 1}`, t));
  }
  return map;
}

function side(chunk: DiffChunk, which: "old" | "new", lang: string, map: Map<string, Token[]>) {
  const lines = chunk.lines.filter((l) => l.type === "normal" || l.type === (which === "old" ? "delete" : "add"));
  if (!lines.length) return;
  const tokens = highlightLines(
    lines.map((l) => l.content),
    lang,
  );
  lines.forEach((l, i) => map.set(`${which}:${which === "old" ? l.oldLine : l.newLine}`, tokens[i]));
}

/** Tokens of a code block (a Markdown preview), when Prism knows its language ("ts", "go", "sh"...) */
export function highlightCode(text: string, lang: string | undefined): Token[][] | undefined {
  const name = lang?.toLowerCase();
  if (!name || !Prism.languages[name] || text.length > 100_000) return undefined;
  return highlightLines(text.split("\n"), name);
}
