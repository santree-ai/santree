/**
 * The sidebar's project tree: every registered repo, expanding to its worktrees,
 * each expanding to the agents live inside it.
 *
 * This is the permanent answer to "what is happening across my work", which is
 * why it is cross-repo and always mounted rather than scoped to whatever repo
 * the main pane happens to be showing. Depth is capped at three levels and the
 * hierarchy is drawn with indentation and muted tokens only — hue is spent on
 * state and on the repo's own mark (`RepoAvatar`, the same
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
import { useCallback, useEffect, useRef, useState } from "react";

import { useOpenAgent } from "../../features/agents/useOpenAgent";
import { CreateWorktreeDialog } from "../../features/trees/CreateWorktreeDialog";
import { usePersistedState } from "../../lib/usePersistedState";
import { type TreeFocus, type TreeFocusPane, useApp, useAppUi } from "../../state/AppContext";
import { RepoAvatar } from "../chrome/RepoAvatar";
import { ChevronDownIcon, ChevronRightIcon, PlusIcon } from "../icons";
import { ProjectGlyph, Skeleton } from "../primitives";
import { MilestoneHeading, ProjectDueDate } from "../WorkSignals";
import {
  type AgentNode,
  ancestorGroupKeys,
  type LinearProjectNode,
  milestoneKey,
  type ProjectNode,
  projectKey,
  repoKey,
  useProjectTree,
} from "./useProjectTree";
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

/** A band heading sits at the worktree level (both headings bring their own
 *  `px-2`, so the wrapper makes up the difference) and the rows under it step in
 *  one level, so a band reads as a group and not as one more row. */
const BAND_GUTTER = WORKTREE_GUTTER - 8;

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
  const { activeRepo, setActiveRepo } = useApp();
  const { requestTreeFocus, openWorktree, treeFocus } = useAppUi();
  const openAgent = useOpenAgent();

  // Which repo's "Create worktree" dialog is open, if any. Held here rather
  // than per-section so only one can ever be open.
  const [createFor, setCreateFor] = useState<string | null>(null);

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
      // `fromSidebar` is what keeps the reveal effect below off a row the user
      // just clicked — it is already in front of them.
      requestTreeFocus(worktreeId, { pane: pane ?? "issue", fromSidebar: true });
      navigate({ to: "/trees" });
    },
    [navigate, setActiveRepo, requestTreeFocus],
  );

  // A worktree picked anywhere else — Issues, the graph, the palette, a
  // session-history row — lands on a row this tree may have folded away, which
  // reads as nothing having happened. Expand its ancestors so the selection is
  // visible. Expanding only: a fold the user chose elsewhere in the tree is not
  // this request's to undo.
  const revealed = useRef<TreeFocus | null>(null);
  useEffect(() => {
    if (!treeFocus || treeFocus.fromSidebar || treeFocus === revealed.current) return;
    const keys = ancestorGroupKeys(projects, treeFocus.id, activeRepo);
    // Not in the tree yet — a worktree still being created, a repo whose read
    // hasn't landed. Leave the request unhandled so the next fold reveals it.
    if (keys.length === 0) return;
    revealed.current = treeFocus;
    setCollapsed((current) => {
      // Nothing folded: return the same record rather than minting one, so a
      // selection that needed no reveal costs no re-render and no write.
      if (keys.every((key) => !current[key])) return current;
      const next = { ...current };
      for (const key of keys) next[key] = false;
      return next;
    });
  }, [treeFocus, projects, activeRepo, setCollapsed]);

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
            isBandOpen={(key) => !collapsed[key]}
            onToggle={() => toggle(repoKey(project.repo))}
            onToggleBand={toggle}
            openWorktreeId={openWorktree?.repo === project.repo ? openWorktree.id : null}
            onSelectWorktree={(worktreeId, pane) => selectWorktree(project.repo, worktreeId, pane)}
            onOpenAgent={openAgentRow}
            onCreateWorktree={() => setCreateFor(project.repo)}
          />
        ))
      )}
      {createFor && <CreateWorktreeDialog repo={createFor} onClose={() => setCreateFor(null)} />}
    </div>
  );
}

/** One repo's section. Exported for its test, which drives it with props rather
 *  than standing up the router, the app context and the query client that the
 *  tree above it needs. */
