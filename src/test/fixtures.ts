/**
 * Shared test fixtures — the one place a `Worktree`, a `SessionState`, a `Task`,
 * a `TriageTicket` or an `AgentEntry` is built for a test.
 *
 * Before this module every test file reinvented its own defaults, and there was
 * nowhere to review them. That is not a tidiness problem: a fixture default is
 * a silent decision about which branch of the code under test can run at all,
 * and twenty-six copies of that decision are twenty-six places for one to go
 * wrong unnoticed. This repo has already paid for it — a local `worktree()`
 * helper defaulting `project: "Core"` meant no test in that file could describe
 * a worktree with no project, so the "no project" band was written, shipped and
 * broken without a red test.
 *
 * ## The rule these are built to (follow it when you add one)
 *
 *  1. **Spread the caller's overrides LAST.** `{ ...defaults, ...over }`, never
 *     `{ ...over, field: over.field ?? "Claude" }`. The second form silently
 *     removes `null` from the field's domain: a caller can pass it and the
 *     fixture will hand back the default anyway, so the branch that reads
 *     `null` becomes unconstructible and its test can never be written. That is
 *     exactly how `SessionState.agentKind: null` — the case where santree
 *     cannot name a session's provider, and must therefore report it as
 *     *not live* rather than as someone else's — went untested.
 *  2. **Required, not defaulted, for whatever the test's meaning turns on.**
 *     The identity a fixture is looked up by is a parameter (`id`,
 *     `sessionId`, `bucket`). A default there reads as "any id", which is never
 *     what a test means.
 *  3. **Neutral defaults, not convenient ones.** The default is the value that
 *     asserts nothing — `project: null`, `status: null`, `blockedBy: []`,
 *     counters at 0 — not the value that happens to make the most tests pass.
 *     A test that wants a project says so. The two deliberate exceptions are
 *     documented at their fields below; there are no others.
 *  4. **No `as` casts.** Every fixture returns a fully-populated, exactly-typed
 *     value, so a field added to the domain type breaks this file (one place)
 *     instead of being silently absent from every test object. `attention.ts`'s
 *     old local fixture was cast `as AgentEntry` and had been carrying a
 *     non-existent `origin.path` and no `origin.tabId` for exactly that reason.
 *  5. **Derive what can be derived.** `agentEntry` reads its `origin` out of its
 *     own `termKey` through the real `parseTermKey`, so a fixture cannot state
 *     an origin that contradicts the key it claims to have.
 */
import type { SessionState, Task, TriageTicket, Worktree } from "../bindings";
import type { AgentBucket, AgentEntry } from "../features/agents/registry";
import { parseTermKey } from "../features/agents/registry";
import { HOOK_STALE_AFTER_MS } from "../lib/attention";

/** A fixed "now" for every fixture, so a test's timestamps are readable
 *  arithmetic against one number instead of a live clock.
 *
 *  **Hand this to the code under test as its `now` too.** Every fixture here is
 *  stamped `NOW`, so a fold or a component given a live `Date.now()` sees every
 *  one of them as years old and reports it at rest — `useTickets`' fold helper
 *  passed `nowMs: Date.now()` and that alone made the fresh-hook tier of its
 *  attention join unreachable, silently, from a fixture that looked correct. */
export const NOW = 1_700_000_000_000;

/** A moment old enough that a hook event stamped with it has stopped being
 *  evidence — the input that moves `levelOf` off its first tier and onto the
 *  terminal-title fallback. Named because "NOW - 30 * 60 * 1000 - 1" at a call
 *  site says the arithmetic and hides the meaning. */
export const STALE = NOW - HOOK_STALE_AFTER_MS - 1;

/**
 * A worktree as the backend actually ships one: no invented status or activity,
 * nothing ahead or behind, and **no project** — the band a worktree lands in
 * when Linear has none for it, which a `"Core"` default would hide.
 */
