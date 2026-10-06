/**
 * The demo world in the bindings' own shapes: tickets, ticket detail, triage,
 * worktrees and session history — built from `company.ts` (static) and
 * `state.ts` (what the demo has changed).
 */
import type {
  LinearTeam,
  Repo,
  SessionState,
  Task,
  TaskStatus,
  TriageDetail,
  TriageSchedule,
  TriageTicket,
  WorkflowState,
  Worktree,
  WorktreeSession,
} from "../../../bindings";
import {
  avatar,
  CYCLE,
  DAY,
  DRIVER,
  dateIn,
  HOUR,
  INFRA,
  LINEAR_ORG,
  ME,
  MIN,
  milestoneRef,
  PEOPLE,
  PLATFORM,
  REPO_PATH,
  SEEDS,
  TEAMS,
  type TicketSeed,
  ticketSeed,
  worktreePath,
} from "./company";
import { jobSecs, jobState, jobs, T0, type WtState, worktreesState, wtLines } from "./state";

// ── Repos ────────────────────────────────────────────────────────────────────

export const demoRepos = (): Repo[] =>
  // Infra first: it is where the demo launches, so new worktrees land at the top.
  [INFRA, PLATFORM, DRIVER].map((name) => ({
    name,
    tracker: `Linear · ${LINEAR_ORG.name}`,
    provider: "Linear",
    agents: [...jobs.values()].filter((j) => j.repo === name && jobState(j) === "active").length,
    path: REPO_PATH[name],
    location: "Local",
  }));

// ── Tickets ──────────────────────────────────────────────────────────────────

const seedsOf = (repo: string) => SEEDS[repo] ?? [];

const teamOf = (id: string): Task["team"] => {
  const key = id.slice(0, id.indexOf("-"));
  return { key, name: TEAMS[key] ?? null };
};

/** A ticket's status as the demo has moved it: started once it has a worktree. */
function statusOf(seed: TicketSeed): TaskStatus {
  const started = worktreesState.some((w) => w.id === seed.id);
  return started && (seed.status === "Todo" || seed.status === "Backlog")
    ? "InProgress"
    : seed.status;
}

function toTask(seed: TicketSeed, all: TicketSeed[]): Task {
  const done = new Set(all.filter((t) => t.status === "Done").map((t) => t.id));
  const blockedBy = (seed.blockedBy ?? []).filter((id) => !done.has(id));
  const status = statusOf(seed);
  const p = seed.project;
  return {
    id: seed.id,
    title: seed.title,
    priority: seed.priority,
    team: teamOf(seed.id),
    estimate: seed.estimate ?? null,
    cycle: seed.inCycle ? CYCLE(T0) : null,
    dueDate: seed.dueDays === undefined ? null : dateIn(T0, seed.dueDays),
    project: p?.project ?? "No Project",
    projectColor: p?.projectColor ?? null,
    projectIcon: p?.projectIcon ?? null,
    projectTargetDate: p ? dateIn(T0, p.targetDays) : null,
    projectMilestone: p && seed.milestone ? milestoneRef(T0, p, seed.milestone) : null,
    parentId: null,
    status,
    ready: blockedBy.length === 0 && (status === "Todo" || status === "Backlog"),
    blockedBy,
    actionable: status !== "Backlog" && status !== "Done",
    assignee: seed.assignee ?? null,
    assigneeAvatarUrl: seed.assignee ? avatar(seed.assignee) : null,
    x: 0,
    y: 0,
  };
}

/** Every ticket in the Parcelwise org: one Linear workspace behind all three repos. */
export const tasks = (): Task[] => {
  const all = Object.values(SEEDS).flat();
  return all.map((seed) => toTask(seed, all));
};

