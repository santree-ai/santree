/**
 * The API rate-limit meters on Settings → Integrations.
 *
 * Both integrations borrow someone else's quota — `gh`'s GitHub session, the
 * Linear workspace's OAuth grant — and both go quiet in the same confusing way
 * when it runs out: the Reviews inbox empties, the ticket list stops updating,
 * and nothing on screen says why. These meters exist so "santree is broken" and
 * "you have 40 GitHub search calls left this minute" are distinguishable.
 *
 * Deliberately not on the status bar. A budget with thousands of headroom is
 * ambient noise, and the bar is for what is true *now* about the work; this is
 * the sort of number you go and look up when something looks wrong.
 */
import { useEffect, useState } from "react";

import type { ApiBudgetWindow } from "../../bindings";
import { formatUntilPrecise } from "../../lib/format";
import { apiBudgetColor, apiBudgetMeta } from "../../theme/colors";

/**
 * A clock that ticks exactly when one of `resets` would change its own label,
 * and not otherwise.
 *
 * The shared `useLiveNow` runs at 30s, which is useless here: GitHub's search
 * pool refills every 60 seconds, so the interesting countdown is the one that
 * has to move every second. A blanket 1s interval would re-render this panel
 * 3,600 times to watch a pool that resets in an hour, so instead each tick is
 * scheduled for just past the next boundary the label crosses — a second while
 * something is close, a minute while nothing is.
 */
function useCountdownNow(resets: (number | null)[]): number {
  const [now, setNow] = useState(() => Date.now());
  // The scheduling only depends on *when* the resets are, so a re-render with
  // the same times must not restart the timer.
  const key = resets.join(",");

  useEffect(() => {
    const times = key
      .split(",")
      .map(Number)
      .filter((t) => Number.isFinite(t) && t > 0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const at = Date.now();
      setNow(at);
      const soonest = times
        .map((t) => t - at)
        .filter((ms) => ms > 0)
        .reduce((min, ms) => Math.min(min, ms), Number.POSITIVE_INFINITY);
      if (!Number.isFinite(soonest)) return;
      // Under a minute the label counts seconds, so wake on the next second;
      // above it the label only moves on the minute. +1ms so the timeout fires
      // just past the boundary rather than on it.
      const step = soonest < 60_000 ? 1_000 : 60_000;
      timer = setTimeout(schedule, (soonest % step) + 1);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [key]);

  return now;
}

/** One pool: its name, a fill bar, and what's left of it with a reset countdown.
 *
 *  The bar fills with what has been **spent**, not with what remains — a meter
 *  that empties as you work matches how a fuel gauge reads, and an almost-full
 *  bar is then the state worth noticing rather than the resting state. */
function BudgetRow({ window: w, nowMs }: { window: ApiBudgetWindow; nowMs: number }) {
  const meta = apiBudgetMeta[w.kind];
  // `?? 0` because specta cannot export a 64-bit integer, so every count crosses
  // the bridge as `number | null` even though the backend always sends one.
  const limit = w.limit ?? 0;
  const remaining = Math.max(0, w.remaining ?? 0);
  const used = Math.max(0, limit - remaining);
  // A zero limit is a service that answered with nonsense; show the row (the
  // pool exists) but never divide by it.
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const color = apiBudgetColor(remaining, limit);

  return (
    <div className="flex items-center gap-3 border-t border-line px-3 py-2 first:border-t-0">
      <div className="w-[74px] flex-none text-[11.5px] text-fg-3" title={meta.hint}>
        {meta.label}
      </div>
      {/* `bg-input`, not `bg-surface`: the card behind this row is already
          `bg-surface`, so a track of the same tone is invisible and the meter
          reads as a bar floating on nothing rather than as a filled proportion. */}
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-input">
        <div
          className="h-full rounded-full transition-[width] duration-150"
          style={{ width: `${Math.max(pct > 0 ? 1 : 0, pct)}%`, background: color }}
        />
      </div>
      {/* Exact, not compacted: "4.9k of 5k" and "4,982 of 5,000" answer different
          questions, and the one worth asking here is how much is actually left. */}
      <div className="flex-none font-mono text-[11px] text-muted-3">
        {Math.round(remaining).toLocaleString()}
        <span className="text-muted-4"> / {Math.round(limit).toLocaleString()}</span>
      </div>
      {/* The reset is the other half of the number: 12 search calls left is fine
          when the pool refills in 20 seconds and a wall when it refills in an
          hour. Ticks live off the shared clock rather than a refetch. */}
      <div className="w-[92px] flex-none text-right text-[11px] text-muted-4">
        {w.resetsAtMs ? `resets in ${formatUntilPrecise(w.resetsAtMs, nowMs)}` : ""}
      </div>
    </div>
  );
}

/** A card's worth of meters, with a caption naming where the numbers came from.
 *  Renders nothing when there are no windows — an unknown budget is not an empty
 *  one, and a row of zeroes would read as "you're out". */
export function ApiBudgetMeters({
  windows,
  caption,
}: {
  windows: ApiBudgetWindow[];
  caption: string;
}) {
  const nowMs = useCountdownNow(windows.map((w) => w.resetsAtMs));
  if (windows.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-lg border border-line-3 bg-surface">
      {windows.map((w) => (
        <BudgetRow key={w.kind} window={w} nowMs={nowMs} />
      ))}
      <div className="border-t border-line px-3 py-2 text-[11px] text-muted-4">{caption}</div>
    </div>
  );
}
