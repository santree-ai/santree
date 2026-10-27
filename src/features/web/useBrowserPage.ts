/** Keep a Web tab's page — a native view the backend lays over the window — on
 *  its placeholder, and out of the way of the app's overlays.
 *
 *  **Placement** follows the placeholder: shown when the tab mounts, moved on
 *  every resize, window resize, scroll, or relayout (a split group moving without
 *  resizing — the same signal the terminal layer follows), hidden when the tab
 *  unmounts. The page is never recreated by any of it.
 *
 *  **Overlays** (`lib/overlays`) are checked once per animation frame, and only
 *  while one is open: a menu or toast crossing the page is cut out of it; a modal
 *  covering it has the page swap itself for a still — taken while it is still on
 *  screen, shown underneath, and only then the page hidden, so nothing flashes. A
 *  later swap back undoes it in the opposite order. `generation` drops a still
 *  that lands after the modal it was for has already closed (Orca's lesson). */
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { type BrowserHole, commands } from "../../bindings";
import {
  type OverlayRect,
  overlayRects,
  overlaysOpen,
  subscribeOverlays,
} from "../../lib/overlays";
import { RELAYOUT_EVENT } from "../terminal/relayout";

/** A rectangle in the app webview's CSS pixels — what the backend's
 *  `BrowserRect` carries, with every field known. */
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const rectOf = (el: HTMLElement): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
};

const sameRect = (a: Rect | null, b: Rect) =>
  !!a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** The overlays that cross `page`, as holes relative to its top-left — or
 *  `"covered"` when one covers all of it. Exported for testing. */
export function holesIn(page: Rect, overlays: OverlayRect[]): BrowserHole[] | "covered" {
  const right = page.x + page.width;
  const bottom = page.y + page.height;
  const holes: BrowserHole[] = [];
  for (const o of overlays) {
    if (o.left <= page.x && o.top <= page.y && o.right >= right && o.bottom >= bottom) {
      return "covered";
    }
    if (o.left >= right || o.right <= page.x || o.top >= bottom || o.bottom <= page.y) continue;
    holes.push({
      rect: {
        x: o.left - page.x,
        y: o.top - page.y,
        width: o.right - o.left,
        height: o.bottom - o.top,
      },
      radius: o.radius,
    });
  }
  return holes;
}

export function useBrowserPage({
  id,
  url,
  anchor,
  show,
}: {
  id: string;
  /** The address to open the page on, if the tab has none yet. */
  url: string | null;
  /** The placeholder the page is laid over. */
  anchor: RefObject<HTMLDivElement | null>;
  /** Whether the page belongs on screen — the tab shows, and has a page that
   *  isn't standing aside for an error or a crash. */
  show: boolean;
}): { still: string | null; stillShown: () => void } {
  const [still, setStill] = useState<string | null>(null);
  const placed = useRef<Rect | null>(null);
  const holesKey = useRef("[]");
  const covered = useRef(false);
  const generation = useRef(0);

  // Place the page on its placeholder, and keep it there.
  useLayoutEffect(() => {
    const el = anchor.current;
    if (!show || !el) return;
    let frame = 0;
    let live = true;
    placed.current = rectOf(el);
    void commands.browserShow(id, url, placed.current);
    const place = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!live) return;
        const rect = rectOf(el);
        if (sameRect(placed.current, rect)) return;
        placed.current = rect;
        void commands.browserPlace(id, rect);
      });
    };
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    window.addEventListener(RELAYOUT_EVENT, place);
    window.addEventListener("scroll", place, true);
    return () => {
      live = false;
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener(RELAYOUT_EVENT, place);
      window.removeEventListener("scroll", place, true);
      placed.current = null;
      holesKey.current = "[]";
      covered.current = false;
      generation.current++;
      setStill(null);
      void commands.browserHide(id);
    };
  }, [id, url, show, anchor]);

  // Give way to the overlays crossing the page.
  useEffect(() => {
    if (!show) return;
    let frame = 0;
    const settle = () => {
      const el = anchor.current;
      if (!el) return;
      const holes = overlaysOpen() ? holesIn(rectOf(el), overlayRects()) : [];
      if (holes === "covered") {
        if (!covered.current) {
          covered.current = true;
          const mine = ++generation.current;
          void commands.browserSnapshot(id).then((res) => {
            if (res.status === "ok" && res.data && generation.current === mine) setStill(res.data);
          });
        }
      } else {
        if (covered.current) {
          covered.current = false;
          generation.current++;
          // Back on screen first, then the still goes: the page is above it.
          const rect = anchor.current ? rectOf(anchor.current) : null;
          if (rect) void commands.browserShow(id, null, rect).then(() => setStill(null));
          else setStill(null);
        }
        const key = JSON.stringify(holes);
        if (key !== holesKey.current) {
          holesKey.current = key;
          void commands.browserSetHoles(id, holes);
        }
      }
      if (overlaysOpen()) frame = requestAnimationFrame(settle);
    };
    const restart = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(settle);
    };
    restart();
    const unsubscribe = subscribeOverlays(restart);
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, [id, show, anchor]);

  // The still is drawn under the page; hide the page once it can be seen. Hiding
  // clears the page's holes, so they are sent afresh when it is shown again.
  const stillShown = useCallback(() => {
    if (!covered.current) return;
    holesKey.current = "[]";
    void commands.browserHide(id);
  }, [id]);

  return { still, stillShown };
}
