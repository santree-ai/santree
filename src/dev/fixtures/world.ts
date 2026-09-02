/**
 * The fixture world: Mallard Labs, a small company whose pond-management
 * platform (QuackStack) keeps a team of ducks busy. Everything here is invented
 * — names, tickets, branches, pull requests — so a capture of it can go on the
 * README and the website without showing anyone's real work.
 *
 * Shapes are the generated bindings' own, so the views render this exactly as
 * they render a live backend. Times are computed against `now` at request time
 * rather than baked in, so a fresh hook event stays fresh however long the dev
 * app has been open.
 */
import type {
  AgentKind,
  AgentState,
  ChangedFile,
  FileSource,
  Repo,
  SessionDetail,
  SessionState,
  Task,
  TaskStatus,
  TriageDetail,
  TriageSchedule,
  TriageTicket,
  WorkflowState,
  Worktree,
  WorktreePr,
  WorktreeSession,
  WorktreeTab,
} from "../../bindings";
import { avatarFor } from "./avatars";

// ── Time ─────────────────────────────────────────────────────────────────────

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** `YYYY-MM-DD`, `days` from now (local calendar). */
export function dateIn(now: number, days: number): string {
  const d = new Date(now + days * DAY);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, "0")}`;
}

export const iso = (ms: number) => new Date(ms).toISOString();

// ── People ───────────────────────────────────────────────────────────────────

export const ME = "Sam Waddle";
export const ME_LOGIN = "samwaddle";

export const PEOPLE = {
  sam: ME,
  ada: "Ada Featherstone",
  raul: "Raúl Pondsworth",
  mei: "Mei Quackenbush",
  theo: "Theo Drakeford",
  priya: "Priya Mallardi",
  otto: "Otto Bill",
} as const;

export const avatar = avatarFor;

// ── Repos ────────────────────────────────────────────────────────────────────

export const HOME = "/Users/sam/dev/mallard";
export const QUACK = "mallard-labs/quackstack";
export const INFRA = "mallard-labs/pond-infra";
export const BEAK = "mallard-labs/beak-cli";

export const REPO_PATH: Record<string, string> = {
  [QUACK]: `${HOME}/quackstack`,
  [INFRA]: `${HOME}/pond-infra`,
  [BEAK]: `${HOME}/beak-cli`,
};

export const LINEAR_ORG = { slug: "mallard", name: "Mallard Labs" };

export const repos = (): Repo[] => [
  { name: QUACK, tracker: `Linear · ${LINEAR_ORG.name}`, agents: 4, path: REPO_PATH[QUACK] },
  { name: INFRA, tracker: `Linear · ${LINEAR_ORG.name}`, agents: 0, path: REPO_PATH[INFRA] },
  { name: BEAK, tracker: `Linear · ${LINEAR_ORG.name}`, agents: 0, path: REPO_PATH[BEAK] },
];

export const worktreePath = (repo: string, id: string) =>
  `${REPO_PATH[repo]}/.santree/worktrees/${id}`;

// ── Linear planning structure ────────────────────────────────────────────────

const POND = {
  project: "Pond 2.0",
  projectColor: "#5E6AD2",
  projectIcon: "🌊",
  targetDays: 23,
};
const BREAD = {
  project: "Bread API",
  projectColor: "#D97706",
  projectIcon: "🍞",
  targetDays: 10,
};

type MilestoneKey = "alpha" | "beta" | "ga" | "bread-ga";
const milestone = (now: number, key: MilestoneKey) =>
  ({
    alpha: { id: "ms-alpha", name: "Alpha", targetDate: dateIn(now, 3), sortOrder: 1 },
    beta: { id: "ms-beta", name: "Beta", targetDate: dateIn(now, 16), sortOrder: 2 },
    ga: { id: "ms-ga", name: "GA", targetDate: dateIn(now, 23), sortOrder: 3 },
    "bread-ga": { id: "ms-bread-ga", name: "GA", targetDate: dateIn(now, 10), sortOrder: 1 },
  })[key];

const cycle = (now: number) => ({
  number: 14,
  name: null,
  startsAtMs: now - 6 * DAY,
  endsAtMs: now + 8 * DAY,
});

interface TicketSeed {
  id: string;
  title: string;
  priority: Task["priority"];
  status: TaskStatus;
  estimate?: number;
  assignee?: string;
  blockedBy?: string[];
  project?: typeof POND | typeof BREAD;
  milestone?: MilestoneKey;
  inCycle?: boolean;
  dueDays?: number;
  /** Markdown body, for the ticket pane. */
  body: string;
  comments?: { by: string; agoMs: number; body: string }[];
  labels?: string[];
}

const QUACK_TICKETS: TicketSeed[] = [
  {
    id: "QK-142",
    title: "Ducks render upside down in Safari",
    priority: "High",
    status: "InProgress",
    estimate: 2,
    assignee: PEOPLE.sam,
    project: POND,
    milestone: "alpha",
    inCycle: true,
    labels: ["bug", "pond"],
    body: `Every duck facing west renders upside down, but only in Safari 26. Chrome and Firefox are fine.

## Repro

1. Open any pond with more than one duck.
2. Drag a duck so it swims left.
3. Watch it flip.

## Notes

