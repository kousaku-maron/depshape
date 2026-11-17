import { CommentIcon } from "./icons";

/** How many comments a row or a box has: an amber speech bubble and the number, like difit's file tree */
export function CommentCount({ n, title, className }: { n: number; title?: string; className?: string }) {
  return (
    <span className={`ds-count${className ? ` ${className}` : ""}`} title={title}>
      <CommentIcon size={12} />
      {n}
    </span>
  );
}
