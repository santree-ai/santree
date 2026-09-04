/**
 * The sidebar tree's data fold: every registered repo, its worktrees, and the
 * live agents sitting on each one.
 *
 * A single-repo rail can read "the active repo" and be done. A permanent sidebar
 * cannot — its whole point is that work in a repo you are not looking at still
 * reaches you — so every read here is the `*ByRepo` variant over the full
 * registration list rather than the scoped one, and the fold below is what turns
 * those per-repo maps into one ordered tree.
 *
 * Two orderings meet here and the precedence matters. Attention (see
 * `lib/attention.ts`) decides which worktree is worth looking at, so it sorts
 * first, with a label tiebreak so an all-idle repo keeps a fixed order instead
 * of reshuffling as timestamps land. Linear's planning grouping (project and/or
 * milestone, per the `linear_group_by` setting) and the stacked-branch nesting
 * the Trees rail established then apply *inside* that order — a branch
 * relationship must not drag a row across its planning boundary, and neither
 * structure should outrank "this one is blocked on you".
 */
import { useCallback, useEffect, useMemo } from "react";

import type { Task, Worktree, WorktreePr } from "../../bindings";
import { type AgentEntry, agentKey } from "../../features/agents/registry";
import { useAgentEntries } from "../../features/agents/useAgents";
import { mergeWorktrees } from "../../features/trees/model";
import { stackWorktrees } from "../../features/trees/worktreeGrouping";
import {
  type Attention,
  compareAttention,
  highest,
  IDLE,
  isUnseen,
  levelOf,
  type SeenMap,
  useDecayClock,
  useSeenAgents,
} from "../../lib/attention";
import {
  LINEAR_GROUP_BY_KEY,
  type LinearGroupBy,
  parseLinearGroupBy,
  useBaseWorktreesByRepo,
  useRepos,
  useSetting,
  useTasksByRepo,
  useWorktreePrsByRepo,
  useWorktreesByRepo,
} from "../../lib/queries";
import { shortRepoName } from "../../lib/repoName";
import { useAppUi } from "../../state/AppContext";
import { PROJECT_FALLBACK } from "../../theme/colors";
import {
  groupByMilestone,
  groupByProject,
  type MilestoneGroup,
  NO_MILESTONE,
  NO_PROJECT,
  type ProjectGroup,
  showMilestoneGroups,
  showProjectGroups,
} from "../WorkSignals";

/** Stable stand-in for "the session read hasn't landed yet", so a render before
 *  it does doesn't hand every memo below a fresh array identity. */
const EMPTY_ENTRIES: AgentEntry[] = [];

/** One live agent as a tree row. */
export interface AgentNode {
  entry: AgentEntry;
  /** It has produced something since the row was last opened — rendered bolder. */
  unseen: boolean;
  attention: Attention;
}

/** One worktree row, with the agents nested under it. */
export interface WorktreeNode {
  worktree: Worktree;
  /** Nesting level under the worktree this one branched off (see `stackWorktrees`). */
  depth: number;
  /** The repo's **own checkout**, which leads its section — not "the default
   *  branch": it sits on whatever branch it was last left on, which is often a
   *  feature branch someone is working in. Naming it for the default branch is
   *  what made the old `primary` badge read as a claim the data never made. */
  primary: boolean;
  prs: WorktreePr[];
  /** The Linear ticket this worktree was started from, when it is one. */
  task: Task | null;
  agents: AgentNode[];
  /** The most urgent of `agents` — the row's own dot. */
  attention: Attention;
}

/** A Linear milestone band inside one project band. */
export interface MilestoneNode {
  key: string;
  label: string;
  targetDate: string | null;
  worktrees: WorktreeNode[];
}

/**
 * A Linear **project** band inside one repo's section.
 *
 * Qualified because the sidebar's own "Projects" are the registered repos (see
 * {@link ProjectNode}); this is the project a Linear issue belongs to.
 *
 * Every mode builds this level, including the ones that don't group by project:
 * with grouping off the section holds a single band whose heading is suppressed,
 * so the sidebar renders one tree shape instead of branching on the setting.
 */
