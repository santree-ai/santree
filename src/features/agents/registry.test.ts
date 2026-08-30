import { describe, expect, it } from "vitest";

import type { AgentKind, SessionState, Worktree } from "../../bindings";
import { HOOK_STALE_AFTER_MS } from "../../lib/attention";
import { session as baseSession, worktree as baseWorktree, NOW } from "../../test/fixtures";
import type { TerminalSource, TerminalTab } from "../terminal/orchestrator";
import { paneAddress } from "../terminal/paneAddress";
import {
  attentionCount,
  type BuildInput,
  bucketOf,
  buildAgentEntries,
  countAttention,
  DONE_WINDOW_MS,
  liveTabFor,
  parseTermKey,
  type RepoData,
} from "./registry";

const worktree = (id: string, over: Partial<Worktree> = {}) =>
  baseWorktree(id, { path: `/repo/.santree/worktrees/${id}`, ...over });

/**
 * A session row, scoped to this file's repo.
 *
 * The overrides are spread LAST, deliberately and load-bearingly: this helper
 * used to end with `agentKind: over.agentKind ?? "Claude"`, which quietly took
 * `null` out of the field's domain — a caller could pass it and still get back
 * "Claude". The whole "santree cannot name this session's provider" branch of
 * `liveTabFor` was therefore unconstructible from here, and untested. See
 * `src/test/fixtures.ts`.
 */
const session = (over: Partial<SessionState> & { sessionId: string }) =>
  baseSession({ repo: "canary", ...over });

/**
 * One live PTY pane, addressed the way every launch site addresses one: the
 * surface's `term_key` as the tab's `refId` — undecorated, exactly the string
 * the durable row carries — and the provider santree launched in it beside it.
 */
function pane(
  termKey: string,
  kind: AgentKind,
  source: TerminalSource = "issue",
  key = `p-${source}-${termKey}-${kind}`,
): TerminalTab {
  return {
    key,
    title: termKey,
    source,
    refId: termKey,
    agent: { kind, repo: "canary", termKey },
  };
}

/** Live Claude PTY tabs for the given tree term keys — what makes a session
 *  `live`. */
function liveTabs(...termKeys: string[]): TerminalTab[] {
  return termKeys.map((termKey, i) => pane(termKey, "Claude", "issue", `t${i}`));
}

/** One selected repo's enrichment. Defaults to "canary" with nothing in it. */
function repoData(over: Partial<RepoData> = {}): RepoData {
  return { repo: "canary", worktrees: [], tasks: [], baseWorktree: null, ...over };
}

function build(over: Partial<BuildInput> = {}): BuildInput {
  return {
    sessions: [],
    terminals: [],
    repos: [repoData()],
    allRepos: ["canary", "other"],
    nowMs: NOW,
    ...over,
  };
}

describe("parseTermKey", () => {
  it("parses each launch site's convention", () => {
    expect(parseTermKey("tree:AK-1")).toEqual({
      kind: "tree",
      ticket: "AK-1",
      tabId: null,
      pr: null,
    });
    expect(parseTermKey("tree:AK-1:tab:6f9a")).toEqual({
      kind: "tree-tab",
      ticket: "AK-1",
      tabId: "6f9a",
      pr: null,
    });
    expect(parseTermKey("triage:AK-9")).toEqual({
      kind: "triage",
      ticket: "AK-9",
      tabId: null,
      pr: null,
    });
    expect(parseTermKey("review:acme/web#4821")).toEqual({
      kind: "review",
      ticket: null,
      tabId: null,
      pr: "acme/web#4821",
    });
    expect(parseTermKey("ai-review:acme/web#4821")).toEqual({
      kind: "ai-review",
      ticket: null,
      tabId: null,
      pr: "acme/web#4821",
    });
  });

  it("falls back to unknown for a missing or unrecognized key", () => {
    expect(parseTermKey(null).kind).toBe("unknown");
    expect(parseTermKey("something-else").kind).toBe("unknown");
  });
});