- Started after the \`DuckLayer\` sprite refactor (#398).
- \`heading\` comes out negative for westward ducks; the rotate branch in \`DuckLayer\` keys off the sign.
- Ripples point the wrong way too, which suggests the bearing math rather than the sprite.`,
    comments: [
      {
        by: PEOPLE.mei,
        agoMs: 5 * HOUR,
        body: "Confirmed on Safari 26.1 and the iOS beta. Not on Chrome. Screen recording in the thread.",
      },
      {
        by: PEOPLE.sam,
        agoMs: 40 * MIN,
        body: "Picking this up — suspect `bearing()` in geometry.ts, will start there.",
      },
    ],
  },
  {
    id: "QK-138",
    title: "Migrate quack events to the pond_v2 schema",
    priority: "Urgent",
    status: "InReview",
    estimate: 5,
    assignee: PEOPLE.sam,
    project: POND,
    milestone: "alpha",
    inCycle: true,
    dueDays: 2,
    labels: ["migration"],
    body: `Move the \`quack_events\` table onto the \`pond_v2\` schema and backfill the last 90 days.

- [x] Schema + migration
- [x] Dual-write behind \`pond_v2_events\`
- [ ] Backfill job (batched, resumable)
- [ ] Flip reads`,
    comments: [
      {
        by: PEOPLE.ada,
        agoMs: 3 * HOUR,
        body: "Should the backfill run in batches? 40k ponds in one transaction worries me.",
      },
    ],
  },
  {
    id: "QK-140",
    title: "Backfill legacy ponds into pond_v2",
    priority: "High",
    status: "Todo",
    estimate: 3,
    assignee: PEOPLE.raul,
    blockedBy: ["QK-138"],
    project: POND,
    milestone: "alpha",
    inCycle: true,
    body: "Once QK-138 lands, backfill every pond created before 2024 into the new schema. Batches of 500, resumable from the last pond id.",
  },
  {
    id: "QK-127",
    title: "Pond dashboard: dark mode",
    priority: "Medium",
    status: "InProgress",
    estimate: 3,
    assignee: PEOPLE.mei,
    project: POND,
    milestone: "alpha",
    inCycle: true,
    labels: ["dashboard"],
    body: "The dashboard hardcodes about forty hex values. Move them onto the theme tokens and add a dark palette. Design in Figma → Pond 2.0 → Dashboard / Dark.",
  },
  {
    id: "QK-145",
    title: "Duckling onboarding emails go out at 3am",
    priority: "Medium",
    status: "Todo",
    estimate: 1,
    project: POND,
    milestone: "beta",
    body: "The welcome sequence is scheduled in UTC. Schedule it in the pond's own timezone, defaulting to 9am local.",
  },
  {
    id: "QK-146",
    title: "Feather cache never evicts",
    priority: "High",
    status: "Todo",
    estimate: 2,
    assignee: PEOPLE.theo,
    project: POND,
    milestone: "beta",
    inCycle: true,
    dueDays: -1,
    labels: ["bug", "perf"],
    body: "`FeatherCache` has a `maxEntries` option that nothing reads. Memory on the pond worker climbs about 40 MB/hour until it is restarted.",
  },
  {
    id: "QK-147",
    title: "Realtime pond updates over WebSockets",
    priority: "Medium",
    status: "Backlog",
    estimate: 5,
    blockedBy: ["QK-138", "QK-146"],
    project: POND,
    milestone: "beta",
    body: "Replace the 5s poll with a subscription per pond. Needs the v2 events (QK-138) and a cache that evicts (QK-146) first.",
  },
  {
    id: "QK-150",
    title: "Pond 2.0 launch checklist",
    priority: "Low",
    status: "Backlog",
    assignee: PEOPLE.ada,
    blockedBy: ["QK-147"],
    project: POND,
    milestone: "ga",
    body: "Changelog, docs, the migration guide for self-hosted ponds, and the announcement honk.",
  },
  {
    id: "QK-119",
    title: "Rate-limit the bread dispenser API",
    priority: "High",
    status: "InReview",
    estimate: 3,
    assignee: PEOPLE.sam,
    project: BREAD,
    milestone: "bread-ga",
    inCycle: true,
    labels: ["bread-api"],
    body: "A single duck can request crumbs 40×/s. Add a per-duck token bucket in front of the dispenser: 10 crumbs/s sustained, bursts of 30.",
  },
  {
    id: "QK-160",
    title: "Rate-limit crumb requests per duck",
    priority: "High",
    status: "InReview",
    estimate: 2,
    assignee: PEOPLE.raul,
    project: BREAD,
    milestone: "bread-ga",
    inCycle: true,
    labels: ["bread-api"],
    body: "Follow-up to QK-119: the bucket has to be per duck, not per pond, or one greedy duck starves the flock.",
  },
  {
    id: "QK-151",
    title: "Bread dispenser returns 402 for premium crumbs",
    priority: "Urgent",
    status: "Todo",
    estimate: 1,
    assignee: PEOPLE.sam,
    project: BREAD,
    milestone: "bread-ga",
    inCycle: true,
    dueDays: 0,
    labels: ["bug", "bread-api"],
    body: "Ducks on the Premium plan get `402 Payment Required` for sourdough crumbs. The plan check reads `plan.tier` but billing now writes `plan.level`.",
  },
  {
    id: "QK-152",
    title: "Crumb metering drifts after DST",
    priority: "Medium",
    status: "Todo",
    blockedBy: ["QK-119"],
    project: BREAD,
    milestone: "bread-ga",
    body: "The meter window is computed in local time; on the DST change a pond gets a 25-hour day of crumbs.",
  },
  {
    id: "QK-136",
    title: "Goose mode is on by default (should be opt-in)",
    priority: "High",
    status: "Todo",
    estimate: 1,
    assignee: PEOPLE.priya,
    inCycle: true,
    labels: ["bug"],
    body: "New ponds ship with `goose_mode: true`. Nobody wants that. Flip the default and add the opt-in toggle to pond settings.",
  },
  {
    id: "QK-133",
    title: "[Flaky] pond.spec.ts › ripples settle within 200ms",
    priority: "Low",
    status: "Todo",
    labels: ["flaky-test"],
    body: "Fails about one run in twenty on CI. The assertion races the animation frame; it should wait for the ripple store to settle instead.",
  },
  {
    id: "QK-121",
    title: "Investigate: pond count is off by one on Tuesdays",
    priority: "Medium",
    status: "Backlog",
    body: "The weekly report shows one more pond on Tuesdays than on any other day. Nobody has found the extra pond.",
  },
];

