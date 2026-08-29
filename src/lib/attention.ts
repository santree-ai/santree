/**
 * Which agent is asking for you, and in what order the tree should show them.
 *
 * The registry already classifies a single session (`bucketOf` → `AgentBucket`).
 * This adds the two things a permanent sidebar needs on top of that:
 *
 *  - **Seen-gating.** A finished agent is only interesting until you have looked
 *    at it. "Done" therefore decays to plain idle once its row has been opened,
 *    while a *blocked* agent never decays — a permission prompt is actionable
 *    right now and must not disappear because you glanced at the row.
 *  - **Aggregation.** A worktree row shows one dot for N agents, and a project
 *    header one for N worktrees, so both need "the most urgent of these".
 *
 * Ordering follows the same ladder: what needs a human first, then what just
 * finished, then what is still running, then everything at rest. Within a level
 * the most recent event wins, so a fresh prompt outranks one that has been
 * blocked (or running) for an hour.
 *
 * It is also where the **three signals about an agent are arbitrated into one
 * level** — see {@link levelOf}. That has to happen here and nowhere else: a
 * status dot, an ordering and a "needs you" count all read this module, so a
 * second place that decided "is this agent working" would be free to disagree
 * with the dot sitting next to it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import type { AgentBucket, AgentEntry } from "../features/agents/registry";
import { classifyAgentTitle } from "../features/terminal/agentTitle";
import { usePersistedState } from "./usePersistedState";

/** Attention levels, most urgent first (see {@link ATTENTION_RANK}). */
export type AttentionLevel = "needs-you" | "done" | "working" | "idle";

/** Sort weight per level — lower sorts first. */
export const ATTENTION_RANK: Record<AttentionLevel, number> = {
  "needs-you": 0,
  done: 1,
  working: 2,
  idle: 3,
};

/** Which signal decided a level (see {@link levelOf}). Never rendered — it is
 *  what makes "why does this row say idle" answerable in a debugger. */
export type AttentionSource = "hook" | "title" | "none";

/** A row's resolved attention: its level and the moment that set it. */
export interface Attention {
  level: AttentionLevel;
  /** Epoch ms of the event behind `level`; 0 when unknown (sorts last). */
  at: number;
  /** Which tier produced `level`. Optional because the aggregates below hand
   *  back attentions no single tier produced. */
  source?: AttentionSource;
}

export const IDLE: Attention = { level: "idle", at: 0, source: "none" };

/**
 * How long a hook event is believed.
 *
 * santree's agent state is hook-driven end to end: a `session_state` row says
 * whatever `santree-hook` last wrote, and holds it forever. That is right until
 * an event goes missing — a dropped `UserPromptSubmit`, a provider whose hook
 * coverage has a gap — at which point a row asserts "working" (or "waiting on
 * you") indefinitely with nothing behind it. Half an hour is the window past
 * which a *non-terminal* claim stops being evidence.
 *
 * The decay is a **rendering** decision and nothing else. The stored row is the
 * record of what the hook actually said and is never rewritten to match what
 * the tree draws; ask again a millisecond earlier and it resolves the old way.
 */
export const HOOK_STALE_AFTER_MS = 30 * 60 * 1000;

/** Acknowledgement timestamps, keyed by the agent's stable identity. */
export type SeenMap = Record<string, number>;

const SEEN_KEY = "santree.agents.seenAt";

/**
 * The key an acknowledgement is stored under. Prefer the logical terminal (a
 * worktree tab keeps its identity across resumes, which is what "I have seen
 * this" should follow); fall back to the session for an unattributed agent.
 */
export function seenKeyOf(entry: AgentEntry): string {
  return entry.termKey ?? `session:${entry.sessionId}`;
}

/**
 * Whether `entry` has produced something since it was last looked at. An entry
 * with no timestamp counts as seen: a row that cannot say *when* it changed
 * would otherwise stay bold forever.
 */
export function isUnseen(entry: AgentEntry, seen: SeenMap): boolean {
  const at = entry.updatedAtMs;
  if (at === null) return false;
  return at > (seen[seenKeyOf(entry)] ?? 0);
}

/** The level a hook-written bucket asserts, taken at face value. */
function levelOfBucket(bucket: AgentBucket): AttentionLevel {
  switch (bucket) {
    case "attention":
      return "needs-you";
    case "working":
      return "working";
    default:
      // `idle` and `detached` both mean "not asking for anything". `done` never
      // reaches here — it is seen-gated by the caller.
      return "idle";
  }
}

/**
 * One agent's attention level, arbitrated from every signal santree has.
 *
 * Three tiers, in strict order, and the order is the design:
 *
 *  1. **A fresh hook event is authoritative.** `santree-hook` sits inside the
 *     agent's own lifecycle, so while its last event is recent nothing may
 *     contradict it — not even a terminal title that disagrees. A finished
 *     session is terminal and never expires: its process is gone, so no later
 *     evidence can exist.
 *  2. **The terminal title, as a fallback, and only with a live PTY.** Past
 *     {@link HOOK_STALE_AFTER_MS} the row has stopped being evidence, and the
 *     spinner a coding CLI animates into its OSC title is the one live signal
 *     left. Gated on the PTY because a title from a dead process is a ghost —
 *     it would say "working" forever. See `agentTitle.ts`, including why this
 *     is display-only and must stay that way.
 *  3. **Nothing.** No fresh event, no title: the row renders at rest rather
 *     than holding an hours-old claim it can no longer support.
 *
 * Seen-gating rides on top, unchanged: `attention` (blocked on permission or
 * input) is never seen-gated — looking at a question does not answer it — while
 * a finished agent is "done" only while unseen, so a tree full of yesterday's
 * completions doesn't outrank today's work.
 *
 * `nowMs` defaults to the clock for callers that re-render often enough not to
 * care exactly when a row decays; the sidebar passes {@link useDecayClock}
 * instead, which fires at the precise instant one does.
 */
