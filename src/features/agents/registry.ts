/**
 * The Agents panel's data model: fold every live Claude session — whatever
 * surface launched it — into one ordered, groupable list.
 *
 * The session rows are already global (`session_state`, one per session id).
 * What they lack is *ownership*, and that's the whole job here: a session is
 * attributed by its `term_key` (the logical terminal santree minted it for),
 * joined on in the backend. Correlating by `cwd` instead — which the old Trees
 * "all agents" grid did — silently collapses a worktree's extra tabs into one
 * and confuses a base-branch agent with a triage investigation, since both run
 * at the repo root.
 */
import type { AgentKind, AgentState, SessionState, Task, Worktree } from "../../bindings";
import { palette, sessionStateMeta } from "../../theme/colors";
import type { TerminalTab } from "../terminal/orchestrator";

/** The base-branch entry's sentinel ticket id (mirrors the Trees model's
 *  `BASE_ID` / Rust `worktree::BASE_ID` — duplicated here so this feature doesn't
 *  import the Trees model, which drags a React context along with it). */
export const BASE_TICKET = "__base__";

/** Which surface a session belongs to, parsed from its `term_key`. */
export type AgentOriginKind =
  | "tree"
  | "tree-tab"
  | "triage"
  | "review"
  | "ai-review"
  | "dev"
  | "unknown";

export interface AgentOrigin {
  kind: AgentOriginKind;
  /** Ticket id for `tree`/`tree-tab`/`triage` ({@link BASE_TICKET} for the base
   *  entry); `null` for the review kinds, `dev` and `unknown`. */
  ticket: string | null;
  /** The persisted extra tab's id, for `tree-tab` only. */
  tabId: string | null;
  /** `owner/name#number` for `review`/`ai-review` — which PR the session is on. */
  pr: string | null;
}

const UNKNOWN_ORIGIN: AgentOrigin = { kind: "unknown", ticket: null, tabId: null, pr: null };

/**
 * Parse a `terminal_sessions.term_key` into its owning surface. The conventions
 * are minted by the launch sites — `useAgentTab` (`tree:<id>`,
 * `tree:<id>:tab:<n>`), `InvestigatePane` (`triage:<id>`), the retired read-only
 * review pane (`review:<owner>/<name>#<number>`), `AiReviewSessionPane`
 * (`ai-review:<owner>/<name>#<number>`) and `DevView` (`dev:<path>`) — and
 * mirrored here rather than imported, so this panel doesn't take a dependency on
 * the features it reports on.
 */
export function parseTermKey(termKey: string | null | undefined): AgentOrigin {
  if (!termKey) return UNKNOWN_ORIGIN;
  if (termKey.startsWith("triage:")) {
    return { ...UNKNOWN_ORIGIN, kind: "triage", ticket: termKey.slice("triage:".length) };
  }
  // Before `review:`, since one prefix isn't a prefix of the other but the two
  // read as siblings and belong together.
  if (termKey.startsWith("ai-review:")) {
    return { ...UNKNOWN_ORIGIN, kind: "ai-review", pr: termKey.slice("ai-review:".length) };
  }
  if (termKey.startsWith("review:")) {
    return { ...UNKNOWN_ORIGIN, kind: "review", pr: termKey.slice("review:".length) };
  }
  if (termKey.startsWith("dev:")) return { ...UNKNOWN_ORIGIN, kind: "dev" };
  if (termKey.startsWith("tree:")) {
    const rest = termKey.slice("tree:".length);
    const sep = rest.indexOf(":");
    if (sep === -1) return { ...UNKNOWN_ORIGIN, kind: "tree", ticket: rest };
    const tail = rest.slice(sep + 1);
    return {
      ...UNKNOWN_ORIGIN,
      kind: "tree-tab",
      ticket: rest.slice(0, sep),
      tabId: tail.startsWith("tab:") ? tail.slice("tab:".length) : null,
    };
  }
  return UNKNOWN_ORIGIN;
}

