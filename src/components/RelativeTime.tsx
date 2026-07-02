/**
 * Small presentational wrappers around `relativeTime.ts` so every triage
 * render site (queue row, issue header, discussion comments, the Trees/Issues/
 * Reviews "linked issue" cards) formats live epoch-ms timestamps the same way,
 * ticking on the shared 30s interval instead of freezing at fetch time.
 */
import { formatRelativeTime, formatSla, useLiveNow } from "../lib/relativeTime";

/** A ticking "time ago" label, e.g. "5m ago". Renders nothing if `ms` is
 *  absent (bindings type it as nullable, though the backend always sets it). */
export function RelativeTime({ ms, className }: { ms: number | null; className?: string }) {
  const now = useLiveNow();
  if (ms == null) return null;
  return <span className={className}>{formatRelativeTime(ms, now)}</span>;
}

/** A ticking SLA countdown, e.g. "SLA in 3h". Renders nothing when the issue
 *  has no SLA (`breachMs` is `null`). */
export function SlaCountdown({
  breachMs,
  className,
}: {
  breachMs: number | null;
  className?: string;
}) {
  const now = useLiveNow();
  const label = formatSla(breachMs, now);
  if (!label) return null;
  return <span className={className}>{label}</span>;
}
