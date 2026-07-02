import { describe, expect, it } from "vitest";

import type { Worktree } from "../../bindings";
import type { PendingLaunch } from "../../state/AppContext";
import type { TerminalTab } from "../terminal/orchestrator";
import {
  isTreeLaunchDead,
  mergeWorktrees,
  pendingWorktree,
  planStartAgent,
  resolveActiveTab,
  shouldCompleteSetup,
  tabsToCloseForWorktree,
  withLiveWorktreeStatus,
} from "./model";

/** Minimal Worktree with backend-placeholder status/activity (the pre-fix constants). */
function worktree(id: string): Worktree {
  return {
    id,
    title: `Task ${id}`,
    status: "InProgress",
    addLines: 0,
    delLines: 0,
    dirty: false,
    ahead: 0,
    behind: 0,
    unpushed: 0,
    agent: "Claude",
    activity: "Idle",
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
    const statusByTaskId = new Map<string, Worktree["status"]>([["AK-1", "InReview"]]);
    const result = withLiveWorktreeStatus(worktree("AK-1"), statusByTaskId, new Set());
    expect(result.status).toBe("InReview");
  });

  it("falls back to the backend status when the task isn't in the current tasks fetch", () => {
    const result = withLiveWorktreeStatus(worktree("AK-1"), new Map(), new Set());
    expect(result.status).toBe("InProgress");
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

/** Minimal TerminalTab fixture. */
function tab(key: string, refId?: string): TerminalTab {
  return { key, title: key, source: "issue", refId };
}

describe("tabsToCloseForWorktree", () => {
  it("includes the worktree's main terminal session", () => {
    const tabs = [tab("t1", "tree:AK-1")];
    expect(tabsToCloseForWorktree(tabs, "AK-1")).toEqual(tabs);
  });

  it("includes extra terminal tabs opened via the + tab", () => {
    const extra = tab("t2", "tree:AK-1:t2");
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
    expect(placeholder?.activity).toBe("Idle");
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

describe("shouldCompleteSetup", () => {
  it("completes when the finishing run still matches the current setupFor slot", () => {
    expect(shouldCompleteSetup("AK-1", "AK-1")).toBe(true);
  });

  it("is a no-op once a different worktree's setup has superseded the single setupFor slot", () => {
    expect(shouldCompleteSetup("AK-1", "AK-2")).toBe(false);
  });

  it("is a no-op once the slot has already been cleared", () => {
    expect(shouldCompleteSetup("AK-1", null)).toBe(false);
  });
});

describe("planStartAgent", () => {
  it("runs setup first (Setup tab) when the run-setup preference is on", () => {
    expect(planStartAgent(true)).toEqual({ tab: "setup", setupThenLaunch: true });
  });

  it("launches the agent immediately (Terminal tab) when the preference is off", () => {
    expect(planStartAgent(false)).toEqual({ tab: "terminal", setupThenLaunch: false });
  });
});

describe("resolveActiveTab", () => {
  const base = {
    isBaseActive: false,
    selectedFile: null as string | null,
    setupFor: null as string | null,
    activeId: "AK-1",
    extraTerminals: [] as number[],
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

  it("keeps a remembered extra-terminal tab only while that terminal still exists", () => {
    expect(resolveActiveTab("term:2", { ...base, extraTerminals: [2, 3] })).toBe("term:2");
    expect(resolveActiveTab("term:2", { ...base, extraTerminals: [3] })).toBe("issue");
  });
});
