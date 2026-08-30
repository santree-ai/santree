/**
 * `useState` whose value outlives the component — backed by browser storage.
 *
 * Route-scoped view state dies with its route. Leaving Trees for Dev unmounted
 * `TreesProvider`, so coming back reset the selected worktree to "" and dropped
 * every per-worktree tab and open file: the terminal session was still alive in
 * the global layer, but the view had forgotten which worktree it belonged to and
 * landed on the all-agents overview. Persisting the selection keeps the two in
 * step across that round trip.
 *
 * `scope` picks how long "outlives" means. `"local"` (the default) is
 * `localStorage`: kept across restarts, like the active repo, theme, and sidebar
 * width. `"session"` is `sessionStorage`: it still survives a route change and a
 * webview reload, but a cold launch starts from the fallback.
 *
 * Chrome/UI state only. Anything functional or cross-device belongs in the
 * settings table instead — see CLAUDE.md.
 *
 * The value is JSON round-tripped, so it must be JSON-safe: no `Set`, `Map`, or
 * `undefined` members (a `Set` silently persists as `{}`).
 */
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";

export type PersistScope = "local" | "session";

/** The backing store, or `null` where the context refuses one (a privacy mode, a
 *  test env without jsdom) — the hook then degrades to a plain `useState`. */
function store(scope: PersistScope): Storage | null {
  try {
    return scope === "session" ? sessionStorage : localStorage;
  } catch {
    return null;
  }
}

/** Read `key`, distinguishing "absent" from "stored null" — which a plain
 *  `?? fallback` would collapse together. */
function load<T>(key: string, scope: PersistScope): { hit: true; value: T } | { hit: false } {
  try {
    const raw = store(scope)?.getItem(key) ?? null;
    if (raw === null) return { hit: false };
    return { hit: true, value: JSON.parse(raw) as T };
  } catch {
    // A half-written or hand-edited entry must not take the view down with it:
    // fall back to the default and let the next write replace it.
    return { hit: false };
  }
}

export function usePersistedState<T>(
  key: string,
  fallback: T,
  scope: PersistScope = "local",
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    const stored = load<T>(key, scope);
    return stored.hit ? stored.value : fallback;
  });

  // Skip the first run: it would either rewrite exactly what was just read, or —
  // on a miss — persist the default before the user has chosen anything, turning
  // a later change to that default into a value we can no longer tell apart.
  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    try {
      store(scope)?.setItem(key, JSON.stringify(value));
    } catch {
      // Quota exhaustion or a privacy mode that refuses writes. The value still
      // works for this session; only its persistence is lost.
    }
  }, [key, value, scope]);

  // `setValue` goes back out unwrapped, which is why nothing here tests the
  // updater form — `set((n) => n + 1)` works because React's setter does, and a
  // test for it would be a test of React. Wrap this (to debounce the write, to
  // reject a value, to notify another pane) and that stops being true: the
  // updater form becomes santree's behaviour and needs its own case.
  return [value, setValue];
}
