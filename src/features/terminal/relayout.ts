/** Fired when terminal hosts may have moved without changing size — a split
 *  group's tab moved into another group of the same width, say. A
 *  `ResizeObserver` only reports size, so a host that only *moved* would leave
 *  its pane behind. The terminal layer re-places every embedded pane on it. */
export const RELAYOUT_EVENT = "santree:terminal-relayout";

/** Re-place every embedded terminal pane on its host. Call from a layout effect
 *  after a change that can move hosts, so the panes land in the same frame. */
export function relayoutTerminals() {
  window.dispatchEvent(new Event(RELAYOUT_EVENT));
}
