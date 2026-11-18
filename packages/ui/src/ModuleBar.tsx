import type { ReactNode } from "react";
import "./bar.css";

/*
 * The first row of every module, under the shell's header: what changed (counts with a label each),
 * then the module's own controls on the right, with how much has been marked reviewed.
 */

export function ModuleBar({ children }: { children: ReactNode }) {
  return <header className="ds-bar">{children}</header>;
}

/** Counts with their labels, kept together on the left */
export function BarCounts({ children }: { children: ReactNode }) {
  return <span className="ds-bar-counts">{children}</span>;
}

export function BarLabel({ children }: { children: ReactNode }) {
  return <span className="ds-bar-label">{children}</span>;
}

export function BarSep() {
  return <span className="ds-bar-sep" />;
}

/** Everything after it goes to the right end */
export function BarSpacer() {
  return <span className="ds-bar-spacer" />;
}

/** "確認済み 3 / 10" with a bar; nothing when there is nothing to review */
export function ReviewProgress({ done, total, title }: { done: number; total: number; title: string }) {
  if (total === 0) return null;
  return (
    <span className="ds-progress" title={title}>
      <span>
        確認済み {done} / {total}
      </span>
      <span className="ds-progress-bar">
        <span style={{ width: `${(done / total) * 100}%` }} />
      </span>
    </span>
  );
}
