import { forwardRef } from "react";

/** The comment text box: ⌘ / Ctrl + Enter saves, Esc cancels (without closing anything around it). */
export const CommentInput = forwardRef<
  HTMLTextAreaElement,
  { value: string; onChange: (v: string) => void; onSave: () => void; onCancel: () => void; placeholder?: string; autoFocus?: boolean; className?: string }
>(function CommentInput({ value, onChange, onSave, onCancel, placeholder, autoFocus, className }, ref) {
  return (
    <textarea
      ref={ref}
      className={className}
      autoFocus={autoFocus}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          onSave();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          (e.target as HTMLTextAreaElement).blur();
          onCancel();
        }
      }}
    />
  );
});
