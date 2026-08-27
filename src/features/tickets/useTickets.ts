/**
 * The Tickets page's data: every ticket in every registered repo, folded into
 * one ordered, groupable list.
 *
 * The old Issues rail could assume a single active repo, so a ticket's worktree,
 * PRs and agents were all one lookup away. Spanning repos, none of that holds:
 * ticket ids are only unique *within* a repo, and the per-repo reads land
 * independently. Everything here is therefore keyed by `(repo, id)`, and the
 * fold is driven by the repo list rather than by "the" repo — the same shape the
 * Agents panel uses, and on the same query keys, so opening this page refetches
 * nothing Trees or Agents already loaded.
 *
 * "Still loading" is kept distinct from "nothing to show": a repo whose tasks
 * haven't landed is absent from the map, and the page renders skeletons for that
 * rather than an empty state the user would read as fact.
 */
import { useMemo } from "react";

import type { Task, Worktree, WorktreePr } from "../../bindings";
import { groupByMilestone, type MilestoneGroup } from "../../components/WorkSignals";
import {
  type Attention,
  highest,
  IDLE,
  levelOf,
  type SeenMap,
  useSeenAgents,
} from "../../lib/attention";
import {
  useRepos,
  useTasksByRepo,
  useWorktreePrsByRepo,
  useWorktreesByRepo,
} from "../../lib/queries";
import { PROJECT_FALLBACK } from "../../theme/colors";
import type { AgentEntry } from "../agents/registry";
import { useAgentEntries } from "../agents/useAgents";

/** One ticket, with everything the row paints from already joined on. */
export interface TicketRow {
  /** Owning repo — part of the row's identity, since ids repeat across repos. */
  repo: string;
  task: Task;
  /** The ticket's worktree, when the work has already been started. */
  worktree: Worktree | null;
  prs: WorktreePr[];
  /** Live agents attributed to this ticket (any repo-scoped surface). */
  agents: AgentEntry[];
  /** The most urgent of `agents` — what the row's link chip speaks in. */
  attention: Attention;
  /** The blocker named by the "Blocked · <key>" tag, or null when not blocked. */
  blockedBy: string | null;
}

/** A project's tickets inside one repo, split into its milestones. */
export interface TicketProjectGroup {
  /** Stable list key: a project name alone repeats across repos. */
  key: string;
  repo: string;
  project: string;
  color: string;
  icon: string | null;
  targetDate: string | null;
  count: number;
  milestones: MilestoneGroup<TicketRow>[];
}

/** The header's one-line answer to "how much is there, and how much can I do?". */
export interface TicketsSummary {
  total: number;
  projects: number;
  ready: number;
  blocked: number;
}

export interface TicketsData {
  repos: string[];
  groups: TicketProjectGroup[];
  summary: TicketsSummary;
  /** At least one repo's tickets are still in flight — render skeletons. */
  loading: boolean;
}

/** A ticket is startable when it has no worktree and nothing open blocks it. */
export function isStartable(row: TicketRow): boolean {
  return row.worktree === null && row.task.ready && row.task.actionable;
}

/**
 * The blocker the row names. `ready === false` guarantees at least one open
 * blocker, but not that we hold its task: blockers owned by someone else are
 * pulled in as graph context and may be missing entirely under a repo the user
 * has no access to. Prefer one we know about, fall back to the raw id.
 */
function firstBlocker(task: Task, byId: Map<string, Task>): string | null {
  if (task.ready) return null;
  return task.blockedBy.find((id) => byId.has(id)) ?? task.blockedBy[0] ?? null;
}

/** The per-repo reads the fold joins, exactly as the query layer hands them over. */
export interface TicketFoldInput {
  /** Registration order — the order the page's groups come out in. */
  repos: string[];
  tasks: Map<string, Task[]>;
  worktrees: Map<string, Worktree[]>;
  prs: Map<string, WorktreePr[]>;
  agents: AgentEntry[];
  seen: SeenMap;
  /** On, the page is the viewer's own queue; off, it also shows the context
   *  tickets — someone else's work, or work already done — the queue depends on. */
  actionableOnly: boolean;
}

/**
 * Fold the per-repo reads into the page's groups, project by project.
 *
 * Pure, so the joining rules can be tested without a query client — the same
 * split the Agents panel's `buildAgentEntries` uses. A repo whose tasks haven't
 * landed contributes nothing rather than an empty group: the caller reports that
 * as loading, and a "0 tickets" heading that fills in later reads as a wrong
 * answer while it's up.
 */
