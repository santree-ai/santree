/**
 * Which input the user is currently driving with — so a focus ring only appears
 * when it is useful.
 *
 * `:focus-visible` alone isn't enough here. Anything that moves focus in script
 * counts as "not a pointer" to the engine, so a menu that focuses its first item
 * on open (see {@link Dropdown}) paints a ring the moment it is *clicked* open,
 * and paints another on the trigger when the menu hands focus back on close.
 * That reads as a stuck highlight, because nothing the user did asked for it.
 *
 * So the ring is gated on modality instead: a pointer press marks the document,
 * and the first key that could navigate clears the mark. Keyboard focus keeps
 * its ring at all times (WCAG 2.4.7) — a pointer user simply doesn't get one for
 * focus they never asked to see.
 */

/** Keys that move or use focus. A plain character key doesn't count: typing into
 *  a field is not navigation, and shouldn't light up rings elsewhere. */
const NAV_KEYS = new Set([
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "Enter",
  " ",
  "Escape",
]);

/** Start watching. Idempotent, and safe to call before the DOM has content. */
export function initFocusModality(): void {
  const root = document.documentElement;
  const pointer = () => {
    root.dataset.pointerNav = "true";
  };
  const key = (e: KeyboardEvent) => {
    // A modifier alone (holding ⌘ before a click) isn't navigation.
    if (!NAV_KEYS.has(e.key)) return;
    delete root.dataset.pointerNav;
  };
  // Capture phase: the mark has to be set before the click's focus lands, or the
  // ring paints for a frame first.
  window.addEventListener("pointerdown", pointer, { capture: true });
  window.addEventListener("keydown", key, { capture: true });
}