describe("liveTabFor", () => {
  /** The regression this join exists for. Triage and the AI review used to open
   *  their PTY under a provider-suffixed key (`triage:AK-9::codex`), which
   *  matched no `term_key` anywhere — so a running investigation was reported as
   *  having no live pane, and the fold below turned it into `done`. Every
   *  surface now opens under the plain key, whatever its provider. */
  it("finds a triage or AI-review pane by the surface key the row stores", () => {
    const terminals = [
      pane("triage:AK-9", "Codex", "triage"),
      pane("ai-review:acme/web#7", "Claude", "review"),
      pane("tree:AK-1", "Claude"),
    ];
    expect(liveTabFor("triage:AK-9", "Codex", terminals)?.refId).toBe("triage:AK-9");
    expect(liveTabFor("ai-review:acme/web#7", "Claude", terminals)?.refId).toBe(
      "ai-review:acme/web#7",
    );
    expect(liveTabFor("tree:AK-1", "Claude", terminals)?.refId).toBe("tree:AK-1");
  });

  /** The other half of the pair. One surface can host a pane per provider, so
   *  the key alone would report the Claude session as running because the Codex
   *  pane beside it is. */
  it("keeps two providers on one surface apart", () => {
    const terminals = [
      pane("ai-review:acme/web#7", "Claude", "review"),
      pane("ai-review:acme/web#7", "Codex", "review"),
    ];
    expect(liveTabFor("ai-review:acme/web#7", "Claude", terminals)?.agent?.kind).toBe("Claude");
    expect(liveTabFor("ai-review:acme/web#7", "Codex", terminals)?.agent?.kind).toBe("Codex");
    expect(liveTabFor("triage:AK-9", "Codex", terminals)).toBeUndefined();
  });

  it("matches nothing for a session santree cannot attribute", () => {
    const terminals = [pane("triage:AK-9", "Codex", "triage")];
    expect(liveTabFor(null, "Codex", terminals)).toBeUndefined();
    expect(liveTabFor("triage:AK-9", null, terminals)).toBeUndefined();
    expect(liveTabFor("triage:AK-9", "Claude", terminals)).toBeUndefined();
  });
});

describe("bucketOf", () => {
  it("buckets a live session by what it wants from you", () => {
    expect(bucketOf("permission", true)).toBe("attention");
    expect(bucketOf("waiting", true)).toBe("attention");
    expect(bucketOf("active", true)).toBe("working");
    expect(bucketOf("delegating", true)).toBe("working");
    expect(bucketOf("idle", true)).toBe("idle");
  });

  it("never raises an alarm for a session with no live process", () => {
    // The PTY is a child of this app: no PTY means the agent is gone, whatever
    // its last hook wrote. A stored `waiting` is then a leftover, not a request.
    expect(bucketOf("waiting", false)).toBe("detached");
    expect(bucketOf("permission", false)).toBe("detached");
    expect(bucketOf("active", false)).toBe("detached");
  });

  it("keeps an explicitly exited session as finished either way", () => {
    expect(bucketOf("exited", false)).toBe("done");
    expect(bucketOf("exited", true)).toBe("done");
  });
});

