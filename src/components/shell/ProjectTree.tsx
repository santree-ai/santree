/**
 * The sidebar's project tree: every registered repo, expanding to its worktrees,
 * each expanding to the agents live inside it.
 *
 * This is the permanent answer to "what is happening across my work", which is
 * why it is cross-repo and always mounted rather than scoped to whatever repo
 * the main pane happens to be showing. Depth is capped at three levels and the
 * hierarchy is drawn with indentation and muted tokens only — hue is spent on
 * state (see `AttentionDot`) and on the repo's own mark (`RepoAvatar`, the same
 * one the repo switcher used to carry), so a colored dot anywhere in the tree
 * means something is happening rather than something is nested. A repo header
 * shows its dot only while something under it is not at rest.
 *
 * Vertical rhythm comes from the density tokens in `styles.css`, not per-row
 * pixel values: headers and agent rows are chrome (`--density-compact`), a
 * worktree is a selectable entity (`--density-standard`, see `WorktreeRow`).
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
import { type TreeFocusPane, useApp, useAppUi } from "../../state/AppContext";
import { RepoAvatar } from "../chrome/RepoAvatar";
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

/** Left gutter of a repo header — the tree's level 0. Lines the avatar up with
 *  the "Projects" label above it (`px-4`). */
const HEADER_GUTTER = 16;

/** Left gutter of a worktree row: one indent level in from its repo header. */
const WORKTREE_GUTTER = HEADER_GUTTER + INDENT_PX;

/** A milestone heading sits at the worktree level (`MilestoneHeading` brings its
 *  own `px-2`, so the wrapper makes up the difference) and the worktrees under it
 *  step in one level, so the band reads as a group and not as one more row. */
const MILESTONE_GUTTER = WORKTREE_GUTTER - 8;
const MILESTONE_WORKTREE_GUTTER = WORKTREE_GUTTER + INDENT_PX;

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
  const { requestTreeFocus, openWorktree } = useAppUi();
  const openAgent = useOpenAgent();

  const [collapsed, setCollapsed] = usePersistedState<Record<string, boolean>>(COLLAPSED_KEY, {});
  const toggle = useCallback(
    (key: string) => setCollapsed((current) => ({ ...current, [key]: !current[key] })),
    [setCollapsed],
  );

  const selectWorktree = useCallback(
    // `pane` is what the row's Linear and GitHub marks use to land on the ticket
    // or the pull request; a plain row click keeps the default.
    (repo: string, worktreeId: string, pane?: TreeFocusPane) => {
      setActiveRepo(repo);
      // The sidebar has always landed on the ticket; the marks name their own.
      requestTreeFocus(worktreeId, { pane: pane ?? "issue" });
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
            openWorktreeId={openWorktree?.repo === project.repo ? openWorktree.id : null}
            onSelectWorktree={(worktreeId, pane) => selectWorktree(project.repo, worktreeId, pane)}
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
  openWorktreeId,
  onToggle,
  onToggleMilestone,
  onSelectWorktree,
  onOpenAgent,
}: {
  project: ProjectNode;
  open: boolean;
  isMilestoneOpen: (key: string) => boolean;
  /** The worktree the workspace view has open, when it is one of this repo's. */
  openWorktreeId: string | null;
  onToggle: () => void;
  onToggleMilestone: (key: string) => void;
  onSelectWorktree: (worktreeId: string, pane?: TreeFocusPane) => void;
  onOpenAgent: (agent: AgentNode) => void;
}) {
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  const empty = !project.loading && !project.base && project.worktreeCount === 0;

  return (
    <div className="mb-2">
      {/* The header is the repo's name, not a disclosure control: the fold
          chevron rides at the trailing edge and only shows itself on hover or
          keyboard focus — except while the section is folded, when it stays
          as the one hint that there is more here. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={project.repo}
        className="tree-row group mx-1.5 flex w-[calc(100%-12px)] cursor-pointer items-center gap-2 py-(--density-compact) pr-2 text-left"
        style={{ paddingLeft: HEADER_GUTTER - 6 }}
      >
        <RepoAvatar repo={project.repo} size={16} bordered={false} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-fg-2">
          {project.label}
        </span>
        {project.attention.level !== "idle" && <AttentionDot level={project.attention.level} />}
        {/* No count until the read lands: "0" beside skeleton rows is a claim. */}
        {!project.loading && (
          <span className="flex-none font-mono text-[10px] text-muted-4 tabular-nums">
            {project.worktreeCount}
          </span>
        )}
        <Chevron
          size={10}
          className={`flex-none text-muted-4 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 ${
            open ? "opacity-0" : "opacity-100"
          }`}
        />
      </button>

      {open && project.loading && <SectionSkeleton />}

      {open && empty && (
        <div
          className="py-(--density-compact) text-[11px] text-muted-4"
          style={{ paddingLeft: WORKTREE_GUTTER }}
        >
          No worktrees yet
        </div>
      )}

      {open && project.base && (
        <WorktreeRow
          repo={project.repo}
          node={project.base}
          indent={WORKTREE_GUTTER}
          selected={openWorktreeId === project.base.worktree.id}
          onSelect={() => onSelectWorktree(project.base?.worktree.id ?? "")}
          onOpenPane={(pane) => onSelectWorktree(project.base?.worktree.id ?? "", pane)}
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
                    repo={project.repo}
                    node={node}
                    indent={project.showMilestones ? MILESTONE_WORKTREE_GUTTER : WORKTREE_GUTTER}
                    selected={openWorktreeId === node.worktree.id}
                    onSelect={() => onSelectWorktree(node.worktree.id)}
                    onOpenPane={(pane) => onSelectWorktree(node.worktree.id, pane)}
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
    <div className="flex flex-col gap-3 py-2" style={{ paddingLeft: WORKTREE_GUTTER }} aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="pr-2">
          <Skeleton className="h-3" style={{ width: `${[72, 58, 66][i]}%` }} />
          <Skeleton className="mt-1 h-2" style={{ width: `${[44, 36, 40][i]}%` }} />
        </div>
      ))}
    </div>
  );
}