export interface LinearProjectNode {
  key: string;
  label: string;
  /** Linear's own project color, or the shared fallback when it has none. */
  color: string;
  /** An emoji, a Linear icon name, or nothing — see `ProjectGlyph`. */
  icon: string | null;
  targetDate: string | null;
  milestones: MilestoneNode[];
  /** Whether the milestone headings **inside this band** carry information (see
   *  `showMilestoneGroups`). Per band, not per repo: one project can be split
   *  across real milestones while the next has none at all. */
  showMilestones: boolean;
  /** Rows in the band — the count beside its heading. */
  worktreeCount: number;
}

/** One repo's collapsible section. */
export interface ProjectNode {
  /** The registered repo name — the id every action keys off. */
  repo: string;
  /** Its short name, for the header. */
  label: string;
  /** The repo's own checkout (see {@link WorktreeNode.primary} — whatever branch
   *  it holds, not necessarily the default one), or `null` with no local path. */
  base: WorktreeNode | null;
  /** The section's work, always one level of project bands deep (see
   *  {@link LinearProjectNode}). */
  linearProjects: LinearProjectNode[];
  /** Whether the project headings carry information here (see `showProjectGroups`). */
  showProjects: boolean;
  /** Task worktrees in this repo — the count beside the header. */
  worktreeCount: number;
  /** The most urgent of every row in the section — the header's dot. */
  attention: Attention;
  /** This repo's worktree read is still in flight; the section shows skeletons. */
  loading: boolean;
}

export interface ProjectTreeModel {
  projects: ProjectNode[];
  /** The repo list itself is still in flight — nothing can be grouped yet. */
  loading: boolean;
  /** Acknowledge an agent row, clearing its unseen treatment. */
  markSeen: (entry: AgentEntry) => void;
  /** The AI review sessions running on each pull request, keyed by
   *  {@link prAgentKey}. Not folded into `projects` the way worktree agents are:
   *  a PR reaches the rail from the Reviews inbox, which is a different read on a
   *  different schedule, so the section that draws those rows looks its agents up
   *  rather than being handed a tree with them already inside. */
  agentsByPr: Map<string, AgentNode[]>;
}

/**
 * The key an agent is filed under: its repo and the worktree its `term_key`
 * attributes it to. Repo-qualified because two repos routinely carry the same
 * ticket id, and an unqualified key would hang one repo's agents off the other's
 * row.
 */
export function worktreeKey(repo: string, worktreeId: string): string {
  // A vertical tab, not a NUL: git classifies a file holding a raw NUL as binary,
  // which silently drops it from every diff, grep and review. It only has to be a
  // character that can't appear in a repo name or a ticket id.
  return `${repo}\v${worktreeId}`;
}

/**
 * Section keys for the sidebar's persisted collapse record: a repo, a Linear
 * project band inside it, and a milestone band inside that. Namespaced so all
 * three can share a single record; the milestone key carries its project because
 * two projects routinely hold a band with the same name (their "No milestone").
 */
export const repoKey = (repo: string) => `repo:${repo}`;
export const projectKey = (repo: string, key: string) => `proj:${repo}:${key}`;
export const milestoneKey = (repo: string, project: string, key: string) =>
  `ms:${repo}:${project}:${key}`;
/** One block inside a project's Reviews section. Namespaced the same way, so
 *  folding "Assigned to me" in one project leaves it open in the next. (The
 *  section's own fold is not here: it defaults the other way, and lives in its
 *  own record — see `REVIEWS_OPEN_KEY`.) */
export const reviewGroupKey = (repo: string, group: string) => `reviews:${repo}:${group}`;

/**
 * The sections that have to be open for one worktree's row to be on screen,
 * outermost first — and only the ones that actually gate it: a suppressed
 * heading (see {@link ProjectNode.showProjects} and
 * {@link LinearProjectNode.showMilestones}) renders its rows unconditionally, so
 * there is nothing to expand at that level.
 *
 * This is what a selection made *outside* the sidebar needs. The row it lands on
 * is worthless as confirmation while it sits folded away inside a collapsed
 * parent, and the tree has no other way to know which parents those are.
 *
 * `repo` narrows the answer without restricting it: two repos routinely carry
 * the same ticket id, and revealing both beats revealing neither when the active
 * repo hasn't caught up with the selection yet.
 *
 * Exported for testing.
 */