export function worktree(id: string, over: Partial<Worktree> = {}): Worktree {
  return {
    id,
    title: `Task ${id}`,
    status: null,
    addLines: 0,
    delLines: 0,
    dirty: false,
    ahead: 0,
    behind: 0,
    // Not a convenience: `unpushed > 0` is what makes `prDiffModeFor` pick the
    // local diff *with* the out-of-sync notice instead of GitHub's patch, and a
    // fixture that could not express it is how that branch went uncovered.
    unpushed: 0,
    remoteBehind: 0,
    pullConflict: false,
    // Exception to rule 3, deliberately: santree creates every worktree with a
    // provider, so `null` here is the *unknown-provider* case rather than the
    // ordinary one. Tests about an unknown provider pass `agent: null`.
    agent: "Claude",
    activity: null,
    branch: `santree/${id.toLowerCase()}`,
    path: `/tmp/${id}`,
    project: null,
    baseBranch: "main",
    setupRan: true,
    pending: false,
    ...over,
  };
}

/**
 * A session row as `santree-hook` writes one.
 *
 * `agentKind` is spread-overridable like everything else — see rule 1. `null`
 * means santree lost the registry row that named the provider, and the registry
 * must then treat the session as matching no pane at all.
 */
export function session(over: Partial<SessionState> & { sessionId: string }): SessionState {
  return {
    agentKind: "Claude",
    state: "active",
    event: "UserPromptSubmit",
    cwd: "/repo",
    message: null,
    transcriptPath: null,
    updatedAtMs: NOW,
    repo: null,
    termKey: null,
    ...over,
  };
}

/** A Linear issue. `project` is required because `Task.project` is a non-null
 *  string the grouping keys on — there is no neutral value to pick for you. */
export function task(id: string, project: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    priority: "None",
    estimate: null,
    project,
    projectColor: null,
    projectIcon: null,
    projectTargetDate: null,
    projectMilestone: null,
    parentId: null,
    status: "Todo",
    ready: true,
    blockedBy: [],
    actionable: true,
    assignee: null,
    assigneeAvatarUrl: null,
    x: 0,
    y: 0,
    ...over,
  };
}

/**
 * A triage ticket.
 *
 * `createdAtMs` is a required parameter, not a default. Every triage order
 * except `created-newest` falls through to "oldest first" as its last tiebreak,
 * so a fixture that stamped every ticket with the same creation time collapsed
 * four of the six orderings onto the id tiebreak and made them untestable.
 */
export function triageTicket(
  id: string,
  createdAtMs: number,
  over: Partial<TriageTicket> = {},
): TriageTicket {
  return {
    id,
    title: id,
    priority: "None",
    estimate: null,
    project: null,
    projectColor: null,
    projectIcon: null,
    projectTargetDate: null,
    dueDate: null,
    sortOrder: null,
    createdAtMs,
    meta: "unassigned",
    team: "SAN",
    slaBreachMs: null,
    snoozedUntilMs: null,
    mine: true,
    ...over,
  };
}

/**
 * One agent as the sidebar and the palette render it.
 *
 * `bucket` is required: it is the classification the whole display model hangs
 * off, and "some bucket" is never what a test means.
 *
 * `origin` is derived from `termKey` through the real `parseTermKey` unless the
 * caller overrides it outright, so the fixture cannot claim a surface its own
 * key disagrees with.
 *
 * `updatedAtMs` and `terminalTitle` are the pair `levelOf` arbitrates between:
 * a fresh timestamp keeps it on tier 1 (the hook), {@link STALE} drops it to
 * tier 2 (the terminal title, and only with `live: true`) or tier 3 (nothing).
 * Pinning either one in a local fixture is how two of those three tiers stopped
 * being exercised.
 */
export function agentEntry(over: Partial<AgentEntry> & { bucket: AgentBucket }): AgentEntry {
  const termKey = over.termKey ?? ("termKey" in over ? null : "tree:AK-1");
  const origin = over.origin ?? parseTermKey(termKey);
  const defaults: AgentEntry = {
    sessionId: "s1",
    agentKind: "Claude",
    state: "active",
    bucket: over.bucket,
    origin,
    repo: "acme/app",
    termKey,
    cwd: "/repo",
    message: null,
    updatedAtMs: NOW,
    live: true,
    tabKey: null,
    terminalTitle: null,
    openable: true,
    ticket: origin.ticket,
    project: "Core",
    projectColor: null,
    projectIcon: null,
    purpose: "work",
    title: "Task",
    subtitle: null,
    worktree: null,
  };
  return { ...defaults, ...over };
}
