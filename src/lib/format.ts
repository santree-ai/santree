/** Small presentation helpers shared across views. */
import type { AgentDef } from "../bindings";

/** Whether an agent harness is wired up today — the catalog's own
 *  `available` flag (see `crates/core/src/config.rs`), not a frontend guess. */
export const agentAvailable = (agent: Pick<AgentDef, "available">): boolean => agent.available;

/** A diff size as `+540 −121` (note the real minus sign, matching the design). */
export function diffLabel(add: number, del: number): string {
  return `+${add} −${del}`;
}

/** f64 fields cross the typed bridge as `number | null` (specta's float
 *  convention); the Usage counts read a null/undefined as 0. */
type Num = number | null | undefined;

const UNITS = [
  { div: 1000, suffix: "k" },
  { div: 1_000_000, suffix: "M" },
  { div: 1_000_000_000, suffix: "B" },
] as const;

/** A compact token count: `812`, `51.2k`, `1.2M`, `3.4B`. */
export function formatCompact(value: Num): string {
  const n = value ?? 0;
  if (n < 1000) return String(Math.round(n));
  for (const { div, suffix } of UNITS) {
    // Rounding to one decimal can push a value past its own unit's ceiling
    // (999_950 → "1000.0k"), so carry it into the next unit instead.
    const label = trimZero(n / div);
    if (Number.parseFloat(label) < 1000) return `${label}${suffix}`;
  }
  return `${trimZero(n / 1_000_000_000)}B`;
}

/** One decimal, but drop a trailing `.0` (`1.2`, `51`, not `51.0`). */
function trimZero(n: number): string {
  return n.toFixed(1).replace(/\.0$/, "");
}

/** An approximate USD cost: `$0`, `<$0.01`, `$3.42`, `$1,204`. */
export function formatUsd(value: Num): string {
  const n = value ?? 0;
  if (n <= 0) return "$0";
  if (n < 0.01) return "<$0.01";
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString()}`;
}

/**
 * A session's approximate cost, to the resolution the number actually has:
 * `$0.41`, `$1,204.00`, and **four** decimals below a cent (`$0.0037`) — a
 * sub-cent spend rounded to `$0.00` is indistinguishable from free.
 *
 * `null` in, `null` out, and that is the whole contract for an **unpriced
 * model**: the backend sends `null` rather than `0` when it has no rate for the
 * model (see `SessionModelSpend`), and the caller renders nothing. Never
 * substitute a zero here.
 */
export function formatCostPrecise(value: number | null | undefined): string | null {
  if (value == null) return null;
  if (value <= 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Bytes as the OS would show them: "451.8 MB", "1.76 GB". Decimal units — the
 *  same base Activity Monitor uses, so the two agree. */
export function formatBytes(value: Num): string {
  const n = value ?? 0;
  if (n < 1_000) return `${Math.round(n)} B`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(0)} KB`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  return `${(n / 1_000_000_000).toFixed(2)} GB`;
}

/**
 * A duration from now until `untilMs`, to the second: "45s", "12m", "3h 9m",
 * "now". Distinct from {@link formatUntil}, which floors to whole minutes,
 * because the two are read off different clocks: the shared `useLiveNow` ticks
 * every 30s, so a seconds label driven by it would be wrong most of the time.
 * Only use this where the caller owns a clock fast enough to keep it true.
 *
 * The sub-minute case is the reason it exists — GitHub's search pool refills
 * every 60 seconds, and "resets in 1m" is never the useful answer about a window
 * that short.
 */
export function formatUntilPrecise(untilMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((untilMs - nowMs) / 1000));
  if (seconds === 0) return "now";
  if (seconds < 60) return `${seconds}s`;
  return formatUntil(untilMs, nowMs);
}

/** A duration from now until `untilMs`, coarse: "3h 9m", "4d 10h", "12m", or
 *  "now" once it has passed. Two units at most — a countdown is read, not
 *  computed. */
export function formatUntil(untilMs: number, nowMs: number): string {
  const total = Math.max(0, Math.round((untilMs - nowMs) / 60_000));
  if (total === 0) return "now";
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}
