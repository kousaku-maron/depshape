import { useEffect, useState, type RefObject } from "react";
import "./areas.css";

/*
 * A draggable line between two areas laid out in a grid (an area of its own, DIVIDER_W wide).
 * `start` reads the width being changed when the drag begins; `onDrag` gets it plus how far the
 * pointer moved, and the module decides which area grows. A double click resets.
 */

export const DIVIDER_W = 6;

export function AreaDivider(props: { title: string; start: () => number; onDrag: (w0: number, dx: number) => void; onEnd: () => void; onReset: () => void }) {
  return (
    <div
      className="ds-divider"
      role="separator"
      aria-orientation="vertical"
      title={props.title}
      onDoubleClick={props.onReset}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const el = e.currentTarget;
        const x0 = e.clientX;
        const w0 = props.start();
        el.setPointerCapture(e.pointerId);
        el.classList.add("dragging");
        document.body.classList.add("ds-resizing");
        const move = (ev: PointerEvent) => props.onDrag(w0, ev.clientX - x0);
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
          el.classList.remove("dragging");
          document.body.classList.remove("ds-resizing");
          props.onEnd();
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
      }}
    />
  );
}

/** The width of an element, kept up to date (0 while it is hidden) */
export function useWidth(ref: RefObject<HTMLElement>): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}