describe("buildAgentEntries", () => {
  it("keeps two sessions in the same cwd apart (the bug a cwd-keyed map hides)", () => {
    // A base-branch agent and a triage investigation both run at the repo root.
    const entries = buildAgentEntries(
      build({
        sessions: [
          session({ sessionId: "base", termKey: "tree:__base__", cwd: "/repo" }),
          session({ sessionId: "inv", termKey: "triage:AK-9", cwd: "/repo" }),
        ],
      }),
    );
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.origin.kind)).toEqual(["tree", "triage"]);
  });

  it("marks a session live only when its PTY tab is open, and carries its key", () => {
    const entries = buildAgentEntries(
      build({
        terminals: liveTabs("tree:AK-1"),
        sessions: [
          session({ sessionId: "a", termKey: "tree:AK-1" }),
          session({ sessionId: "b", termKey: "tree:AK-2" }),
        ],
      }),
    );
    expect(entries[0]).toMatchObject({ live: true, tabKey: "t0", bucket: "working" });
    expect(entries[1]).toMatchObject({ live: false, tabKey: null, bucket: "detached" });
  });

  /** The surfaces the Trees-shaped tests above never covered. A triage
   *  investigation and an AI review used to open their PTY under a
   *  provider-suffixed ref, so no tab matched the `term_key` their row carries
   *  and a running agent was folded away as having no process. */
  it("marks a live triage or AI-review session live, whatever provider runs it", () => {
    const entries = buildAgentEntries(
      build({
        sessions: [
          session({
            sessionId: "inv",
            termKey: "triage:AK-9",
            agentKind: "Codex",
            state: "waiting",
            message: "Which environment?",
          }),
          session({
            sessionId: "rev",
            termKey: "ai-review:acme/web#7",
            agentKind: "Claude",
            state: "active",
          }),
        ],
        terminals: [
          pane("triage:AK-9", "Codex", "triage"),
          pane("ai-review:acme/web#7", "Claude", "review"),
        ],
      }),
    );
    expect(entries.map((e) => [e.origin.kind, e.live, e.bucket])).toEqual([
      ["triage", true, "attention"],
      ["ai-review", true, "working"],
    ]);
    // …and the attention signal survives the fold, which is what the bug ate.
    expect(attentionCount(entries, NOW)).toBe(1);
  });

  /** The real DB has both providers' rows on one `ai-review:` surface. They are
   *  two sessions in two panes, and each must find its own. */
  it("gives a surface's two providers one live entry each", () => {
    const sessions = [
      session({ sessionId: "c", termKey: "ai-review:acme/web#7", agentKind: "Claude" }),
      session({ sessionId: "x", termKey: "ai-review:acme/web#7", agentKind: "Codex" }),
    ];
    const claudePane = pane("ai-review:acme/web#7", "Claude", "review");
    const entries = buildAgentEntries(build({ sessions, terminals: [claudePane] }));
    expect(entries.map((e) => [e.sessionId, e.live, e.tabKey])).toEqual([
      ["c", true, claudePane.key],
      // Only Claude's pane is open, so Codex's row is detached rather than
      // borrowing the liveness of the pane beside it.
      ["x", false, null],
    ]);
  });

  /**
   * The branch this file's `session()` helper made unconstructible until its
   * spread order was fixed: a row whose provider santree cannot name.
   *
   * `SessionState.agentKind` is `null` when the session lost the registry row
   * that named it — a terminal keeps one row per logical surface, so the moment
   * it mints a *second* session the first one's join is gone. The pane on that
   * surface is still open and still belongs to somebody, so the unnamed row must
   * match NOTHING: reported not-live, its own provider left blank rather than
   * guessed, and no attention raised for a process that may already be dead.
   * Borrowing the neighbouring pane's liveness is the alternative, and it would
   * paint a finished session with a live "waiting on you" dot.
   */
  it("matches no pane for a session whose provider it cannot name", () => {
    const claudePane = pane("tree:AK-1", "Claude");
    const entries = buildAgentEntries(
      build({
        repos: [repoData({ worktrees: [worktree("AK-1")] })],
        sessions: [
          session({ sessionId: "named", termKey: "tree:AK-1", agentKind: "Claude" }),
          session({ sessionId: "orphan", termKey: "tree:AK-1", agentKind: null, state: "waiting" }),
        ],
        terminals: [claudePane],
      }),
    );

    expect(entries.map((e) => [e.sessionId, e.agentKind, e.live, e.tabKey])).toEqual([
      ["named", "Claude", true, claudePane.key],
      ["orphan", null, false, null],
    ]);
    // Detached, not "attention": nothing may ask the user to answer a prompt
    // santree can no longer prove is still on screen.
    expect(entries.map((e) => e.bucket)).toEqual(["working", "detached"]);
    expect(attentionCount(entries, NOW)).toBe(0);
  });

  it("enriches every selected repo, not just one active one", () => {
    const entries = buildAgentEntries(
      build({
        repos: [
          repoData({ repo: "canary", worktrees: [worktree("AK-1")] }),
          repoData({ repo: "other", worktrees: [worktree("AK-9")] }),
        ],
        sessions: [
          session({ sessionId: "a", termKey: "tree:AK-1", repo: "canary" }),
          session({ sessionId: "b", termKey: "tree:AK-9", repo: "other" }),
        ],
      }),
    );
    expect(entries.map((e) => e.subtitle)).toEqual(["Task AK-1", "Task AK-9"]);
    expect(entries.map((e) => e.worktree?.branch)).toEqual(["santree/ak-1", "santree/ak-9"]);
  });

  it("identifies ticket work, fixed workspaces and review sessions by purpose", () => {
    const base = worktree("__base__");
    base.branch = "master";
    const ticket = worktree("AK-1");
    ticket.project = "Knowledge Base";
    const entries = buildAgentEntries(
      build({
        repos: [repoData({ worktrees: [ticket], baseWorktree: base })],
        sessions: [
          session({ sessionId: "base", termKey: "tree:__base__" }),
          session({ sessionId: "base-tab", termKey: "tree:__base__:tab:one" }),
          session({ sessionId: "work", termKey: "tree:AK-1" }),
          session({ sessionId: "review", termKey: "ai-review:acme/app#7" }),
        ],
      }),
    );

    expect(entries.map(({ project, purpose, title }) => ({ project, purpose, title }))).toEqual([
      { project: "Workspace", purpose: "Base workspace", title: "master" },
      { project: "Workspace", purpose: "Base workspace tab", title: "master" },
      { project: "Knowledge Base", purpose: "Worktree", title: "AK-1" },
      { project: "Reviews", purpose: "AI review", title: "acme/app#7" },
    ]);
  });

  it("drops sessions from repos that aren't selected", () => {
    const entries = buildAgentEntries(
      build({
        repos: [repoData({ repo: "canary" })],
        sessions: [
          session({ sessionId: "shown", termKey: "tree:AK-1", repo: "canary" }),
          session({ sessionId: "hidden", termKey: "tree:AK-2", repo: "other" }),
        ],
      }),
    );
    expect(entries.map((e) => e.sessionId)).toEqual(["shown"]);
  });

  it("keeps sessions scoped to something that was never a repo", () => {
    // Filtering is "known but not selected", not "not selected": a session whose
    // repo was never registered has no checkbox to turn back on, so dropping it
    // would hide it permanently.
    const entries = buildAgentEntries(
      build({
        repos: [repoData({ repo: "canary" })],
        allRepos: ["canary", "other"],
        sessions: [session({ sessionId: "stray", termKey: "tree:AK-9", repo: "unregistered" })],
      }),
    );
    expect(entries.map((e) => e.sessionId)).toEqual(["stray"]);
  });

  it("never borrows one repo's worktree for another repo's ticket", () => {
    // Two repos can each have an AK-1; enrichment must come from the session's
    // own repo, not from whichever list happens to contain the id.
    const entries = buildAgentEntries(
      build({
        repos: [
          repoData({ repo: "canary", worktrees: [worktree("AK-1")] }),
          repoData({ repo: "other" }),
        ],
        sessions: [session({ sessionId: "a", termKey: "tree:AK-1", repo: "other" })],
      }),
    );
    expect(entries[0].worktree).toBeNull();
    expect(entries[0].subtitle).toBeNull();
  });

  it("names the base entry by its branch", () => {
    const base = { ...worktree("__base__"), branch: "main", title: "" };
    const entries = buildAgentEntries(
      build({
        repos: [repoData({ baseWorktree: base })],
        sessions: [session({ sessionId: "a", termKey: "tree:__base__" })],
      }),
    );
    expect(entries[0].title).toBe("main");
  });

  it("marks a session santree can't attribute as not openable", () => {
    const entries = buildAgentEntries(
      build({ sessions: [session({ sessionId: "a", state: "waiting", termKey: null })] }),
    );
    // Recent, so it's still listed — but "open" has nowhere to go and says so
    // instead of being a button that does nothing.
    expect(entries[0].openable).toBe(false);
    expect(entries[0].bucket).toBe("detached");
  });

  it("drops a finished session that has lost its owner", () => {
    const entries = buildAgentEntries(
      build({ sessions: [session({ sessionId: "corpse", state: "exited", termKey: null })] }),
    );
    expect(entries).toEqual([]);
  });

  it("drops a finished session older than the done window", () => {
    const entries = buildAgentEntries(
      build({
        sessions: [
          session({
            sessionId: "old",
            state: "exited",
            termKey: "tree:AK-1",
            updatedAtMs: NOW - DONE_WINDOW_MS - 1,
          }),
          session({
            sessionId: "recent",
            state: "exited",
            termKey: "tree:AK-2",
            updatedAtMs: NOW - 1000,
          }),
        ],
      }),
    );
    expect(entries.map((e) => e.sessionId)).toEqual(["recent"]);
  });

  it("drops the stale ghost: unowned, no live process, and days old", () => {
    // A session that died with a prompt on screen keeps `waiting` on disk with
    // nothing to attribute it to. It used to sit at the top of the panel as an
    // alarm nobody could answer or clear.
    const entries = buildAgentEntries(
      build({
        sessions: [
          session({
            sessionId: "ghost",
            state: "waiting",
            termKey: null,
            updatedAtMs: NOW - DONE_WINDOW_MS - 1,
          }),
          session({
            sessionId: "just-now",
            state: "waiting",
            termKey: null,
            updatedAtMs: NOW - 60_000,
          }),
        ],
      }),
    );
    expect(entries.map((e) => e.sessionId)).toEqual(["just-now"]);
  });

  it("keeps an old session that is still live", () => {
    const entries = buildAgentEntries(
      build({
        terminals: liveTabs("tree:AK-1"),
        sessions: [
          session({
            sessionId: "long-runner",
            state: "waiting",
            termKey: "tree:AK-1",
            updatedAtMs: NOW - DONE_WINDOW_MS - 1,
          }),
        ],
      }),
    );
    expect(entries.map((e) => e.bucket)).toEqual(["attention"]);
  });
});