const INFRA_TICKETS: TicketSeed[] = [
  {
    id: "INF-88",
    title: "Terraform the pond thermostat",
    priority: "Medium",
    status: "InProgress",
    assignee: PEOPLE.otto,
    body: "Bring the thermostat fleet under Terraform. One module per pond region.",
  },
  {
    id: "INF-91",
    title: "Rotate the pond thermostat certificate",
    priority: "High",
    status: "InReview",
    assignee: PEOPLE.otto,
    dueDays: 4,
    body: "The current certificate expires in 12 days.",
  },
  {
    id: "INF-93",
    title: "Alert when a pond goes quiet for 10 minutes",
    priority: "Low",
    status: "Todo",
    body: "No quacks in ten minutes is either a very calm pond or a dead worker.",
  },
];

const BEAK_TICKETS: TicketSeed[] = [
  {
    id: "BK-12",
    title: "`beak pond ls` should paginate past 100 ponds",
    priority: "Medium",
    status: "Todo",
    body: "It prints the first page and stops. Follow the cursor.",
  },
  {
    id: "BK-15",
    title: "Shell completions for fish",
    priority: "Low",
    status: "Backlog",
    body: "bash and zsh have them; fish users keep asking.",
  },
];

const SEEDS: Record<string, TicketSeed[]> = {
  [QUACK]: QUACK_TICKETS,
  [INFRA]: INFRA_TICKETS,
  [BEAK]: BEAK_TICKETS,
};

const seedsOf = (repo: string) => SEEDS[repo] ?? [];

function toTask(seed: TicketSeed, all: TicketSeed[], now: number): Task {
  const done = new Set(all.filter((t) => t.status === "Done").map((t) => t.id));
  const blockedBy = (seed.blockedBy ?? []).filter((id) => !done.has(id));
  const project = seed.project;
  return {
    id: seed.id,
    title: seed.title,
    priority: seed.priority,
    estimate: seed.estimate ?? null,
    cycle: seed.inCycle ? cycle(now) : null,
    dueDate: seed.dueDays === undefined ? null : dateIn(now, seed.dueDays),
    project: project?.project ?? "No Project",
    projectColor: project?.projectColor ?? null,
    projectIcon: project?.projectIcon ?? null,
    projectTargetDate: project ? dateIn(now, project.targetDays) : null,
    projectMilestone: seed.milestone ? milestone(now, seed.milestone) : null,
    parentId: null,
    status: seed.status,
    ready: blockedBy.length === 0,
    blockedBy,
    actionable: seed.status !== "Backlog" && seed.status !== "Done",
    assignee: seed.assignee ?? null,
    assigneeAvatarUrl: seed.assignee ? avatar(seed.assignee) : null,
    x: 0,
    y: 0,
  };
}

export const tasks = (repo: string, now: number): Task[] =>
  seedsOf(repo).map((seed) => toTask(seed, seedsOf(repo), now));

export const taskById = (id: string, now: number): Task | null => {
  for (const repo of Object.keys(SEEDS)) {
    const seed = seedsOf(repo).find((t) => t.id === id);
    if (seed) return toTask(seed, seedsOf(repo), now);
  }
  return null;
};

const WORKFLOW: WorkflowState[] = [
  { id: "st-backlog", name: "Backlog", type: "backlog", color: "#bec2c8" },
  { id: "st-todo", name: "Todo", type: "unstarted", color: "#e2e2e2" },
  { id: "st-progress", name: "In Progress", type: "started", color: "#f2c94c" },
  { id: "st-review", name: "In Review", type: "started", color: "#26b5ce" },
  { id: "st-done", name: "Done", type: "completed", color: "#5e6ad2" },
  { id: "st-triage", name: "Triage", type: "triage", color: "#f97316" },
];

const stateName: Record<TaskStatus, string> = {
  Backlog: "Backlog",
  Todo: "Todo",
  InProgress: "In Progress",
  InReview: "In Review",
  Blocked: "Todo",
  Done: "Done",
};

