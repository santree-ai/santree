import { describe, expect, it } from "vitest";

import type {
  AgentKind,
  SessionState,
  TabKind,
  TaskStatus,
  Worktree,
  WorktreeTab,
} from "../../bindings";
import type { PendingLaunch } from "../../state/AppContext";
import { palette } from "../../theme/colors";
import type { TerminalTab } from "../terminal/orchestrator";
import { aiWorkDot } from "./FilePickerPanel";
import {
  availableFileTabs,
  BASE_ID,
  defaultTabTitle,
  effectiveSessionState,
  finishedSetups,
  focusedAgentFor,
  isTreeLaunchDead,
  type MainTab,
  mergeWorktrees,
  type OpenCheckLog,
  pendingWorktree,
  prDiffModeFor,
  resolveActiveTab,
  resolveFileTab,
  shouldHoldTerminal,
  startTabFor,
  withLiveWorktreeStatus,
} from "./model";
import { tabsToCloseForWorktree } from "./useWorktreeDeletion";

/** Minimal Worktree as the backend ships it: no invented status/activity. */
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
    path: "/tmp/x",
    project: null,
    baseBranch: "main",
    setupRan: true,
    pending: false,
  };
}

describe("withLiveWorktreeStatus", () => {
  it("overrides status with the linked Linear task's real workflow state", () => {
    const statusByTaskId = new Map<string, TaskStatus>([["AK-1", "InReview"]]);
    const result = withLiveWorktreeStatus(worktree("AK-1"), statusByTaskId, new Set());
    expect(result.status).toBe("InReview");
  });

  // The backend has no status to give (there's no column for it, and list/get never
  // call Linear), so a worktree whose task isn't in the fetch has no status at all —
  // the sidebar renders no chip rather than a confident, meaningless one.
  it("leaves the status null when the task isn't in the current tasks fetch", () => {
    const result = withLiveWorktreeStatus(worktree("AK-1"), new Map(), new Set());
    expect(result.status).toBeNull();
  });

  it("reports Running only when a live PTY session exists for the worktree's main terminal", () => {
    const live = withLiveWorktreeStatus(worktree("AK-1"), new Map(), new Set(["tree:AK-1"]));
    expect(live.activity).toBe("Running");

    const idle = withLiveWorktreeStatus(worktree("AK-1"), new Map(), new Set(["tree:AK-2"]));
    expect(idle.activity).toBe("Idle");
  });

  it("leaves every other field untouched", () => {
    const w = worktree("AK-1");
    const result = withLiveWorktreeStatus(w, new Map(), new Set());
    expect(result).toEqual({ ...w, activity: "Idle" });
  });
});

describe("effectiveSessionState", () => {
  const running = (): Worktree => ({ ...worktree("AK-1"), activity: "Running" });
  const idle = (): Worktree => ({ ...worktree("AK-1"), activity: "Idle" });
  const hook = (state: SessionState["state"]): SessionState => ({
    agentKind: "Claude",
    sessionId: "s1",
    state,
    event: "x",
    cwd: "/tmp/x",
    message: null,
    transcriptPath: null,
    updatedAtMs: 0,
    repo: "canary",
    termKey: "tree:AK-1",
  });

  it("shows the hook state for a live session", () => {
    expect(effectiveSessionState(running(), hook("waiting"))).toBe("waiting");
    expect(effectiveSessionState(running(), hook("active"))).toBe("active");
  });

  it("reads a stopped worktree as exited even if the last hook said active", () => {
    // Liveness is authoritative — a session that died without SessionEnd is stale.
    expect(effectiveSessionState(idle(), hook("active"))).toBe("exited");
    expect(effectiveSessionState(idle(), hook("waiting"))).toBe("exited");
  });

  it("shows nothing for a worktree that never ran an agent", () => {
    expect(effectiveSessionState(idle(), undefined)).toBeNull();
    // Live terminal but no agent state reported yet (e.g. a plain shell tab).
    expect(effectiveSessionState(running(), undefined)).toBeNull();
  });
});

/** Minimal TerminalTab fixture. */
function tab(key: string, refId?: string): TerminalTab {
  return { key, title: key, source: "issue", refId };
}

