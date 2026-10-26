/** Rate-limit windows, provider-neutral: what the status bar's Usage cluster and
 *  Settings → Agents' account rows both meter. One reading of a provider's wire
 *  shape, so the bar and the settings rows can't disagree about what "5h" is. */
import type { ClaudeRateLimitWindow, CodexRateLimits } from "../../../bindings";

/** Warn/critical thresholds shared with the terminal bar and the tree status
 *  line, so one fill never reads as two different levels of urgent. Below the
 *  warn point the fill stays muted: an unremarkable meter should look like it. */
export function meterColor(pct: number): string {
  if (pct >= 80) return "var(--color-status-red)";
  if (pct >= 60) return "var(--color-status-amber)";
  return "var(--color-muted-4)";
}

/** One rate-limit window, provider-neutral. */
export interface UsageWindow {
  /** "5h", "wk", a model name — what the window is, in a word, for the bar. */
  label: string;
  /** The same thing spelled out, for the panel's labelled rows. */
  longLabel: string;
  pct: number;
  resetsAtMs: number | null;
}

/** A window's name spelled out, for a labelled row: "5h" is enough beside a bar
 *  three characters wide, but as the label column of its own row it reads like a
 *  truncation. A name that isn't a duration (a model's) is already a word. */
function spellOut(label: string): string {
  if (label === "wk") return "Weekly";
  const parsed = /^(\d+)([dhm])$/.exec(label);
  if (!parsed) return label;
  const n = Number(parsed[1]);
  if (parsed[2] === "m") return `${n} min`;
  const unit = parsed[2] === "d" ? "day" : "hour";
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** Claude's windows, by the names the CLI reports them under: the session and
 *  weekly ones first, then anything else (a per-model weekly window, say) by its
 *  own name with the `seven_day_` prefix dropped and the first letter raised. */
export function claudeWindows(rows: ClaudeRateLimitWindow[] | undefined): UsageWindow[] {
  const order = ["five_hour", "seven_day"];
  const rank = (w: string) => (order.includes(w) ? order.indexOf(w) : 99);
  return (rows ?? [])
    .filter((r) => r.usedPct !== null)
    .sort((a, b) => rank(a.window) - rank(b.window) || a.window.localeCompare(b.window))
    .map((r) => {
      const bare = r.window.replace(/^seven_day_/, "");
      const label =
        r.window === "five_hour"
          ? "5h"
          : r.window === "seven_day"
            ? "wk"
            : bare.charAt(0).toUpperCase() + bare.slice(1);
      return {
        label,
        longLabel: spellOut(label),
        pct: Math.round(r.usedPct ?? 0),
        resetsAtMs: r.resetsAtMs,
      };
    });
}

/** Codex reports window length in minutes, and a weekly window is 10080 of them. */
function codexLabel(minutes: number | null, fallback: string): string {
  if (!minutes) return fallback;
  if (minutes >= 10_000) return "wk";
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}d`;
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

export function codexWindows(limits: CodexRateLimits | undefined): UsageWindow[] {
  if (!limits) return [];
  const out: UsageWindow[] = [];
  const pairs: [CodexRateLimits["primary"], string][] = [
    [limits.primary, "5h"],
    [limits.secondary, "wk"],
  ];
  for (const [w, fallback] of pairs) {
    if (!w || typeof w.usedPercent !== "number") continue;
    // Epoch seconds and epoch millis both appear on the wire, told apart by scale.
    const reset =
      w.resetsAt === null ? null : w.resetsAt < 10_000_000_000 ? w.resetsAt * 1_000 : w.resetsAt;
    const label = codexLabel(w.windowMinutes, fallback);
    out.push({
      label,
      longLabel: spellOut(label),
      pct: Math.min(100, Math.round(w.usedPercent)),
      resetsAtMs: reset,
    });
  }
  return out;
}