/** The full ticket, for the ticket panes — the same detail shape triage uses. */
export function ticketDetail(id: string, now: number): TriageDetail | null {
  const triage = TRIAGE.find((t) => t.id === id);
  if (triage) return triageDetail(triage, now);
  const seed = Object.keys(SEEDS)
    .flatMap((repo) => seedsOf(repo))
    .find((t) => t.id === id);
  if (!seed) return null;
  const task = taskById(id, now);
  const state = stateName[seed.status];
  return {
    id: seed.id,
    title: seed.title,
    priority: seed.priority,
    state,
    stateId: WORKFLOW.find((s) => s.name === state)?.id ?? null,
    states: WORKFLOW,
    url: `https://linear.app/${LINEAR_ORG.slug}/issue/${seed.id}`,
    author: PEOPLE.ada,
    authorAvatarUrl: avatar(PEOPLE.ada),
    createdAtMs: now - 6 * DAY,
    labels: seed.labels ?? [],
    project: task?.project === "No Project" ? null : (task?.project ?? null),
    projectMilestone: task?.projectMilestone ?? null,
    assignee: seed.assignee ?? null,
    assigneeAvatarUrl: seed.assignee ? avatar(seed.assignee) : null,
    estimate: seed.estimate ?? null,
    cycle: task?.cycle ?? null,
    dueDate: task?.dueDate ?? null,
    slaBreachMs: null,
    snoozedUntilMs: null,
    description: seed.body,
    comments: (seed.comments ?? []).map((c, i) => ({
      id: `${seed.id}-c${i}`,
      author: c.by,
      avatarUrl: avatar(c.by),
      createdAtMs: now - c.agoMs,
      body: c.body,
      children: [],
    })),
  };
}

// ── Worktrees ────────────────────────────────────────────────────────────────

interface WorktreeSeed {
  id: string;
  repo: string;
  status: TaskStatus | null;
  add: number;
  del: number;
  dirty: boolean;
  ahead: number;
  unpushed: number;
  agent: AgentKind | null;
  running: boolean;
  branch: string;
}

const WORKTREES: WorktreeSeed[] = [
  {
    id: "QK-142",
    repo: QUACK,
    status: "InProgress",
    add: 54,
    del: 1,
    dirty: true,
    ahead: 1,
    unpushed: 1,
    agent: "Claude",
    running: true,
    branch: "sam/qk-142-ducks-render-upside-down-in-safari",
  },
  {
    id: "QK-138",
    repo: QUACK,
    status: "InReview",
    add: 412,
    del: 88,
    dirty: false,
    ahead: 4,
    unpushed: 0,
    agent: "Claude",
    running: true,
    branch: "sam/qk-138-migrate-quack-events-to-the-pond-v2-schema",
  },
  {
    id: "QK-127",
    repo: QUACK,
    status: "InProgress",
    add: 188,
    del: 40,
    dirty: true,
    ahead: 2,
    unpushed: 2,
    agent: "Codex",
    running: true,
    branch: "sam/qk-127-pond-dashboard-dark-mode",
  },
  {
    id: "QK-119",
    repo: QUACK,
    status: "InReview",
    add: 156,
    del: 12,
    dirty: false,
    ahead: 0,
    unpushed: 0,
    agent: "Claude",
    running: false,
    branch: "sam/qk-119-rate-limit-the-bread-dispenser-api",
  },
  {
    id: "QK-151",
    repo: QUACK,
    status: "Todo",
    add: 0,
    del: 0,
    dirty: false,
    ahead: 0,
    unpushed: 0,
    agent: null,
    running: false,
    branch: "sam/qk-151-bread-dispenser-returns-402-for-premium-crumbs",
  },
  {
    id: "INF-88",
    repo: INFRA,
    status: "InProgress",
    add: 240,
    del: 3,
    dirty: true,
    ahead: 1,
    unpushed: 1,
    agent: "Codex",
    running: false,
    branch: "sam/inf-88-terraform-the-pond-thermostat",
  },
];

function toWorktree(seed: WorktreeSeed, now: number): Worktree {
  const task = taskById(seed.id, now);
  return {
    id: seed.id,
    title: task?.title ?? seed.id,
    status: seed.status,
    addLines: seed.add,
    delLines: seed.del,
    dirty: seed.dirty,
    ahead: seed.ahead,
    behind: 0,
    unpushed: seed.unpushed,
    remoteBehind: 0,
    pullConflict: false,
    agent: seed.agent,
    activity: seed.agent ? (seed.running ? "Running" : "Idle") : null,
    branch: seed.branch,
    path: worktreePath(seed.repo, seed.id),
    project: task && task.project !== "No Project" ? task.project : null,
    baseBranch: "main",
    setupRan: true,
    pending: false,
  };
}

export const worktrees = (repo: string, now: number): Worktree[] =>
  WORKTREES.filter((w) => w.repo === repo).map((w) => toWorktree(w, now));

export const worktree = (repo: string, id: string, now: number): Worktree | null =>
  id === BASE_ID ? baseWorktree(repo) : (worktrees(repo, now).find((w) => w.id === id) ?? null);

export const BASE_ID = "__base__";

