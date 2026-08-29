/**
 * The one line that stands in for a worktree's agents while they're collapsed.
 *
 * Collapsed, it is chips: one per attention level, each a dot plus the marks of
 * the providers in it. That shape answers the two questions a sidebar row is
 * asked at a glance — is anything waiting on me, and who is doing the work —
 * without spending a row per agent. Expanded, the chips give way to the plain
 * count, because the list underneath is now saying all of it.
 *
 * A worktree with exactly one agent never gets this: the agent's own row is
 * shorter *and* says more (see {@link AgentRow}), so summarizing one thing would
 * be strictly worse.
 */
import { AgentIcon, ChevronDownIcon } from "../icons";
import { AttentionDot } from "./AttentionDot";
import { type AgentGroup, describeAgents, pickGroupIcons, splitGroups } from "./agentGrouping";
import type { AgentNode } from "./useProjectTree";

/** One level's chip: its dot, a mark per provider, and what didn't fit. */
function GroupChip({ group }: { group: AgentGroup }) {
  const icons = pickGroupIcons(group.agents);
  const hidden = group.agents.length - icons.length;
  return (
    <span className="inline-flex flex-none items-center gap-1 rounded-[var(--radius-sm)] bg-hover-2 px-1 py-0.5">
      <AttentionDot level={group.level} size={6} />
      {/* Overlapped, like a face pile: the marks are one fact ("these providers")
          rather than a list, and at 14px the overlap is what keeps three of them
          from eating the row. */}
      <span className="inline-flex flex-none items-center -space-x-1">
        {icons.map((agent) => (
          <span
            key={agent.entry.sessionId}
            className="flex size-3.5 items-center justify-center rounded-full border border-line-2 bg-panel"
          >
            {agent.entry.agentKind && (
              <AgentIcon kind={agent.entry.agentKind} size={9} className="text-muted-2" />
            )}
          </span>
        ))}
      </span>
      {hidden > 0 && <span className="text-[10px] text-muted-4 tabular-nums">+{hidden}</span>}
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
            <GroupChip key={group.level} group={group} />
          ))}
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