describe("terminal titles", () => {
  /** The title of the pane running a session, joined through the live tab —
   *  which is also the live-PTY gate, since only open panes have an entry. */
  it("joins a live pane's title onto the session it hosts", () => {
    const entries = buildAgentEntries(
      build({
        sessions: [session({ sessionId: "a", termKey: "tree:AK-1" })],
        terminals: liveTabs("tree:AK-1"),
        // Keyed by the pane's address, exactly as `TerminalView` files it.
        titles: new Map([[paneAddress("tree:AK-1", "Claude"), "\u25d0 Fix the flaky suite"]]),
      }),
    );
    expect(entries[0].terminalTitle).toBe("\u25d0 Fix the flaky suite");
  });

  it("takes no title for a session with no live PTY", () => {
    // A title left over from a process that has gone is a ghost: it would keep
    // saying "working" with nothing running that could ever correct it.
    const entries = buildAgentEntries(
      build({
        sessions: [session({ sessionId: "a", termKey: "tree:AK-1" })],
        terminals: [],
        titles: new Map([["tree:AK-1", "\u25d0 Fix the flaky suite"]]),
      }),
    );
    expect(entries[0].live).toBe(false);
    expect(entries[0].terminalTitle).toBeNull();
  });

  it("gives a session whose pane has set no title nothing to read", () => {
    const entries = buildAgentEntries(
      build({
        sessions: [session({ sessionId: "a", termKey: "tree:AK-1" })],
        terminals: liveTabs("tree:AK-1"),
      }),
    );
    expect(entries[0].terminalTitle).toBeNull();
  });
});