export function ancestorGroupKeys(
  projects: ProjectNode[],
  worktreeId: string,
  repo?: string | null,
): string[] {
  const holders = projects
    .map((project) => ({ project, keys: sectionKeysFor(project, worktreeId) }))
    .filter((hit): hit is { project: ProjectNode; keys: string[] } => hit.keys !== null);
  const scoped = holders.filter((hit) => hit.project.repo === repo);
  return (scoped.length > 0 ? scoped : holders).flatMap((hit) => hit.keys);
}

/**
 * Every collapsible key *under* one — what a ⌘-click on that heading reaches.
 *
 * A repo section reaches its project bands and their milestones; a band reaches
 * its own milestones; a milestone has nothing below it that folds, so it gets
 * an empty scope and the gesture is simply a plain toggle there. Bands and
 * milestones that this section doesn't draw (`showProjects`, `showMilestones`)
 * are left out: a key nothing renders would persist a collapse state for a row
 * that isn't there, and reappear the day the section starts drawing it.
 */
export function groupKeysUnder(projects: ProjectNode[], key: string): string[] {
  const out: string[] = [];
  for (const project of projects) {
    const isRepo = key === repoKey(project.repo);
    for (const band of project.linearProjects) {
      const bandK = projectKey(project.repo, band.key);
      if (!isRepo && key !== bandK) continue;
      if (isRepo && project.showProjects) out.push(bandK);
      if (!band.showMilestones) continue;
      for (const milestone of band.milestones) {
        out.push(milestoneKey(project.repo, band.key, milestone.key));
      }
    }
  }
  return out;
}

/** One section's keys, or `null` when the worktree isn't in it. */
function sectionKeysFor(project: ProjectNode, worktreeId: string): string[] | null {
  // The repo's own checkout leads the section and sits under no band.
  if (project.base?.worktree.id === worktreeId) return [repoKey(project.repo)];
  for (const band of project.linearProjects) {
    for (const milestone of band.milestones) {
      if (!milestone.worktrees.some((node) => node.worktree.id === worktreeId)) continue;
      return [
        repoKey(project.repo),
        ...(project.showProjects ? [projectKey(project.repo, band.key)] : []),
        ...(band.showMilestones ? [milestoneKey(project.repo, band.key, milestone.key)] : []),
      ];
    }
  }
  return null;
}

/** A worktree's stable sort label — the tiebreak that keeps equal rows still. */
function labelOf(worktree: Worktree): string {
  return worktree.title || worktree.id;
}

/**
 * File every agent under the worktree that owns it.
 *
 * Only the worktree-borne surfaces (`tree`, `tree-tab`) are placed: a triage
 * investigation or a PR review runs at the repo root and belongs to its own nav
 * item, so hanging it off a worktree row would claim an ownership the term key
 * does not assert.
 *
 * Exported for testing.
 */
export function groupAgentsByWorktree(
  entries: AgentEntry[],
  seen: SeenMap,
  nowMs: number = Date.now(),
): Map<string, AgentNode[]> {
  const byWorktree = new Map<string, AgentNode[]>();
  for (const entry of entries) {
    const { kind, ticket } = entry.origin;
    if (kind !== "tree" && kind !== "tree-tab") continue;
    if (!entry.repo || !ticket) continue;
    const node: AgentNode = {
      entry,
      unseen: isUnseen(entry, seen),
      attention: levelOf(entry, seen, nowMs),
    };
    const key = worktreeKey(entry.repo, ticket);
    byWorktree.set(key, [...(byWorktree.get(key) ?? []), node]);
  }
  for (const nodes of byWorktree.values()) {
    nodes.sort(
      (a, b) =>
        compareAttention(a.attention, b.attention) ||
        agentKey(a.entry).localeCompare(agentKey(b.entry)),
    );
  }
  return byWorktree;
}

/** The key an AI review session is filed under: `owner/name#number`, exactly as
 *  `AiReviewSessionPane` mints it into the `ai-review:` term key. Not
 *  repo-qualified the way {@link worktreeKey} is — a PR slug already names its
 *  GitHub repo, and the registered santree project a session was launched under
 *  is not part of what it is a review *of*. */
export function prAgentKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

