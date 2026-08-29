/**
 * The agent registry: fold every live agent session — whatever surface launched
 * it — into one ordered list the sidebar tree, the status bar and the palette
 * all read from.
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
import { HOOK_STALE_AFTER_MS, levelOf, needsYou, type SeenMap } from "../../lib/attention";
import type { TerminalTab } from "../terminal/orchestrator";

/** The base-branch entry's sentinel ticket id (mirrors the Trees model's
 *  `BASE_ID` / Rust `worktree::BASE_ID` — duplicated here so this feature doesn't
 *  import the Trees model, which drags a React context along with it). */
export const BASE_TICKET = "__base__";

/** Which surface a session belongs to, parsed from its `term_key`. */
export type AgentOriginKind = "tree" | "tree-tab" | "triage" | "review" | "ai-review" | "unknown";

export interface AgentOrigin {
  kind: AgentOriginKind;
  /** Ticket id for `tree`/`tree-tab`/`triage` ({@link BASE_TICKET} for the base
   *  entry); `null` for the review kinds and `unknown`. */
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
  /** `null`/omitted when the session's provider is unknown — the ref then falls
   *  back to the bare key, which matches no per-provider tab, so an
   *  unattributable session reads as not-live rather than as someone else's. */
  agentKind?: AgentKind | null,
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

/** One agent as the panel renders it. */
export interface AgentEntry {
  sessionId: string;
  /** Provider that owns this durable session. Kept on the display model so the
   *  control surface never has to infer identity from a title or terminal key.
   *  `null` when the session lost the registry row that named it (a terminal that
   *  minted a second session takes the row with it) — the UI then shows no
   *  provider mark, rather than defaulting to one and labelling it wrong. */
  agentKind: AgentKind | null;
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
  /** What the hosted CLI last set its terminal title to, when a PTY is open for
   *  this session — the fallback status signal `levelOf` falls back to once the
   *  hook row has gone stale. `null` whenever there is no live PTY, which is the
   *  live-PTY gate made structural: a title from a dead process is a ghost. */
  terminalTitle: string | null;
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
  /**
   * Every open pane's terminal title, by pane label (`useSessionTitles`).
   *
   * Only panes that exist right now are in it, so joining through the live tab
   * below is also the live-PTY gate — a session whose process ended can't pick
   * up a title, and can't keep one.
   */
  titles?: ReadonlyMap<string, string>;
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
  const { sessions, terminals, repos, allRepos, titles, nowMs } = input;
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
      // Joined through the live tab, whose `refId ?? key` IS the label the pane
      // files its title under (see `TerminalLayer`) — so this is null exactly
      // when there is no PTY, with no separate liveness check to keep in sync.
      terminalTitle: tab ? (titles?.get(tab.refId ?? tab.key) ?? null) : null,
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
    default:
      return { title: basename(cwd) || "agent", subtitle: null };
  }
}

/** `needs-you` is never seen-gated (looking at a question does not answer it),
 *  so the counts below need no acknowledgement map — an empty one is the
 *  identity here, not a shortcut. */
const NOT_SEEN: SeenMap = {};

/**
 * How many agents are blocked on you — the number the nav badge shows.
 *
 * Goes through `levelOf` rather than reading the bucket, so the badge speaks the
 * same classification as the dot it points at: a hook row too old to be believed
 * renders at rest in the tree, and must not still be shouting up here.
 */
export function attentionCount(entries: AgentEntry[], nowMs: number = Date.now()): number {
  return entries.filter((e) => needsYou(levelOf(e, NOT_SEEN, nowMs).level)).length;
}

/**
 * {@link attentionCount} straight off the raw reads, for the always-mounted nav
 * chrome — it needs the number, not the per-repo enrichment the full fold does.
 * Deliberately shares `bucketOf`, the same liveness rule and the same freshness
 * window so the badge can never disagree with the panel it points at.
 *
 * Only a `bucketOf` claim can ever be `needs-you` — the title fallback speaks
 * `working` and `idle` and nothing else — so a freshness check is all the raw
 * shortcut needs to stay in step with `levelOf`.
 */
export function countAttention(
  sessions: SessionState[],
  terminals: TerminalTab[],
  nowMs: number = Date.now(),
): number {
  let n = 0;
  for (const s of sessions) {
    const origin = parseTermKey(s.termKey);
    const live = liveTabFor(s, origin, terminals) !== undefined;
    if (bucketOf(s.state, live) !== "attention") continue;
    if (nowMs - (s.updatedAtMs ?? 0) > HOOK_STALE_AFTER_MS) continue;
    n++;
  }
  return n;
}
