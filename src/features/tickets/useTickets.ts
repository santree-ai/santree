/**
 * The Tickets page's data: every ticket the viewer can see, once, folded into
 * one ordered, groupable list.
 *
 * Tickets belong to a Linear org, not to a repo. A registered repo resolves to
 * one org, and several repos routinely resolve to the same one — so reading
 * "the tasks of each repo" yields the same tickets once per repo. The fold
 * therefore keys a ticket by (org, id) and lists it once; the repos it came
 * from are kept on the row as the places it could be *started*, which is the
 * only moment a repo enters the picture. A ticket that has already been
 * started has a home: the repo holding its worktree (or, failing that, a PR).
 *
 * "Still loading" is kept distinct from "nothing to show": a repo whose tasks
 * haven't landed is absent from the map, and the page renders skeletons for
 * that rather than an empty state the user would read as fact.
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
  useDecayClock,
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

/** Stable stand-in for "the session read hasn't landed yet", so a render before
 *  it does doesn't hand the memos below a fresh array identity. */
const EMPTY_ENTRIES: AgentEntry[] = [];

/** One ticket, with everything the row paints from already joined on. */
export interface TicketRow {
  /** Where an action on this ticket runs: the repo holding its worktree (or
   *  PR), else the first of `repos`. */
  repo: string;
  /** Every registered repo whose org lists this ticket — the places it can be
   *  started — in registration order. */
  repos: string[];
  task: Task;
  /** The ticket's worktree, when the work has already been started. */
  worktree: Worktree | null;
  prs: WorktreePr[];
  /** Live agents attributed to this ticket, in any of its repos. */
  agents: AgentEntry[];
  /** The most urgent of `agents` — what the row's link chip speaks in. */
  attention: Attention;
  /** The blocker named by the "Blocked · <key>" tag, or null when not blocked. */
  blockedBy: string | null;
}

/** A project's tickets, split into its milestones. */
export interface TicketProjectGroup {
  /** Stable list key: the project name, qualified by its org when several are connected. */
  key: string;
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
  /** Registration order — the order repos are offered as start targets. */
  repos: string[];
  /** The org each repo resolves to (its `tracker` label). Repos sharing a value
   *  carry the same tickets; a repo missing here is treated as the unnamed org. */
  orgOf?: Map<string, string>;
  tasks: Map<string, Task[]>;
  worktrees: Map<string, Worktree[]>;
  prs: Map<string, WorktreePr[]>;
  agents: AgentEntry[];
  seen: SeenMap;
  /** `Date.now()` at render, passed in so the fold stays pure. A hook event
   *  older than the freshness window renders at rest — see `levelOf`. */
  nowMs: number;
  /** On, the page is the viewer's own queue; off, it also shows the context
   *  tickets — someone else's work, or work already done — the queue depends on. */
  actionableOnly: boolean;
}

