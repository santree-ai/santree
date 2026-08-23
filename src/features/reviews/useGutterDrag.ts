/**
 * Makes the diff's gutter `+` behave the way github.com's does: **press it and
 * drag** to comment on a range, release to open the composer on what you covered.
 *
 * `@git-diff-view` doesn't support that gesture, and gets in the way twice.
 *
 * **It opens the composer on `mousedown`.** The press that should have started a
 * drag ends the interaction instead. The fix leans on where each listener lives:
 * the range manager binds a **native** `mousedown` on a container inside the
 * diff, while React dispatches the button's `onMouseDown` from the root, above
 * us. A native listener on the diff's own wrapper sits between them — by the time
 * it runs the manager has already armed the drag, and calling `stopPropagation`
 * there keeps the event from ever reaching React, so the composer stays shut. We
 * open it ourselves on mouseup, on the last line of the selection, which is where
 * the library anchors a range comment anyway.
 *
 * **It only grows the range while the pointer is over the line numbers.** The `+`
 * straddles the boundary between the gutter and the code, so dragging straight
 * down from it lands on the content cells and the range stops at the line that
 * was pressed. Every row carries its line numbers in a sibling cell, so while a
 * drag is running we forward the hover there, and the manager extends as if the
 * pointer had stayed in the gutter.
 *
 * A press with no movement still selects a single line, so a plain click on the
 * `+` behaves as it always did.
 */
import { SplitSide } from "@git-diff-view/react";
import { type RefObject, useCallback, useEffect, useRef } from "react";

/** What a completed drag covered. `side` is the library's own spelling. */
export interface GutterSelection {
  side: "old" | "new";
  from: number;
  to: number;
}

/** Opens the composer on a line — `setWidget` from the library's widget store. */
type OpenWidget = (at: { side: SplitSide; lineNumber: number }) => void;

/** The line a gutter `+` belongs to, read back out of the row it sits in. */
function lineAt(widget: Element): GutterSelection | null {
  // `data-add-widget` carries the side's name; the numbers live in the sibling
  // spans of the same line-number cell.
  const side = widget.getAttribute("data-add-widget") === "old" ? "old" : "new";
  const cell = widget.closest("td");
  const span = cell?.querySelector(`span[data-line-${side}-num]`);
  const n = Number(span?.getAttribute(`data-line-${side}-num`));
  return Number.isFinite(n) && n > 0 ? { side, from: n, to: n } : null;
}

export function useGutterDrag(root: RefObject<HTMLElement | null>) {
  const openRef = useRef<OpenWidget | null>(null);
  const selection = useRef<GutterSelection | null>(null);
  /** A drag the range manager is tracking, however it started. */
  const dragging = useRef(false);
  /** Set when the drag began on a `+`, holding the line it was pressed on. */
  const pressed = useRef<GutterSelection | null>(null);

  /** Hand on the widget store once the library creates it. */
  const bindWidgetStore = useCallback((open: OpenWidget) => {
    openRef.current = open;
  }, []);

  /** Record what a drag ended up covering (the library reports this on mouseup,
   *  before our own handler runs). */
  const onSelection = useCallback((next: GutterSelection | null) => {
    selection.current = next;
  }, []);

  useEffect(() => {
    const node = root.current;
    if (!node) return;

    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      // The manager only arms on the line-number cell, so nothing else can be
      // the start of a range.
      if (!target?.closest?.("td.diff-line-num")) return;
      dragging.current = true;
      selection.current = null;

      const widget = target.closest(".diff-add-widget-wrapper");
      if (!widget) return;
      pressed.current = lineAt(widget);
      // Swallow it before React's root listener dispatches the button's own
      // handler. The range manager, further down the tree, has already seen it.
      e.stopPropagation();
    };

    const onOver = (e: MouseEvent) => {
      if (!dragging.current) return;
      const target = e.target as Element | null;
      // Already in the gutter: the manager saw this one on its way up.
      if (!target || target.closest("td.diff-line-num")) return;
      const gutter = target.closest("tr")?.querySelector("td.diff-line-num");
      // Re-aimed at the row's line numbers. This bubbles back through our own
      // listener, where the check above stops it going round again.
      gutter?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    };

    const onUp = () => {
      dragging.current = false;
      const from = pressed.current;
      pressed.current = null;
      if (!from) return;
      // The selection the manager just completed, or — if it never armed — the
      // line that was pressed, so a `+` can never come out dead.
      const at = selection.current ?? from;
      selection.current = null;
      openRef.current?.({
        side: at.side === "old" ? SplitSide.old : SplitSide.new,
        lineNumber: Math.max(at.from, at.to),
      });
    };

    node.addEventListener("mousedown", onDown);
    node.addEventListener("mouseover", onOver);
    window.addEventListener("mouseup", onUp);
    return () => {
      node.removeEventListener("mousedown", onDown);
      node.removeEventListener("mouseover", onOver);
      window.removeEventListener("mouseup", onUp);
    };
  }, [root]);

  return { bindWidgetStore, onSelection };
}
