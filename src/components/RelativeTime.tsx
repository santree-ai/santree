/**
 * Small presentational wrappers around `relativeTime.ts` so every triage
 * render site (sidebar row, issue header, discussion comments, the Trees/Issues/
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

/** One working day. Inside this the triage clock is worth a color; beyond it a
 *  countdown is reference, not news. */
const SLA_URGENT_MS = 24 * 60 * 60 * 1000;

/**
 * The compact triage clock, toned like the due-date signals: red once breached,
 * amber inside the last day, plain muted ink otherwise. The unconditional red it
 * used to wear made "SLA in 4d" shout as loudly as "SLA breached", which is the
 * decorative-color habit the monochrome pass exists to remove.
 *
 * It reads `useLiveNow` itself rather than taking `now` from the row, so the
 * shared 30s tick re-renders this span and not every row in the list.
 */
export function SlaSignal({
  breachMs,
  className,
}: {
  breachMs: number | null;
  className?: string;
}) {
  const now = useLiveNow();
  const label = formatSla(breachMs, now);
  if (label == null || breachMs == null) return null;
  const left = breachMs - now;
  const color =
    left <= 0
      ? "var(--color-status-red)"
      : left <= SLA_URGENT_MS
        ? "var(--color-status-amber)"
        : "var(--color-muted-4)";
  return (
    <span
      className={`flex-none font-mono text-[9px] tabular-nums ${className ?? ""}`}
      style={{ color }}
      title={left <= 0 ? "Triage SLA has been breached" : "Time left on the triage SLA"}
    >
      {label}
    </span>
  );
}