/**
 * The live terminal tab that hosts a session, if the app has one open right now.
 * `term_key` and the terminal registry's `refId` agree everywhere except triage,
 * where the tab is registered under the bare ticket id with source `"triage"` —
 * so the lookup goes through the origin, not the raw key.
 */
export function terminalRefFor(
  termKey: string | null,
  origin: AgentOrigin,
  agentKind?: AgentKind,
): { source: string; refId: string } | null {
  if (!termKey) return null;
  if (origin.kind === "triage") {
    const refId = origin.ticket ?? "";
    return {
      source: "triage",
      refId: agentKind ? `${refId}::${agentKind.toLowerCase()}` : refId,
    };
  }
  // Both review sessions register under the `review` source, keyed by their own
  // term key — so the two can be open on one PR at once.
  if (origin.kind === "review" || origin.kind === "ai-review") {
    return {
      source: "review",
      refId: agentKind ? `${termKey}::${agentKind.toLowerCase()}` : termKey,
    };
  }
  return { source: "issue", refId: termKey };
}

/**
 * The panel's top-level grouping, ordered by what it wants from you.
 *
 * Grouping is by **actionability, not by recorded state**. The stored state is
 * the last thing a hook observed, and hooks can't always record the end of a
 * session — so a session that died mid-question keeps `waiting` on disk forever.
 * Treating that as "needs you" put days-old ghosts at the top of the panel and
 * counted them in the nav badge, which is worse than useless: it's a false alarm
 * you can't act on or dismiss.
 *
 * A session's PTY is a child of this app, so **no live PTY means the process is
 * gone** whatever the row says. Those land in `detached` — still listed, still
 * openable (opening resumes the conversation), just not shouting.
 */
export type AgentBucket = "attention" | "working" | "idle" | "detached" | "done";

export const BUCKET_ORDER: readonly AgentBucket[] = [
  "attention",
  "working",
  "idle",
  "detached",
  "done",
];

export const BUCKET_LABEL: Record<AgentBucket, string> = {
  attention: "Needs you",
  working: "Working",
  idle: "Idle",
  detached: "Paused",
  done: "Recently finished",
};

/** One-line explanation under a group header, where the name isn't self-evident. */
export const BUCKET_HINT: Partial<Record<AgentBucket, string>> = {
  detached: "not running; open to resume",
};

/** `live` is whether a PTY for the session is open in this app right now. */
export function bucketOf(state: AgentState, live: boolean): AgentBucket {
  if (state === "exited") return "done";
  if (!live) return "detached";
  if (state === "permission" || state === "waiting") return "attention";
  if (state === "active" || state === "delegating") return "working";
  return "idle";
}

/** How far back a finished session still counts as "recently finished". Older
 *  ones are history, not a control panel's business — the table keeps rows for a
 *  week so the raw read is dominated by them. */
export const DONE_WINDOW_MS = 8 * 60 * 60 * 1000;

/** Cap on the "Recently finished" group, after the window. */
export const MAX_DONE = 20;

/** One agent as the panel renders it. */
export interface AgentEntry {
  sessionId: string;
  /** Provider that owns this durable session. Kept on the display model so the
   *  control surface never has to infer identity from a title or terminal key. */
  agentKind: AgentKind;
  state: AgentState;
  bucket: AgentBucket;
  origin: AgentOrigin;
  /** Repo the session belongs to (`null` when unattributed). */
  repo: string | null;
  termKey: string | null;
  cwd: string;
  /** The pending question / permission text, when the agent is blocked on you. */
  message: string | null;
  updatedAtMs: number | null;
  /** A PTY for this session is open in the app right now (so it can be attached
   *  to and replied to). A dead one can still be peeked at via its transcript. */
  live: boolean;
  /** The live terminal tab's key, for attach/reply. */
  tabKey: string | null;
  /** Whether "open" can go anywhere. False for a session santree can't attribute
   *  to a surface — the action is disabled and says so, rather than doing nothing. */
  openable: boolean;
  ticket: string | null;
  /** Human-facing ownership axis. Linear-backed work uses its project; fixed
   *  application sessions use a stable workspace name instead. */
  project: string;
  projectColor: string | null;
  projectIcon: string | null;
  /** Why this session exists, independent of provider and live state. */
  purpose: string;
  title: string;
  subtitle: string | null;
  /** The owning worktree, when it's a tree session in the active repo. */
  worktree: Worktree | null;
}

