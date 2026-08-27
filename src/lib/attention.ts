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
 */
import { useCallback, useMemo } from "react";

import type { AgentEntry } from "../features/agents/registry";
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

/** A row's resolved attention: its level and the moment that set it. */
export interface Attention {
  level: AttentionLevel;
  /** Epoch ms of the event behind `level`; 0 when unknown (sorts last). */
  at: number;
}

export const IDLE: Attention = { level: "idle", at: 0 };

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

/**
 * One agent's attention level.
 *
 * `attention` (blocked on permission or input) is deliberately not seen-gated —
 * looking at a question does not answer it. A finished agent, by contrast, is
 * only "done" while unseen; afterwards it recedes to idle so a tree full of
 * yesterday's completions doesn't outrank today's work.
 */
export function levelOf(entry: AgentEntry, seen: SeenMap): Attention {
  const at = entry.updatedAtMs ?? 0;
  switch (entry.bucket) {
    case "attention":
      return { level: "needs-you", at };
    case "working":
      return { level: "working", at };
    case "done":
      return isUnseen(entry, seen) ? { level: "done", at } : { level: "idle", at };
    default:
      return { level: "idle", at };
  }
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
