/**
 * Makes the diff's gutter `+` behave the way github.com's does: **press it and
 * drag** to comment on a range, release to open the composer on what you covered.
 *
 * `@git-diff-view` doesn't support that gesture. Its `+` opens the composer on
 * `mousedown`, so the press that should have started a drag ends the interaction
 * instead — the composer is already open before the pointer moves. The library's
 * own way in is to drag the line-number column and *then* click the `+`, which
 * works but is the opposite of where the affordance is: the `+` is the only thing
 * that appears on hover, so it's the thing people press.
 *
 * The fix leans on where each listener lives. The range manager binds a **native**
 * `mousedown` on a container inside the diff, while React dispatches the button's
 * `onMouseDown` from the root — above us. So a native listener on the diff's own
 * wrapper sits between them: by the time it runs, the manager has already armed
 * the drag, and calling `stopPropagation` there keeps the event from ever
 * reaching React, so the composer doesn't open. We then open it ourselves on
 * mouseup, on the last line of the selection, which is exactly where the library
 * expects a range comment to be anchored.
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
  const dragging = useRef<GutterSelection | null>(null);

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
      const widget = (e.target as Element | null)?.closest?.(".diff-add-widget-wrapper");
      if (!widget) return;
      selection.current = null;
      dragging.current = lineAt(widget);
      // Swallow it before React's root listener dispatches the button's own
      // handler. The range manager, further down the tree, has already seen it.
      e.stopPropagation();
    };

    const onUp = () => {
      const pressed = dragging.current;
      dragging.current = null;
      if (!pressed) return;
      // The selection the manager just completed, or — if it never armed — the
      // line that was pressed, so a `+` can never come out dead.
      const at = selection.current ?? pressed;
      selection.current = null;
      openRef.current?.({
        side: at.side === "old" ? SplitSide.old : SplitSide.new,
        lineNumber: Math.max(at.from, at.to),
      });
    };

    node.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    return () => {
      node.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
    };
  }, [root]);

  return { bindWidgetStore, onSelection };
}
