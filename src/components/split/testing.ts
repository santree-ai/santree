/**
 * Test-only: split controllers for a test that stubs its host's model, built
 * from the real layout code rather than a hand-rolled object, so a test's
 * controller can't drift from what the hosts get.
 */
import { vi } from "vitest";

import { focusedTab, initialLayout, normalize, selectTab, visibleTabs } from "./layout";
import { type SplitController, useSplitLayout, useSplitLayouts } from "./useSplitLayout";

/** The storage key {@link useTestSplit} keeps its layouts under. */
export const TEST_SPLIT_KEY = "santree:test:split";

/** A live controller: one surface over `open`, persisted under `storageKey`
 *  like a host's — its gestures really move the layout. */
export function useTestSplit<T extends string>(
  open: readonly T[],
  surface = "test",
  storageKey = TEST_SPLIT_KEY,
): SplitController<T> {
  return useSplitLayout(useSplitLayouts<T>(storageKey), surface, open, true);
}

/** Store a surface's layout as one group over `open` with `active` selected —
 *  how a {@link useTestSplit} test starts on a tab other than the first. Call
 *  before mounting: the store reads storage once. */
export function seedSplit<T extends string>(
  open: readonly T[],
  active: T,
  surface = "test",
  storageKey = TEST_SPLIT_KEY,
): void {
  const layout = selectTab(normalize(initialLayout<T>(), open), active);
  const all = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Record<string, unknown>;
  localStorage.setItem(storageKey, JSON.stringify({ ...all, [surface]: layout }));
}

/** A frozen controller: one group over `open` showing `active`, its gestures
 *  spies — for a stubbed model whose selection the test dials directly. */
export function fakeSplit<T extends string>(open: readonly T[], active: T): SplitController<T> {
  const layout = selectTab(normalize(initialLayout<T>(), open), active);
  return {
    layout,
    active: focusedTab(layout),
    visible: visibleTabs(layout),
    select: vi.fn(),
    focus: vi.fn(),
    move: vi.fn(),
    split: vi.fn(),
    resize: vi.fn(),
    equalize: vi.fn(),
  };
}
