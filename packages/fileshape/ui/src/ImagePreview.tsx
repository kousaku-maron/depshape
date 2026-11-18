import { useState } from "react";
import type { DiffFile } from "../../src/types";
import { rawUrl, type Side } from "./api";

/* An image file before and after, side by side on a checkerboard. */

export function ImagePreview({ file, version }: { file: DiffFile; version: number }) {
  const sides: Side[] = file.status === "added" ? ["new"] : file.status === "removed" ? ["old"] : ["old", "new"];
  return (
    <div className={`fs-images n${sides.length}`}>
      {sides.map((side) => (
        <Picture key={side} side={side} path={side === "old" ? (file.oldPath ?? file.path) : file.path} version={version} />
      ))}
    </div>
  );
}

function Picture({ side, path, version }: { side: Side; path: string; version: number }) {
  const [size, setSize] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  return (
    <figure className={`fs-image ${side}`}>
      <figcaption>
        <span className={`fs-image-side ${side}`}>{side === "old" ? "変更前" : "変更後"}</span>
        {size && <span className="ds-muted">{size}</span>}
      </figcaption>
      <div className="fs-image-frame">
        {failed ? (
          <span className="ds-muted">表示できませんでした</span>
        ) : (
          <img
            src={rawUrl(path, side, version)}
            alt={`${path}（${side === "old" ? "変更前" : "変更後"}）`}
            onLoad={(e) => setSize(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </figure>
  );
}