describe("tabsToCloseForWorktree", () => {
  it("includes the worktree's main terminal session", () => {
    const tabs = [tab("t1", "tree:AK-1")];
    expect(tabsToCloseForWorktree(tabs, "AK-1")).toEqual(tabs);
  });

  it("includes extra tabs opened via the + tab", () => {
    const extra = tab("t2", "tree:AK-1:tab:6f9a");
    const tabs = [tab("t1", "tree:AK-1"), extra];
    expect(tabsToCloseForWorktree(tabs, "AK-1")).toEqual(tabs);
  });

  it("excludes sessions belonging to other worktrees or ids that share a prefix", () => {
    const other = tab("t1", "tree:AK-1");
    const otherWorktree = tab("t2", "tree:AK-10");
    const shell = tab("t3", undefined);
    const tabs = [other, otherWorktree, shell];
    expect(tabsToCloseForWorktree(tabs, "AK-1")).toEqual([other]);
  });
});

/** Minimal PendingLaunch fixture. */
function pendingLaunch(id: string, overrides: Partial<PendingLaunch> = {}): PendingLaunch {
  return { id, title: `Task ${id}`, project: null, agent: "Claude", ...overrides };
}

describe("pendingWorktree", () => {
  it("synthesizes a placeholder with no branch/path/stats yet, carrying the launch's title/project/agent", () => {
    const w = pendingWorktree(pendingLaunch("AK-1", { title: "Fix the thing", project: "Core" }));
    expect(w).toMatchObject({
      id: "AK-1",
      title: "Fix the thing",
      project: "Core",
      agent: "Claude",
      pending: true,
      branch: "",
      path: "",
      addLines: 0,
      delLines: 0,
      dirty: false,
    });
    // A root launch has no base — an invented one would make the sidebar hunt for a
    // parent that doesn't exist.
    expect(w.baseBranch).toBe("");
  });

  // The stack is decided at launch, so the placeholder must carry its base through
  // to `stackWorktrees`. Without this the sidebar shows a sub-task as a root — and
  // placeholders sort first, so it appears *above* the parent it belongs under —
  // until the git worktree finishes creating seconds later.
  it("carries a stacked launch's base branch so the placeholder can nest at once", () => {
    const w = pendingWorktree(pendingLaunch("AK-277", { baseBranch: "santree/ak-275" }));
    expect(w.baseBranch).toBe("santree/ak-275");
  });
});

describe("mergeWorktrees", () => {
  const identity = (w: Worktree) => w;

  it("shows a placeholder for a launch that hasn't landed as a real worktree yet", () => {
    const result = mergeWorktrees([], [pendingLaunch("AK-1")], new Set(), identity);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "AK-1", pending: true });
  });

  it("drops the placeholder once the real worktree lands, keeping only the real one", () => {
    const result = mergeWorktrees([worktree("AK-1")], [pendingLaunch("AK-1")], new Set(), identity);
    expect(result).toHaveLength(1);
    expect(result[0].pending).toBe(false);
  });

  it("hides a worktree that's pending delete, even though it's still in the real list", () => {
    const result = mergeWorktrees([worktree("AK-1")], [], new Set(["AK-1"]), identity);
    expect(result).toHaveLength(0);
  });

  it("applies withLiveStatus to every visible real worktree, not to placeholders", () => {
    const withLiveStatus = (w: Worktree): Worktree => ({ ...w, activity: "Running" });
    const result = mergeWorktrees(
      [worktree("AK-1")],
      [pendingLaunch("AK-2")],
      new Set(),
      withLiveStatus,
    );
    const real = result.find((w) => w.id === "AK-1");
    const placeholder = result.find((w) => w.id === "AK-2");
    expect(real?.activity).toBe("Running");
    // A placeholder worktree doesn't exist yet — nothing is known about it.
    expect(placeholder?.activity).toBeNull();
  });
});

describe("isTreeLaunchDead", () => {
  it("is not dead while its pending placeholder is still around", () => {
    const worktrees = [pendingWorktree(pendingLaunch("AK-1"))];
    expect(isTreeLaunchDead("AK-1", worktrees, [pendingLaunch("AK-1")])).toBe(false);
  });

  it("is not dead once the real worktree has landed (even after the placeholder is gone)", () => {
    expect(isTreeLaunchDead("AK-1", [worktree("AK-1")], [])).toBe(false);
  });

  // Regression guard for finding #37: a failed createWorktree drops the pending
  // placeholder (see IssuesModel.launch's .catch) without ever producing a real
  // worktree — the launch must be recognized as dead so it doesn't stay armed
  // and auto-start an agent for an unrelated worktree that later reuses the id.
  it("is dead once neither a real worktree nor its pending placeholder exists for the id (#37)", () => {
    expect(isTreeLaunchDead("AK-1", [], [])).toBe(true);
    // Some *other* launch is still pending — AK-1 itself is still dead.
    const otherLaunch = [pendingLaunch("AK-2")];
    const otherWorktrees = [pendingWorktree(pendingLaunch("AK-2"))];
    expect(isTreeLaunchDead("AK-1", otherWorktrees, otherLaunch)).toBe(true);
  });
});

