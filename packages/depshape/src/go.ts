// Minimal Go source understanding: module paths from go.mod and import paths from .go files.
// We deliberately avoid needing the Go toolchain so any git revision can be analyzed
// straight from git objects.

export function parseGoModModulePath(content: string): string | null {
  for (const raw of content.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    const m = /^module\s+("?)([^\s"]+)\1$/.exec(line);
    if (m) return m[2];
  }
  return null;
}

type Token =
  | { kind: "ident"; value: string }
  | { kind: "string"; value: string }
  | { kind: "punct"; value: string };

/**
 * Lazily tokenizes Go source, skipping whitespace and comments.
 * Only what is needed for the package clause and import declarations is supported.
 */
function* tokenize(src: string): Generator<Token> {
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let value = "";
      while (j < n && src[j] !== '"' && src[j] !== "\n") {
        if (src[j] === "\\") {
          value += src[j + 1] ?? "";
          j += 2;
        } else {
          value += src[j];
          j++;
        }
      }
      i = j + 1;
      yield { kind: "string", value };
      continue;
    }
    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      const value = src.slice(i + 1, end === -1 ? n : end);
      i = end === -1 ? n : end + 1;
      yield { kind: "string", value };
      continue;
    }
    if (/[A-Za-z_\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_\u0080-￿]/.test(src[j])) j++;
      yield { kind: "ident", value: src.slice(i, j) };
      i = j;
      continue;
    }
    yield { kind: "punct", value: c };
    i++;
  }
}

/** Returns the import paths declared in a Go source file. */
export function parseGoImports(src: string): string[] {
  const tokens = tokenize(src);
  const next = () => {
    const r = tokens.next();
    return r.done ? null : r.value;
  };

  // package clause
  let t = next();
  if (!t || t.kind !== "ident" || t.value !== "package") return [];
  t = next(); // package name
  if (!t) return [];

  const imports: string[] = [];
  t = next();
  while (t) {
    if (t.kind === "punct" && t.value === ";") {
      t = next();
      continue;
    }
    if (!(t.kind === "ident" && t.value === "import")) break;
    t = next();
    if (!t) break;
    if (t.kind === "punct" && t.value === "(") {
      t = next();
      while (t && !(t.kind === "punct" && t.value === ")")) {
        if (t.kind === "string") imports.push(t.value);
        t = next();
      }
      t = next();
      continue;
    }
    // single spec: [name|.|_] "path"
    if (t.kind !== "string") t = next();
    if (t && t.kind === "string") imports.push(t.value);
    t = next();
  }
  return imports;
}

/** Standard library packages have no dot in their first path element. */
export function isStdlib(importPath: string): boolean {
  const first = importPath.split("/")[0];
  return !first.includes(".");
}
