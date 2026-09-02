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
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ReviewPr, TicketRef } from "../../bindings";
import { useOpenAgent } from "../../features/agents/useOpenAgent";
import { ticketIdFor } from "../../features/reviews/ticket";
import { CreateWorktreeDialog } from "../../features/trees/CreateWorktreeDialog";
import { BULK_TOGGLE_HINT, isBulkToggle, toggleDisclosureMap } from "../../lib/disclosure";
import { useOpenPr } from "../../lib/openPr";
import {
  GITHUB_GROUP_BY_KEY,
  isOptedIn,
  type LinearGroupBy,
  parseGithubGroupBy,
  REVIEWS_SHOW_EMPTY_KEY,
  reviewGroupsByProject,
  usePrTicketsByRepo,
  useReviewCountsByProject,
  useReviews,
  useSetting,
} from "../../lib/queries";
import { usePersistedState } from "../../lib/usePersistedState";
import { type TreeFocus, type TreeFocusPane, useApp, useAppUi } from "../../state/AppContext";
import { RepoAvatar } from "../chrome/RepoAvatar";
import { BranchIcon, ChevronDownIcon, ChevronRightIcon, PlusIcon } from "../icons";
import { Skeleton } from "../primitives";
import { INDENT_PX, MilestoneHeading, ProjectHeading } from "../WorkSignals";
import {
  HeaderCount,
  headerReviewsHint,
  type PrAgents,
  type ProjectReviews,
  ProjectReviewsBadge,
  ProjectReviewsSection,
  showReviewsSection,
} from "./ProjectReviewsSection";
import {
  type AgentNode,
  ancestorGroupKeys,
  groupKeysUnder,
  milestoneKey,
  type ProjectNode,
  prAgentKey,
  projectKey,
  repoKey,
  reviewGroupKey,
  useProjectTree,
} from "./useProjectTree";
import { WorktreeRow } from "./WorktreeRow";

/** A PR with no sessions gets the same array every render, so `listFor` never
 *  hands a row a fresh `[]` and re-renders it for nothing. */
const EMPTY_AGENTS: AgentNode[] = [];

/** Which sections the user has folded away, by section key. Persisted because a
 *  tree that re-expands every repo on relaunch undoes the one piece of curation
 *  this surface offers. */
const COLLAPSED_KEY = "santree.shell.projectTree.collapsed";

/** Which Reviews sections the user has opened, by registry name.
 *
 *  A second record rather than a flag in the one above, because the default runs
 *  the other way: every band in this tree is open until you fold it, and the
 *  Reviews section is folded until you open it. It is a place you go to browse,
 *  and its resting state is the one number that says whether browsing is worth it
 *  — a project that expanded to eight PR rows by default would push the work you
 *  actually have checked out off the screen. Both records hold "not the default",
 *  which is why neither needs seeding. */
const REVIEWS_OPEN_KEY = "santree.shell.projectTree.reviewsOpen";

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
 * Per-project review state for the rows, keyed by registry name.
 *
 * Both reads come out of one cached `useReviews`, so the row and the Reviews view
 * it opens can never disagree about what is waiting. A project with no GitHub
 * `origin` gets no entry at all — it can never own a review, so its row would be
 * a permanent blank rather than a temporary one.
 */
function useProjectReviews(): Map<string, ProjectReviews> {
  const { data: inbox } = useReviews();
  const counts = useReviewCountsByProject();
  const groups = useMemo(() => reviewGroupsByProject(inbox), [inbox]);
  return useMemo(() => {
    const byProject = new Map<string, ProjectReviews>();
    // No inbox yet: unknown, which is not the same as empty — leave the map bare
    // so nothing renders rather than asserting a zero the read hasn't earned.
    for (const project of inbox?.projects ?? []) {
      const row = counts.get(project.repo);
      if (!project.slug || !row) continue;
      byProject.set(project.repo, {
        counts: row,
        connected: inbox?.githubConnected ?? false,
        groups: groups.get(project.repo) ?? [],
      });
    }
    return byProject;
  }, [inbox, counts, groups]);
}

