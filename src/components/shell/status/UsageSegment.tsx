/**
 * Usage meters — one per agent provider that currently has something to report.
 *
 * The two providers meter different things, and neither is worth a view of its
 * own: Claude's number is the live context fill of the session closest to
 * compaction (the one you act on), Codex's is the fullest of its rate-limit
 * windows. Both answer the same glance-level question — how much room is left —
 * so they share one meter shape and one ramp: muted until it matters, amber, then
 * red. The detail behind each meter is a click away rather than inline, because
 * the numbers that explain a meter are never the ones you need at a glance.
 *
 * A provider with no data renders nothing. An empty track reads as "0% used",
 * which is a different claim from "nothing has reported yet".
 */
import { type ReactNode, useMemo } from "react";

import type {
  CodexRateLimits,
  CodexRateLimitWindow,
  SessionUsageLive,
  UsageTotals,
} from "../../../bindings";
import { displayFill } from "../../../lib/contextFill";
import { formatCompact, formatUsd } from "../../../lib/format";
import {
  useClaudeUsage,
  useCodexAccount,
  useCodexHealth,
  useCodexRateLimits,
  useSessionUsageLive,
} from "../../../lib/queries";
import { useLiveNow } from "../../../lib/relativeTime";
import { modelVersion } from "../../../theme/colors";
import { AgentIcon } from "../../icons";
import { Dropdown, TerminalActivity } from "../../primitives";
import { StatusButton } from "./StatusSegment";

/** A row older than this is history, not status: the context fill of a session
 *  that went quiet an hour ago is nothing to act on, and a stale meter is worse
 *  than no meter — it claims headroom is gone when the session holding it isn't. */
const FRESH_MS = 30 * 60_000;

/** Warn/critical thresholds shared with the terminal bar and the tree status
 *  line, so one fill never reads as two different levels of urgent. Below the
 *  warn point the fill stays muted: an unremarkable meter should look like it. */
function meterColor(pct: number): string {
  if (pct >= 80) return "var(--color-status-red)";
  if (pct >= 60) return "var(--color-status-amber)";
  return "var(--color-muted-4)";
}

/** The headline tokens for a bucket: input + output + cache **writes**. Cache
 *  reads are the same context re-read every turn — counting them inflates the
 *  figure several-fold and stops it meaning "work done". */
function workTokens(t: UsageTotals): number {
  return (t.inputTokens ?? 0) + (t.outputTokens ?? 0) + (t.cacheWriteTokens ?? 0);
}

function Meter({ pct }: { pct: number }) {
  return (
    <div className="h-[5px] w-12 flex-none overflow-hidden rounded-full bg-input">
      <div
        className="h-full rounded-full"
        style={{ width: `${pct}%`, background: meterColor(pct) }}
      />
    </div>
  );
}

/** One provider's meter: glyph, track, percentage — and its detail on click. */
function MeterSegment({
  kind,
  pct,
  label,
  children,
}: {
  kind: "Claude" | "Codex";
  pct: number;
  label: string;
  children: ReactNode;
}) {
  return (
    <Dropdown
      placement="up"
      menuClassName="w-[232px] px-3 py-2"
      trigger={(toggle) => (
        <StatusButton onClick={toggle} title={label} aria-label={label}>
          <AgentIcon kind={kind} size={11} />
          <Meter pct={pct} />
          <span
            className="w-[26px] text-right text-[10px] tabular-nums"
            // Muted below the warn threshold is the button's own resting color,
            // so it brightens with the rest of the segment on hover.
            style={pct >= 60 ? { color: meterColor(pct) } : undefined}
          >
            {pct}%
          </span>
        </StatusButton>
      )}
    >
      {() => children}
    </Dropdown>
  );
}

/** A label/value line inside a meter's popover. */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3 text-[11px]">
      <span className="text-muted-4">{label}</span>
      <span className="ml-auto tabular-nums text-fg-3">{value}</span>
    </div>
  );
}

/** The freshest, fullest Claude session — the one nearest compaction. */
function fullestClaudeSession(
  rows: SessionUsageLive[] | undefined,
  nowMs: number,
): SessionUsageLive | null {
  let best: SessionUsageLive | null = null;
  for (const row of rows ?? []) {
    if (row.agentKind !== "Claude" || row.usedPct === null) continue;
    if (nowMs - (row.updatedAtMs ?? 0) > FRESH_MS) continue;
    if (!best || row.usedPct > (best.usedPct ?? 0)) best = row;
  }
  return best;
}