/** Everything needed to describe one repo's agents. The panel is cross-repo, so
 *  it loads this per selected repo rather than for a single "active" one. */
export interface RepoData {
  repo: string;
  worktrees: Worktree[];
  tasks: Task[];
  baseWorktree: Worktree | null;
}

export interface BuildInput {
  sessions: SessionState[];
  terminals: TerminalTab[];
  /** The selected repos, with their data. */
  repos: RepoData[];
  /**
   * Every *registered* repo — the set the picker can toggle.
   *
   * Filtering is "known but not selected", not "not selected": some sessions are
   * scoped to something that was never a repo (the Dev tab keys its own by
   * `@dev`), and those have no checkbox to turn back on. Dropping them would
   * make them permanently invisible with no way to get them back.
   */
  allRepos: string[];
  /** `Date.now()` at render — passed in so the fold stays pure/testable. */
  nowMs: number;
}

/** Last path segment of a cwd, the only label an unattributed session can offer. */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}

/** The live PTY hosting a session, if this app has one open for it. */
function liveTabFor(
  s: SessionState,
  origin: AgentOrigin,
  terminals: TerminalTab[],
): TerminalTab | undefined {
  const ref = terminalRefFor(s.termKey, origin, s.agentKind);
  return ref ? terminals.find((t) => t.source === ref.source && t.refId === ref.refId) : undefined;
}

/**
 * Fold the raw session rows into display entries.
 *
 * Rows are dropped only when they are both **unactionable and stale** — showing
 * them would be a to-do item you can neither do nor dismiss:
 *  - a **finished session with no owner**: `terminal_sessions` keeps one row per
 *    logical terminal, so when a terminal mints a fresh session the *previous*
 *    session loses its join and becomes an anonymous corpse;
 *  - anything **finished** longer ago than {@link DONE_WINDOW_MS};
 *  - an **unowned, not-live** session past that same window. This is the ghost
 *    case: a session that died while a prompt was up leaves `waiting` on disk
 *    with nothing to attribute it to. Recent ones are kept — attribution may
 *    simply not have caught up yet — but a two-day-old one is not news.
 */
export function buildAgentEntries(input: BuildInput): AgentEntry[] {
  const { sessions, terminals, repos, allRepos, nowMs } = input;
  const known = new Set(allRepos);
  // Per-repo lookups, built once. Every selected repo is enriched — there is no
  // "active" repo here; the panel spans all of them at the same fidelity.
  const byRepo = new Map(
    repos.map((r) => [
      r.repo,
      {
        base: r.baseWorktree,
        worktrees: new Map(r.worktrees.map((w) => [w.id, w])),
        tasks: new Map(r.tasks.map((t) => [t.id, t])),
      },
    ]),
  );

  const entries: AgentEntry[] = [];
  for (const s of sessions) {
    // A session whose repo is registered but unselected is out. Unattributed and
    // non-repo-scoped sessions have no checkbox, so they're never filtered here —
    // the staleness rule below is what keeps those from piling up.
    if (s.repo && known.has(s.repo) && !byRepo.has(s.repo)) continue;

    const origin = parseTermKey(s.termKey);
    const tab = liveTabFor(s, origin, terminals);
    const live = tab !== undefined;
    const bucket = bucketOf(s.state, live);
    const stale = nowMs - (s.updatedAtMs ?? 0) > DONE_WINDOW_MS;

    if (bucket === "done" && (!s.termKey || stale)) continue;
    if (!s.termKey && !live && stale) continue;

    const data = s.repo ? byRepo.get(s.repo) : undefined;
    const worktree = origin.ticket
      ? origin.ticket === BASE_TICKET
        ? (data?.base ?? null)
        : (data?.worktrees.get(origin.ticket) ?? null)
      : null;
    const task = origin.ticket ? (data?.tasks.get(origin.ticket) ?? null) : null;

    const identity = sessionIdentity(origin, worktree, task);
    entries.push({
      sessionId: s.sessionId,
      agentKind: s.agentKind,
      state: s.state,
      bucket,
      origin,
      repo: s.repo,
      termKey: s.termKey,
      cwd: s.cwd,
      message: s.message,
      updatedAtMs: s.updatedAtMs,
      live,
      tabKey: tab?.key ?? null,
      // An unparseable term key means no surface to open — `useOpenAgent` would
      // have nowhere to navigate, so the action is disabled instead of silently
      // doing nothing (which is exactly how it felt).
      openable: origin.kind !== "unknown",
      ticket: origin.ticket,
      ...identity,
      ...label(origin, worktree, task, s.cwd),
      worktree,
    });
  }
  return entries;
}

