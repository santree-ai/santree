/**
 * How several agents on one worktree collapse into a single line.
 *
 * A worktree row has room for one agent, not five, and the sidebar's whole job
 * is to be readable at thirty rows. So a row with more than one agent shows a
 * *summary*: one chip per **provider**, carrying that provider's mark, how many
 * of it are running, and the state of the busiest one. Expanding the row is what
 * gets you the list.
 *
 * Grouping by provider rather than by attention level is what makes the chips
 * answer the question they are actually asked — "what is on this branch, and is
 * any of it waiting on me" — in one pass: three Claudes and a Codex is two
 * chips, not one pile of marks whose count belongs to nobody in particular.
 *
 * **The state a chip shows still comes from `lib/attention.ts` and nowhere
 * else** — {@link highest} over the group's agents, the same aggregation a
 * worktree row's dot and a repo header's dot already use, and
 * {@link compareAttention} for the order. The provider decides which chip an
 * agent lands in; it never decides what colour that chip is. A second notion of
 * agent state living here is exactly the drift that rule exists to prevent.
 */
import type { AgentKind } from "../../bindings";
import { type Attention, compareAttention, highest } from "../../lib/attention";
import { attentionMeta } from "./AttentionDot";
import type { AgentNode } from "./useProjectTree";

/** How many provider chips a collapsed summary shows before the rest become a
 *  trailing count. Three is what fits beside the chevron at the sidebar's
 *  narrowest, and with four known providers plus the unattributable bucket a
 *  row can genuinely have more than that. */
export const MAX_GROUPS = 3;

/** One provider's agents, for a summary chip. */
export interface AgentGroup {
  /** The provider these agents belong to; `null` for a session santree cannot
   *  attribute to one — its own bucket, never lumped in with a real provider. */
  kind: AgentKind | null;
  /** The busiest of `agents`, straight from {@link highest}. The chip's dot, its
   *  tint and its place in the row all read this. */
  attention: Attention;
  agents: AgentNode[];
}

/**
 * Agents grouped by provider, the one that most needs a human first.
 *
 * Order is {@link compareAttention} on each group's aggregate attention — level
 * first, then the most recent event within a level — so the chips read in the
 * same priority the tree sorts by. Ties fall back to the order the providers
 * appeared in, so equal chips keep a fixed position instead of swapping as
 * timestamps arrive.
 */
export function groupByProvider(agents: AgentNode[]): AgentGroup[] {
  const byKind = new Map<string, { kind: AgentKind | null; agents: AgentNode[]; seen: number }>();
  agents.forEach((agent, index) => {
    const kind = agent.entry.agentKind ?? null;
    const group = byKind.get(kind ?? "unknown");
    if (group) group.agents.push(agent);
    else byKind.set(kind ?? "unknown", { kind, agents: [agent], seen: index });
  });
  return [...byKind.values()]
    .map((group) => ({ ...group, attention: highest(group.agents.map((a) => a.attention)) }))
    .sort((a, b) => compareAttention(a.attention, b.attention) || a.seen - b.seen)
    .map(({ kind, agents, attention }) => ({ kind, agents, attention }));
}

/** How a summary splits: the chips that fit, and how many agents didn't. */
export function splitGroups(agents: AgentNode[]): {
  visible: AgentGroup[];
  hiddenAgents: number;
} {
  const groups = groupByProvider(agents);
  const visible = groups.slice(0, MAX_GROUPS);
  const hiddenAgents = groups
    .slice(visible.length)
    .reduce((count, group) => count + group.agents.length, 0);
  return { visible, hiddenAgents };
}

/**
 * The summary in words, for the button's accessible name — a screen reader gets
 * what the chips show, since dots and logomarks say nothing out loud.
 *
 * "3 agents: 2 Claude working, 1 Codex idle". One clause per chip, in chip
 * order, each naming the provider its mark stands for and the state its dot is
 * showing. An unattributable session says "agent", which is all the row knows.
 */
export function describeAgents(agents: AgentNode[]): string {
  const parts = groupByProvider(agents).map((group) => {
    const state = attentionMeta[group.attention.level].label.toLowerCase();
    return `${group.agents.length} ${group.kind ?? "agent"} ${state}`;
  });
  return `${agents.length} agents: ${parts.join(", ")}`;
}