/**
 * Fold the per-repo reads into the page's groups, one row per ticket.
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
  const orgOf = (repo: string) => input.orgOf?.get(repo) ?? "";

  // Blockers are org-level facts, so the lookup that names them spans every
  // repo of the org rather than the one a row happened to be read from.
  const tasksByOrg = new Map<string, Map<string, Task>>();
  for (const repo of input.repos) {
    const tasks = input.tasks.get(repo);
    if (!tasks) continue;
    const org = orgOf(repo);
    const byId = tasksByOrg.get(org) ?? new Map<string, Task>();
    for (const task of tasks) byId.set(task.id, task);
    tasksByOrg.set(org, byId);
  }

  // Agents keyed by the ticket they belong to, per repo — one pass instead of a
  // scan per row.
  const agentsByTicket = new Map<string, AgentEntry[]>();
  for (const entry of input.agents) {
    if (!entry.repo || !entry.ticket) continue;
    const key = `${entry.repo} ${entry.ticket}`;
    agentsByTicket.set(key, [...(agentsByTicket.get(key) ?? []), entry]);
  }

  // One row per (org, id), in first-seen order — which is registration order
  // across repos and the backend's ticket order within one.
  const rows = new Map<string, TicketRow>();
  for (const repo of input.repos) {
    const tasks = input.tasks.get(repo);
    if (!tasks) continue;
    const org = orgOf(repo);
    const byId = tasksByOrg.get(org) ?? new Map<string, Task>();
    const worktreeById = new Map((input.worktrees.get(repo) ?? []).map((w) => [w.id, w]));
    const prsByTicket = new Map<string, WorktreePr[]>();
    for (const pr of input.prs.get(repo) ?? []) {
      prsByTicket.set(pr.issueId, [...(prsByTicket.get(pr.issueId) ?? []), pr]);
    }

    for (const task of tasks) {
      if (input.actionableOnly && !task.actionable) continue;
      const key = `${org}|${task.id}`;
      const worktree = worktreeById.get(task.id) ?? null;
      const prs = prsByTicket.get(task.id) ?? [];
      const existing = rows.get(key);
      if (!existing) {
        rows.set(key, {
          repo,
          repos: [repo],
          task,
          worktree,
          prs,
          agents: [],
          attention: IDLE,
          blockedBy: firstBlocker(task, byId),
        });
        continue;
      }
      existing.repos.push(repo);
      // A later repo that actually holds the work becomes the home; the first
      // repo was only a default.
      const homeless = existing.worktree === null;
      if ((homeless && worktree) || (homeless && existing.prs.length === 0 && prs.length > 0)) {
        existing.repo = repo;
        existing.worktree = worktree;
        existing.prs = prs;
      }
    }
  }

  for (const row of rows.values()) {
    row.agents = row.repos.flatMap((repo) => agentsByTicket.get(`${repo} ${row.task.id}`) ?? []);
    row.attention =
      row.agents.length > 0
        ? highest(row.agents.map((a) => levelOf(a, input.seen, input.nowMs)))
        : IDLE;
  }

  // Projects keep their first-seen order (the backend's ticket order), which is
  // the ordering the graph's bands and the old rail both used.
  const byProject = new Map<string, TicketRow[]>();
  const summary: TicketsSummary = { total: 0, projects: 0, ready: 0, blocked: 0 };
  for (const [key, row] of rows) {
    const org = key.slice(0, key.indexOf("|"));
    const groupKey = org ? `${org} ${row.task.project}` : row.task.project;
    byProject.set(groupKey, [...(byProject.get(groupKey) ?? []), row]);

    summary.total += 1;
    if (isStartable(row)) summary.ready += 1;
    else if (row.worktree === null && !row.task.ready) summary.blocked += 1;
  }

  const groups: TicketProjectGroup[] = [];
  for (const [key, items] of byProject) {
    const meta = items[0].task;
    groups.push({
      key,
      project: meta.project,
      color: meta.projectColor ?? PROJECT_FALLBACK,
      icon: meta.projectIcon ?? null,
      targetDate: meta.projectTargetDate ?? null,
      count: items.length,
      milestones: groupByMilestone(items, (row) => row.task.projectMilestone),
    });
  }

  // Projects are counted by name: the number answers "how much of my work is
  // in play", and the same project name in two orgs is still one line of work.
  summary.projects = new Set(groups.map((g) => g.project)).size;
  return { groups, summary };
}

/**
 * Every ticket across every registered repo, listed once and grouped
 * project → milestone.
 *
 * `actionableOnly` mirrors the graph's filter: on (the default) the page is the
 * viewer's own queue, off it also shows the context tickets the queue depends on.
 */
export function useTickets(actionableOnly: boolean): TicketsData {
  const { data: repoList } = useRepos();
  const repos = useMemo(() => (repoList ?? []).map((r) => r.name), [repoList]);
  // `tracker` names the org the repo's queries actually go to (see repo.rs), so
  // it is the fold's org key.
  const orgOf = useMemo(
    () => new Map((repoList ?? []).map((r) => [r.name, r.tracker])),
    [repoList],
  );

  const tasksByRepo = useTasksByRepo(repos);
  const worktreesByRepo = useWorktreesByRepo(repos);
  const prsByRepo = useWorktreePrsByRepo(repos);
  // Both arguments are the full set: this page has no repo scoping of its own,
  // so "shown" and "registered" are the same list.
  const entries = useAgentEntries(repos, repos);
  const { seen } = useSeenAgents();
  // The same one-shot timer the sidebar arms, so a row decays here at the same
  // instant it decays there rather than at the next unrelated re-render.
  const nowMs = useDecayClock(entries ?? EMPTY_ENTRIES);

  return useMemo(() => {
    const { groups, summary } = buildTicketGroups({
      repos,
      orgOf,
      tasks: tasksByRepo,
      worktrees: worktreesByRepo,
      prs: prsByRepo,
      agents: entries ?? EMPTY_ENTRIES,
      seen,
      nowMs,
      actionableOnly,
    });
    return {
      groups,
      summary,
      loading: repoList === undefined || repos.some((repo) => !tasksByRepo.has(repo)),
    };
  }, [
    repoList,
    repos,
    orgOf,
    tasksByRepo,
    worktreesByRepo,
    prsByRepo,
    entries,
    seen,
    nowMs,
    actionableOnly,
  ]);
}
