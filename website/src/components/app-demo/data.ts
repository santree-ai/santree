/** All mock content for the AppDemo — the single file to edit when tuning
 * the story. Data mirrors the real app's shapes (worktrees, tickets, PRs)
 * with believable task-scale numbers; diffstats are kept self-consistent
 * across views (SAN-142 is +186 −44 everywhere it appears). */

export type DemoView = "triage" | "issues" | "trees" | "reviews";

export interface DemoViewMeta {
  id: DemoView;
  label: string;
  count: number;
  /** Read by screen readers on the window (role="img") when this view is active. */
  aria: string;
}

/** Pipeline order — also the auto-advance order. */
export const DEMO_VIEWS: readonly DemoViewMeta[] = [
  {
    id: "triage",
    label: "Triage",
    count: 5,
    aria: "Preview of santree's Triage view: a Linear inbox with priority-ranked tickets, one being investigated by a Claude agent, and an Investigate button in the issue header.",
  },
  {
    id: "issues",
    label: "Issues",
    count: 12,
    aria: "Preview of santree's Issues view: a grouped ticket list beside a dependency graph with project bands; one ticket is queued in the launch tray as an agent launches on it.",
  },
  {
    id: "trees",
    label: "Trees",
    count: 5,
    aria: "Preview of santree's Trees view: a sidebar of git worktrees with running Claude agents, and a live terminal where an agent fixes an OAuth refresh race.",
  },
  {
    id: "reviews",
    label: "Reviews",
    count: 3,
    aria: "Preview of santree's Reviews view: a pull-request inbox with a diff and an AI review comment anchored to the changed lines.",
  },
] as const;

/** The nav bar's Agents badge: agents blocked on you (SAN-138 is waiting). */
export const NEEDS_YOU = 1;

/** The right-aligned status summary in the top bar, per view (Triage has none —
 * its tab badge already carries the count, like the real app). */
export const VIEW_SUMMARY: Record<
  DemoView,
  { lead?: string; value: string; color: "accent" | "green" } | null
> = {
  triage: null,
  issues: { lead: "12 tasks · ", value: "2 ready", color: "green" },
  trees: { lead: "5 worktrees · ", value: "2 running", color: "accent" },
  reviews: { value: "3 awaiting review", color: "accent" },
};

/* ---------------------------------------------------------------- *
 * Trees
 * ---------------------------------------------------------------- */

export type SessionState = "running" | "waiting" | "delegating" | "merged";

export interface DemoWorktree {
  ticket: string;
  title: string;
  /** 1 = stacked under the previous depth-0 entry (elbow connector). */
  depth: 0 | 1;
  state: SessionState;
  add: number;
  del: number;
  ahead?: number;
  dirty?: boolean;
  pr?: { num: number; state: "open" | "merged" };
  active?: boolean;
}

export const WORKTREES: readonly DemoWorktree[] = [
  {
    ticket: "SAN-142",
    title: "Fix OAuth token refresh race",
    depth: 0,
    state: "running",
    add: 186,
    del: 44,
    ahead: 2,
    dirty: true,
    active: true,
  },
  {
    ticket: "SAN-127",
    title: "Session restore on relaunch",
    depth: 1,
    state: "delegating",
    add: 58,
    del: 3,
  },
  {
    ticket: "SAN-138",
    title: "Webhook retries duplicate on 429",
    depth: 0,
    state: "waiting",
    add: 94,
    del: 12,
    ahead: 1,
    pr: { num: 816, state: "open" },
  },
  {
    ticket: "SAN-119",
    title: "Bound the image cache",
    depth: 0,
    state: "merged",
    add: 61,
    del: 9,
    pr: { num: 812, state: "merged" },
  },
] as const;

/** Terminal script events. `pre` = extra beat (in char-ticks) before the
 * line starts typing; `pause` = a beat with no output, like a tool running. */
export type TermEvent =
  | { kind: "prompt" | "text" | "tool" | "todo" | "diffstat"; text: string; pre?: number }
  | { kind: "pause"; ticks: number };

/** The t=0 frame: rendered fully, always — server HTML, no-JS, and
 * reduced-motion users see this exact (good-looking) state. */
export const TERM_PRESEEDED: readonly TermEvent[] = [
  { kind: "prompt", text: "fix the OAuth token refresh race in session restore" },
  { kind: "text", text: "I'll trace how the refresh token is stored and reused across restarts." },
  { kind: "tool", text: "Read src/auth/refresh.ts" },
  { kind: "tool", text: 'Grep "refresh_token" src/' },
  { kind: "tool", text: "Read src/session/restore.ts" },
  {
    kind: "text",
    text: "Found it — two callers can refresh concurrently and the second write clobbers the first.",
  },
  { kind: "todo", text: "Reproduce with two concurrent refresh calls" },
  { kind: "tool", text: "Bash pnpm test auth -- --grep refresh" },
  { kind: "text", text: "Confirmed: the stale token wins the write 3 times out of 20. Fixing." },
] as const;