export function buildTicketGroups(input: TicketFoldInput): {
  groups: TicketProjectGroup[];
  summary: TicketsSummary;
} {
  // Agents keyed by the ticket they belong to, per repo — one pass instead of a
  // scan per row.
  const agentsByTicket = new Map<string, AgentEntry[]>();
  for (const entry of input.agents) {
    if (!entry.repo || !entry.ticket) continue;
    const key = `${entry.repo} ${entry.ticket}`;
    agentsByTicket.set(key, [...(agentsByTicket.get(key) ?? []), entry]);
  }

  const groups: TicketProjectGroup[] = [];
  const summary: TicketsSummary = { total: 0, projects: 0, ready: 0, blocked: 0 };

  for (const repo of input.repos) {
    const tasks = input.tasks.get(repo);
    if (!tasks) continue;
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const worktreeById = new Map((input.worktrees.get(repo) ?? []).map((w) => [w.id, w]));
    const prsByTicket = new Map<string, WorktreePr[]>();
    for (const pr of input.prs.get(repo) ?? []) {
      prsByTicket.set(pr.issueId, [...(prsByTicket.get(pr.issueId) ?? []), pr]);
    }

    // Projects keep their first-seen order (the backend's ticket order), which is
    // the ordering the graph's bands and the old rail both used.
    const byProject = new Map<string, TicketRow[]>();
    for (const task of tasks) {
      if (input.actionableOnly && !task.actionable) continue;
      const agents = agentsByTicket.get(`${repo} ${task.id}`) ?? [];
      const row: TicketRow = {
        repo,
        task,
        worktree: worktreeById.get(task.id) ?? null,
        prs: prsByTicket.get(task.id) ?? [],
        agents,
        attention: agents.length > 0 ? highest(agents.map((a) => levelOf(a, input.seen))) : IDLE,
        blockedBy: firstBlocker(task, byId),
      };
      byProject.set(task.project, [...(byProject.get(task.project) ?? []), row]);

      summary.total += 1;
      if (isStartable(row)) summary.ready += 1;
      else if (row.worktree === null && !task.ready) summary.blocked += 1;
    }

    for (const [project, rows] of byProject) {
      const meta = rows[0].task;
      groups.push({
        key: `${repo} ${project}`,
        repo,
        project,
        color: meta.projectColor ?? PROJECT_FALLBACK,
        icon: meta.projectIcon ?? null,
        targetDate: meta.projectTargetDate ?? null,
        count: rows.length,
        milestones: groupByMilestone(rows, (row) => row.task.projectMilestone),
      });
    }
  }

  // Projects are counted by name across repos: the number answers "how much of my
  // work is in play", and the same project split over two repos is one.
  summary.projects = new Set(groups.map((g) => g.project)).size;
  return { groups, summary };
}

/**
 * Every ticket across every registered repo, grouped project → milestone.
 *
 * `actionableOnly` mirrors the graph's filter: on (the default) the page is the
 * viewer's own queue, off it also shows the context tickets the queue depends on.
 */
export function useTickets(actionableOnly: boolean): TicketsData {
  const { data: repoList } = useRepos();
  const repos = useMemo(() => (repoList ?? []).map((r) => r.name), [repoList]);

  const tasksByRepo = useTasksByRepo(repos);
  const worktreesByRepo = useWorktreesByRepo(repos);
  const prsByRepo = useWorktreePrsByRepo(repos);
  // Both arguments are the full set: this page has no repo scoping of its own,
  // so "shown" and "registered" are the same list.
  const entries = useAgentEntries(repos, repos);
  const { seen } = useSeenAgents();

  return useMemo(() => {
    const { groups, summary } = buildTicketGroups({
      repos,
      tasks: tasksByRepo,
      worktrees: worktreesByRepo,
      prs: prsByRepo,
      agents: entries ?? [],
      seen,
      actionableOnly,
    });
    return {
      repos,
      groups,
      summary,
      loading: repoList === undefined || repos.some((repo) => !tasksByRepo.has(repo)),
    };
  }, [repoList, repos, tasksByRepo, worktreesByRepo, prsByRepo, entries, seen, actionableOnly]);
}