/**
 * The same fold as {@link groupAgentsByWorktree}, for the sessions that belong to
 * a pull request instead of a checkout.
 *
 * Both review kinds land here. `ai-review` is what the AI review launches today;
 * `review` is the retired read-only pane's, kept because a session minted under
 * it can still be alive, and a live agent the rail can't show is worse than one
 * whose surface has moved on.
 */
export function groupAgentsByPr(
  entries: AgentEntry[],
  seen: SeenMap,
  nowMs: number = Date.now(),
): Map<string, AgentNode[]> {
  const byPr = new Map<string, AgentNode[]>();
  for (const entry of entries) {
    const { kind, pr } = entry.origin;
    if (kind !== "ai-review" && kind !== "review") continue;
    if (!pr) continue;
    const node: AgentNode = {
      entry,
      unseen: isUnseen(entry, seen),
      attention: levelOf(entry, seen, nowMs),
    };
    byPr.set(pr, [...(byPr.get(pr) ?? []), node]);
  }
  for (const nodes of byPr.values()) {
    nodes.sort(
      (a, b) =>
        compareAttention(a.attention, b.attention) ||
        agentKey(a.entry).localeCompare(agentKey(b.entry)),
    );
  }
  return byPr;
}

/**
 * The same fold again, for triage investigations, keyed by the ticket alone.
 *
 * Not repo-qualified the way {@link worktreeKey} is: the row these hang under is
 * the Linear issue itself, not a checkout of it, and an investigation of AK-1
 * run from another registered checkout is still an investigation of AK-1.
 *
 * Exported for testing.
 */
export function groupAgentsByTicket(
  entries: AgentEntry[],
  seen: SeenMap,
  nowMs: number = Date.now(),
): Map<string, AgentNode[]> {
  const byTicket = new Map<string, AgentNode[]>();
  for (const entry of entries) {
    const { kind, ticket } = entry.origin;
    if (kind !== "triage" || !ticket) continue;
    const node: AgentNode = {
      entry,
      unseen: isUnseen(entry, seen),
      attention: levelOf(entry, seen, nowMs),
    };
    byTicket.set(ticket, [...(byTicket.get(ticket) ?? []), node]);
  }
  for (const nodes of byTicket.values()) {
    nodes.sort(
      (a, b) =>
        compareAttention(a.attention, b.attention) ||
        agentKey(a.entry).localeCompare(agentKey(b.entry)),
    );
  }
  return byTicket;
}

/**
 * Fold one repo's reads into its section.
 *
 * `worktrees === undefined` is "we haven't looked yet", not "there is nothing" —
 * it becomes `loading`, and the section renders skeletons rather than asserting
 * an empty repo.
 *
 * Exported for testing.
 */
