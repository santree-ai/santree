/**
 * One metered line in the Usage panel.
 *
 * Every budget in that panel answers the same three-part question — what is
 * this, how much of it is gone, and when does it come back — so every budget is
 * drawn the same way, whatever it meters. GitHub and Linear meter calls and put
 * "4,982 / 5,000" in the number slot; Claude and Codex meter time and put "52%"
 * there. The columns, the track, the countdown and the widths are this
 * component's, not each caller's, because a second row that merely *looks* like
 * this one is how the two halves of the panel drift apart.
 *
 * The tone is the caller's, though, and deliberately: a call pool goes amber on
 * how little is left (`apiBudgetColor`), a provider window on how much is spent,
 * against the same thresholds the terminal bar and the tree status line use. One
 * shared threshold across two different quantities would be a coincidence, not a
 * meaning.
 */
import type { ReactNode } from "react";

import { formatUntil } from "../../../lib/format";

export function BudgetLine({
  label,
  hint,
  pct,
  color,
  value,
  resetsAtMs,
  nowMs,
}: {
  /** What the pool or window is, in a word or two. */
  label: string;
  /** The longer gloss, on hover, when the label alone doesn't say. */
  hint?: string;
  /** How much of the budget is spent, 0–100. */
  pct: number;
  /** The fill's tone, from the caller's own threshold helper. */
  color: string;
  /** The number that binds — calls left, or percent used. */
  value: ReactNode;
  resetsAtMs: number | null;
  nowMs: number;
}) {
  return (
    <span className="flex items-center gap-2 text-[10.5px]">
      <span className="w-[62px] flex-none truncate text-muted-4" title={hint}>
        {label}
      </span>
      {/* A hair of fill for anything above zero: a budget that has been touched
          at all should not read as an empty track. */}
      <span className="h-[5px] min-w-0 flex-1 overflow-hidden rounded-full bg-input">
        <span
          className="block h-full rounded-full"
          style={{ width: `${Math.max(pct > 0 ? 1 : 0, pct)}%`, background: color }}
        />
      </span>
      <span className="flex-none tabular-nums text-fg">{value}</span>
      {/* The reset is the other half of the number: 12 search calls left is fine
          when the pool refills in 20 seconds and a wall when it refills in an
          hour, and a 5-hour window at 90% means something different an hour
          before it rolls than a minute before. Coarse here — the precise
          countdown is on the settings meters. */}
      <span className="w-[74px] flex-none text-right text-[10px] text-muted-4">
        {resetsAtMs ? `resets in ${formatUntil(resetsAtMs, nowMs)}` : ""}
      </span>
    </span>
  );
}