describe("startTabFor", () => {
  it("opens the Setup tab when the run-setup preference is on", () => {
    expect(startTabFor(true)).toBe("setup");
  });

  it("opens the Terminal tab when the preference is off", () => {
    expect(startTabFor(false)).toBe("terminal");
  });
});

describe("finishedSetups", () => {
  it("reports the worktree whose setup just ended", () => {
    expect(finishedSetups(new Set(["AK-1"]), new Set())).toEqual(["AK-1"]);
  });

  it("reports nothing while the setup is still running", () => {
    expect(finishedSetups(new Set(["AK-1"]), new Set(["AK-1"]))).toEqual([]);
  });

  // The bug this replaces latched a bare "was setting up" boolean: switching away
  // from a setting-up worktree read as "setup finished" for the *newly* selected
  // one — dropping it onto its terminal tab (spawning a shell nobody asked for) —
  // while the worktree that actually finished never got switched.
  it("ignores a worktree that was never setting up, and still fires for the one that was", () => {
    // AK-1 is mid-setup; the user switches to AK-2. Nothing finished.
    expect(finishedSetups(new Set(["AK-1"]), new Set(["AK-1"]))).toEqual([]);
    // AK-1's script then finishes while AK-2 is on screen — AK-1 is the one that
    // lands on its terminal, not AK-2.
    expect(finishedSetups(new Set(["AK-1"]), new Set())).toEqual(["AK-1"]);
  });

  it("reports every worktree that finished since the last check", () => {
    expect(finishedSetups(new Set(["AK-1", "AK-2"]), new Set(["AK-2"]))).toEqual(["AK-1"]);
  });
});

describe("shouldHoldTerminal", () => {
  const idle = { launching: false, initialSetup: false, promptFetched: false };

  // Regression guard for the bare-shell launch race: the terminal must be withheld
  // while the work prompt is still being written, or it mounts seedless and the
  // launch is lost (a seed only applies at PTY creation).
  it("holds during a launch while the work prompt is still being written", () => {
    expect(shouldHoldTerminal({ ...idle, launching: true })).toBe(true);
  });

  it("does not hold during the initial setup (the setup gate withholds the terminal itself)", () => {
    expect(shouldHoldTerminal({ ...idle, launching: true, initialSetup: true })).toBe(false);
  });

  it("releases once the prompt has landed, and never holds a passive reopen", () => {
    expect(shouldHoldTerminal({ ...idle, launching: true, promptFetched: true })).toBe(false);
    expect(shouldHoldTerminal(idle)).toBe(false);
  });
});

describe("resolveActiveTab", () => {
  const base = {
    selectedFile: null as string | null,
    setupFor: null as string | null,
    activeId: "AK-1",
    extraTabIds: [] as string[],
    checkLog: null as OpenCheckLog | null,
  };

  it("defaults a never-visited worktree to the Terminal tab", () => {
    expect(resolveActiveTab(undefined, base)).toBe("terminal");
  });

  it("keeps a remembered Terminal tab as-is", () => {
    expect(resolveActiveTab("terminal", base)).toBe("terminal");
  });

  it("keeps the File tab only while a file is actually open", () => {
    expect(resolveActiveTab("file", { ...base, selectedFile: "src/main.rs" })).toBe("file");
    expect(resolveActiveTab("file", base)).toBe("terminal");
  });

  it("keeps the Setup tab only while setup is running for THIS worktree", () => {
    expect(resolveActiveTab("setup", { ...base, setupFor: "AK-1" })).toBe("setup");
    // A different worktree's setup superseded the single setupFor slot.
    expect(resolveActiveTab("setup", { ...base, setupFor: "AK-2" })).toBe("terminal");
  });

  it("keeps a remembered extra tab only while that tab still exists", () => {
    expect(resolveActiveTab("tab:a1", { ...base, extraTabIds: ["a1", "b2"] })).toBe("tab:a1");
    expect(resolveActiveTab("tab:a1", { ...base, extraTabIds: ["b2"] })).toBe("terminal");
  });

  // The log itself is deliberately not persisted, so a remembered "checkLog" tab
  // routinely comes back with an empty slot — after a reload, or on a worktree
  // whose log was closed elsewhere.
  it("keeps the check-log tab only while a log is actually open", () => {
    const checkLog: OpenCheckLog = {
      jobId: 42,
      name: "test (ubuntu-latest)",
      url: null,
      prRepo: "acme/api",
    };
    expect(resolveActiveTab("checkLog", { ...base, checkLog })).toBe("checkLog");
    expect(resolveActiveTab("checkLog", base)).toBe("terminal");
  });
});

