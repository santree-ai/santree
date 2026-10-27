/** The app's overlays — menus, dialogs, toasts, drag previews — as a Web tab
 *  needs to know them.
 *
 *  A Web tab's page is a native view laid *above* the app's webview, so an
 *  overlay drawn there would end up under the page. Each overlay registers here
 *  while it is on screen, and a page it crosses gives way (`useBrowserPage`): a
 *  menu or a toast is cut out of the page, and a modal that covers the page has
 *  it stand aside for a still of itself, so the modal's blurred scrim has
 *  something to blur.
 *
 *  Registration is explicit and lives in the few shared pieces every overlay is
 *  built from — `Dropdown`, `PositionedMenu`, `useModalA11y`, the toast viewport,
 *  the split workspace's drop preview — so a new overlay built from them is
 *  covered without knowing any of this. Nothing runs while none is open. */
import { type RefObject, useEffect } from "react";

/** One overlay: an element, or the whole window (a modal's scrim). */
type Overlay = { el: RefObject<HTMLElement | null> } | { window: true };

const overlays = new Set<Overlay>();
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

export function subscribeOverlays(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function overlaysOpen(): boolean {
  return overlays.size > 0;
}

/** Where an overlay is, in viewport pixels, with its corner radius. */
export interface OverlayRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  radius: number;
}

/** Every open overlay's rectangle, measured now. A modal is the whole window. */
export function overlayRects(): OverlayRect[] {
  const rects: OverlayRect[] = [];
  for (const overlay of overlays) {
    if ("window" in overlay) {
      rects.push({
        left: 0,
        top: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
        radius: 0,
      });
      continue;
    }
    const el = overlay.el.current;
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const style = getComputedStyle(el);
    // A menu measures itself hidden for a frame before it is placed.
    if (style.visibility === "hidden") continue;
    const radius = Number.parseFloat(style.borderTopLeftRadius) || 0;
    rects.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, radius });
  }
  return rects;
}

function useRegistered(overlay: Overlay | null) {
  useEffect(() => {
    if (!overlay) return;
    overlays.add(overlay);
    changed();
    return () => {
      overlays.delete(overlay);
      changed();
    };
  }, [overlay]);
}

/** Register `el` as an overlay while `open`. Stable per element ref. */
export function useOverlay(el: RefObject<HTMLElement | null>, open: boolean) {
  useRegistered(open ? overlayFor(el) : null);
}

/** Register a modal — which covers the whole window — while `open`. */
export function useModalOverlay(open: boolean) {
  useRegistered(open ? WINDOW : null);
}

const WINDOW: Overlay = { window: true };
const byRef = new WeakMap<RefObject<HTMLElement | null>, Overlay>();

/** One overlay object per ref, so a re-render doesn't re-register it. */
function overlayFor(el: RefObject<HTMLElement | null>): Overlay {
  let overlay = byRef.get(el);
  if (!overlay) {
    overlay = { el };
    byRef.set(el, overlay);
  }
  return overlay;
}
