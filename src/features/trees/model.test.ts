import { describe, expect, it } from "vitest";

import type { SessionState, TabKind, TaskStatus, Worktree, WorktreeTab } from "../../bindings";
import type { PendingLaunch } from "../../state/AppContext";
import type { TerminalTab } from "../terminal/orchestrator";
import {
  defaultTabTitle,
  effectiveSessionState,
  isTreeLaunchDead,
  mergeWorktrees,
  pendingWorktree,
  resolveActiveTab,
  shouldHoldTerminal,
  startTabFor,
  tabsToCloseForWorktree,
  withLiveWorktreeStatus,
} from "./model";

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
    sessionId: "s1",
    state,
    event: "x",
    cwd: "/tmp/x",
    message: null,
    transcriptPath: null,
    updatedAtMs: 0,
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
    isBaseActive: false,
    selectedFile: null as string | null,
    setupFor: null as string | null,
    activeId: "AK-1",
    extraTabIds: [] as string[],
  };

  it("defaults a never-visited worktree to the Issue tab", () => {
    expect(resolveActiveTab(undefined, base)).toBe("issue");
  });

  it("defaults the base entry (no ticket) to the Terminal tab", () => {
    expect(resolveActiveTab(undefined, { ...base, isBaseActive: true })).toBe("terminal");
  });

  it("keeps a remembered Terminal tab as-is", () => {
    expect(resolveActiveTab("terminal", base)).toBe("terminal");
  });

  it("falls back off a remembered Issue tab for the base entry — it has no ticket", () => {
    expect(resolveActiveTab("issue", { ...base, isBaseActive: true })).toBe("terminal");
  });

  it("keeps the File tab only while a file is actually open", () => {
    expect(resolveActiveTab("file", { ...base, selectedFile: "src/main.rs" })).toBe("file");
    expect(resolveActiveTab("file", base)).toBe("issue");
  });

  it("keeps the Setup tab only while setup is running for THIS worktree", () => {
    expect(resolveActiveTab("setup", { ...base, setupFor: "AK-1" })).toBe("setup");
    // A different worktree's setup superseded the single setupFor slot.
    expect(resolveActiveTab("setup", { ...base, setupFor: "AK-2" })).toBe("issue");
  });

  it("keeps a remembered extra tab only while that tab still exists", () => {
    expect(resolveActiveTab("tab:a1", { ...base, extraTabIds: ["a1", "b2"] })).toBe("tab:a1");
    expect(resolveActiveTab("tab:a1", { ...base, extraTabIds: ["b2"] })).toBe("issue");
  });
});

/** Minimal WorktreeTab fixture. */
function extraTabRow(id: string, kind: TabKind, title: string): WorktreeTab {
  return { id, worktreeId: "AK-1", kind, title };
}

describe("defaultTabTitle", () => {
  it("names the first Claude tab plain 'Claude', then numbers from 2", () => {
    expect(defaultTabTitle("claude", [])).toBe("Claude");
    expect(defaultTabTitle("claude", [extraTabRow("a", "claude", "Claude")])).toBe("Claude 2");
  });

  it("numbers terminals from 2 — the primary Terminal tab is #1 implicitly", () => {
    expect(defaultTabTitle("terminal", [])).toBe("Terminal 2");
    expect(defaultTabTitle("terminal", [extraTabRow("a", "terminal", "Terminal 2")])).toBe(
      "Terminal 3",
    );
  });

  it("skips past renamed/deleted gaps to stay unique among existing titles", () => {
    // "Claude" was renamed away → the base name is free again.
    expect(defaultTabTitle("claude", [extraTabRow("a", "claude", "Debugging")])).toBe("Claude");
    // A middle title was taken back by a rename — pick the first free number.
    const taken = [extraTabRow("a", "claude", "Claude"), extraTabRow("b", "claude", "Claude 3")];
    expect(defaultTabTitle("claude", taken)).toBe("Claude 2");
  });

  it("ignores the other kind's titles", () => {
    expect(defaultTabTitle("claude", [extraTabRow("a", "terminal", "Terminal 2")])).toBe("Claude");
  });
});