/**
 * The Linear tickets behind the PRs in every project's Reviews section, keyed by
 * project and then by ticket identifier.
 *
 * Only fetched when the nesting actually needs them: with `github_group_by` off
 * — the default — there is nothing to group on, and this should cost no Linear
 * call at all.
 */
function useReviewTickets(
  reviews: Map<string, ProjectReviews>,
  enabled: boolean,
): Map<string, Map<string, TicketRef>> {
  const idsByProject = useMemo(() => {
    const ids = new Map<string, string[]>();
    for (const [repo, entry] of reviews) {
      const wanted = new Set<string>();
      for (const group of entry.groups) {
        for (const pr of group.prs) {
          const id = ticketIdFor(pr);
          if (id) wanted.add(id);
        }
      }
      // Sorted, so a refetch that returns the same PRs in a different order is
      // the same query key rather than a fresh one that refetches.
      ids.set(repo, [...wanted].sort());
    }
    return ids;
  }, [reviews]);

  const byProject = usePrTicketsByRepo(idsByProject, enabled);
  return useMemo(() => {
    const out = new Map<string, Map<string, TicketRef>>();
    for (const [repo, tickets] of byProject) {
      out.set(repo, new Map(tickets.map((ticket) => [ticket.identifier, ticket])));
    }
    return out;
  }, [byProject]);
}

/**
 * The projects → worktrees → agents tree.
 *
 * Selecting a worktree is a three-part handoff, because every other view is
 * scoped to the active repo: switch the repo, publish the focus request, then
 * navigate. Opening an agent goes through `useOpenAgent`, which already knows
 * how to reach each surface a session can belong to.
 */