export function buildProjectNode(input: {
  repo: string;
  worktrees: Worktree[] | undefined;
  base: Worktree | null | undefined;
  tasks: Task[];
  prs: WorktreePr[];
  agentsByWorktree: Map<string, AgentNode[]>;
  /** Which levels of Linear's planning structure the tree nests by. */
  groupBy: LinearGroupBy;
}): ProjectNode {
  const { repo, worktrees, base, tasks, prs, agentsByWorktree, groupBy } = input;

  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  // A project's colour and icon belong to the *project*, not to the ticket that
  // happens to carry them — so any live ticket in a project can supply them for a
  // worktree whose own ticket no longer resolves (an issue that has aged out of
  // the active set still names its project on the worktree row). Keyed by name
  // because that is all the worktree kept.
  const projectMetaByName = new Map(
    tasks
      .filter((task) => task.projectColor || task.projectIcon || task.projectTargetDate)
      .map((task) => [task.project, task]),
  );
  const prsByWorktree = new Map<string, WorktreePr[]>();
  for (const pr of prs) {
    prsByWorktree.set(pr.issueId, [...(prsByWorktree.get(pr.issueId) ?? []), pr]);
  }

  const nodeOf = (worktree: Worktree, depth: number, primary: boolean): WorktreeNode => {
    const agents = agentsByWorktree.get(worktreeKey(repo, worktree.id)) ?? [];
    return {
      worktree,
      depth,
      primary,
      prs: prsByWorktree.get(worktree.id) ?? [],
      task: primary ? null : (tasksById.get(worktree.id) ?? null),
      agents,
      attention: highest(agents.map((agent) => agent.attention)),
    };
  };

  const list = worktrees ?? [];
  const attentionById = new Map(
    list.map((worktree) => [
      worktree.id,
      highest((agentsByWorktree.get(worktreeKey(repo, worktree.id)) ?? []).map((a) => a.attention)),
    ]),
  );
  const ordered = [...list].sort(
    (a, b) =>
      compareAttention(attentionById.get(a.id) ?? IDLE, attentionById.get(b.id) ?? IDLE) ||
      labelOf(a).localeCompare(labelOf(b)),
  );

  // Both levels are always built; the setting only decides whether each one is
  // grouped for real or collapsed into a single suppressed band. A row therefore
  // sits in exactly one project band and exactly one milestone band in every
  // mode, which is what keeps it from being rendered twice.
  const wholeSection = (items: Worktree[]): ProjectGroup<Worktree>[] =>
    items.length === 0
      ? []
      : [{ key: NO_PROJECT, label: NO_PROJECT, color: null, icon: null, targetDate: null, items }];
  const oneBand = (items: Worktree[]): MilestoneGroup<Worktree>[] => [
    {
      key: NO_MILESTONE,
      label: NO_MILESTONE,
      targetDate: null,
      sortOrder: Number.POSITIVE_INFINITY,
      items,
    },
  ];

  const byProject =
    groupBy === "project" || groupBy === "project_milestone"
      ? groupByProject(ordered, (worktree) => {
          const task = tasksById.get(worktree.id);
          // The live ticket first — it is the only source that also carries the
          // project's colour, icon and target date.
          if (task) {
            return {
              name: task.project,
              color: task.projectColor,
              icon: task.projectIcon,
              targetDate: task.projectTargetDate,
            };
          }
          // Then the project santree recorded on the worktree itself. A repo
          // whose Linear org isn't connected resolves no tickets at all, so
          // reading only the live task collapsed every one of its worktrees
          // into the unnamed band — while the name sat in `worktree_links`
          // the whole time. Name only: the rest is the ticket's to give, and
          // the glyph falls back rather than inventing a colour.
          if (!worktree.project) return null;
          const known = projectMetaByName.get(worktree.project);
          return {
            name: worktree.project,
            color: known?.projectColor ?? null,
            icon: known?.projectIcon ?? null,
            targetDate: known?.projectTargetDate ?? null,
          };
        })
      : wholeSection(ordered);

  const linearProjects: LinearProjectNode[] = byProject.map((band) => {
    const groups =
      groupBy === "milestone" || groupBy === "project_milestone"
        ? groupByMilestone(band.items, (worktree) => tasksById.get(worktree.id)?.projectMilestone)
        : oneBand(band.items);
    return {
      key: band.key,
      label: band.label,
      color: band.color ?? PROJECT_FALLBACK,
      icon: band.icon,
      targetDate: band.targetDate,
      // Stacking runs inside a band and never across two: a branch relationship
      // must not drag a row over a planning boundary.
      milestones: groups.map((group) => ({
        key: group.key,
        label: group.label,
        targetDate: group.targetDate,
        worktrees: stackWorktrees(group.items).map(({ worktree, depth }) =>
          nodeOf(worktree, depth, false),
        ),
      })),
      showMilestones: showMilestoneGroups(groups),
      worktreeCount: band.items.length,
    };
  });

  const baseNode = base ? nodeOf(base, 0, true) : null;

  return {
    repo,
    label: shortRepoName(repo),
    base: baseNode,
    linearProjects,
    showProjects: showProjectGroups(byProject),
    worktreeCount: list.length,
    attention: highest([...(baseNode ? [baseNode.attention] : []), ...[...attentionById.values()]]),
    loading: worktrees === undefined,
  };
}