export function ProjectSection({
  project,
  open,
  isBandOpen,
  openWorktreeId,
  onToggle,
  onToggleBand,
  onSelectWorktree,
  onOpenAgent,
  onCreateWorktree,
}: {
  project: ProjectNode;
  open: boolean;
  /** Whether a band (project or milestone) is expanded, by its persisted key. */
  isBandOpen: (key: string) => boolean;
  /** The worktree the workspace view has open, when it is one of this repo's. */
  openWorktreeId: string | null;
  onToggle: () => void;
  onToggleBand: (key: string) => void;
  onSelectWorktree: (worktreeId: string, pane?: TreeFocusPane) => void;
  onOpenAgent: (agent: AgentNode) => void;
  /** Open the "Create worktree" dialog for this repo. */
  onCreateWorktree: () => void;
}) {
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  const empty = !project.loading && !project.base && project.worktreeCount === 0;

  return (
    <div className="mb-2">
      {/* The header is the repo's name, not a disclosure control: the fold
          chevron rides at the trailing edge and only shows itself on hover or
          keyboard focus — except while the section is folded, when it stays
          as the one hint that there is more here.

          The row is a container with a *stretched* toggle button rather than one
          big button, because "create worktree" is a real button beside it and
          ARIA makes a button's children presentational — nested, it would vanish
          from the accessibility tree (the same pattern `WorktreeRow` uses for its
          Linear/GitHub marks). Every trailing item — the count, the add button,
          the chevron — keeps a permanently reserved fixed-size slot and toggles
          only opacity, so revealing them on hover never reflows the row under the
          pointer that is revealing them. */}
      <div
        className="tree-band group relative mx-1.5 flex w-[calc(100%-12px)] items-center gap-2 py-(--density-compact) pr-1.5"
        style={{ paddingLeft: HEADER_GUTTER - 6 }}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${project.label}`}
          title={project.repo}
          className="absolute inset-0 cursor-pointer"
        />
        <RepoAvatar repo={project.repo} size={16} bordered={false} />
        <span className="pointer-events-none min-w-0 flex-1 truncate text-[12px] font-semibold text-fg-2">
          {project.label}
        </span>
        {/* The count is reference, not news — how many worktrees a repo has does
            not change while you look at it, and a column of numbers down a rail
            that is open all day is noise. So it fades in with the row's other
            trailing controls.

            Rendered always, never conditionally: the slot keeps its width whether
            the number is showing or not (and while the read is still in flight,
            which is why the digits and not the element are what `loading` gates —
            "0" beside skeleton rows is a claim). Only `opacity` animates, so the
            row cannot resize under a pointer that is already on it. `opacity: 0`
            leaves the text in the accessibility tree, so a screen reader still
            reaches the count that a sighted user has to hover for. */}
        <span className="pointer-events-none min-w-[13px] flex-none text-right font-mono text-[10px] text-muted-4 tabular-nums opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          {project.loading ? "" : project.worktreeCount}
        </span>
        <button
          type="button"
          onClick={onCreateWorktree}
          aria-label={`Create worktree in ${project.label}`}
          title="Create worktree"
          className="relative flex h-4 w-4 flex-none cursor-pointer items-center justify-center rounded text-muted-4 opacity-0 transition-opacity hover:bg-hover-2 hover:text-fg-2 focus-visible:opacity-100 group-hover:opacity-100"
        >
          <PlusIcon size={11} />
        </button>
        <Chevron
          size={10}
          className={`pointer-events-none flex-none text-muted-4 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 ${
            open ? "opacity-0" : "opacity-100"
          }`}
        />
      </div>

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

      {/* Two band levels, each of which pays for itself in indentation only when
          it is actually shown: a suppressed heading costs its rows nothing, so a
          repo with one project and no milestones renders the same flat list it
          did before either level existed. */}
      {open &&
        project.linearProjects.map((band) => {
          const bandKey = projectKey(project.repo, band.key);
          const bandOpen = !project.showProjects || isBandOpen(bandKey);
          const milestoneGutter = BAND_GUTTER + (project.showProjects ? INDENT_PX : 0);
          const rowGutter = WORKTREE_GUTTER + (project.showProjects ? INDENT_PX : 0);
          return (
            <div key={band.key}>
              {project.showProjects && (
                <div style={{ paddingLeft: BAND_GUTTER }}>
                  <ProjectBandHeading
                    band={band}
                    open={bandOpen}
                    onToggle={() => onToggleBand(bandKey)}
                  />
                </div>
              )}
              {bandOpen &&
                band.milestones.map((milestone) => {
                  const key = milestoneKey(project.repo, band.key, milestone.key);
                  const milestoneOpen = !band.showMilestones || isBandOpen(key);
                  return (
                    <div key={milestone.key}>
                      {band.showMilestones && (
                        <div style={{ paddingLeft: milestoneGutter }}>
                          <MilestoneHeading
                            label={milestone.label}
                            count={milestone.worktrees.length}
                            targetDate={milestone.targetDate}
                            open={milestoneOpen}
                            onToggle={() => onToggleBand(key)}
                          />
                        </div>
                      )}
                      {milestoneOpen &&
                        milestone.worktrees.map((node) => (
                          <WorktreeRow
                            key={node.worktree.id}
                            repo={project.repo}
                            node={node}
                            indent={rowGutter + (band.showMilestones ? INDENT_PX : 0)}
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
        })}
    </div>
  );
}

/** A Linear project band's folding heading. Quieter than the repo header above
 *  it and louder than the milestone band below — three registers for three
 *  levels, so the depth reads without a rule or a rail. The glyph is the
 *  project's own (emoji or colored dot), the one place hue enters the tree
 *  besides the attention dot. */
function ProjectBandHeading({
  band,
  open,
  onToggle,
}: {
  band: LinearProjectNode;
  open: boolean;
  onToggle: () => void;
}) {
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`${open ? "Collapse" : "Expand"} project ${band.label}`}
      // No focus styling of its own: THE ring is the one global `:focus-visible`
      // rule in styles.css, and a local override escapes its pointer gate.
      className="tree-band flex w-full cursor-pointer items-center gap-1.5 px-2 pt-2.5 pb-1 text-left text-[11px] font-medium text-muted-3 hover:text-fg-2"
    >
      <Chevron size={9} className="flex-none" />
      <ProjectGlyph color={band.color} icon={band.icon} size={6} />
      <span className="truncate">{band.label}</span>
      <span className="font-mono text-[10px] text-muted-4 tabular-nums">{band.worktreeCount}</span>
      <ProjectDueDate date={band.targetDate} />
    </button>
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