export function ProjectTree() {
  const { projects, loading, markSeen, agentsByPr } = useProjectTree();
  const navigate = useNavigate();
  const { activeRepo, setActiveRepo } = useApp();
  const { requestTreeFocus, openWorktree, treeFocus } = useAppUi();
  const openAgent = useOpenAgent();
  const openPr = useOpenPr();
  // What the *visible* destination has open, so the rail carries one selection
  // rather than two. A worktree stays lit only while Trees is showing it; open a
  // pull request and the lit row is that PR's. Both are read as plain strings so
  // an unrelated navigation can't re-render the whole tree on a fresh identity.
  const openPrUrl = useRouterState({
    select: (s) =>
      s.location.pathname.startsWith("/reviews")
        ? ((s.location.search as { pr?: string }).pr ?? null)
        : null,
  });
  const inTrees = useRouterState({ select: (s) => s.location.pathname.startsWith("/trees") });
  const reviewsByProject = useProjectReviews();
  // The Reviews section's own nesting, its own setting: a review inbox is a
  // different question from "what am I building", and it is usually short enough
  // that nesting costs more than it explains. Off until you turn it on.
  const reviewGroupBy = parseGithubGroupBy(useSetting("app", GITHUB_GROUP_BY_KEY).data);
  const showEmptyReviews = isOptedIn(useSetting("app", REVIEWS_SHOW_EMPTY_KEY).data);
  const reviewTickets = useReviewTickets(reviewsByProject, reviewGroupBy !== "none");

  const openMergeQueue = useCallback(
    // Same three-part handoff as a worktree: every other view is scoped to the
    // active repo, so a link that only navigated would leave the rest of the app
    // pointing somewhere else. The project and the queue both ride in the route,
    // so a reload lands back on the same queue — the Reviews view holds no view
    // state the rail can't reach (see `routes/reviews.tsx`).
    (repo: string) => {
      setActiveRepo(repo);
      navigate({ to: "/reviews", search: { project: repo, queue: true } });
    },
    [navigate, setActiveRepo],
  );

  // Which repo's "Create worktree" dialog is open, if any. Held here rather
  // than per-section so only one can ever be open.
  const [createFor, setCreateFor] = useState<string | null>(null);

  const [collapsed, setCollapsed] = usePersistedState<Record<string, boolean>>(COLLAPSED_KEY, {});
  // Read at call time so `toggle` keeps one identity across a projects refetch.
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const toggle = useCallback(
    (key: string, bulk = false) =>
      setCollapsed((current) =>
        // ⌘-click reaches the headings *under* this one — a repo's bands and
        // their milestones, a band's milestones. See `lib/disclosure`.
        toggleDisclosureMap(
          current,
          key,
          bulk ? groupKeysUnder(projectsRef.current, key) : [],
          bulk,
        ),
      ),
    [setCollapsed],
  );

  const [reviewsOpen, setReviewsOpen] = usePersistedState<Record<string, boolean>>(
    REVIEWS_OPEN_KEY,
    {},
  );
  // Read at call time: `toggleReviews` decides the groups' state from what the
  // section is *becoming*, which is the opposite of what it holds now.
  const reviewsOpenRef = useRef(reviewsOpen);
  reviewsOpenRef.current = reviewsOpen;
  const toggleReviews = useCallback(
    (repo: string, groupKeys: string[], bulk: boolean) => {
      setReviewsOpen((current) => ({ ...current, [repo]: !current[repo] }));
      // The Reviews heading's own state lives in its own map; what a ⌘-click
      // reaches — its groups — lives in the shared collapse map, so the gesture
      // has to touch both. Opening the section opens its groups with it.
      if (!bulk) return;
      setCollapsed((current) => {
        const collapse = reviewsOpenRef.current[repo] ?? false;
        const next = { ...current };
        for (const key of groupKeys) next[key] = !collapse;
        return next;
      });
    },
    [setReviewsOpen, setCollapsed],
  );

  const selectWorktree = useCallback(
    // `page` is what the row's Linear and GitHub marks use: the ticket or the
    // pull request, opened at reading width as a main tab. A plain row click
    // keeps the default — the ticket, in the rail.
    (repo: string, worktreeId: string, page?: TreeFocusPane) => {
      setActiveRepo(repo);
      // `fromSidebar` is what keeps the reveal effect below off a row the user
      // just clicked — it is already in front of them.
      requestTreeFocus(
        worktreeId,
        page
          ? { pane: page, expand: true, fromSidebar: true }
          : { pane: "issue", fromSidebar: true },
      );
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

  // One object for every section, so a rail full of PR rows doesn't mint a new
  // pair of callbacks per project on each render. Opening an AI review session
  // goes through the same acknowledge-then-navigate path a worktree's agents do.
  const prAgents = useMemo<PrAgents>(
    () => ({
      listFor: (pr) => agentsByPr.get(prAgentKey(pr.repo, pr.number)) ?? EMPTY_AGENTS,
      onOpen: openAgentRow,
    }),
    [agentsByPr, openAgentRow],
  );

  // No viewport of its own: the tree scrolls inside the sidebar's, together
  // with Triage and the Projects label above it (see `Sidebar`).
  return (
    <div className="flex flex-none flex-col pb-2">
      {loading ? (
        <SectionSkeleton />
      ) : (
        projects.map((project) => (
          <ProjectSection
            key={project.repo}
            project={project}
            open={!collapsed[repoKey(project.repo)]}
            isBandOpen={(key) => !collapsed[key]}
            onToggle={(bulk) => toggle(repoKey(project.repo), bulk)}
            onToggleBand={toggle}
            openWorktreeId={inTrees && openWorktree?.repo === project.repo ? openWorktree.id : null}
            onSelectWorktree={(worktreeId, pane) => selectWorktree(project.repo, worktreeId, pane)}
            onOpenAgent={openAgentRow}
            onCreateWorktree={() => setCreateFor(project.repo)}
            reviews={reviewsByProject.get(project.repo) ?? null}
            showEmptyReviews={showEmptyReviews}
            openPrUrl={openPrUrl}
            reviewGroupBy={reviewGroupBy}
            reviewTickets={reviewTickets.get(project.repo)}
            reviewsOpen={reviewsOpen[project.repo] ?? false}
            onToggleReviews={(bulk) =>
              toggleReviews(
                project.repo,
                (reviewsByProject.get(project.repo)?.groups ?? []).map((group) =>
                  reviewGroupKey(project.repo, group.key),
                ),
                bulk,
              )
            }
            onOpenMergeQueue={() => openMergeQueue(project.repo)}
            prAgents={prAgents}
            onOpenPrInInbox={(pr) => {
              setActiveRepo(project.repo);
              openPr(pr.url);
            }}
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
  reviews = null,
  showEmptyReviews = false,
  openPrUrl = null,
  reviewGroupBy = "none",
  reviewTickets,
  reviewsOpen = false,
  onToggleReviews,
  onOpenMergeQueue,
  onOpenPrInInbox,
  prAgents,
}: {
  project: ProjectNode;
  open: boolean;
  /** Whether a band (project or milestone) is expanded, by its persisted key. */
  isBandOpen: (key: string) => boolean;
  /** The worktree the workspace view has open, when it is one of this repo's. */
  openWorktreeId: string | null;
  /** `bulk` is the ⌘-click: apply this heading's new state to everything under
   *  it (see `lib/disclosure`). */
  onToggle: (bulk: boolean) => void;
  onToggleBand: (key: string, bulk: boolean) => void;
  onSelectWorktree: (worktreeId: string, pane?: TreeFocusPane) => void;
  onOpenAgent: (agent: AgentNode) => void;
  /** Open the "Create worktree" dialog for this repo. */
  onCreateWorktree: () => void;
  /** This project's review inbox, or `null` while the read is in flight (or when
   *  the project has no GitHub remote). See {@link showReviewsSection}. */
  reviews?: ProjectReviews | null;
  /** Draw the Reviews section on a project with nothing waiting. Off by default
   *  — see `REVIEWS_SHOW_EMPTY_KEY`. */
  showEmptyReviews?: boolean;
  /** The pull request the Reviews view has open, by url — the section's own
   *  selection. `null` whenever Reviews isn't the visible destination. */
  openPrUrl?: string | null;
  /** How the Reviews section nests inside each of its blocks. */
  reviewGroupBy?: LinearGroupBy;
  /** This project's PR tickets by identifier — what that nesting groups on. */
  reviewTickets?: Map<string, TicketRef>;
  /** The Reviews section is expanded. Defaults closed — see {@link REVIEWS_OPEN_KEY}. */
  reviewsOpen?: boolean;
  onToggleReviews?: (bulk: boolean) => void;
  /** Open Reviews on this project's merge queue — the section's one row that
   *  isn't a pull request. */
  onOpenMergeQueue: () => void;
  /** Open one PR in the Reviews view — where a PR whose branch isn't checked out
   *  locally has to go, since there is no worktree to show it beside. */
  onOpenPrInInbox?: (pr: ReviewPr) => void;
  /** The AI review sessions to hang under this project's PR rows. */
  prAgents?: PrAgents;
}) {
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  const empty = !project.loading && !project.base && project.worktreeCount === 0;
  // Narrowed once so the header badge and the row below it can never disagree
  // about whether this project has anything to say.
  const reviewRow = showReviewsSection(reviews, showEmptyReviews) ? reviews : null;
  // The breakdown behind the header's reviews count lives on the header's own
  // tooltip: the count sits under the stretched toggle and can't hold one.
  const reviewsHint = headerReviewsHint(reviewRow);

  return (
    <div className="mb-1">
      {/* The header is the repo's name, not a disclosure control: the fold
          chevron rides inline after the name and only shows itself on hover or
          keyboard focus — except while the section is folded, when it stays
          as the one hint that there is more here. The create button sits with
          it. Both live in the room between the name and the counts rather than
          at the trailing edge: held open there, their slot was a gap the header
          wore all day, with the counts stranded short of the edge every other
          row reaches. Here the counts sit flush right, and revealing the two
          moves nothing — they appear in space that was empty, and only a name
          already at its limit truncates a little sooner.

          The row is a container with a *stretched* toggle button rather than one
          big button, because "create worktree" is a real button beside it and
          ARIA makes a button's children presentational — nested, it would vanish
          from the accessibility tree (the same pattern `WorktreeRow` uses for its
          Linear/GitHub marks). */}
      <div
        className="tree-band group relative mx-1.5 flex w-[calc(100%-12px)] items-center gap-2 py-(--density-compact) pr-1.5"
        style={{ paddingLeft: HEADER_GUTTER - 6 }}
      >
        <button
          type="button"
          onClick={(e) => onToggle(isBulkToggle(e))}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${project.label}`}
          title={[project.repo, reviewsHint, BULK_TOGGLE_HINT].filter(Boolean).join("\n")}
          className="absolute inset-0 cursor-pointer"
        />
        <RepoAvatar repo={project.repo} size={16} bordered={false} />
        <span className="pointer-events-none min-w-0 truncate text-[12px] font-semibold text-fg-2">
          {project.label}
        </span>
        <Chevron
          size={10}
          className={`pointer-events-none -ml-1 flex-none text-muted-4 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 ${
            open ? "opacity-0" : "opacity-100"
          }`}
        />
        <button
          type="button"
          onClick={onCreateWorktree}
          aria-label={`Create worktree in ${project.label}`}
          title="Create worktree"
          className="relative flex h-4 w-4 flex-none cursor-pointer items-center justify-center rounded text-muted-4 opacity-0 transition-opacity hover:bg-hover-2 hover:text-fg-2 focus-visible:opacity-100 group-hover:opacity-100"
        >
          <PlusIcon size={11} />
        </button>
        {/* Two counts, always on, open or folded: what is waiting on you, and how
            much of this repo is checked out. Both are reference the user asked to
            read at a glance rather than hover for — folded, they are all that is
            left of the project; open, a number beside the name is still quicker
            than a scan of the rows under it. Each number sits with its own glyph
            so neither reads as belonging to the chevron.

            Both counts show only when there is something to say — the rule the
            reviews tooltip breakdown follows (`headerReviewsHint`); a quiet
            project is silent, not a pair of noughts. While the worktree read is
            in flight the count keeps its slot with blank digits ("0" beside
            skeleton rows is a claim), so a number that lands doesn't move the
            row; a zero that lands takes the slot with it. */}
        <span className="pointer-events-none ml-auto flex flex-none items-center gap-2">
          {reviewRow && <ProjectReviewsBadge reviews={reviewRow} />}
          {(project.loading || project.worktreeCount > 0) && (
            <HeaderCount
              icon={<BranchIcon size={10} />}
              count={project.loading ? null : project.worktreeCount}
              srLabel="worktrees"
            />
          )}
        </span>
      </div>

      {/* Above the checkout and above the work: what is coming *in* to this
          project, before what is already on disk. Outside the `loading` gate on
          purpose — the inbox is its own read and lands on its own schedule, so it
          shouldn't wait on the worktree list to be allowed on screen. */}
      {open && reviewRow && (
        <ProjectReviewsSection
          project={project.label}
          repo={project.repo}
          reviews={reviewRow}
          bandIndent={BAND_GUTTER}
          open={reviewsOpen}
          onToggle={(bulk) => onToggleReviews?.(bulk)}
          isGroupOpen={(group) => isBandOpen(reviewGroupKey(project.repo, group))}
          onToggleGroup={(group, bulk) => onToggleBand(reviewGroupKey(project.repo, group), bulk)}
          onOpenMergeQueue={onOpenMergeQueue}
          openPrUrl={openPrUrl}
          groupBy={reviewGroupBy}
          ticketFor={(pr) => reviewTickets?.get(ticketIdFor(pr) ?? "")}
          // A PR row opens the pull request, always — even when the same work has
          // a worktree row a few lines below it. The two are separate entities
          // that happen to share a checkout: one is here to be reviewed, the
          // other to be worked in. Routing this row to the worktree (which it
          // used to do, on the theory that your own PR belongs in Trees) meant
          // clicking "review this" and landing in the editor.
          onOpenPr={(pr) => onOpenPrInInbox?.(pr)}
          agents={prAgents}
        />
      )}

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
          onOpenPage={(page) => onSelectWorktree(project.base?.worktree.id ?? "", page)}
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
                  <ProjectHeading
                    label={band.label}
                    count={band.worktreeCount}
                    color={band.color}
                    icon={band.icon}
                    targetDate={band.targetDate}
                    open={bandOpen}
                    onToggle={(bulk) => onToggleBand(bandKey, bulk)}
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
                            onToggle={(bulk) => onToggleBand(key, bulk)}
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
                            onOpenPage={(page) => onSelectWorktree(node.worktree.id, page)}
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
