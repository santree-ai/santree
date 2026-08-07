/**
 * Presentation for the raw epoch-ms timestamps the backend sends for triage
 * tickets (created/SLA-breach/snooze times) — kept as plain numbers so the
 * frontend decides how to render them, per CLAUDE.md's "presentation is the
 * frontend's job" rule. Baking a formatted "5m ago"/"SLA in 3h" string into
 * the domain field at fetch time would freeze between refetches — triage's
 * query has a multi-minute staleTime, so an SLA could read "in 3m" long after
 * it actually breached. `useLiveNow` ticks these labels live instead.
 */
import { useSyncExternalStore } from "react";

const TICK_MS = 30_000;

let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function tick() {
  now = Date.now();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  // The clock stops with the interval when the last consumer unmounts, so the
  // first one back re-reads it — otherwise a view revisited after an hour away
  // would serve an hour-stale `now` until the next tick.
  if (listeners.size === 0) now = Date.now();
  listeners.add(listener);
  timer ??= setInterval(tick, TICK_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

function getSnapshot(): number {
  return now;
}

/**
 * The current time in epoch ms, ticking every 30s while at least one consumer
 * is mounted (a single shared interval, not one per caller — same pattern as
 * the toast store). Lets relative-time labels stay live without a data refetch.
 */
export function useLiveNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * An ISO-8601 timestamp (what GitHub's API returns) as epoch ms, or `null` if it
 * can't be parsed. The `null` matters: `RelativeTime` renders nothing for it,
 * where the `NaN` that `Date.parse` returns for junk would render "NaN ago".
 */
export function isoMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** A compact "time ago" label for an absolute timestamp, e.g. "just now",
 *  "5m ago", "2h ago", "3d ago", "5w ago", "3mo ago", or "2y ago". */
export function formatRelativeTime(thenMs: number, nowMs: number): string {
  const ms = Math.max(0, nowMs - thenMs);
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** A short SLA countdown from an absolute breach time, e.g. "SLA in 3h",
 *  "SLA in 1d 6h", or "SLA breached". `null` when the issue has no SLA. */
export function formatSla(breachMs: number | null | undefined, nowMs: number): string | null {
  if (breachMs == null) return null;
  const ms = breachMs - nowMs;
  if (ms <= 0) return "SLA breached";
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const label = days >= 1 ? `${days}d ${hours}h` : hours >= 1 ? `${hours}h` : `${mins}m`;
  return `SLA in ${label}`;
}

/** A short wake label for a snoozed issue, e.g. "Jun 30". An absolute future
 *  date, not a countdown, so it doesn't need to tick live. */
export function formatSnoozeLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