export function levelOf(entry: AgentEntry, seen: SeenMap, nowMs: number = Date.now()): Attention {
  const at = entry.updatedAtMs ?? 0;

  // Terminal: the process exited, and that is the last thing that can be true
  // of it. Exempt from the freshness window for the same reason.
  if (entry.bucket === "done") {
    return { level: isUnseen(entry, seen) ? "done" : "idle", at, source: "hook" };
  }
  if (nowMs - at <= HOOK_STALE_AFTER_MS) {
    return { level: levelOfBucket(entry.bucket), at, source: "hook" };
  }

  const fromTitle = entry.live ? classifyAgentTitle(entry.terminalTitle) : null;
  if (fromTitle !== null) return { level: fromTitle, at, source: "title" };

  return { level: "idle", at, source: "none" };
}

/**
 * When `entry` stops being fresh — the one future instant at which its
 * rendering can change without any new data arriving.
 *
 * `null` when it can't decay: a finished session is terminal, and a row with no
 * timestamp is already past every window.
 */
export function decayDeadline(entry: AgentEntry): number | null {
  if (entry.bucket === "done" || entry.updatedAtMs === null) return null;
  return entry.updatedAtMs + HOOK_STALE_AFTER_MS;
}

/**
 * The earliest deadline still ahead of `nowMs`, or `null` when none is.
 *
 * One instant for the whole tree, not one timer per row: with thirty agents
 * open, twenty-nine of those timers would fire while the twenty-ninth-earliest
 * deadline was still hours away.
 */
export function nextDecayAt(entries: Iterable<AgentEntry>, nowMs: number): number | null {
  let soonest: number | null = null;
  for (const entry of entries) {
    const at = decayDeadline(entry);
    if (at === null || at <= nowMs) continue;
    if (soonest === null || at < soonest) soonest = at;
  }
  return soonest;
}

/**
 * A clock that ticks only when it has to: once, at the next moment some row's
 * hook event goes stale.
 *
 * An interval would be the obvious way to make a time-based rendering settle,
 * and it is the wrong one — a poll that runs all day to catch an event that
 * happens twice costs a wakeup per tick, forever, on an app that sits open. A
 * deadline is exact and free: nothing between two expiries can change what any
 * row renders, so there is nothing to re-check until the next one.
 */
export function useDecayClock(entries: readonly AgentEntry[]): number {
  const [now, setNow] = useState(() => Date.now());
  // Computed every render (cheap, linear) but armed only when the answer moves,
  // so a re-render for unrelated reasons doesn't restart the timer.
  const next = nextDecayAt(entries, now);

  useEffect(() => {
    if (next === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()));
    return () => clearTimeout(timer);
  }, [next]);

  return now;
}

/**
 * The most urgent of several attentions — how a worktree row summarizes its
 * agents, and a project header its worktrees. Ties keep the newest event, so the
 * aggregate points at the thing that just happened.
 */
export function highest(items: Iterable<Attention>): Attention {
  let best: Attention = IDLE;
  for (const item of items) {
    const rank = ATTENTION_RANK[item.level] - ATTENTION_RANK[best.level];
    if (rank < 0 || (rank === 0 && item.at > best.at)) best = item;
  }
  return best;
}

/**
 * Sort comparator: level first, then most recent within a level. Callers pass a
 * final tiebreak (a stable label) so equal rows keep a fixed order instead of
 * shuffling as timestamps arrive.
 */
export function compareAttention(a: Attention, b: Attention): number {
  return ATTENTION_RANK[a.level] - ATTENTION_RANK[b.level] || b.at - a.at;
}

/** True for the levels the chrome counts as "a human is needed here". */
export function needsYou(level: AttentionLevel): boolean {
  return level === "needs-you";
}

/**
 * Read/write acknowledgements. Persisted, because an unseen marker that resets
 * on relaunch would light up every finished agent from the previous session.
 */
export function useSeenAgents(): {
  seen: SeenMap;
  markSeen: (entry: AgentEntry) => void;
} {
  const [seen, setSeen] = usePersistedState<SeenMap>(SEEN_KEY, {});

  const markSeen = useCallback(
    (entry: AgentEntry) => {
      const key = seenKeyOf(entry);
      // Stamp with the entry's own event time, not `Date.now()`: acknowledging
      // with a clock reading would also swallow an event that lands in the same
      // moment the row is opened.
      const at = entry.updatedAtMs ?? 0;
      setSeen((prev) => (prev[key] === at ? prev : { ...prev, [key]: at }));
    },
    [setSeen],
  );

  return useMemo(() => ({ seen, markSeen }), [seen, markSeen]);
}
