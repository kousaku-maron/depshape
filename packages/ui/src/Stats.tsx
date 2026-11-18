import "./stats.css";

/*
 * One rule for every count in every module: the status of a thing (a file, a table) is a colored
 * letter box, A / M / D (like git), and + / − / ~ always mean what changed inside it (a file's
 * imports, a table's columns).
 */

export type MarkStatus = "added" | "modified" | "removed" | "renamed" | "unchanged";

const LETTER: Record<MarkStatus, string> = { added: "A", modified: "M", removed: "D", renamed: "R", unchanged: "" };
export const STATUS_LABEL: Record<MarkStatus, string> = { added: "追加", modified: "変更", removed: "削除", renamed: "名前の変更", unchanged: "変更なし" };

/**
 * The status of one thing as a letter in a colored box: A (added), M (modified), D (removed),
 * R (renamed); an unchanged thing keeps the slot, blank. `title` null leaves the tooltip to the parent.
 */
export function StatusMark({ status, small = false, title }: { status: MarkStatus; small?: boolean; title?: string | null }) {
  const label = title === null ? undefined : (title ?? STATUS_LABEL[status]);
  return (
    <span className={`ds-st ${status}${small ? " small" : ""}`} title={label} aria-label={STATUS_LABEL[status]}>
      {LETTER[status]}
    </span>
  );
}

export interface StatusStats {
  added: number;
  modified: number;
  removed: number;
}

export interface ChangeStats {
  added: number;
  removed: number;
  modified?: number;
}

const STATUS_KINDS = [
  ["added", "追加"],
  ["modified", "変更"],
  ["removed", "削除"],
] as const;

/** Changed things as status letters with a count: A 2  M 3  D 0. `unit` names the things ("ファイル", "テーブル"). */
export function StatusCounts({ stats, unit, showZero = false }: { stats: StatusStats; unit: string; showZero?: boolean }) {
  const shown = STATUS_KINDS.filter(([k]) => showZero || stats[k] > 0);
  if (shown.length === 0) return null;
  const title = STATUS_KINDS.map(([k, label]) => `${label} ${stats[k]}`).join("・") + ` ${unit}`;
  return (
    <span className="ds-status" title={title}>
      {shown.map(([k]) => (
        <span key={k} className={`ds-status-n ${k}${stats[k] === 0 ? " zero" : ""}`}>
          <StatusMark status={k} small title={null} />
          {stats[k]}
        </span>
      ))}
    </span>
  );
}

/** What changed inside, side by side in one chip: +2 −1 ~3. `title` says what is counted. */
export function ChangeCounts({ stats, title, showZero = false }: { stats: ChangeStats; title: string; showZero?: boolean }) {
  const parts: [string, string, number][] = [
    ["added", "+", stats.added],
    ["removed", "−", stats.removed],
  ];
  if (stats.modified !== undefined) parts.push(["modified", "~", stats.modified]);
  const shown = parts.filter(([, , n]) => showZero || n > 0);
  if (shown.length === 0) return null;
  return (
    <span className="ds-change" title={title}>
      {shown.map(([k, sign, n]) => (
        <span key={k} className={n ? k : "zero"}>
          {sign}
          {n}
        </span>
      ))}
    </span>
  );
}