describe("focusedAgentFor", () => {
  const base = {
    activeTab: "terminal" as MainTab,
    activeId: "AK-1",
    extraTabs: [] as WorktreeTab[],
    worktreeAgent: "Claude" as AgentKind | null,
  };

  it("points at the worktree's work session on the Terminal tab", () => {
    expect(focusedAgentFor(base)).toEqual({ termKey: "tree:AK-1", agentKind: "Claude" });
  });

  // The base entry is the repo root on the default branch: its terminal is a
  // plain shell, and a shell has no context window to meter.
  it("has nothing to point at on the base worktree", () => {
    expect(focusedAgentFor({ ...base, activeId: BASE_ID })).toBeNull();
  });

  it("has nothing to point at with no worktree open, or none launched yet", () => {
    expect(focusedAgentFor({ ...base, activeId: "" })).toBeNull();
    expect(focusedAgentFor({ ...base, worktreeAgent: null })).toBeNull();
  });

  it("points at an extra agent tab's own session, with that tab's provider", () => {
    const tabs = [extraTabRow("a1", "agent", "Codex"), extraTabRow("b2", "agent", "Codex 2")];
    expect(focusedAgentFor({ ...base, activeTab: "tab:b2", extraTabs: tabs })).toEqual({
      termKey: "tree:AK-1:tab:b2",
      agentKind: "Codex",
    });
  });

  // A "+ Terminal" tab runs a shell in the worktree, not an agent — the meter
  // must not fall back to the worktree's work session beside it.
  it("has nothing to point at on a plain Terminal tab", () => {
    const tabs = [extraTabRow("t1", "terminal", "Terminal 2")];
    expect(focusedAgentFor({ ...base, activeTab: "tab:t1", extraTabs: tabs })).toBeNull();
  });

  it("has nothing to point at for a tab that no longer exists", () => {
    expect(focusedAgentFor({ ...base, activeTab: "tab:gone" })).toBeNull();
  });

  // A diff, a setup log and a job log are all things you read *about* the work,
  // not the work running — the meter belongs to a session on screen.
  it("has nothing to point at while the main area shows a file, setup or a job log", () => {
    for (const tab of ["file", "setup", "checkLog"] as const) {
      expect(focusedAgentFor({ ...base, activeTab: tab })).toBeNull();
    }
  });
});

describe("prDiffModeFor", () => {
  it("shows GitHub's patch when the file is in the PR and the branch is pushed", () => {
    expect(prDiffModeFor({ inPr: true, unpushed: 0 })).toBe("pr");
  });

  // The PR's file list is capped and a binary file has no patch, so "in the PR"
  // is genuinely false for real files on a big PR — it degrades to the local
  // diff rather than to nothing.
  it("falls back to the local diff for a file the PR doesn't carry", () => {
    expect(prDiffModeFor({ inPr: false, unpushed: 0 })).toBe("local");
    expect(prDiffModeFor({ inPr: false, unpushed: 3 })).toBe("local");
  });

  // The dangerous case: GitHub's patch describes the pushed head, so on a branch
  // that has moved it would show older code and anchor comments to lines the user
  // isn't looking at. Never silently.
  it("refuses to silently show the PR's version when the branch is ahead", () => {
    expect(prDiffModeFor({ inPr: true, unpushed: 1 })).toBe("localAhead");
  });
});

describe("availableFileTabs", () => {
  it("offers the PR and its AI work queue only once the branch has one", () => {
    expect(availableFileTabs({ isBase: false, hasPr: false })).toEqual([
      "issue",
      "files",
      "changes",
      "history",
    ]);
    expect(availableFileTabs({ isBase: false, hasPr: true })).toEqual([
      "issue",
      "files",
      "changes",
      "history",
      "pr",
      "aiWork",
    ]);
  });

  // The queue is what you do about the PR, so it sits against the PR's own tab
  // rather than at the end of the strip.
  it("puts the AI work queue directly after the PR", () => {
    const tabs = availableFileTabs({ isBase: false, hasPr: true });
    expect(tabs[tabs.indexOf("pr") + 1]).toBe("aiWork");
  });

  it("drops the Issue pane on the base entry — it has no ticket", () => {
    expect(availableFileTabs({ isBase: true, hasPr: false })).not.toContain("issue");
  });
});