describe("attention counting", () => {
  const sessions = [
    session({ sessionId: "a", state: "waiting", termKey: "tree:AK-1" }),
    session({ sessionId: "b", state: "permission", termKey: "tree:AK-2" }),
    session({ sessionId: "c", state: "active", termKey: "tree:AK-3" }),
    // Dead process still recorded as waiting — must never reach the badge.
    session({ sessionId: "ghost", state: "waiting", termKey: "tree:AK-4" }),
  ];
  const terminals = liveTabs("tree:AK-1", "tree:AK-2", "tree:AK-3");

  it("counts only live agents that are blocked on the user", () => {
    const entries = buildAgentEntries(build({ sessions, terminals }));
    expect(attentionCount(entries, NOW)).toBe(2);
  });

  it("agrees with the badge's own shortcut over the raw reads", () => {
    // The badge must never claim an alert the panel doesn't show.
    const entries = buildAgentEntries(build({ sessions, terminals }));
    expect(countAttention(sessions, terminals, NOW)).toBe(attentionCount(entries, NOW));
  });

  it("stops counting a block whose hook event has gone stale, in both", () => {
    // A prompt nobody answered for half an hour is a ghost, not an alarm — and
    // the tree stops drawing it at exactly this moment, so the badge must too.
    const old = NOW - HOOK_STALE_AFTER_MS - 1;
    const stale = [
      session({ sessionId: "a", state: "waiting", termKey: "tree:AK-1", updatedAtMs: old }),
    ];
    const live = liveTabs("tree:AK-1");
    expect(countAttention(stale, live, NOW)).toBe(0);
    expect(
      attentionCount(buildAgentEntries(build({ sessions: stale, terminals: live })), NOW),
    ).toBe(0);
  });
});