/** Period totals, read only once the popover is open — the report behind them is
 *  a cold parse of every local transcript, which the always-mounted bar has no
 *  business paying for until someone asks. */
function ClaudeDetail({ session, pct }: { session: SessionUsageLive; pct: number }) {
  const { data, isLoading, isError } = useClaudeUsage();
  const periods: [string, UsageTotals][] = data
    ? [
        ["Today", data.today],
        ["This week", data.week],
        ["This month", data.month],
      ]
    : [];

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2 text-[11px]">
        <span className="text-fg-2">{modelVersion(session.model)}</span>
        <span className="ml-auto tabular-nums text-muted-3">
          {pct}% of {formatCompact(session.contextSize)}
        </span>
      </div>
      <div className="border-t border-line pt-1.5">
        {isLoading ? (
          <TerminalActivity label="Reading transcripts…" />
        ) : isError || !data ? (
          <div className="text-[11px] text-muted-4">Token totals are unavailable.</div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {periods.map(([label, totals]) => (
              <DetailRow
                key={label}
                label={label}
                value={`${formatCompact(workTokens(totals))} · ${formatUsd(totals.costUsd)}`}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ClaudeMeter() {
  const { data } = useSessionUsageLive();
  // The shared 30s clock, so a session going quiet retires its meter on its own
  // rather than at the next unrelated re-render.
  const nowMs = useLiveNow();
  const session = useMemo(() => fullestClaudeSession(data, nowMs), [data, nowMs]);
  if (!session) return null;

  const pct = displayFill(session.usedPct);
  return (
    <MeterSegment kind="Claude" pct={pct} label={`Claude context ${pct}% full`}>
      <ClaudeDetail session={session} pct={pct} />
    </MeterSegment>
  );
}

/** Codex reports window length in minutes, and a weekly window is 10080 of them. */
function windowLabel(minutes: number | null, fallback: string): string {
  if (!minutes) return fallback;
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}d window`;
  if (minutes >= 60) return `${Math.round(minutes / 60)}h window`;
  return `${minutes}m window`;
}

function windowValue(window: CodexRateLimitWindow): string {
  const used = `${Math.round(window.usedPercent ?? 0)}% used`;
  if (!window.resetsAt) return used;
  // Epoch seconds and epoch millis both appear on the wire, told apart by scale.
  const ms = window.resetsAt < 10_000_000_000 ? window.resetsAt * 1_000 : window.resetsAt;
  return `${used} · resets ${new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}`;
}

function CodexDetail({ limits }: { limits: CodexRateLimits }) {
  const windows: [string, CodexRateLimitWindow | null][] = [
    [windowLabel(limits.primary?.windowMinutes ?? null, "Primary"), limits.primary],
    [windowLabel(limits.secondary?.windowMinutes ?? null, "Secondary"), limits.secondary],
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2 text-[11px]">
        <span className="text-fg-2">Codex</span>
        {limits.plan && <span className="ml-auto text-muted-3">{limits.plan}</span>}
      </div>
      <div className="flex flex-col gap-0.5 border-t border-line pt-1.5">
        {windows.map(([label, window]) =>
          window ? <DetailRow key={label} label={label} value={windowValue(window)} /> : null,
        )}
      </div>
    </div>
  );
}

function CodexMeter() {
  const health = useCodexHealth();
  const account = useCodexAccount(health.data?.available === true);
  const limits = useCodexRateLimits(account.data?.connected === true);

  const data = limits.data;
  if (!data) return null;
  // The binding constraint is whichever window is fullest — a 10%-used 5h window
  // says nothing while the weekly one is nearly spent.
  const percents = [data.primary?.usedPercent, data.secondary?.usedPercent].filter(
    (p): p is number => typeof p === "number",
  );
  if (percents.length === 0) return null;

  const pct = Math.min(100, Math.round(Math.max(...percents)));
  return (
    <MeterSegment kind="Codex" pct={pct} label={`Codex rate limit ${pct}% used`}>
      <CodexDetail limits={data} />
    </MeterSegment>
  );
}

/** Every agent provider's usage meter, in a fixed order so a provider appearing
 *  or going quiet never shuffles the ones beside it. */
export function UsageSegment() {
  return (
    <>
      <ClaudeMeter />
      <CodexMeter />
    </>
  );
}
