/* Icons (Feather outlines) for the diffshape tools. They work inside HTML and inside another <svg>. */

/*!
 * Icon paths from Feather (https://github.com/feathericons/feather)
 * The MIT License (MIT)
 * Copyright (c) 2013-2023 Cole Bemis
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { ReactNode } from "react";

export function EyeIcon({ on, size = 14, x, y }: { on: boolean; size?: number; x?: number; y?: number }) {
  return (
    <svg
      className={`eye${on ? " on" : ""}`}
      x={x}
      y={y}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {on ? (
        <>
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </>
      ) : (
        <>
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </>
      )}
    </svg>
  );
}

/* A push pin (drawn for depshape, in the same line style): filled when pinned. */
export function PinIcon({ on, size = 14, x, y }: { on: boolean; size?: number; x?: number; y?: number }) {
  return (
    <svg
      className={`pin-icon${on ? " on" : ""}`}
      x={x}
      y={y}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 3h8" />
      <path d="M9.5 3v6L6 14h12l-3.5-5V3z" fill={on ? "currentColor" : "none"} />
      <path d="M12 14v7" />
    </svg>
  );
}

interface OutlineProps {
  size?: number;
  /** position inside another <svg> */
  x?: number;
  y?: number;
  className?: string;
}

function Outline({ size = 18, x, y, className, children }: OutlineProps & { children: ReactNode }) {
  return (
    <svg
      className={className}
      x={x}
      y={y}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Feather "share-2": the code dependency module */
export function GraphIcon(p: OutlineProps) {
  return (
    <Outline {...p}>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </Outline>
  );
}

/** Feather "database": the DB schema module */
export function DatabaseIcon(p: OutlineProps) {
  return (
    <Outline {...p}>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </Outline>
  );
}

/** Feather "message-square": review comments */
export function CommentIcon({ size = 14, ...p }: OutlineProps) {
  return (
    <Outline size={size} {...p}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </Outline>
  );
}

/** Feather "copy" */
export function CopyIcon({ size = 14, ...p }: OutlineProps) {
  return (
    <Outline size={size} {...p}>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Outline>
  );
}

/** Feather "refresh-cw" */
export function RefreshIcon({ size = 14, ...p }: OutlineProps) {
  return (
    <Outline size={size} {...p}>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </Outline>
  );
}

/** Feather "check" */
export function CheckIcon({ size = 14, ...p }: OutlineProps) {
  return (
    <Outline size={size} {...p}>
      <polyline points="20 6 9 17 4 12" />
    </Outline>
  );
}