export const baseWorktree = (repo: string): Worktree | null =>
  REPO_PATH[repo]
    ? {
        id: BASE_ID,
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

export const worktreePrs = (repo: string): WorktreePr[] =>
  repo === QUACK
    ? [
        {
          issueId: "QK-138",
          repo: QUACK,
          number: 418,
          url: `https://github.com/${QUACK}/pull/418`,
          state: "Open",
        },
        {
          issueId: "QK-119",
          repo: QUACK,
          number: 412,
          url: `https://github.com/${QUACK}/pull/412`,
          state: "Open",
        },
      ]
    : repo === INFRA
      ? [
          {
            issueId: "INF-88",
            repo: INFRA,
            number: 57,
            url: `https://github.com/${INFRA}/pull/57`,
            state: "Open",
          },
        ]
      : [];

// ── Tabs and agents ──────────────────────────────────────────────────────────

export type TranscriptKind =
  | "claude-fix"
  | "claude-permission"
  | "claude-investigate"
  | "claude-idle"
  | "codex-dark-mode"
  | "codex-review"
  | "shell";

export interface FakeAgent {
  termKey: string;
  source: "issue" | "triage" | "review";
  kind: AgentKind;
  repo: string;
  cwd: string;
  title: string;
  sessionId: string;
  state: AgentState;
  message: string | null;
  /** How long ago the last hook event was. */
  agoMs: number;
  transcript: TranscriptKind;
  /** Which pane this shows in: the worktree tab row it belongs to, when it is one. */
  tab?: WorktreeTab;
}

const tab = (
  id: string,
  worktreeId: string,
  agentKind: AgentKind | null,
  title: string,
  kind: WorktreeTab["kind"] = agentKind ? "agent" : "terminal",
): WorktreeTab => ({ id, worktreeId, kind, agentKind, title, pr: null });

export const TABS: WorktreeTab[] = [
  tab("t-142a", "QK-142", "Claude", "Claude Code"),
  tab("t-142s", "QK-142", null, "Terminal"),
  tab("t-138a", "QK-138", "Claude", "Claude Code"),
  tab("t-127a", "QK-127", "Codex", "Codex"),
  tab("t-119a", "QK-119", "Claude", "Claude Code"),
];

export const AGENTS: FakeAgent[] = [
  {
    termKey: "tree:QK-142:tab:t-142a",
    source: "issue",
    kind: "Claude",
    repo: QUACK,
    cwd: worktreePath(QUACK, "QK-142"),
    title: "Claude Code",
    sessionId: "3f1c9a2e-142a",
    state: "active",
    message: null,
    agoMs: 40_000,
    transcript: "claude-fix",
    tab: TABS[0],
  },
  {
    termKey: "tree:QK-138:tab:t-138a",
    source: "issue",
    kind: "Claude",
    repo: QUACK,
    cwd: worktreePath(QUACK, "QK-138"),
    title: "Claude Code",
    sessionId: "8a77d0b1-138a",
    state: "permission",
    message: "Allow Bash(pnpm db:migrate --dry-run)?",
    agoMs: 3 * MIN,
    transcript: "claude-permission",
    tab: TABS[2],
  },
  {
    termKey: "tree:QK-127:tab:t-127a",
    source: "issue",
    kind: "Codex",
    repo: QUACK,
    cwd: worktreePath(QUACK, "QK-127"),
    title: "Codex",
    sessionId: "01a0-127a-codex",
    state: "delegating",
    message: null,
    agoMs: 2 * MIN,
    transcript: "codex-dark-mode",
    tab: TABS[3],
  },
  {
    termKey: "triage:QK-203",
    source: "triage",
    kind: "Claude",
    repo: QUACK,
    cwd: REPO_PATH[QUACK],
    title: "QK-203",
    sessionId: "c0ffee42-203",
    state: "active",
    message: null,
    agoMs: 70_000,
    transcript: "claude-investigate",
  },
  {
    termKey: `ai-review:${QUACK}#417`,
    source: "review",
    kind: "Codex",
    repo: QUACK,
    cwd: REPO_PATH[QUACK],
    title: `${QUACK}#417`,
    sessionId: "01a0-417-review",
    state: "active",
    message: null,
    agoMs: 4 * MIN,
    transcript: "codex-review",
  },
];

/** The finished one: its process is gone, so it has no pane — the row is "just
 *  finished" until looked at, then history. */
const FINISHED: SessionState = {
  agentKind: "Claude",
  sessionId: "e4d5c6b7-119a",
  state: "exited",
  event: "SessionEnd",
  cwd: worktreePath(QUACK, "QK-119"),
  message: null,
  transcriptPath: null,
  updatedAtMs: null,
  repo: QUACK,
  termKey: "tree:QK-119:tab:t-119a",
};

export const sessionStates = (now: number): SessionState[] => [
  ...AGENTS.map<SessionState>((a) => ({
    agentKind: a.kind,
    sessionId: a.sessionId,
    state: a.state,
    event: a.state === "permission" ? "PermissionRequest" : "PostToolUse",
    cwd: a.cwd,
    message: a.message,
    transcriptPath: null,
    updatedAtMs: now - a.agoMs,
    repo: a.repo,
    termKey: a.termKey,
  })),
  { ...FINISHED, updatedAtMs: now - 25 * MIN },
];

export const agentByTermKey = (termKey: string) => AGENTS.find((a) => a.termKey === termKey);

// ── Session history ──────────────────────────────────────────────────────────

const spend = (model: string, tokens: number, cost: number) => ({
  totalTokens: tokens,
  costUsd: cost,
  models: [{ model, totalTokens: tokens, costUsd: cost }],
});

export function sessions(repo: string, id: string, now: number): WorktreeSession[] {
  if (repo !== QUACK) return [];
  switch (id) {
    case "QK-142":
      return [
        {
          sessionId: "3f1c9a2e-142a",
          agentKind: "Claude",
          termKey: "tree:QK-142:tab:t-142a",
          title: "Ducks render upside down in Safari",
          lastMessage:
            "Fixed. bearing() had its atan2 arguments swapped, so every westward duck got a negative heading…",
          lastMessageFrom: "Agent",
          messageCount: 14,
          subagentCount: 0,
          model: "claude-opus-5",
          startedAtMs: now - 38 * MIN,
          lastActivityMs: now - 40_000,
          spend: spend("claude-opus-5", 184_320, 1.87),
        },
        {
          sessionId: "9b2e7f10-142z",
          agentKind: "Claude",
          termKey: null,
          title: "Reproduce the Safari flip with a headless run",
          lastMessage: "Thanks, park it — I'll pick it up tomorrow.",
          lastMessageFrom: "You",
          messageCount: 22,
          subagentCount: 2,
          model: "claude-sonnet-5",
          startedAtMs: now - 26 * HOUR,
          lastActivityMs: now - 25 * HOUR,
          spend: spend("claude-sonnet-5", 96_100, 0.64),
        },
      ];
    case "QK-119":
      return [
        {
          sessionId: "e4d5c6b7-119a",
          agentKind: "Claude",
          termKey: "tree:QK-119:tab:t-119a",
          title: "Rate-limit the bread dispenser API",
          lastMessage: "Pushed. PR #412 is up with the token bucket and the load test.",
          lastMessageFrom: "Agent",
          messageCount: 31,
          subagentCount: 1,
          model: "claude-opus-5",
          startedAtMs: now - 3 * HOUR,
          lastActivityMs: now - 25 * MIN,
          spend: spend("claude-opus-5", 402_800, 4.12),
        },
      ];
    case BASE_ID:
      return [
        {
          sessionId: "c0ffee42-203",
          agentKind: "Claude",
          termKey: "triage:QK-203",
          title: "Investigate QK-203: dispenser 500s on a zero crumb budget",
          lastMessage:
            "The divide is in meter.ts:88 — a zero budget makes the ratio NaN and the guard only checks for Infinity.",
          lastMessageFrom: "Agent",
          messageCount: 9,
          subagentCount: 0,
          model: "claude-opus-5",
          startedAtMs: now - 12 * MIN,
          lastActivityMs: now - 70_000,
          spend: spend("claude-opus-5", 61_200, 0.58),
        },
        {
          sessionId: "d1e2f3a4-base",
          agentKind: "Codex",
          termKey: null,
          title: "Why does the pond count drift on Tuesdays?",
          lastMessage: "It's the weekly report job: it counts the archived demo pond once a week.",
          lastMessageFrom: "Agent",
          messageCount: 17,
          subagentCount: 0,
          model: "gpt-5.6-sol",
          startedAtMs: now - 2 * DAY,
          lastActivityMs: now - 2 * DAY + 20 * MIN,
          spend: spend("gpt-5.6-sol", 143_000, 0.9),
        },
      ];
    default:
      return [];
  }
}

export function sessionDetail(sessionId: string): SessionDetail {
  const first =
    sessionId === "3f1c9a2e-142a"
      ? "Ducks render upside down in Safari — find out why and fix it. Ticket QK-142 is attached; the repro is in the description."
      : "Continue the work on this branch.";
  return {
    firstPrompt: first,
    firstPromptTruncated: false,
    recentTurns: [
      { from: "You", text: first },
      {
        from: "Agent",
        text: "Found it. bearing() passes atan2 its arguments the wrong way round.",
      },
    ],
    cwd: worktreePath(QUACK, "QK-142"),
  };
}

// ── Files and diffs ──────────────────────────────────────────────────────────

const QUACK_FILES = [
  ".github/workflows/ci.yml",
  ".santree/init.sh",
  "README.md",
  "docs/bread-api.md",
  "docs/pond-2.0.md",
  "migrations/0041_ponds.sql",
  "migrations/0042_pond_v2.sql",
  "package.json",
  "pnpm-lock.yaml",
  "src/bread/dispenser.ts",
  "src/bread/meter.ts",
  "src/bread/rateLimit.test.ts",
  "src/bread/rateLimit.ts",
  "src/dashboard/Pond.tsx",
  "src/dashboard/Ripples.tsx",
  "src/flock/Flock.tsx",
  "src/flock/roster.ts",
  "src/index.ts",
  "src/pond/DuckLayer.tsx",
  "src/pond/Pond.tsx",
  "src/pond/__fixtures__/headings.json",
  "src/pond/geometry.test.ts",
  "src/pond/geometry.ts",
  "src/pond/ripples.ts",
  "src/theme/tokens.ts",
  "tsconfig.json",
  "vite.config.ts",
];

export const files = (repo: string): string[] => (repo === QUACK ? QUACK_FILES : []);

const change = (
  path: string,
  status: ChangedFile["status"],
  addLines: number,
  delLines: number,
  staged = false,
): ChangedFile => ({ path, oldPath: null, status, staged, addLines, delLines, binary: false });

/** Uncommitted changes in the working tree. */
export function workingChanges(id: string): ChangedFile[] {
  switch (id) {
    case "QK-142":
      return [
        change("src/pond/geometry.ts", "Modified", 1, 1),
        change("src/pond/geometry.test.ts", "Modified", 11, 0),
      ];
    case "QK-127":
      return [
        change("src/dashboard/Pond.tsx", "Modified", 34, 21),
        change("src/theme/tokens.ts", "Modified", 48, 2),
        change("src/theme/dark.ts", "Untracked", 61, 0),
      ];
    case "INF-88":
      return [change("modules/thermostat/main.tf", "Untracked", 240, 0)];
    default:
      return [];
  }
}

/** Committed on the branch, against its base. */
export function branchChanges(id: string): ChangedFile[] {
  switch (id) {
    case "QK-142":
      return [change("src/pond/__fixtures__/headings.json", "Added", 42, 0)];
    case "QK-138":
      return [
        change("migrations/0042_pond_v2.sql", "Added", 88, 0),
        change("src/pond/events.ts", "Modified", 210, 64),
        change("src/pond/events.test.ts", "Modified", 96, 24),
        change("src/pond/backfill.ts", "Added", 18, 0),
      ];
    case "QK-127":
      return [
        change("src/dashboard/Pond.tsx", "Modified", 40, 12),
        change("src/theme/tokens.ts", "Modified", 5, 5),
      ];
    case "QK-119":
      return [
        change("src/bread/rateLimit.ts", "Added", 92, 0),
        change("src/bread/rateLimit.test.ts", "Added", 51, 0),
        change("src/bread/dispenser.ts", "Modified", 9, 12),
        change("docs/bread-api.md", "Modified", 4, 0),
      ];
    default:
      return [];
  }
}

const GEOMETRY_OLD = `import type { Point } from "./types";

/** Straight-line distance between two points on the pond, in metres. */
export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Compass bearing from one point to another, in radians. */
export function bearing(from: Point, to: Point): number {
  return Math.atan2(to.x - from.x, to.y - from.y);
}

/** Where a duck ends up after swimming \`metres\` along \`heading\`. */
export function advance(from: Point, heading: number, metres: number): Point {
  return { x: from.x + Math.cos(heading) * metres, y: from.y + Math.sin(heading) * metres };
}
`;

const GEOMETRY_NEW = GEOMETRY_OLD.replace(
  "return Math.atan2(to.x - from.x, to.y - from.y);",
  "return Math.atan2(to.y - from.y, to.x - from.x);",
);

const GEOMETRY_DIFF = `diff --git a/src/pond/geometry.ts b/src/pond/geometry.ts
index 3f9a1c2..b71e0d4 100644
--- a/src/pond/geometry.ts
+++ b/src/pond/geometry.ts
@@ -7,7 +7,7 @@ export function distance(a: Point, b: Point): number {
 
 /** Compass bearing from one point to another, in radians. */
 export function bearing(from: Point, to: Point): number {
-  return Math.atan2(to.x - from.x, to.y - from.y);
+  return Math.atan2(to.y - from.y, to.x - from.x);
 }
 
 /** Where a duck ends up after swimming \`metres\` along \`heading\`. */
`;

const GEOMETRY_TEST_OLD = `import { describe, expect, it } from "vitest";

import { advance, bearing, distance } from "./geometry";

describe("distance", () => {
  it("is zero for the same point", () => {
    expect(distance({ x: 1, y: 1 }, { x: 1, y: 1 })).toBe(0);
  });
});

describe("bearing", () => {
  it("points east for (1, 0)", () => {
    expect(bearing({ x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(0);
  });

  it("points north for (0, 1)", () => {
    expect(bearing({ x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(Math.PI / 2);
  });
});
`;

const GEOMETRY_TEST_NEW = GEOMETRY_TEST_OLD.replace(
  `  it("points north for (0, 1)", () => {
    expect(bearing({ x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(Math.PI / 2);
  });
});
`,
  `  it("points north for (0, 1)", () => {
    expect(bearing({ x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(Math.PI / 2);
  });

  // QK-142: a westward duck has a bearing of ±π, never a negative "half turn"
  // that the sprite layer would read as upside down.
  it("keeps a westward duck upright", () => {
    const west = bearing({ x: 0, y: 0 }, { x: -1, y: 0 });
    expect(Math.abs(west)).toBeCloseTo(Math.PI);
    const upright = advance({ x: 0, y: 0 }, west, 1);
    expect(upright.y).toBeCloseTo(0);
    expect(upright.x).toBeCloseTo(-1);
  });
});
`,
);

const GEOMETRY_TEST_DIFF = `diff --git a/src/pond/geometry.test.ts b/src/pond/geometry.test.ts
index 9c1d2e3..4f5a6b7 100644
--- a/src/pond/geometry.test.ts
+++ b/src/pond/geometry.test.ts
@@ -16,4 +16,15 @@ describe("bearing", () => {
   it("points north for (0, 1)", () => {
     expect(bearing({ x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(Math.PI / 2);
   });
+
+  // QK-142: a westward duck has a bearing of ±π, never a negative "half turn"
+  // that the sprite layer would read as upside down.
+  it("keeps a westward duck upright", () => {
+    const west = bearing({ x: 0, y: 0 }, { x: -1, y: 0 });
+    expect(Math.abs(west)).toBeCloseTo(Math.PI);
+    const upright = advance({ x: 0, y: 0 }, west, 1);
+    expect(upright.y).toBeCloseTo(0);
+    expect(upright.x).toBeCloseTo(-1);
+  });
 });
`;

const HEADINGS_JSON = `[
  { "name": "east", "from": [0, 0], "to": [1, 0], "bearing": 0 },
  { "name": "north", "from": [0, 0], "to": [0, 1], "bearing": 1.5707963 },
  { "name": "west", "from": [0, 0], "to": [-1, 0], "bearing": 3.1415927 },
  { "name": "south", "from": [0, 0], "to": [0, -1], "bearing": -1.5707963 }
]
`;

const HEADINGS_DIFF = `diff --git a/src/pond/__fixtures__/headings.json b/src/pond/__fixtures__/headings.json
new file mode 100644
index 0000000..a1b2c3d
--- /dev/null
+++ b/src/pond/__fixtures__/headings.json
@@ -0,0 +1,6 @@
+[
+  { "name": "east", "from": [0, 0], "to": [1, 0], "bearing": 0 },
+  { "name": "north", "from": [0, 0], "to": [0, 1], "bearing": 1.5707963 },
+  { "name": "west", "from": [0, 0], "to": [-1, 0], "bearing": 3.1415927 },
+  { "name": "south", "from": [0, 0], "to": [0, -1], "bearing": -1.5707963 }
+]
`;

export function fileDiff(path: string): string {
  switch (path) {
    case "src/pond/geometry.ts":
      return GEOMETRY_DIFF;
    case "src/pond/geometry.test.ts":
      return GEOMETRY_TEST_DIFF;
    case "src/pond/__fixtures__/headings.json":
      return HEADINGS_DIFF;
    default:
      return "";
  }
}

export function fileSource(path: string): FileSource {
  switch (path) {
    case "src/pond/geometry.ts":
      return { oldText: GEOMETRY_OLD, newText: GEOMETRY_NEW };
    case "src/pond/geometry.test.ts":
      return { oldText: GEOMETRY_TEST_OLD, newText: GEOMETRY_TEST_NEW };
    case "src/pond/__fixtures__/headings.json":
      return { oldText: "", newText: HEADINGS_JSON };
    default:
      return { oldText: "", newText: "" };
  }
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
  comments?: { by: string; agoMs: number; body: string }[];
  labels?: string[];
}

const TRIAGE: TriageSeed[] = [
  {
    id: "QK-203",
    title: "Bread dispenser 500s when the crumb budget is exactly zero",
    priority: "Urgent",
    slaMs: 110 * MIN,
    mine: true,
    author: PEOPLE.theo,
    labels: ["bread-api", "customer"],
    body: `Three ponds on the Free plan hit this overnight. Any crumb request with a remaining budget of exactly 0 returns \`500 Internal Server Error\` instead of \`429\`.

\`\`\`
TypeError: Cannot read properties of undefined (reading 'ratio')
    at meter (src/bread/meter.ts:88:21)
    at dispense (src/bread/dispenser.ts:41:9)
\`\`\`

Budgets of 1 and above are fine. Negative budgets (refunds) are fine. Only zero.`,
    comments: [
      {
        by: PEOPLE.ada,
        agoMs: 50 * MIN,
        body: "Reproduced on staging with `beak pond crumbs --budget 0`. It's deterministic.",
      },
    ],
  },
  {
    id: "QK-199",
    title: "Login loops when the flock has more than 500 ducks",
    priority: "High",
    slaMs: -40 * MIN,
    mine: false,
    author: PEOPLE.priya,
    body: "Big flocks bounce between `/login` and `/pond` forever. The session cookie exceeds 4 KB once the roster is embedded in it.",
  },
  {
    id: "QK-204",
    title: "Pond thermostat reports −273 °C after firmware 4.2",
    priority: "High",
    slaMs: 5 * HOUR,
    mine: false,
    author: PEOPLE.otto,
    body: "Every thermostat that took the 4.2 update now reports absolute zero. The ducks report otherwise.",
  },
  {
    id: "QK-201",
    title: "Duck names with emoji break the leaderboard export",
    priority: "Medium",
    slaMs: 27 * HOUR,
    mine: true,
    snoozeMs: DAY,
    author: PEOPLE.mei,
    body: "The CSV export truncates a row at the first emoji. `🦆 Gerald` becomes `` and the columns shift.",
  },
  {
    id: "QK-197",
    title: "Add a 'honk' reaction to pond comments",
    priority: "Low",
    slaMs: 3 * DAY,
    mine: false,
    snoozeMs: 3 * DAY,
    author: PEOPLE.raul,
    body: "We have 👍 and 🦆. The geese have asked for representation.",
  },
  {
    id: "QK-190",
    title: "Nightly ripple report is empty on Mondays",
    priority: "Medium",
    slaMs: 2 * DAY,
    mine: true,
    snoozeMs: 2 * DAY,
    author: PEOPLE.ada,
    body: "Snoozed until the reporting job moves off the weekend cron.",
  },
];

export const triageTickets = (repo: string, now: number): TriageTicket[] =>
  repo === QUACK
    ? TRIAGE.map((t) => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        team: "QuackStack",
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
    createdAtMs: now - 3 * HOUR - t.slaMs / 4,
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
    comments: (t.comments ?? []).map((c, i) => ({
      id: `${t.id}-c${i}`,
      author: c.by,
      avatarUrl: avatar(c.by),
      createdAtMs: now - c.agoMs,
      body: c.body,
      children: [],
    })),
  };
}

export function triageSchedule(repo: string, now: number): TriageSchedule[] {
  if (repo !== QUACK) return [];
  // Shifts hand over at 4 PM local, the way the real rotation does.
  const handover = new Date(now);
  handover.setHours(16, 0, 0, 0);
  const todayAt16 = handover.getTime();
  const nextHandover = todayAt16 > now ? todayAt16 : todayAt16 + DAY;
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
      team: "QuackStack",
      scheduleName: "Pond duty",
      currentName: PEOPLE.ada,
      currentAvatarUrl: avatar(PEOPLE.ada),
      currentIsMe: false,
      shifts: [
        shift(PEOPLE.theo, nextHandover - 2 * DAY, nextHandover - DAY),
        shift(PEOPLE.ada, nextHandover - DAY, nextHandover, true),
        shift(ME, nextHandover, nextHandover + DAY),
        shift(PEOPLE.mei, nextHandover + DAY, nextHandover + 2 * DAY),
        shift(PEOPLE.raul, nextHandover + 2 * DAY, nextHandover + 3 * DAY),
      ],
    },
  ];
}
