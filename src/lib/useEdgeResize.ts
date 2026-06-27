/**
 * Drag-to-resize for a panel's edge handle. Shared by the left sidebar and the
 * Issues right panel, which had the same pointer-capture dance copy-pasted.
 *
 * The key trick (kept from both originals): during a drag the width is written
 * straight to a CSS custom property — no React state, so the heavy panel content
 * doesn't re-render on every pointer move — and the final width is committed to
 * state exactly once on pointer-up.
 */
import { type PointerEvent as ReactPointerEvent, useRef } from "react";

export interface EdgeResizeOptions {
  /** CSS custom property updated live during the drag (e.g. `--sidebar-width`). */
  cssVar: string;
  /** Current committed width (px). */
  width: number;
  min: number;
  max: number;
  /**
   * Which edge the handle sits on: `"right"` grows as you drag right (the
   * sidebar), `"left"` grows as you drag left (the right panel).
   */
  edge: "left" | "right";
  /** Commit the final width on pointer-up. */
  onCommit: (width: number) => void;
  /**
   * Optional collapse-past-threshold: when the dragged width would fall below
   * `at`, end the drag and collapse instead of clamping (resetting the stored
   * width to `resetTo` so re-expanding restores a sensible size).
   */
  collapse?: { at: number; resetTo: number; onCollapse: () => void };
}

/** Returns the pointer handlers to spread onto a resize-handle element. */
export function useEdgeResize(opts: EdgeResizeOptions) {
  const startX = useRef(0);
  const startW = useRef(0);
  const latest = useRef(opts.width);
  const dragging = useRef(false);

  const setVar = (w: number) => document.documentElement.style.setProperty(opts.cssVar, `${w}px`);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    startX.current = e.clientX;
    startW.current = opts.width;
    latest.current = opts.width;
    dragging.current = true;
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !(e.buttons & 1)) return;
    const delta = e.clientX - startX.current;
    const next = opts.edge === "right" ? startW.current + delta : startW.current - delta;

    if (opts.collapse && next < opts.collapse.at) {
      dragging.current = false;
      e.currentTarget.releasePointerCapture(e.pointerId);
      latest.current = opts.collapse.resetTo;
      setVar(opts.collapse.resetTo);
      opts.collapse.onCollapse();
      opts.onCommit(opts.collapse.resetTo);
      return;
    }

    const clamped = Math.min(opts.max, Math.max(opts.min, next));
    latest.current = clamped;
    setVar(clamped);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    // Commit the dragged width to state exactly once.
    opts.onCommit(latest.current);
  };

  return { onPointerDown, onPointerMove, onPointerUp };
}