/** Project ownership and session purpose are separate dimensions: a Codex
 *  investigation and a Claude worktree can belong to the same Linear project,
 *  while fixed surfaces (the Triage desk, base workspace and Dev) have a clear
 *  home without pretending they came from a ticket. */
function sessionIdentity(
  origin: AgentOrigin,
  worktree: Worktree | null,
  task: Task | null,
): Pick<AgentEntry, "project" | "projectColor" | "projectIcon" | "purpose"> {
  const taskProject = task?.project || worktree?.project;
  const project = taskProject || "Unassigned";
  const projectMeta = {
    projectColor: task?.projectColor ?? null,
    projectIcon: task?.projectIcon ?? null,
  };

  switch (origin.kind) {
    case "tree":
      return origin.ticket === BASE_TICKET
        ? { project: "Workspace", projectColor: null, projectIcon: null, purpose: "Base workspace" }
        : { project, ...projectMeta, purpose: "Worktree" };
    case "tree-tab":
      return origin.ticket === BASE_TICKET
        ? {
            project: "Workspace",
            projectColor: null,
            projectIcon: null,
            purpose: "Base workspace tab",
          }
        : { project, ...projectMeta, purpose: "Worktree tab" };
    case "triage":
      return origin.ticket?.startsWith("__repo__:")
        ? { project: "Workspace", projectColor: null, projectIcon: null, purpose: "Triage desk" }
        : { project, ...projectMeta, purpose: "Investigation" };
    case "review":
      return { project: "Reviews", projectColor: null, projectIcon: null, purpose: "PR session" };
    case "ai-review":
      return { project: "Reviews", projectColor: null, projectIcon: null, purpose: "AI review" };
    case "dev":
      return {
        project: "Santree",
        projectColor: null,
        projectIcon: null,
        purpose: "Dev workspace",
      };
    default:
      return {
        project: "Unassigned",
        projectColor: null,
        projectIcon: null,
        purpose: "Unlinked session",
      };
  }
}

/** Title + subtitle for one entry, by origin. */
function label(
  origin: AgentOrigin,
  worktree: Worktree | null,
  task: Task | null,
  cwd: string,
): { title: string; subtitle: string | null } {
  const summary = worktree?.title ?? task?.title ?? null;
  switch (origin.kind) {
    case "tree":
    case "tree-tab": {
      const extra = origin.kind === "tree-tab" ? "extra tab" : null;
      if (origin.ticket === BASE_TICKET) {
        return { title: worktree?.branch || "base branch", subtitle: extra ?? summary };
      }
      return {
        title: origin.ticket ?? basename(cwd),
        subtitle: [extra, summary].filter(Boolean).join(" · ") || null,
      };
    }
    case "triage":
      if (origin.ticket?.startsWith("__repo__:")) {
        return { title: "Triage desk", subtitle: "Ask general questions about the repository" };
      }
      return { title: origin.ticket ?? basename(cwd), subtitle: summary ?? "investigation" };
    case "review":
      return { title: origin.pr ?? basename(cwd), subtitle: "asking about a PR" };
    case "ai-review":
      return { title: origin.pr ?? basename(cwd), subtitle: "reviewing a PR" };
    case "dev":
      return { title: "Dev", subtitle: basename(cwd) };
    default:
      return { title: basename(cwd) || "agent", subtitle: null };
  }
}