/** Typed live after the preseeded frame, one char per ticker quantum. */
export const TERM_LIVE: readonly TermEvent[] = [
  { kind: "tool", text: "Edit src/auth/refresh.ts", pre: 14 },
  { kind: "pause", ticks: 10 },
  { kind: "todo", text: "Serialize refresh behind a keyed mutex" },
  { kind: "tool", text: "Bash pnpm test auth", pre: 8 },
  { kind: "pause", ticks: 18 },
  { kind: "text", text: "14 tests passed. Refresh now single-flights; the race is gone." },
  { kind: "todo", text: "Add regression test for concurrent refresh" },
  { kind: "diffstat", text: "+186 −44 across 4 files", pre: 10 },
  { kind: "text", text: "Ready to commit — want me to open a PR?", pre: 6 },
] as const;

export const SESSION_STATUS = {
  model: "Opus 4.8",
  contextPct: 42,
  cost: "$1.87",
} as const;

/** The worktree's VS Code-style bottom bar: git state + the base-branch chip. */
export const BOTTOM_BAR = {
  dirty: true,
  base: "main",
  ahead: 2,
  push: 2,
} as const;

/* ---------------------------------------------------------------- *
 * Triage
 * ---------------------------------------------------------------- */

export type TicketPriority = "urgent" | "high" | "medium" | "low";

export interface DemoTicket {
  id: string;
  title: string;
  priority: TicketPriority;
  age: string;
  /** The team · project line under the title, like the real queue row. */
  meta: string;
  /** SLA countdown shown at the row's bottom right (urgent/high only). */
  sla?: string;
  state?: "investigating" | "snoozed";
}

export const TRIAGE_QUEUE: readonly DemoTicket[] = [
  {
    id: "SAN-151",
    title: "Webhook retries duplicate on 429",
    priority: "urgent",
    age: "2h",
    meta: "Engineering · Webhooks",
    sla: "SLA 4h",
  },
  {
    id: "SAN-149",
    title: "Terminal loses scrollback on resize",
    priority: "high",
    age: "5h",
    meta: "Engineering · Terminal",
    state: "investigating",
  },
  {
    id: "SAN-150",
    title: "Empty diff view after fast rebase",
    priority: "high",
    age: "3h",
    meta: "Engineering · Git",
  },
  {
    id: "SAN-147",
    title: "Dark mode flash on cold start",
    priority: "medium",
    age: "1d",
    meta: "Engineering · Shell",
  },
  {
    id: "SAN-133",
    title: "Migrate settings to per-repo scope",
    priority: "low",
    age: "6d",
    meta: "Engineering · Settings",
    state: "snoozed",
  },
] as const;

export const TRIAGE_DETAIL = {
  id: "SAN-151",
  title: "Webhook retries duplicate on 429",
  priority: "urgent" as TicketPriority,
  status: "Triage",
  sla: "SLA 4h",
  author: "Maya Torres",
  authorInitials: "MT",
  created: "2h ago",
  project: "Webhooks",
  body: [
    "Linear webhooks that hit our rate limit are retried by both the queue and the handler, so a single event can apply twice.",
    "Repro: burst 30 label updates; watch the audit log double-count. Likely fix is an idempotency key on the delivery id.",
  ],
} as const;

/* ---------------------------------------------------------------- *
 * Issues (dependency graph + grouped list)
 * ---------------------------------------------------------------- */

export type NodeStatus = "done" | "started" | "todo" | "blocked";

/** Mirrors the app's Linear status colors: In Progress amber, Todo blue,
 * Blocked red, Done purple. */
export const ISSUE_STATUS_META: Record<NodeStatus, { color: string; label: string }> = {
  done: { color: "var(--color-status-purple)", label: "Done" },
  started: { color: "var(--color-status-amber)", label: "In Progress" },
  todo: { color: "var(--color-status-blue)", label: "Todo" },
  blocked: { color: "var(--color-status-red)", label: "Blocked" },
};

export interface GraphNode {
  id: string;
  title: string;
  x: number;
  y: number;
  status: NodeStatus;
  /** Which project band (and sidebar group) the node belongs to. */
  band: string;
  /** A worktree exists — amber edge tint + WIP badge, like the real graph. */
  working?: boolean;
  /** Ready to start (unblocked): the green RDY badge. */
  ready?: boolean;
  /** The story node: queued in the launch tray, accent-filled card. */
  launching?: boolean;
  pr?: { num: number; state: "open" | "merged" };
}

export interface GraphEdge {
  from: string;
  to: string;
}