const WORKFLOW: WorkflowState[] = [
  { id: "st-triage", name: "Triage", type: "triage", color: "#FC7840" },
  { id: "st-backlog", name: "Backlog", type: "backlog", color: "#bec2c8" },
  { id: "st-todo", name: "Todo", type: "unstarted", color: "#e2e2e2" },
  { id: "st-progress", name: "In Progress", type: "started", color: "#f2c94c" },
  { id: "st-review", name: "In Review", type: "started", color: "#0f783c" },
  { id: "st-done", name: "Done", type: "completed", color: "#5e6ad2" },
];

const STATE_NAME: Record<TaskStatus, string> = {
  Backlog: "Backlog",
  Todo: "Todo",
  InProgress: "In Progress",
  InReview: "In Review",
  Blocked: "Todo",
  Done: "Done",
};

export function ticketDetail(id: string, now: number): TriageDetail | null {
  const triage = TRIAGE.find((t) => t.id === id);
  if (triage) return triageDetail(triage, now);
  const seed = ticketSeed(id);
  if (!seed) return null;
  const repo = Object.keys(SEEDS).find((r) => seedsOf(r).includes(seed)) ?? PLATFORM;
  const task = toTask(seed, seedsOf(repo));
  const state = STATE_NAME[task.status];
  const author = seed.author ?? PEOPLE.daniel;
  return {
    id: seed.id,
    title: seed.title,
    priority: seed.priority,
    state,
    stateId: WORKFLOW.find((s) => s.name === state)?.id ?? null,
    states: WORKFLOW,
    url: `https://linear.app/${LINEAR_ORG.slug}/issue/${seed.id}`,
    author,
    authorAvatarUrl: avatar(author),
    createdAtMs: T0 - (seed.createdAgo ?? 4 * DAY),
    labels: seed.labels ?? [],
    project: task.project === "No Project" ? null : task.project,
    projectMilestone: task.projectMilestone,
    assignee: task.assignee,
    assigneeAvatarUrl: task.assigneeAvatarUrl,
    estimate: task.estimate,
    cycle: task.cycle,
    dueDate: task.dueDate,
    slaBreachMs: null,
    snoozedUntilMs: null,
    description: seed.body,
    comments: (seed.comments ?? []).map((c, i) => ({
      id: `${seed.id}-c${i}`,
      author: c.by,
      avatarUrl: avatar(c.by),
      createdAtMs: T0 - c.agoMs,
      body: c.body,
      children: [],
    })),
  };
}

// ── Triage ───────────────────────────────────────────────────────────────────

interface TriageSeed {
  id: string;
  title: string;
  priority: TriageTicket["priority"];
  slaMs: number;
  mine: boolean;
  snoozeMs?: number;
  author: string;
  body: string;
  labels?: string[];
}

const TRIAGE: TriageSeed[] = [
  {
    id: "PLAT-437",
    title: "Tracking page shows “Delivered” for parcels still out for delivery",
    priority: "Urgent",
    slaMs: 95 * MIN,
    mine: true,
    author: PEOPLE.aisha,
    labels: ["bug", "tracking", "customer"],
    body: "Three shippers reported customers seeing *Delivered* while the driver is still two stops away. All three use DHL. Screenshots in the Intercom thread.",
  },
  {
    id: "PLAT-436",
    title: "CSV export of shipments times out above 50k rows",
    priority: "High",
    slaMs: -25 * MIN,
    mine: false,
    author: PEOPLE.priya,
    labels: ["bug", "dashboard"],
    body: "The export runs in the request. Enterprise shippers with a busy month hit the 30s gateway timeout.",
  },
  {
    id: "PLAT-435",
    title: "Label PDFs render the wrong font for Cyrillic addresses",
    priority: "Medium",
    slaMs: 7 * HOUR,
    mine: false,
    author: PEOPLE.jonas,
    labels: ["bug", "labels"],
    body: "Cyrillic characters fall back to a bitmap font and the carrier's scanner rejects one in ten labels.",
  },
  {
    id: "PLAT-433",
    title: "Webhook signing secret rotation has no overlap window",
    priority: "Medium",
    slaMs: 30 * HOUR,
    mine: true,
    snoozeMs: DAY,
    author: PEOPLE.daniel,
    labels: ["webhooks", "security"],
    body: "Rotating the secret invalidates in-flight deliveries. Sign with both secrets for 24h.",
  },
];

