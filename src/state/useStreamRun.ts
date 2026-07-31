/** Subscribe to one background run's transcript (see `streamRuns`). Split from the
 *  store itself so the store stays a plain module — importable from tests and from
 *  non-React code — while this file owns the React binding. */
import { useCallback, useSyncExternalStore } from "react";

import { getRun, type StreamRun, subscribe } from "./streamRuns";

export function useStreamRun(key: string): StreamRun {
  const sub = useCallback((cb: () => void) => subscribe(key, cb), [key]);
  const snapshot = useCallback(() => getRun(key), [key]);
  // The store publishes a new object per change and never mutates one in place, so
  // this identity is a safe change signal for `useSyncExternalStore`.
  return useSyncExternalStore(sub, snapshot, snapshot);
}
