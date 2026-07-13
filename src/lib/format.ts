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
