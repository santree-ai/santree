/** A slim, santree-native status line for a worktree's Claude session — the GUI
 *  counterpart to the in-terminal bar. Sourced from `session_usage_live`, which
 *  captures Claude's OWN `used_percentage` from the status-line stdin (pushed live
 *  over the signal socket). So this shows the exact same number as the terminal
 *  bar (both apply the 1.2x display nudge to Claude's authoritative percentage) —
 *  unlike the earlier transcript-derived reconstruction, which diverged. */

import { formatUsd } from "../../lib/format";
import { useSessionUsageLive } from "../../lib/queries";
import { modelVersion } from "../../theme/colors";

/** santree-cli's convention: inflate the shown context % by 20% (clamped) so the
 *  warning colors trip earlier and nudge `/compact`. Kept identical to the
 *  terminal bar (crates/hook's `render_bar`) so the two line up. */
const CONTEXT_DISPLAY_MULTIPLIER = 1.2;

/** Context-fill color on the (inflated) displayed percentage, matching the
 *  terminal bar's 60%/80% thresholds. */
function fillColor(pct: number): string {
  if (pct >= 80) return "var(--color-status-red)";
  if (pct >= 60) return "var(--color-status-amber)";
  return "var(--color-status-green)";
}

export function SessionStatusLine({ sessionId }: { sessionId: string | null }) {
  const { data } = useSessionUsageLive();
  const s = sessionId ? data?.find((x) => x.sessionId === sessionId) : undefined;
  if (!s) return null;

  const pct = Math.min(100, Math.round((s.usedPct ?? 0) * CONTEXT_DISPLAY_MULTIPLIER));
  const color = fillColor(pct);

  return (
    <div className="flex items-center gap-2.5 border-t border-line bg-surface px-3 py-1 font-mono text-[10.5px] text-muted-3">
      <span className="text-fg-3">{modelVersion(s.model)}</span>
      <div className="h-1.5 w-28 flex-none overflow-hidden rounded-full bg-input">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="tabular-nums" style={{ color }}>
        {pct}%
      </span>
      <span className="ml-auto text-muted-4 tabular-nums">{formatUsd(s.costUsd)}</span>
    </div>
  );
}
