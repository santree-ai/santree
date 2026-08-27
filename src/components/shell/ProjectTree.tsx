/**
 * The sidebar's project tree: every registered repo, expanding to its worktrees,
 * each expanding to the agents live inside it.
 *
 * This is the permanent answer to "what is happening across my work", which is
 * why it is cross-repo and always mounted rather than scoped to whatever repo
 * the main pane happens to be showing. Depth is capped at three levels and the
 * hierarchy is drawn with indentation and muted tokens only — hue is spent
 * exclusively on state (see `AttentionDot`), so a color anywhere in the tree
 * means something is happening rather than something is nested.
 *
 * A repo whose reads have not landed shows skeleton rows, never an empty
 * section: "you have nothing here" and "we haven't looked yet" are different
 * answers and the second one is not ours to assert.
 *
 * The "Projects" label and the add-project action above it belong to `Sidebar`;
 * this component starts at the first repo header.
 */
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useOpenAgent } from "../../features/agents/useOpenAgent";
import { usePersistedState } from "../../lib/usePersistedState";
import { useApp, useAppUi } from "../../state/AppContext";
import { ChevronDownIcon, ChevronRightIcon } from "../icons";
import { Skeleton } from "../primitives";
import { MilestoneHeading } from "../WorkSignals";
import { AttentionDot } from "./AttentionDot";
import { type AgentNode, type ProjectNode, useProjectTree } from "./useProjectTree";
import { INDENT_PX, WorktreeRow } from "./WorktreeRow";

/** Which sections the user has folded away, by section key. Persisted because a
 *  tree that re-expands every repo on relaunch undoes the one piece of curation
 *  this surface offers. */
const COLLAPSED_KEY = "santree.shell.projectTree.collapsed";

/** Left gutter of a repo header — the tree's level 0. */
const HEADER_GUTTER = 8;

/** Left gutter of a worktree row: one indent level in from its repo header. */
const WORKTREE_GUTTER = HEADER_GUTTER + INDENT_PX;

/** `MilestoneHeading` brings its own `px-2`, so its wrapper only makes up the
 *  difference to the worktree rows it sits above. */
const MILESTONE_GUTTER = WORKTREE_GUTTER - 8;

/** Section key for a repo, and for one milestone band inside it. Namespaced so
 *  the two can share a single persisted record. */
const repoKey = (repo: string) => `repo:${repo}`;
const milestoneKey = (repo: string, key: string) => `ms:${repo}:${key}`;

/**
 * The projects → worktrees → agents tree.
 *
 * Selecting a worktree is a three-part handoff, because every other view is
 * scoped to the active repo: switch the repo, publish the focus request, then
 * navigate. Opening an agent goes through `useOpenAgent`, which already knows
 * how to reach each surface a session can belong to.
 */
export function ProjectTree() {
  const { projects, loading, markSeen } = useProjectTree();
  const navigate = useNavigate();
  const { setActiveRepo } = useApp();
  const { requestTreeFocus } = useAppUi();
  const openAgent = useOpenAgent();

  const [collapsed, setCollapsed] = usePersistedState<Record<string, boolean>>(COLLAPSED_KEY, {});
  const toggle = useCallback(
    (key: string) => setCollapsed((current) => ({ ...current, [key]: !current[key] })),
    [setCollapsed],
  );

  const selectWorktree = useCallback(
    (repo: string, worktreeId: string) => {
      setActiveRepo(repo);
      requestTreeFocus(worktreeId);
      navigate({ to: "/trees" });
    },
    [navigate, setActiveRepo, requestTreeFocus],
  );

  const openAgentRow = useCallback(
    (agent: AgentNode) => {
      // Acknowledge before navigating: the row is about to be looked at, and the
      // seen stamp uses the entry's own event time, not a clock reading.
      markSeen(agent.entry);
      openAgent(agent.entry);
    },
    [markSeen, openAgent],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
      {loading ? (
        <SectionSkeleton />
      ) : (
        projects.map((project) => (
          <ProjectSection
            key={project.repo}
            project={project}
            open={!collapsed[repoKey(project.repo)]}
            isMilestoneOpen={(key) => !collapsed[milestoneKey(project.repo, key)]}
            onToggle={() => toggle(repoKey(project.repo))}
            onToggleMilestone={(key) => toggle(milestoneKey(project.repo, key))}
            onSelectWorktree={(worktreeId) => selectWorktree(project.repo, worktreeId)}
            onOpenAgent={openAgentRow}
          />
        ))
      )}
    </div>
  );
}