export const triageTickets = (repo: string, now: number): TriageTicket[] =>
  repo === PLATFORM
    ? TRIAGE.map((t) => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        team: "PLAT",
        slaBreachMs: now + t.slaMs,
        snoozedUntilMs: t.snoozeMs === undefined ? null : now + t.snoozeMs,
        mine: t.mine,
      }))
    : [];

function triageDetail(t: TriageSeed, now: number): TriageDetail {
  return {
    id: t.id,
    title: t.title,
    priority: t.priority,
    state: "Triage",
    stateId: "st-triage",
    states: WORKFLOW,
    url: `https://linear.app/${LINEAR_ORG.slug}/issue/${t.id}`,
    author: t.author,
    authorAvatarUrl: avatar(t.author),
    createdAtMs: now - 2 * HOUR,
    labels: t.labels ?? [],
    project: null,
    projectMilestone: null,
    assignee: t.mine ? ME : null,
    assigneeAvatarUrl: t.mine ? avatar(ME) : null,
    estimate: null,
    cycle: null,
    dueDate: null,
    slaBreachMs: now + t.slaMs,
    snoozedUntilMs: t.snoozeMs === undefined ? null : now + t.snoozeMs,
    description: t.body,
    comments: [],
  };
}

export const linearTeams = (repo: string): LinearTeam[] =>
  repo in REPO_PATH
    ? Object.entries(TEAMS).map(([key, name]) => ({
        key,
        name,
        member: key === "PLAT" || key === "DRV",
        inRotation: key === "PLAT",
        hasRotation: key !== "DRV",
        hasAssigned: key === "PLAT",
      }))
    : [];

export function triageSchedule(repo: string, now: number): TriageSchedule[] {
  if (repo !== PLATFORM) return [];
  const handover = new Date(now);
  handover.setHours(10, 0, 0, 0);
  const at = handover.getTime() > now ? handover.getTime() : handover.getTime() + DAY;
  const shift = (name: string, start: number, end: number, isCurrent = false) => ({
    name,
    avatarUrl: avatar(name),
    startsAtMs: start,
    endsAtMs: end,
    isCurrent,
    isMe: name === ME,
  });
  return [
    {
      team: TEAMS.PLAT,
      teamKey: "PLAT",
      scheduleName: "Platform on-call",
      currentName: ME,
      currentAvatarUrl: avatar(ME),
      currentIsMe: true,
      shifts: [
        shift(PEOPLE.tom, at - 2 * DAY, at - DAY),
        shift(ME, at - DAY, at, true),
        shift(PEOPLE.maya, at, at + DAY),
        shift(PEOPLE.daniel, at + DAY, at + 2 * DAY),
      ],
    },
  ];
}

// ── Worktrees ────────────────────────────────────────────────────────────────

export function toWorktree(w: WtState): Worktree {
  const { add, del } = wtLines(w);
  const seed = ticketSeed(w.id);
  const working = jobsFor(w.id).some((j) => jobState(j) === "active");
  return {
    ticketId: w.id,
    id: w.id,
    title: w.title,
    status: seed ? statusOf(seed) : w.status,
    addLines: add,
    delLines: del,
    dirty: w.working.length > 0,
    ahead: w.ahead,
    behind: w.behind,
    unpushed: w.unpushed,
    remoteBehind: 0,
    pullConflict: false,
    agent: w.agent,
    activity: w.agent ? (working ? "Running" : "Idle") : null,
    branch: w.branch,
    path: worktreePath(w.repo, w.id),
    project: seed?.project?.project ?? null,
    baseBranch: w.baseBranch,
    setupRan: w.setupRan,
    pending: false,
  };
}

