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
 * **It only grows the range while the pointer is over the line numbers.** The
 * `+` straddles the boundary between the gutter and the code, so dragging
 * straight down from it lands on the content cells and the range stops at the
 * line that was pressed. Every row carries its line numbers in a sibling cell,
 * so while a drag is running we forward the hover there, and the manager extends
 * as if the pointer had stayed in the gutter.
 *
 * Split needs the forwarding too, which is not what it looked like: the manager
 * does resolve a *content cell* to its own side's number cell, so a synthetic
 * event aimed at the cell extends fine — but a real pointer is over the `<span>`
 * inside it, and that is one level too deep. Reviews takes the unified diff and
 * Trees the split one, which is precisely why "multi-line works in Reviews and
 * not in Trees" was reported. Split has one number cell per side, so the
 * forwarding re-aims at the side the drag *started* on; anything less specific
 * extends the wrong column.
 *
 * A press with no movement still selects a single line, so a plain click on the
 * `+` behaves as it always did.
 *
 * **Both diff modes, and they are shaped differently.** Trees renders your own
 * PR's diff split by default; Reviews takes the unified one. Unified gives a row
 * one `td.diff-line-num` holding both sides' numbers and one `+`; split gives
 * each side a `.diff-line-<side>-num` numbered `data-line-num`, and renders the
 * `+` twice — once there, once in the code cell, where there is no number beside
 * it. Everything below matches both; a selector that only knows unified leaves
 * half the app without the gesture, and worse than inert: the press falls
 * through to the library's own handler, which opens the composer on the one
 * pressed line *and* clears the range the manager had just armed.
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

/** The line-number cells a range can be dragged from. Unified gives a row one,
 *  holding both sides' numbers; split gives each side its own. */
const NUM_CELL = ".diff-line-num, .diff-line-old-num, .diff-line-new-num";

/** The cell holding the number of the line a `+` belongs to. */
function numberCell(widget: Element, side: "old" | "new"): Element | null {
  const unified = widget.closest(".diff-line-num");
  if (unified) return unified;
  // Split renders the `+` twice per row — once in the number cell, once in the
  // code cell, where there is no number to read. Walk the code-cell copy back to
  // the number cell for its *own* side, the way the library's
  // `getNumberHolderElement_Split` does: a split row has one on each side, so
  // anything less specific picks the wrong column.
  return (
    widget.closest(`.diff-line-${side}-num`) ??
    widget
      .closest(`.diff-line-${side}-content`)
      ?.parentElement?.querySelector(`.diff-line-${side}-num`) ??
    null
  );
}

/** The line a gutter `+` belongs to, read back out of the row it sits in. */
function lineAt(widget: Element): GutterSelection | null {
  // `data-add-widget` carries the side's name in both modes. The number itself is
  // spelled per mode: `data-line-<side>-num` in unified, where one cell holds
  // both, and a plain `data-line-num` in split, where the cell is already a side.
  const side = widget.getAttribute("data-add-widget") === "old" ? "old" : "new";
  const cell = numberCell(widget, side);
  const span =
    cell?.querySelector(`span[data-line-${side}-num]`) ??
    cell?.querySelector("span[data-line-num]");
  const n = Number(
    span?.getAttribute(`data-line-${side}-num`) ?? span?.getAttribute("data-line-num"),
  );
  return Number.isFinite(n) && n > 0 ? { side, from: n, to: n } : null;
}

export function useGutterDrag(root: RefObject<HTMLElement | null>) {
  const openRef = useRef<OpenWidget | null>(null);
  const selection = useRef<GutterSelection | null>(null);
  /** A drag the range manager is tracking, however it started. */
  const dragging = useRef(false);
  /** Set when the drag began on a `+`, holding the line it was pressed on. */
  const pressed = useRef<GutterSelection | null>(null);
  /** Which column the drag is extending. Split has one per side and they
   *  disagree the moment the file has shifted, so the side is read at the press
   *  and kept — the pointer's own column is whatever it happens to be over. */
  const side = useRef<"old" | "new">("new");

  /** Hand on the widget store once the library creates it. */
  const bindWidgetStore = useCallback((open: OpenWidget) => {
    openRef.current = open;
  }, []);

  /** Record what a drag ended up covering (the library reports this on mouseup,
   *  before our own handler runs). */
  const onSelection = useCallback((next: GutterSelection | null) => {
    // TEMPORARY (2026-09-02): tracking down "multi-line works in Reviews, not in
    // Trees". Remove once the cause is known.
    console.debug("[gutter] selection", JSON.stringify(next));
    selection.current = next;
  }, []);

  useEffect(() => {
    const node = root.current;
    if (!node) return;

    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      const widget = target.closest(".diff-add-widget-wrapper");
      // The manager arms on a line-number cell — and, in split, on the `+` in the
      // code cell as well, which it resolves back to one. Nothing else can be the
      // start of a range.
      console.debug(
        "[gutter] down",
        JSON.stringify({
          widget: !!widget,
          tag: target.tagName,
          cls: target.className?.toString().slice(0, 80),
          inNum: !!target.closest(NUM_CELL),
        }),
      );
      if (!widget && !target.closest(NUM_CELL)) return;
      dragging.current = true;
      selection.current = null;
      // Unified's one cell is spelled `.diff-line-num` and carries both sides;
      // only split names a side here, so anything else reads as the new one.
      side.current = target.closest(".diff-line-old-num, .diff-line-old-content") ? "old" : "new";

      if (!widget) return;
      pressed.current = lineAt(widget);
      if (pressed.current) side.current = pressed.current.side;
      // Swallow it before React's root listener dispatches the button's own
      // handler. The range manager, further down the tree, has already seen it.
      e.stopPropagation();
    };

    const onOver = (e: MouseEvent) => {
      if (!dragging.current) return;
      const target = e.target as Element | null;
      // Already in the gutter: the manager saw this one on its way up.
      if (!target || target.closest(NUM_CELL)) return;
      // Unified first — one cell, both sides. Split has one per side, so it is
      // the side the drag started on, never whichever column came first.
      const row = target.closest("tr");
      const gutter =
        row?.querySelector("td.diff-line-num") ??
        row?.querySelector(`.diff-line-${side.current}-num`);
      console.debug(
        "[gutter] over",
        JSON.stringify({
          tag: target.tagName,
          cls: target.className?.toString().slice(0, 60),
          row: !!row,
          reaimed: !!gutter,
        }),
      );
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
      console.debug("[gutter] up", JSON.stringify({ pressed: from, selection: selection.current }));
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