/** A translucent project grouping band drawn behind its nodes. */
export interface ProjectBand {
  name: string;
  color: string;
  count: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const PROJECT_BANDS: readonly ProjectBand[] = [
  { name: "Session hardening", color: "#4493f8", count: 4, x: 36, y: 56, w: 920, h: 300 },
  { name: "Webhook reliability", color: "#a78bfa", count: 3, x: 36, y: 396, w: 568, h: 300 },
] as const;

/** Coordinates are design-canvas px inside the graph pane. */
export const GRAPH_NODES: readonly GraphNode[] = [
  {
    id: "SAN-119",
    title: "Bound the image cache",
    x: 60,
    y: 100,
    status: "done",
    band: "Session hardening",
    pr: { num: 812, state: "merged" },
  },
  {
    id: "SAN-142",
    title: "Fix OAuth token refresh race",
    x: 60,
    y: 218,
    status: "started",
    band: "Session hardening",
    working: true,
  },
  {
    id: "SAN-127",
    title: "Session restore on relaunch",
    x: 392,
    y: 158,
    status: "started",
    band: "Session hardening",
    working: true,
  },
  {
    id: "SAN-160",
    title: "Ship session hardening",
    x: 724,
    y: 218,
    status: "todo",
    band: "Session hardening",
  },
  {
    id: "SAN-138",
    title: "Webhook retries duplicate on 429",
    x: 60,
    y: 446,
    status: "started",
    band: "Webhook reliability",
    working: true,
    pr: { num: 816, state: "open" },
  },
  {
    id: "SAN-151",
    title: "Idempotency keys for deliveries",
    x: 392,
    y: 430,
    status: "todo",
    band: "Webhook reliability",
    ready: true,
    launching: true,
  },
  {
    id: "SAN-153",
    title: "Audit log double-count guard",
    x: 392,
    y: 560,
    status: "blocked",
    band: "Webhook reliability",
  },
] as const;

export const GRAPH_EDGES: readonly GraphEdge[] = [
  { from: "SAN-119", to: "SAN-127" },
  { from: "SAN-142", to: "SAN-127" },
  { from: "SAN-142", to: "SAN-151" },
  { from: "SAN-138", to: "SAN-151" },
  { from: "SAN-138", to: "SAN-153" },
  { from: "SAN-127", to: "SAN-160" },
  { from: "SAN-151", to: "SAN-160" },
] as const;

/** The launch tray at the bottom of the Issues sidebar. */
export const LAUNCH_TRAY = {
  agent: "Claude",
  model: "Opus 4.8",
  count: 1,
} as const;

/* ---------------------------------------------------------------- *
 * Reviews
 * ---------------------------------------------------------------- */

export type CheckState = "pass" | "fail" | "pending";

export interface DemoPr {
  num: number;
  ticket: string;
  title: string;
  checks: CheckState;
  /** Review decision dot, GitHub-style. */
  decision: "approved" | "required";
  /** How long it's been waiting on a review. */
  waiting: string;
  size: "S" | "M" | "L";
  comments?: number;
  active?: boolean;
}

/** Split like the real inbox: a direct request first, then your own PRs. */
export const REVIEW_REQUESTED: readonly DemoPr[] = [
  {
    num: 815,
    ticket: "SAN-142",
    title: "Fix OAuth token refresh race",
    checks: "pass",
    decision: "required",
    waiting: "4h",
    size: "M",
    comments: 3,
    active: true,
  },
] as const;

export const REVIEW_MINE: readonly DemoPr[] = [
  {
    num: 816,
    ticket: "SAN-138",
    title: "Webhook retry backoff",
    checks: "pending",
    decision: "required",
    waiting: "2h",
    size: "S",
  },
  {
    num: 809,
    ticket: "SAN-101",
    title: "Session restore telemetry",
    checks: "pass",
    decision: "approved",
    waiting: "3d",
    size: "S",
    comments: 1,
  },
] as const;

export interface DiffLine {
  kind: "ctx" | "add" | "del";
  old: number | null;
  new: number | null;
  text: string;
}

export const REVIEW_DIFF = {
  file: "src/auth/refresh.ts",
  hunk: "@@ -41,9 +41,14 @@ export async function refreshSession(id: SessionId)",
  lines: [
    { kind: "ctx", old: 41, new: 41, text: "  const stored = await tokens.get(id);" },
    {
      kind: "del",
      old: 42,
      new: null,
      text: "  const fresh = await oauth.refresh(stored.refreshToken);",
    },
    { kind: "del", old: 43, new: null, text: "  await tokens.set(id, fresh);" },
    {
      kind: "add",
      old: null,
      new: 42,
      text: "  const fresh = await refreshLocks.run(id, async () => {",
    },
    { kind: "add", old: null, new: 43, text: "    const current = await tokens.get(id);" },
    {
      kind: "add",
      old: null,
      new: 44,
      text: "    if (current.expiresAt > Date.now() + SKEW) return current;",
    },
    { kind: "add", old: null, new: 45, text: "    return oauth.refresh(current.refreshToken);" },
    { kind: "add", old: null, new: 46, text: "  });" },
    { kind: "ctx", old: 44, new: 47, text: "  return session.withTokens(fresh);" },
  ] satisfies DiffLine[],
} as const;

export const AI_REVIEW = {
  label: "correctness",
  text: "The lock is keyed by session id, but refresh() is also called from the device-link flow with a user id — two keys, same token row. Consider keying on the token row id instead.",
} as const;

export const REVIEW_META = {
  repo: "santree-ai/santree",
  num: 815,
  title: "Fix OAuth token refresh race",
  branch: "santree/san-142-oauth-refresh",
  author: "maya",
  authorInitials: "M",
  add: 186,
  del: 44,
  files: 4,
} as const;
