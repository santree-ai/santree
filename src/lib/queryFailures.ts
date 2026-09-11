/**
 * What the app does when a read or a write fails — one policy for every query and
 * mutation, handed to the `QueryClient` in `main.tsx`.
 *
 * Every failure is logged (`console.warn`, which `lib/logging.ts` forwards to the
 * log file) under the key that names it. A toast is where most views surface an
 * error at all, and once it has faded nothing else says *which* read failed.
 *
 * A failed read toasts. A not-connected backend returns an empty result rather
 * than an error (the no-mock-data rule), so a query error is a real failure — an
 * expired Linear token, a dead `gh` — and must never be swallowed into a cheerful
 * "all caught up"; consumers almost all default their data (`= []`) and never read
 * `isError`. The one exception is a refresh that fails while the last good data is
 * still on screen: the view isn't wrong, only a little stale, so the first such
 * failure stays in the log. The next one in a row toasts, so a failure that
 * persists can't hide behind cached data.
 */
import type { MutationCache, QueryCache } from "@tanstack/react-query";

import { toast } from "../state/toast";

type QueryCacheConfig = NonNullable<ConstructorParameters<typeof QueryCache>[0]>;
type MutationCacheConfig = NonNullable<ConstructorParameters<typeof MutationCache>[0]>;

/** What has been reported for a query since it last succeeded. Held weakly, so a
 *  query the cache garbage-collects takes its entry with it. */
const reported = new WeakMap<object, { failures: number; logged: string }>();

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const readFailures: QueryCacheConfig = {
  onError: (error, query) => {
    const message = messageOf(error);
    const last = reported.get(query);
    const failures = (last?.failures ?? 0) + 1;
    // A failing poll fails the same way on every tick: one line per failure, not per tick.
    if (last?.logged !== message) {
      console.warn(`read failed ${JSON.stringify(query.queryKey)}: ${message}`);
    }
    reported.set(query, { failures, logged: message });

    if (query.meta?.silent) return;
    if (query.state.data !== undefined && failures === 1) return;
    toast.error(message);
  },
  onSuccess: (_data, query) => {
    reported.delete(query);
  },
};

/** A mutation can opt out of the toast with `meta: { silent: true }` when it owns
 *  its own UI; it is logged either way. */
export const writeFailures: MutationCacheConfig = {
  onError: (error, _vars, _ctx, mutation) => {
    const message = messageOf(error);
    const key = mutation.options.mutationKey;
    console.warn(`write failed${key ? ` ${JSON.stringify(key)}` : ""}: ${message}`);
    if (mutation.meta?.silent) return;
    toast.error(message);
  },
};
