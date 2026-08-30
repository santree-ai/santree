/**
 * The one line that stands in for a worktree's agents while they're collapsed.
 *
 * Collapsed, it is chips: one per **provider**, each a dot, that provider's mark
 * and how many of it are running. That shape answers the two questions a sidebar
 * row is asked at a glance — is anything waiting on me, and who is doing the
 * work — without spending a row per agent, and without a count that belongs to
 * nobody in particular. Expanded, the chips give way to the plain count, because
 * the list underneath is now saying all of it.
 *
 * **Hue is the attention level's, never the provider's.** The mark already says
 * which tool is running, so the colour is free to carry the only other thing a
 * collapsed row has to: what that tool needs. A provider→colour map here would
 * be a second thing colour means in a tree where colour means state (see
 * `AttentionDot`), and would have to disagree with the dot it sits beside.
 *
 * A worktree with exactly one agent never gets this: the agent's own row is
 * shorter *and* says more (see {@link AgentRow}), so summarizing one thing would
 * be strictly worse.
 */
import { alpha } from "../../theme/colors";
import { AgentIcon, ChevronDownIcon } from "../icons";
import { AttentionDot, attentionMeta } from "./AttentionDot";
import { type AgentGroup, describeAgents, splitGroups } from "./agentGrouping";
import type { AgentNode } from "./useProjectTree";

/** One provider's chip: the state of its busiest agent, its mark, its count. */
function ProviderChip({ group }: { group: AgentGroup }) {
  const { level } = group.attention;
  const count = group.agents.length;
  // A wash of the level's own colour, so the chips read as coloured at a glance
  // and a resting one stays out of the way: `idle`'s dot is a near-neutral grey
  // whose 16% mix would disappear, so at rest the chip keeps the tree's plain
  // surface step instead.
  const tint = level === "idle" ? "var(--color-hover-2)" : alpha(16, attentionMeta[level].color);

  return (
    <span
      className="inline-flex flex-none items-center gap-1 rounded-[var(--radius-sm)] px-1 py-0.5"
      style={{ background: tint }}
    >
      <AttentionDot level={level} size={6} />
      {/* A fixed slot, so a session santree can't attribute to a provider keeps
          the chip's shape instead of collapsing onto its dot. */}
      <span className="flex size-3.5 flex-none items-center justify-center">
        {group.kind && <AgentIcon kind={group.kind} size={10} className="text-fg-2" />}
      </span>
      {/* One agent is what a single mark already says; the number earns its
          space only from two. */}
      {count > 1 && <span className="text-[10px] text-muted-2 tabular-nums">{count}</span>}
    </span>
  );
}

export function AgentSummaryRow({
  agents,
  expanded,
  onToggle,
  indent,
}: {
  agents: AgentNode[];
  expanded: boolean;
  onToggle: () => void;
  /** Left gutter, so the chips line up under the title's text column. */
  indent: number;
}) {
  const { visible, hiddenAgents } = splitGroups(agents);

  return (
    <button
      type="button"
      onClick={(e) => {
        // The worktree row's own action is a stretched button behind this one;
        // expanding the agents is not opening the worktree.
        e.stopPropagation();
        onToggle();
      }}
      aria-expanded={expanded}
      aria-label={expanded ? "Collapse agents" : `Expand agents. ${describeAgents(agents)}`}
      title={describeAgents(agents)}
      className="tree-row relative flex h-6 w-full cursor-pointer items-center gap-1 pr-1.5 text-left"
      style={{ paddingLeft: indent }}
    >
      {expanded ? (
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-2">
          {agents.length} agents
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden" aria-hidden>
          {visible.map((group) => (
            <ProviderChip key={group.kind ?? "unknown"} group={group} />
          ))}
          {/* The providers that didn't fit, as agents — a "+2" beside two chips
              means two more sessions, not two more tools. */}
          {hiddenAgents > 0 && (
            <span className="flex-none text-[10px] text-muted-4 tabular-nums">+{hiddenAgents}</span>
          )}
        </span>
      )}
      <ChevronDownIcon
        size={10}
        className={`flex-none text-muted-4 transition-transform duration-150 ${
          expanded ? "" : "-rotate-90"
        }`}
      />
    </button>
  );
}