function ProjectSection({
  project,
  open,
  isMilestoneOpen,
  onToggle,
  onToggleMilestone,
  onSelectWorktree,
  onOpenAgent,
}: {
  project: ProjectNode;
  open: boolean;
  isMilestoneOpen: (key: string) => boolean;
  onToggle: () => void;
  onToggleMilestone: (key: string) => void;
  onSelectWorktree: (worktreeId: string) => void;
  onOpenAgent: (agent: AgentNode) => void;
}) {
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  const empty = !project.loading && !project.base && project.worktreeCount === 0;

  return (
    <div className="mb-0.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={project.repo}
        className="selection-row flex w-full cursor-pointer items-center gap-1.5 py-[3px] pr-2 text-left"
        style={{ paddingLeft: HEADER_GUTTER }}
      >
        <Chevron size={10} className="flex-none text-muted-4" />
        <AttentionDot level={project.attention.level} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-fg-2">
          {project.label}
        </span>
        <span className="flex-none font-mono text-[10px] text-muted-4 tabular-nums">
          {project.worktreeCount}
        </span>
      </button>

      {open && project.loading && <SectionSkeleton />}

      {open && empty && (
        <div className="py-1 text-[11px] text-muted-4" style={{ paddingLeft: WORKTREE_GUTTER }}>
          No worktrees yet
        </div>
      )}

      {open && project.base && (
        <WorktreeRow
          node={project.base}
          indent={WORKTREE_GUTTER}
          onSelect={() => onSelectWorktree(project.base?.worktree.id ?? "")}
          onOpenAgent={onOpenAgent}
        />
      )}

      {open &&
        project.milestones.map((milestone) => {
          const milestoneOpen = !project.showMilestones || isMilestoneOpen(milestone.key);
          return (
            <div key={milestone.key}>
              {project.showMilestones && (
                <div style={{ paddingLeft: MILESTONE_GUTTER }}>
                  <MilestoneHeading
                    label={milestone.label}
                    count={milestone.worktrees.length}
                    targetDate={milestone.targetDate}
                    open={milestoneOpen}
                    onToggle={() => onToggleMilestone(milestone.key)}
                  />
                </div>
              )}
              {milestoneOpen &&
                milestone.worktrees.map((node) => (
                  <WorktreeRow
                    key={node.worktree.id}
                    node={node}
                    indent={WORKTREE_GUTTER}
                    onSelect={() => onSelectWorktree(node.worktree.id)}
                    onOpenAgent={onOpenAgent}
                  />
                ))}
            </div>
          );
        })}
    </div>
  );
}

/** Placeholder rows for a section whose reads are still in flight. Widths are
 *  derived from the index, not random, so a re-render doesn't reshuffle them. */
function SectionSkeleton() {
  return (
    <div
      className="flex flex-col gap-2 py-1.5"
      style={{ paddingLeft: WORKTREE_GUTTER }}
      aria-hidden
    >
      {[0, 1, 2].map((i) => (
        <div key={i} className="pr-2">
          <Skeleton className="h-3" style={{ width: `${[72, 58, 66][i]}%` }} />
          <Skeleton className="mt-1 h-2" style={{ width: `${[44, 36, 40][i]}%` }} />
        </div>
      ))}
    </div>
  );
}
