/**
 * How several agents on one worktree collapse into a single line.
 *
 * A worktree row has room for one agent, not five, and the sidebar's whole job
 * is to be readable at thirty rows. So a row with more than one agent shows a
 * *summary*: one chip per attention level, each carrying the providers inside it
 * and a count of what didn't fit. Expanding the row is what gets you the list.
 *
 * The grouping key is the attention level from `lib/attention.ts` and nothing
 * else — the same classification the dots, the ordering and the "needs you"
 * counts already use. A second notion of agent state living here is exactly the
 * drift that rule exists to prevent.
 */
import { ATTENTION_RANK, type AttentionLevel } from "../../lib/attention";
import { attentionMeta } from "./AttentionDot";
import type { AgentNode } from "./useProjectTree";

/** How many level chips a collapsed summary shows before the rest become a
 *  trailing count. Three is what fits beside the chevron at the sidebar's
 *  narrowest, and there are only four levels, so the fourth is the only one that
 *  can ever be folded away. */
export const MAX_GROUPS = 3;

/** How many provider marks one chip shows. Deduped by provider first, so this
 *  bites only when a single level holds three or more *different* providers. */
export const MAX_ICONS = 3;

/** One attention level's agents, for a summary chip. */
export interface AgentGroup {
  level: AttentionLevel;
  agents: AgentNode[];
}

/**
 * Agents grouped by attention level, most urgent group first.
 *
 * Order comes from `ATTENTION_RANK`, so the chips read in the same priority the
 * tree sorts by: what needs you, what just finished, what is running, what is at
 * rest. Levels nobody is in are absent rather than empty.
 */
export function groupByAttention(agents: AgentNode[]): AgentGroup[] {
  const byLevel = new Map<AttentionLevel, AgentNode[]>();
  for (const agent of agents) {
    const group = byLevel.get(agent.attention.level);
    if (group) group.push(agent);
    else byLevel.set(agent.attention.level, [agent]);
  }
  return [...byLevel.entries()]
    .map(([level, agents]) => ({ level, agents }))
    .sort((a, b) => ATTENTION_RANK[a.level] - ATTENTION_RANK[b.level]);
}

/**
 * Which agents in a group get a provider mark: one per provider, the provider
 * with the most agents first, ties broken by the order they arrived in.
 *
 * Deduping by provider rather than taking the first `max` agents is the point.
 * Four Claude sessions and one Codex session are two marks and a "+3", which
 * says something; five Claude marks in a row say nothing you couldn't get from
 * the count.
 */
export function pickGroupIcons(agents: AgentNode[], max: number = MAX_ICONS): AgentNode[] {
  const byProvider = new Map<string, { agents: AgentNode[]; firstIndex: number }>();
  agents.forEach((agent, index) => {
    // A session with no attributable provider is its own bucket, not lumped in
    // with a real one — the chip shows an empty mark for it.
    const key = agent.entry.agentKind ?? "unknown";
    const group = byProvider.get(key);
    if (group) group.agents.push(agent);
    else byProvider.set(key, { agents: [agent], firstIndex: index });
  });
  return [...byProvider.values()]
    .sort((a, b) => b.agents.length - a.agents.length || a.firstIndex - b.firstIndex)
    .slice(0, max)
    .map((group) => group.agents[0]);
}

/** How a summary splits: the chips that fit, and how many agents didn't. */
export function splitGroups(agents: AgentNode[]): {
  visible: AgentGroup[];
  hiddenAgents: number;
} {
  const groups = groupByAttention(agents);
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
 * "2 agents: 1 needs you, 1 idle". The counts are per level and in the same
 * order as the chips.
 */
export function describeAgents(agents: AgentNode[]): string {
  const parts = groupByAttention(agents).map(
    (group) => `${group.agents.length} ${attentionMeta[group.level].label.toLowerCase()}`,
  );
  return `${agents.length} agents: ${parts.join(", ")}`;
}
