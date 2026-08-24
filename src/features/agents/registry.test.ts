import { describe, expect, it } from "vitest";

import type { AgentState, SessionState, Worktree } from "../../bindings";
import type { TerminalTab } from "../terminal/orchestrator";
import {
  attentionCount,
  type BuildInput,
  bucketOf,
  buildAgentEntries,
  countAttention,
  DONE_WINDOW_MS,
  filterAgents,
  groupAgents,
  parseTermKey,
  type RepoData,
  repoLabel,
  terminalRefFor,
} from "./registry";

const NOW = 1_700_000_000_000;

function worktree(id: string): Worktree {
  return {
    id,
    title: `Task ${id}`,
    status: null,
    addLines: 0,
    delLines: 0,
    dirty: false,
    ahead: 0,
    behind: 0,
    unpushed: 0,
    remoteBehind: 0,
    pullConflict: false,
    agent: "Claude",
    activity: null,
    branch: `santree/${id.toLowerCase()}`,
    path: `/repo/.santree/worktrees/${id}`,
    project: null,
    baseBranch: "main",
    setupRan: true,
    pending: false,
  };
}

function session(over: Partial<SessionState> & { sessionId: string }): SessionState {
  return {
    state: "active" as AgentState,
    event: "UserPromptSubmit",
    cwd: "/repo",
    message: null,
    transcriptPath: null,
    updatedAtMs: NOW,
    repo: "canary",
    termKey: null,
    ...over,
    agentKind: over.agentKind ?? "Claude",
  };
}

/** Live PTY tabs for the given tree term keys — what makes a session `live`. */
function liveTabs(...termKeys: string[]): TerminalTab[] {
  return termKeys.map((refId, i) => ({
    key: `t${i}`,
    title: refId,
    source: "issue" as const,
    refId,
  }));
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
    expect(parseTermKey("dev:/Users/me/repo")).toEqual({
      kind: "dev",
      ticket: null,
      tabId: null,
      pr: null,
    });
  });

  it("falls back to unknown for a missing or unrecognized key", () => {
    expect(parseTermKey(null).kind).toBe("unknown");
    expect(parseTermKey("something-else").kind).toBe("unknown");
  });
});

describe("terminalRefFor", () => {
  it("looks a triage session up by its bare ticket id, not its term key", () => {
    // InvestigatePane registers the tab as refId=<ticket> under source "triage",
    // while its term_key is "triage:<ticket>" — the one place the two differ.
    expect(terminalRefFor("triage:AK-9", parseTermKey("triage:AK-9"))).toEqual({
      source: "triage",
      refId: "AK-9",
    });
    expect(terminalRefFor("tree:AK-1", parseTermKey("tree:AK-1"))).toEqual({
      source: "issue",
      refId: "tree:AK-1",
    });
  });

  it("keeps historical and current review sessions under one source", () => {
    // The retired read-only pane's records remain recognizable beside current AI
    // reviews, preserving historical session provenance without reviving its UI.
    for (const key of ["review:acme/web#7", "ai-review:acme/web#7"]) {
      expect(terminalRefFor(key, parseTermKey(key))).toEqual({ source: "review", refId: key });
    }
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
    // The Dev tab keys its session by `@dev`, which has no checkbox in the repo
    // picker — filtering it out would hide it with no way to bring it back.
    const entries = buildAgentEntries(
      build({
        repos: [repoData({ repo: "canary" })],
        allRepos: ["canary", "other"],
        sessions: [session({ sessionId: "dev", termKey: "dev:/x", repo: "@dev" })],
      }),
    );
    expect(entries.map((e) => e.sessionId)).toEqual(["dev"]);
    expect(entries[0].title).toBe("Dev");
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

describe("groupAgents", () => {
  it("orders buckets by urgency and drops empty ones", () => {
    const entries = buildAgentEntries(
      build({
        terminals: liveTabs("tree:AK-1", "tree:AK-2", "tree:AK-3"),
        sessions: [
          session({ sessionId: "i", state: "idle", termKey: "tree:AK-3" }),
          session({ sessionId: "w", state: "permission", termKey: "tree:AK-1" }),
          session({ sessionId: "r", state: "active", termKey: "tree:AK-2" }),
        ],
      }),
    );
    expect(groupAgents(entries).map((g) => g.bucket)).toEqual(["attention", "working", "idle"]);
  });

  it("sorts the blocked agents oldest-first and everything else newest-first", () => {
    const entries = buildAgentEntries(
      build({
        terminals: liveTabs("tree:a", "tree:b", "tree:c", "tree:d"),
        sessions: [
          session({ sessionId: "new-ask", state: "waiting", termKey: "tree:a", updatedAtMs: NOW }),
          session({
            sessionId: "old-ask",
            state: "waiting",
            termKey: "tree:b",
            updatedAtMs: NOW - 60_000,
          }),
          session({
            sessionId: "old-run",
            state: "active",
            termKey: "tree:c",
            updatedAtMs: NOW - 60_000,
          }),
          session({ sessionId: "new-run", state: "active", termKey: "tree:d", updatedAtMs: NOW }),
        ],
      }),
    );
    const groups = groupAgents(entries);
    expect(groups[0].entries.map((e) => e.sessionId)).toEqual(["old-ask", "new-ask"]);
    expect(groups[1].entries.map((e) => e.sessionId)).toEqual(["new-run", "old-run"]);
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
    expect(attentionCount(entries)).toBe(2);
  });

  it("agrees with the badge's own shortcut over the raw reads", () => {
    // The badge must never claim an alert the panel doesn't show.
    const entries = buildAgentEntries(build({ sessions, terminals }));
    expect(countAttention(sessions, terminals)).toBe(attentionCount(entries));
  });
});

describe("repoLabel", () => {
  it("renders the Dev tab's pseudo-repo as a name, not a raw key", () => {
    expect(repoLabel("@dev")).toBe("Dev");
    expect(repoLabel("canary-technologies-corp/canary")).toBe("canary-technologies-corp/canary");
  });
});

describe("filterAgents", () => {
  const entries = buildAgentEntries(
    build({
      repos: [repoData({ worktrees: [worktree("AK-1")] })],
      sessions: [
        session({ sessionId: "a", termKey: "tree:AK-1" }),
        session({
          sessionId: "b",
          termKey: "tree:AK-2",
          state: "permission",
          message: "Bash(rm -rf build)",
        }),
      ],
    }),
  );

  it("matches the ticket, the title and the pending question", () => {
    expect(filterAgents(entries, "ak-1").map((e) => e.sessionId)).toEqual(["a"]);
    expect(filterAgents(entries, "Task AK").map((e) => e.sessionId)).toEqual(["a"]);
    expect(filterAgents(entries, "rm -rf").map((e) => e.sessionId)).toEqual(["b"]);
  });

  it("returns everything for an empty query", () => {
    expect(filterAgents(entries, "  ")).toHaveLength(2);
  });
});
