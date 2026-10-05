/**
 * A host's split layouts, one per surface (a worktree, a pull request, a
 * ticket), persisted so each comes back the way it was left.
 *
 * Two hooks because Trees writes a selection into worktrees it isn't showing (a
 * run it follows lands on its tab whenever that worktree is next opened):
 * {@link useSplitLayouts} is the store, and {@link useSplitLayout} is one
 * surface's live view of it, fitted to what that surface has open.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";

import { usePersistedState } from "../../lib/usePersistedState";
import {
  equalize,
  focusedTab,
  focusGroup,
  initialLayout,
  isLayout,
  moveTab,
  normalize,
  type Side,
  type SplitLayout,
  type SplitPath,
  selectTab,
  setRatio,
  splitTab,
  visibleTabs,
} from "./layout";

export interface SplitLayouts<T extends string> {
  /** The stored layout for a surface (a fresh single group if it has none). */
  get: (surface: string) => SplitLayout<T>;
  update: (surface: string, fn: (layout: SplitLayout<T>) => SplitLayout<T>) => void;
  /** Show a tab on a surface, whether or not that surface is on screen. */
  selectIn: (surface: string, tab: T) => void;
}

// One shared value for every surface with nothing stored, so reading one twice
// gives the same object (and the drawn layout isn't recomputed every render).
// Safe to share: no operation mutates a layout.
const EMPTY = initialLayout<string>();

function read<T extends string>(value: unknown): SplitLayout<T> {
  return (isLayout(value) ? value : EMPTY) as SplitLayout<T>;
}

export function useSplitLayouts<T extends string>(storageKey: string): SplitLayouts<T> {
  const [all, setAll] = usePersistedState<Record<string, unknown>>(storageKey, {});
  const get = useCallback((surface: string) => read<T>(all[surface]), [all]);
  const update = useCallback(
    (surface: string, fn: (layout: SplitLayout<T>) => SplitLayout<T>) =>
      setAll((current) => {
        const before = read<T>(current[surface]);
        const after = fn(before);
        return after === before && surface in current ? current : { ...current, [surface]: after };
      }),
    [setAll],
  );
  const selectIn = useCallback(
    (surface: string, tab: T) => update(surface, (l) => selectTab(l, tab)),
    [update],
  );
  return useMemo(() => ({ get, update, selectIn }), [get, update, selectIn]);
}

export interface SplitController<T extends string> {
  /** The layout as drawn: the stored one fitted to what is open. */
  layout: SplitLayout<T>;
  /** The focused group's tab — what "the active tab" means to a host that only
   *  needs one answer (the status bar, ⌘F, where a launch is followed). */
  active: T | null;
  /** Every group's active tab: everything on screen. */
  visible: T[];
  select: (tab: T) => void;
  focus: (group: string) => void;
  move: (tab: T, group: string, index?: number) => void;
  split: (tab: T, group: string, side: Side) => void;
  resize: (path: SplitPath, ratio: number) => void;
  equalize: (path: SplitPath) => void;
}

/**
 * One surface's layout, fitted to `open` (the host's tabs, in its canonical
 * order).
 *
 * `ready` says `open` is the real answer and not a loading frame. Until it is,
 * the drawn layout still fits what is open, but nothing is written back — a
 * reload would otherwise forget every split while the tab rows were still on
 * their way. Once ready, the store is kept equal to what is drawn, which is how
 * a closed tab's group collapses for good rather than coming back with it.
 */
export function useSplitLayout<T extends string>(
  store: SplitLayouts<T>,
  surface: string,
  open: readonly T[],
  ready: boolean,
): SplitController<T> {
  const stored = store.get(surface);
  const openKey = open.join("\u0000");
  // biome-ignore lint/correctness/useExhaustiveDependencies: openKey stands in for open.
  const layout = useMemo(() => normalize(stored, open), [stored, openKey]);

  const { update } = store;
  useEffect(() => {
    if (!ready || JSON.stringify(layout) === JSON.stringify(stored)) return;
    update(surface, () => layout);
  }, [ready, layout, stored, surface, update]);

  // Gestures act on what is drawn; a selection acts on what is stored, so one
  // made before its tab has rendered survives as `pending`. Read through a ref so
  // every action is stable: hosts call them from effects, and an effect that
  // re-ran on each layout change would repeat what it did.
  const drawn = useRef(layout);
  drawn.current = layout;
  const actions = useMemo(() => {
    const onDrawn = (fn: (l: SplitLayout<T>) => SplitLayout<T>) => {
      const next = fn(drawn.current);
      if (next !== drawn.current) update(surface, () => next);
    };
    return {
      select: (tab: T) => update(surface, (l) => selectTab(l, tab)),
      focus: (group: string) => onDrawn((l) => focusGroup(l, group)),
      move: (tab: T, group: string, index?: number) =>
        onDrawn((l) => moveTab(l, tab, group, index)),
      split: (tab: T, group: string, side: Side) => onDrawn((l) => splitTab(l, tab, group, side)),
      resize: (path: SplitPath, ratio: number) => onDrawn((l) => setRatio(l, path, ratio)),
      equalize: (path: SplitPath) => onDrawn((l) => equalize(l, path)),
    };
  }, [update, surface]);
  return useMemo(
    () => ({ layout, active: focusedTab(layout), visible: visibleTabs(layout), ...actions }),
    [layout, actions],
  );
}
