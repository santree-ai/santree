/**
 * The one rule for expanding and collapsing, wherever the app draws a list that
 * folds: **⌘-click (Ctrl elsewhere) applies what you just did to everything the
 * row you clicked governs.**
 *
 * A plain click is the row's own state and nothing else. A ⌘-click mirrors the
 * *resulting* state outward — collapsing an expanded row collapses the rest,
 * expanding a collapsed one expands the rest — so one gesture answers both "show
 * me all of this" and "get all of this out of my way", which is what a file
 * explorer's option-click has always meant.
 *
 * What "the rest" covers is the one thing each surface decides for itself,
 * because it is the one thing that differs: in a tree it is the clicked folder's
 * own subtree (bounded, and the only reading of "what's below" that can't unfold
 * a monorepo in a single click); in a flat list of sections it is every section
 * beside it. Each caller passes those keys; the rule below is the same either
 * way.
 */

/** Whether this click asked for the bulk gesture. */
export function isBulkToggle(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.metaKey || e.ctrlKey;
}

/**
 * The next membership set after a disclosure is clicked.
 *
 * Deliberately agnostic about what membership *means*: `AllFilesList` holds the
 * folders that are open, `ChangesList` the ones that are shut, and the rule is
 * the same for both because it only ever mirrors the clicked row's new state.
 * `scope` is what a ⌘-click reaches (it need not contain `key`).
 */
export function toggleDisclosure<T>(
  set: ReadonlySet<T>,
  key: T,
  scope: readonly T[],
  bulk: boolean,
): Set<T> {
  if (!bulk) {
    const next = new Set(set);
    if (!next.delete(key)) next.add(key);
    return next;
  }
  // Everything in scope lands on the state the clicked row is moving *to*.
  const next = new Set(set);
  const leaving = set.has(key);
  for (const k of scope) {
    if (leaving) next.delete(k);
    else next.add(k);
  }
  if (leaving) next.delete(key);
  else next.add(key);
  return next;
}

/**
 * The same rule over a `Record<key, boolean>` — the shape a collapse map takes
 * once it has to survive a reload (`usePersistedState` stores objects, not sets).
 * Keys absent from the map read as `false`, which is how the sidebar spells
 * "open by default".
 */
export function toggleDisclosureMap(
  map: Readonly<Record<string, boolean>>,
  key: string,
  scope: readonly string[],
  bulk: boolean,
): Record<string, boolean> {
  const next = !map[key];
  const out = { ...map, [key]: next };
  if (bulk) for (const k of scope) out[k] = next;
  return out;
}

/** The tooltip line every disclosure carries, so the gesture is discoverable
 *  from any of them rather than only from the one place that documented it. */
export const BULK_TOGGLE_HINT = "⌘-click for everything below";
