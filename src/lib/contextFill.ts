/** Shared context-window fill presentation, so every surface that shows it (the
 *  Trees session status line, the Agents panel) reports the same number in the
 *  same colors as santree-cli's in-terminal bar. */

/** santree-cli's convention: inflate the shown context % by 20% (clamped) so the
 *  warning colors trip earlier and nudge `/compact`. Kept identical to the
 *  terminal bar (crates/hook's `render_bar`) so the two line up. */
const CONTEXT_DISPLAY_MULTIPLIER = 1.2;

/** Claude's raw `used_percentage` → the percentage santree displays. */
export function displayFill(usedPct: number | null | undefined): number {
  return Math.min(100, Math.round((usedPct ?? 0) * CONTEXT_DISPLAY_MULTIPLIER));
}

/** Context-fill color on the (inflated) displayed percentage, matching the
 *  terminal bar's 60%/80% thresholds. */
export function fillColor(pct: number): string {
  if (pct >= 80) return "var(--color-status-red)";
  if (pct >= 60) return "var(--color-status-amber)";
  return "var(--color-status-green)";
}