export const worktrees = (repo: string): Worktree[] =>
  worktreesState.filter((w) => w.repo === repo).map(toWorktree);

export const baseWorktree = (repo: string): Worktree | null =>
  REPO_PATH[repo]
    ? {
        id: "__base__",
        title: "main",
        status: null,
        addLines: 0,
        delLines: 0,
        dirty: false,
        ahead: 0,
        behind: 0,
        unpushed: 0,
        remoteBehind: 0,
        pullConflict: false,
        agent: null,
        activity: null,
        branch: "main",
        path: REPO_PATH[repo],
        project: null,
        baseBranch: "main",
        setupRan: true,
        pending: false,
      }
    : null;

// ── Agents ───────────────────────────────────────────────────────────────────

const jobsFor = (worktreeId: string) =>
  [...jobs.values()].filter((j) => j.worktreeId === worktreeId);

export function sessionStates(now: number): SessionState[] {
  return [...jobs.values()].map((j) => ({
    agentKind: j.kind,
    sessionId: j.sessionId,
    state: jobState(j, now),
    event: jobState(j, now) === "active" ? "PostToolUse" : "Stop",
    cwd: j.cwd,
    message: null,
    transcriptPath: null,
    updatedAtMs: Math.min(
      now,
      j.startedAt + (Math.min(jobSecs(j, now), j.script.doneAt ?? 1e9) * 1000) / j.speed,
    ),
    repo: j.repo,
    termKey: j.termKey,
  }));
}

const MODEL: Record<string, string> = { Claude: "claude-opus-5", Codex: "gpt-5.6-sol" };

export function worktreeSessions(repo: string, id: string, now: number): WorktreeSession[] {
  const live = jobsFor(id)
    .filter((j) => j.repo === repo)
    .map<WorktreeSession>((j) => {
      const secs = Math.min(jobSecs(j, now), j.script.doneAt ?? jobSecs(j, now));
      const cost = Number(j.script.cost) * Math.min(1, secs / (j.script.doneAt ?? 240));
      return {
        sessionId: j.sessionId,
        agentKind: j.kind,
        termKey: j.termKey,
        title:
          j.role === "aiReview"
            ? "AI review of #1287"
            : j.role === "fixCi"
              ? "Address review on #1287"
              : (ticketSeed(id)?.title ?? id),
        lastMessage: j.script.final ?? "Working…",
        lastMessageFrom: "Agent",
        messageCount: Math.max(2, j.script.steps.filter((s) => s.at <= secs).length * 2),
        subagentCount: 0,
        model: MODEL[j.kind] ?? null,
        startedAtMs: j.startedAt,
        lastActivityMs: j.startedAt + (secs * 1000) / j.speed,
        spend: {
          totalTokens: Math.round(secs * 310),
          costUsd: j.kind === "Codex" ? null : Math.round(cost * 100) / 100,
          models: [
            {
              model: MODEL[j.kind] ?? "claude-opus-5",
              totalTokens: Math.round(secs * 310),
              costUsd: null,
            },
          ],
        },
        sampled: false,
      };
    });
  if (id === "PLAT-409" && repo === PLATFORM) {
    live.push({
      sessionId: "5d2c9e1a-409-plan",
      agentKind: "Claude",
      termKey: null,
      title: "Plan the rate limiter: Redis vs in-process",
      lastMessage: "Redis, so every pod agrees. I'll fail open if it's unreachable, per Daniel.",
      lastMessageFrom: "Agent",
      messageCount: 18,
      subagentCount: 1,
      model: "claude-opus-5",
      startedAtMs: T0 - 22 * HOUR,
      lastActivityMs: T0 - 21 * HOUR,
      spend: {
        totalTokens: 88_400,
        costUsd: 0.92,
        models: [{ model: "claude-opus-5", totalTokens: 88_400, costUsd: 0.92 }],
      },
      sampled: false,
    });
  }
  return live;
}
