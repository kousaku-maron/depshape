import { useEffect, useState } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DiffFile } from "../../src/types";
import { fetchContent, rawUrl, type Side } from "./api";
import { highlightCode } from "./highlight";

/*
 * A Markdown file rendered: the target side, or both sides in the split view.
 * Raw HTML in the file is not rendered. Images with a path in the repository are read from the same
 * side of the comparison.
 */

export function MarkdownPreview({ file, split, version }: { file: DiffFile; split: boolean; version: number }) {
  const sides: Side[] = file.status === "added" ? ["new"] : file.status === "removed" ? ["old"] : split ? ["old", "new"] : ["new"];
  return (
    <div className={`fs-md-sides n${sides.length}`}>
      {sides.map((side) => (
        <MarkdownSide key={side} side={side} path={side === "old" ? (file.oldPath ?? file.path) : file.path} diffPath={file.path} version={version} labelled={sides.length > 1} />
      ))}
    </div>
  );
}

function MarkdownSide({ side, path, diffPath, version, labelled }: { side: Side; path: string; diffPath: string; version: number; labelled: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setError(null);
    fetchContent(diffPath, side).then(
      (lines) => live && setText(lines.join("\n")),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [diffPath, side, version]);

  const components: Components = {
    a: ({ href, children }) =>
      href && /^(https?:|mailto:)/i.test(href) ? (
        <a href={href} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      ) : (
        <span className="fs-md-link" title={href}>
          {children}
        </span>
      ),
    code: ({ className, children }) => {
      const lang = /language-([\w+-]+)/.exec(className ?? "")?.[1];
      const src = String(children ?? "").replace(/\n$/, "");
      const lines = lang ? highlightCode(src, lang) : undefined;
      if (!lines) return <code className={className}>{children}</code>;
      return (
        <code className={className}>
          {lines.map((line, i) => (
            <span key={i}>
              {line.map((t, j) =>
                t.types ? (
                  <span key={j} className={`token ${t.types}`}>
                    {t.text}
                  </span>
                ) : (
                  t.text
                ),
              )}
              {i < lines.length - 1 && "\n"}
            </span>
          ))}
        </code>
      );
    },
  };

  return (
    <div className={`fs-md-side ${side}`}>
      {labelled && <div className={`fs-image-side ${side}`}>{side === "old" ? "変更前" : "変更後"}</div>}
      {error ? (
        <div className="ds-muted">読み込めませんでした: {error}</div>
      ) : text === null ? (
        <div className="ds-muted">読み込み中…</div>
      ) : (
        <div className="fs-md">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={(url, key) => imageUrl(url, key, path, side, version)}>
            {text}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

/** An image path in the file → the image of the same side; other URLs as react-markdown allows them */
export function imageUrl(url: string, key: string, mdPath: string, side: Side, version: number): string {
  if (key !== "src" || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) return defaultUrlTransform(url);
  const resolved = resolvePath(mdPath, url.replace(/[?#].*$/, ""));
  return resolved ? rawUrl(resolved, side, version) : "";
}

/** `url` relative to the Markdown file's folder ("/x" is from the repository root); null outside it */
export function resolvePath(mdPath: string, url: string): string | null {
  let ref = url;
  try {
    ref = decodeURIComponent(url);
  } catch {
    /* keep it as it is */
  }
  const parts = ref.startsWith("/") ? [] : mdPath.split("/").slice(0, -1);
  for (const seg of ref.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.length ? parts.join("/") : null;
}