/**
 * The Codex-shaped gap this exists to close: a provider that does not announce
 * its session at launch.
 *
 * Codex creates its thread on the first submitted turn and fires `SessionStart`
 * only there, so a tab opened and left at the prompt produces no session row and
 * no `terminal_sessions` binding — for minutes, or forever if the user never
 * types. Reading only the rows meant the sidebar showed nothing for a real,
 * running agent (see `hooks.rs` `CODEX_EVENTS` for the measurement).
 */
describe("agents santree launched that have not announced a session", () => {
  /** A tab carrying santree's own record of the launch. */
  function agentTab(termKey: string, kind: "Claude" | "Codex" = "Codex"): TerminalTab {
    return {
      key: "t-launch",
      title: termKey,
      source: "issue" as const,
      refId: termKey,
      cwd: "/repo/.santree/worktrees/AK-1",
      agent: { kind, repo: "canary", termKey },
    };
  }

  it("shows the launch, filed under its worktree, with no session id or state", () => {
    const entries = buildAgentEntries(
      build({
        terminals: [agentTab("tree:AK-1")],
        repos: [repoData({ worktrees: [worktree("AK-1")] })],
      }),
    );
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry.sessionId).toBeNull();
    // Never a stand-in status: nothing has reported one.
    expect(entry.state).toBeNull();
    expect(entry.agentKind).toBe("Codex");
    expect(entry.repo).toBe("canary");
    expect(entry.termKey).toBe("tree:AK-1");
    expect(entry.origin).toEqual({ kind: "tree", ticket: "AK-1", tabId: null, pr: null });
    expect(entry.worktree?.id).toBe("AK-1");
    expect(entry.live).toBe(true);
    expect(entry.openable).toBe(true);
    expect(entry.updatedAtMs).toBeNull();
  });

  it("is superseded — not duplicated — once the provider's row arrives", () => {
    const entries = buildAgentEntries(
      build({
        sessions: [session({ sessionId: "01a0", termKey: "tree:AK-1", agentKind: "Codex" })],
        terminals: [agentTab("tree:AK-1")],
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe("01a0");
  });

  it("stays superseded even when the row is dropped as stale", () => {
    // A finished session past the done window is filtered out of the panel. The
    // tab it ran in is still open, and must not come back as a second, launch-
    // shaped row claiming a fresh agent.
    const entries = buildAgentEntries(
      build({
        sessions: [
          session({
            sessionId: "01a0",
            termKey: "tree:AK-1",
            agentKind: "Codex",
            state: "exited",
            updatedAtMs: NOW - DONE_WINDOW_MS - 1,
          }),
        ],
        terminals: [agentTab("tree:AK-1")],
      }),
    );
    expect(entries).toHaveLength(0);
  });

  it("ignores a plain shell tab, which is nobody's agent", () => {
    const shell: TerminalTab = {
      key: "t-shell",
      title: "tree:AK-1",
      source: "issue",
      refId: "tree:AK-1",
    };
    expect(buildAgentEntries(build({ terminals: [shell] }))).toHaveLength(0);
  });

  it("respects the repo the picker turned off", () => {
    const hidden = {
      ...agentTab("tree:AK-1"),
      agent: { kind: "Codex" as const, repo: "other", termKey: "tree:AK-1" },
    };
    expect(buildAgentEntries(build({ terminals: [hidden] }))).toHaveLength(0);
  });

  it("never asks the user for anything — it has reported nothing to ask with", () => {
    const entries = buildAgentEntries(build({ terminals: [agentTab("tree:AK-1")] }));
    expect(attentionCount(entries, NOW)).toBe(0);
  });
});

/**
 * What `ps` sees, folded in beside the two records.
 *
 * Process detection observes reality — it catches an agent the user started by
 * hand, and it survives them quitting one CLI and starting another in the same
 * pane — so it outranks santree's launch record. It cannot *replace* it: a `ps`
 * that fails, or a CLI behind an interpreter, names nothing, and the record is
 * what stands then. Identity only: nothing here may produce a status.
 */
describe("agents the process table sees", () => {
  function shellTab(refId: string, key = "t-shell"): TerminalTab {
    return {
      key,
      title: refId,
      source: "issue" as const,
      refId,
      cwd: "/repo/.santree/worktrees/AK-1",
    };
  }

  function launchedTab(termKey: string, kind: "Claude" | "Codex"): TerminalTab {
    return { ...shellTab(termKey, "t-launch"), agent: { kind, repo: "canary", termKey } };
  }

  it("claims an agent the user started in a shell tab, filed under its worktree", () => {
    const entries = buildAgentEntries(
      build({
        terminals: [shellTab("tree:AK-1")],
        repos: [repoData({ worktrees: [worktree("AK-1")] })],
        detected: new Map([["tree:AK-1", "Codex"]]),
      }),
    );
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry.agentKind).toBe("Codex");
    // The ticket is in exactly one shown repo, so the placement is unambiguous.
    expect(entry.repo).toBe("canary");
    expect(entry.worktree?.id).toBe("AK-1");
    expect(entry.termKey).toBe("tree:AK-1");
    expect(entry.sessionId).toBeNull();
    expect(entry.state).toBeNull();
    expect(entry.live).toBe(true);
  });

  it("outranks santree's launch record, which is only a memory of the launch", () => {
    const entries = buildAgentEntries(
      build({
        terminals: [launchedTab("tree:AK-1", "Claude")],
        // The scan answers per pane, so it is keyed per pane: the surface plus
        // the provider santree launched there.
        detected: new Map([[paneAddress("tree:AK-1", "Claude"), "Codex"]]),
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].agentKind).toBe("Codex");
  });

  it("leaves the launch record standing when the scan names nothing", () => {
    // A failed or slow `ps`, or a CLI whose argv[0] is its interpreter: absence
    // is no information, never "no agent".
    for (const detected of [undefined, new Map()]) {
      const entries = buildAgentEntries(
        build({ terminals: [launchedTab("tree:AK-1", "Codex")], detected }),
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].agentKind).toBe("Codex");
    }
  });

  it("still ignores a plain shell tab nothing was seen in", () => {
    expect(
      buildAgentEntries(build({ terminals: [shellTab("tree:AK-1")], detected: new Map() })),
    ).toHaveLength(0);
  });

  it("is superseded by the provider's own row, not duplicated by it", () => {
    const entries = buildAgentEntries(
      build({
        sessions: [session({ sessionId: "01a0", termKey: "tree:AK-1", agentKind: "Codex" })],
        terminals: [launchedTab("tree:AK-1", "Codex")],
        detected: new Map([[paneAddress("tree:AK-1", "Codex"), "Codex"]]),
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe("01a0");
  });

  it("leaves an unplaceable agent honestly unattributed instead of guessing", () => {
    const entries = buildAgentEntries(
      build({
        terminals: [shellTab("term-7")],
        detected: new Map([["term-7", "Claude"]]),
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].repo).toBeNull();
    expect(entries[0].origin.kind).toBe("unknown");
    // Nowhere to navigate, so the action says so rather than doing nothing.
    expect(entries[0].openable).toBe(false);
  });

  it("does not place a ticket two shown repos both claim", () => {
    const entries = buildAgentEntries(
      build({
        terminals: [shellTab("tree:AK-1")],
        repos: [
          repoData({ worktrees: [worktree("AK-1")] }),
          repoData({ repo: "other", worktrees: [worktree("AK-1")] }),
        ],
        detected: new Map([["tree:AK-1", "Codex"]]),
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].repo).toBeNull();
  });

  it("reports identity, never a status — it cannot make anything need you", () => {
    const entries = buildAgentEntries(
      build({
        terminals: [shellTab("tree:AK-1")],
        detected: new Map([["tree:AK-1", "Codex"]]),
      }),
    );
    expect(entries[0].state).toBeNull();
    expect(attentionCount(entries, NOW)).toBe(0);
  });
});