/** Every registered repo as a tree of worktrees and their live agents. */
export function useProjectTree(): ProjectTreeModel {
  const { data: repos } = useRepos();
  const repoNames = useMemo(() => (repos ?? []).map((repo) => repo.name), [repos]);

  const worktreesByRepo = useWorktreesByRepo(repoNames);
  const basesByRepo = useBaseWorktreesByRepo(repoNames);
  const tasksByRepo = useTasksByRepo(repoNames);
  const prsByRepo = useWorktreePrsByRepo(repoNames);
  // Shown and known are the same set here: the tree lists every repo, so there
  // is no "hidden repo" whose sessions would need filtering out.
  const entries = useAgentEntries(repoNames, repoNames);
  const { seen, markSeen } = useSeenAgents();
  // One timer for the whole tree, armed at the first moment a row's hook event
  // goes stale — so a decayed dot appears exactly then, and never costs a poll.
  const nowMs = useDecayClock(entries ?? EMPTY_ENTRIES);
  // Creating and deleting a worktree are both slow enough to need an answer
  // before the filesystem has one. Both registers are app-scoped; a launch says
  // which project it is happening in, so the placeholder appears in that
  // project's section rather than under whichever one was being looked at.
  const { pendingLaunches, pendingDeletes, removePendingLaunch } = useAppUi();
  // App-scoped: the tree is cross-repo, so one shape has to serve all of it.
  const { data: groupByRaw } = useSetting("app", LINEAR_GROUP_BY_KEY);
  const groupBy = parseLinearGroupBy(groupByRaw);

  // Once a real worktree lands for a launch, drop its placeholder. Here rather
  // than in the workspace that started it: the workspace only reads one
  // project, so a launch the user navigated away from — or one started in a
  // project they never opened, which "run in the background" makes routine —
  // had nothing watching for its worktree and left a "Creating workspace…" row
  // in the rail forever. This hook reads every project's list already.
  useEffect(() => {
    for (const launch of pendingLaunches) {
      if (worktreesByRepo.get(launch.repo)?.some((w) => w.id === launch.id)) {
        removePendingLaunch(launch.id);
      }
    }
  }, [worktreesByRepo, pendingLaunches, removePendingLaunch]);

  const agentsByWorktree = useMemo(
    () => groupAgentsByWorktree(entries ?? EMPTY_ENTRIES, seen, nowMs),
    [entries, seen, nowMs],
  );
  const agentsByPr = useMemo(
    () => groupAgentsByPr(entries ?? EMPTY_ENTRIES, seen, nowMs),
    [entries, seen, nowMs],
  );

  const worktreesFor = useCallback(
    (repo: string): Worktree[] | undefined => {
      const real = worktreesByRepo.get(repo);
      const launches = pendingLaunches.filter((l) => l.repo === repo);
      // A launch has to show up even before the first read lands, or starting a
      // task on a cold repo looks like it did nothing.
      if (real === undefined && launches.length === 0) return undefined;
      return mergeWorktrees(real ?? [], launches, pendingDeletes, (worktree) => worktree);
    },
    [worktreesByRepo, pendingLaunches, pendingDeletes],
  );

  const projects = useMemo(
    () =>
      repoNames.map((repo) =>
        buildProjectNode({
          repo,
          worktrees: worktreesFor(repo),
          base: basesByRepo.get(repo),
          tasks: tasksByRepo.get(repo) ?? [],
          prs: prsByRepo.get(repo) ?? [],
          agentsByWorktree,
          groupBy,
        }),
      ),
    [repoNames, worktreesFor, basesByRepo, tasksByRepo, prsByRepo, agentsByWorktree, groupBy],
  );

  return { projects, loading: repos === undefined, markSeen, agentsByPr };
}

/**
 * The investigation agents under each triage ticket, for the sidebar's Triage
 * section.
 *
 * That section sits *beside* the project tree, not inside it, so it reads the
 * same registry sources the tree does rather than asking the tree: the tree's
 * fold rebuilds every repo's worktrees to answer, which is the wrong price for a
 * question about tickets. Cross-repo like the tree, for the same reason — an
 * investigation started from a checkout you are not looking at still belongs
 * under its ticket.
 */
export function useTicketAgents(): {
  agentsByTicket: Map<string, AgentNode[]>;
  markSeen: (entry: AgentEntry) => void;
} {
  const { data: repos } = useRepos();
  const repoNames = useMemo(() => (repos ?? []).map((repo) => repo.name), [repos]);
  const entries = useAgentEntries(repoNames, repoNames);
  const { seen, markSeen } = useSeenAgents();
  const nowMs = useDecayClock(entries ?? EMPTY_ENTRIES);
  const agentsByTicket = useMemo(
    () => groupAgentsByTicket(entries ?? EMPTY_ENTRIES, seen, nowMs),
    [entries, seen, nowMs],
  );
  return { agentsByTicket, markSeen };
}