/** One dot, two signals. The strip has room for exactly one per tab, so which
 *  one wins is a real decision — see {@link aiWorkDot}. */
describe("aiWorkDot", () => {
  it("takes the accent while the queue has open items", () => {
    expect(aiWorkDot(false, 3)).toBe("var(--accent)");
  });

  it("says nothing on an empty, current queue", () => {
    expect(aiWorkDot(false, 0)).toBeNull();
  });

  // A count is "there is work here"; a stale brief is "what you are reading may
  // no longer be true". The second is the one you need to see, so it wins even
  // when there are open items to report.
  it("lets a stale brief beat the count", () => {
    expect(aiWorkDot(true, 0)).toBe(palette.amber);
    expect(aiWorkDot(true, 3)).toBe(palette.amber);
  });
});

describe("resolveFileTab", () => {
  const task = { isBase: false, hasPr: true };

  it("keeps every pane the worktree actually has", () => {
    for (const tab of availableFileTabs(task)) {
      expect(resolveFileTab(tab, task)).toBe(tab);
    }
  });

  it("falls back off the Issue pane for the base entry — it has no ticket", () => {
    expect(resolveFileTab("issue", { isBase: true, hasPr: false })).toBe("changes");
  });

  // The strip hides these when there's no PR, so a remembered one would leave the
  // user on a pane with no tab to get back to.
  it("falls back off the PR panes when the branch has no pull request", () => {
    expect(resolveFileTab("pr", { isBase: false, hasPr: false })).toBe("changes");
    expect(resolveFileTab("aiWork", { isBase: false, hasPr: false })).toBe("changes");
  });

  // The base checkout can still carry a PR (a branch pushed from the repo root),
  // so the AI work pane survives there even though the ticket pane doesn't.
  it("keeps the AI work pane on the base entry when it has a pull request", () => {
    expect(resolveFileTab("aiWork", { isBase: true, hasPr: true })).toBe("aiWork");
  });

  it("leaves the other panes alone on the base entry", () => {
    expect(resolveFileTab("files", { isBase: true, hasPr: false })).toBe("files");
    expect(resolveFileTab("history", { isBase: true, hasPr: false })).toBe("history");
  });
});

/** Minimal WorktreeTab fixture. */
function extraTabRow(id: string, kind: TabKind, title: string): WorktreeTab {
  return { id, worktreeId: "AK-1", kind, agentKind: kind === "terminal" ? null : "Codex", title };
}

describe("defaultTabTitle", () => {
  it("names the first Codex tab plain 'Codex', then numbers from 2", () => {
    expect(defaultTabTitle("agent", "Codex", [])).toBe("Codex");
    expect(defaultTabTitle("agent", "Codex", [extraTabRow("a", "agent", "Codex")])).toBe("Codex 2");
  });

  it("names and numbers Claude Code independently from Codex", () => {
    expect(defaultTabTitle("agent", "Claude", [])).toBe("Claude Code");
    expect(defaultTabTitle("agent", "Claude", [extraTabRow("a", "agent", "Claude Code")])).toBe(
      "Claude Code 2",
    );
    expect(defaultTabTitle("agent", "Claude", [extraTabRow("a", "agent", "Codex")])).toBe(
      "Claude Code",
    );
  });

  it("numbers terminals from 2 — the primary Terminal tab is #1 implicitly", () => {
    expect(defaultTabTitle("terminal", null, [])).toBe("Terminal 2");
    expect(defaultTabTitle("terminal", null, [extraTabRow("a", "terminal", "Terminal 2")])).toBe(
      "Terminal 3",
    );
  });

  it("skips past renamed/deleted gaps to stay unique among existing titles", () => {
    // "Codex" was renamed away → the base name is free again.
    expect(defaultTabTitle("agent", "Codex", [extraTabRow("a", "agent", "Debugging")])).toBe(
      "Codex",
    );
    // A middle title was taken back by a rename — pick the first free number.
    const taken = [extraTabRow("a", "agent", "Codex"), extraTabRow("b", "agent", "Codex 3")];
    expect(defaultTabTitle("agent", "Codex", taken)).toBe("Codex 2");
  });

  it("ignores the other kind's titles", () => {
    expect(defaultTabTitle("agent", "Codex", [extraTabRow("a", "terminal", "Terminal 2")])).toBe(
      "Codex",
    );
  });
});