export interface AgentGroup {
  bucket: AgentBucket;
  entries: AgentEntry[];
}

export interface AgentProjectGroup {
  project: string;
  color: string | null;
  icon: string | null;
  entries: AgentEntry[];
}

/** Preserve the actionability ordering inside a state bucket, then carve it into
 *  project-sized reading chunks. First appearance wins so a recently active
 *  project's place does not jump independently from its sessions. */
export function groupAgentsByProject(entries: AgentEntry[]): AgentProjectGroup[] {
  const groups = new Map<string, AgentProjectGroup>();
  for (const entry of entries) {
    const group = groups.get(entry.project) ?? {
      project: entry.project,
      color: entry.projectColor,
      icon: entry.projectIcon,
      entries: [],
    };
    group.entries.push(entry);
    groups.set(entry.project, group);
  }
  return [...groups.values()];
}

/**
 * Split entries into their buckets, in {@link BUCKET_ORDER}, dropping empties.
 *
 * "Needs you" sorts **oldest first** — the ask that's been sitting longest is the
 * one costing you the most — while every other group sorts newest first, so the
 * thing that just moved is at the top of it.
 */
export function groupAgents(entries: AgentEntry[]): AgentGroup[] {
  const groups: AgentGroup[] = [];
  for (const bucket of BUCKET_ORDER) {
    const list = entries.filter((e) => e.bucket === bucket);
    if (list.length === 0) continue;
    const dir = bucket === "attention" ? 1 : -1;
    list.sort((a, b) => dir * ((a.updatedAtMs ?? 0) - (b.updatedAtMs ?? 0)));
    groups.push({ bucket, entries: bucket === "done" ? list.slice(0, MAX_DONE) : list });
  }
  return groups;
}

/** How many agents are blocked on you — the number the nav badge shows. */
export function attentionCount(entries: AgentEntry[]): number {
  return entries.filter((e) => e.bucket === "attention").length;
}

/**
 * {@link attentionCount} straight off the raw reads, for the always-mounted nav
 * chrome — it needs the number, not the per-repo enrichment the full fold does.
 * Deliberately shares `bucketOf` and the same liveness rule so the badge can
 * never disagree with the panel it points at.
 */
export function countAttention(sessions: SessionState[], terminals: TerminalTab[]): number {
  let n = 0;
  for (const s of sessions) {
    const origin = parseTermKey(s.termKey);
    const live = liveTabFor(s, origin, terminals) !== undefined;
    if (bucketOf(s.state, live) === "attention") n++;
  }
  return n;
}

/**
 * The colour an entry speaks in — the single source for its dot, its state word
 * and its message panel.
 *
 * A detached or finished session shows its *recorded* state as history ("it was
 * waiting when it died"), so it must not wear the urgent red that state carries
 * while live: a red dot inside the Detached group is exactly the false alarm the
 * bucketing exists to kill. The word stays; only the urgency goes.
 */
export function entryColor(entry: AgentEntry): string {
  if (entry.bucket === "detached" || entry.bucket === "done") return palette.muted;
  return sessionStateMeta[entry.state]?.color ?? palette.muted;
}

/** Display name for a repo scope. Sessions are keyed by repo, except the Dev
 *  tab's, which use a `@`-prefixed pseudo-repo — rendering that raw reads as a
 *  leaked internal id sitting among real repository names. Purely cosmetic, and
 *  a no-op if the Dev feature is ever removed. */
export function repoLabel(repo: string): string {
  return repo.startsWith("@") ? repo.slice(1).replace(/^\w/, (c) => c.toUpperCase()) : repo;
}

/** Filter entries by a free-text query over the fields a user would type: the
 *  ticket/title, the repo, and the pending message. */
export function filterAgents(entries: AgentEntry[], query: string): AgentEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) =>
    [e.title, e.subtitle, e.repo, e.message, e.ticket, e.project, e.purpose]
      .filter((v): v is string => !!v)
      .some((v) => v.toLowerCase().includes(q)),
  );
}
