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
import { worktree as fxWorktree } from "../../test/fixtures";
import { palette } from "../../theme/colors";
import { aiWorkDot } from "../reviews/AiWorkPane";
import type { TerminalTab } from "../terminal/orchestrator";
import {
  availableFileTabs,
  defaultTabTitle,
  effectiveSessionState,
  focusedAgentFor,
  hasLivePane,
  type MainTab,
  mergeWorktrees,
  openMainTabs,
  pendingWorktree,
  prDiffModeFor,
  remoteControlTab,
  resolveFileTab,
  shouldHoldTerminal,
  tabForRun,
  withLiveWorktreeStatus,
} from "./model";
import { tabsToCloseForWorktree } from "./useWorktreeDeletion";

/** Minimal Worktree as the backend ships it: no invented status/activity.
 *
 *  The overrides parameter is not decoration. Without it `unpushed` was pinned
 *  at 0 here, and `unpushed > 0` — a branch with commits GitHub has not seen —
 *  is the whole input to `prDiffModeFor`'s `localAhead` answer, the one that
 *  makes DiffPane show the local diff *with* a notice instead of the PR's
 *  patch. See `src/test/fixtures.ts` on why a pinned default is a closed
 *  branch. */
const worktree = (id: string, over: Partial<Worktree> = {}) =>
  fxWorktree(id, { path: "/tmp/x", ...over });

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
});

describe("effectiveSessionState", () => {
  const running = (): Worktree => ({ ...worktree("AK-1"), activity: "Running" });
  const idle = (): Worktree => ({ ...worktree("AK-1"), activity: "Idle" });
  const hook = (state: SessionState["state"]): SessionState => ({
    agentKind: "Claude",
    sessionId: "s1",
    state,
    recordedState: state,
    interruptedAtMs: null,
    event: "x",
    cwd: "/tmp/x",
    message: null,
    transcriptPath: null,
    updatedAtMs: 0,
    repo: "canary",
    termKey: "tree:AK-1",
    prompt: null,
    permissionMode: null,
    effortLevel: null,
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
  it("closes the worktree's main and + tabs, never another worktree's that shares a prefix", () => {
    const main = tab("t1", "tree:AK-1");
    const extra = tab("t2", "tree:AK-1:tab:6f9a");
    const tabs = [main, extra, tab("t3", "tree:AK-10"), tab("t4", undefined)];
    expect(tabsToCloseForWorktree(tabs, "AK-1")).toEqual([main, extra]);
  });
});

/** Minimal PendingLaunch fixture. */
function pendingLaunch(id: string, overrides: Partial<PendingLaunch> = {}): PendingLaunch {
  return {
    repo: "acme/app",
    id,
    title: `Task ${id}`,
    project: null,
    agent: "Claude",
    ...overrides,
  };
}

describe("pendingWorktree", () => {
  // A root launch has no base — an invented one would make the sidebar hunt for a
  // parent that doesn't exist. A stacked launch carries its base so the
  // placeholder nests at once instead of sorting *above* the parent it belongs
  // under until the git worktree finishes creating.
  it("carries the launch's base branch, empty for a root launch", () => {
    expect(pendingWorktree(pendingLaunch("AK-1")).baseBranch).toBe("");
    expect(
      pendingWorktree(pendingLaunch("AK-277", { baseBranch: "santree/ak-275" })).baseBranch,
    ).toBe("santree/ak-275");
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

  it("keeps a split child pending through early watcher refreshes, then replaces it once settled", () => {
    const parent = { ...worktree("AK-1"), branch: "parent" };
    const child = { ...worktree("split-1"), branch: "child", baseBranch: "parent" };
    const pending = pendingLaunch("split-1", {
      baseBranch: "parent",
      ticketId: "AK-1",
      holdUntilSettled: true,
    });
    const during = mergeWorktrees([parent, child], [pending], new Set(), identity);
    expect(during).toHaveLength(2);
    expect(during.find((w) => w.id === "split-1")).toMatchObject({
      pending: true,
      baseBranch: "parent",
      ticketId: "AK-1",
      path: "",
    });
    const after = mergeWorktrees([parent, child], [], new Set(), identity);
    expect(after.find((w) => w.id === "split-1")).toEqual(child);
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

describe("tabForRun", () => {
  // The launch outranks a setup still reported: the agent is what runs next. A
  // manual "Run setup" re-run launches nothing and must not move the selection.
  it("selects the launch's tab, else Setup during the initial setup, else nothing", () => {
    expect(tabForRun({ repo: "acme/app", tabId: "t1" }, true)).toBe("tab:t1");
    expect(tabForRun(undefined, true)).toBe("setup");
    expect(tabForRun(undefined, false)).toBeNull();
  });
});

describe("shouldHoldTerminal", () => {
  const idle = { launching: false, initialSetup: false, promptFetched: false };

  // Regression guard for the bare-shell launch race: the terminal must be withheld
  // while the work prompt is still being written, or it mounts seedless and the
  // launch is lost (a seed only applies at PTY creation). The setup gate withholds
  // the terminal itself during the initial setup.
  it("holds only during a launch whose work prompt is still being written", () => {
    expect(shouldHoldTerminal({ ...idle, launching: true })).toBe(true);
    expect(shouldHoldTerminal({ ...idle, launching: true, initialSetup: true })).toBe(false);
    expect(shouldHoldTerminal({ ...idle, launching: true, promptFetched: true })).toBe(false);
    expect(shouldHoldTerminal(idle)).toBe(false);
  });
});

describe("openMainTabs", () => {
  const base = {
    tabIds: [] as string[],
    hasPrView: false,
    hasIssueView: false,
    hasFile: false,
    hasSetup: false,
    hasCheckLog: false,
  };

  // The point of the change: a workspace with no rows has nothing open, and
  // "nothing open" is what the empty surface renders on.
  it("is empty for a worktree with no tabs and nothing on demand", () => {
    expect(openMainTabs(base)).toEqual([]);
  });

  it("lists the strip in bar order: the tabs, the reference views, then the transient ones", () => {
    expect(
      openMainTabs({
        tabIds: ["a1", "b2"],
        hasPrView: true,
        hasIssueView: true,
        hasFile: true,
        hasSetup: true,
        hasCheckLog: true,
      }),
    ).toEqual(["tab:a1", "tab:b2", "prView", "issueView", "file", "setup", "checkLog"]);
  });
});

describe("focusedAgentFor", () => {
  const agentTabs = [extraTabRow("a1", "agent", "Codex"), extraTabRow("b2", "agent", "Codex 2")];
  const base = {
    activeTab: "tab:a1" as MainTab | null,
    activeId: "AK-1",
    tabs: agentTabs,
  };

  it("points at the showing tab's own session, with that tab's provider", () => {
    expect(focusedAgentFor({ ...base, activeTab: "tab:b2" })).toEqual({
      termKey: "tree:AK-1:tab:b2",
      agentKind: "Codex",
    });
  });

  // No worktree, no tab, a plain shell, a gone tab, or a view *about* the work
  // (diff, logs, PR or ticket page): the meter belongs to an agent session on
  // screen and must not fall back to an agent tab beside it.
  it("has nothing to point at unless the showing tab is a live agent row", () => {
    const shell = [extraTabRow("t1", "terminal", "Terminal 2")];
    expect(focusedAgentFor({ ...base, activeId: "" })).toBeNull();
    expect(focusedAgentFor({ ...base, activeTab: null })).toBeNull();
    expect(focusedAgentFor({ ...base, activeTab: "tab:t1", tabs: shell })).toBeNull();
    expect(focusedAgentFor({ ...base, activeTab: "tab:gone" })).toBeNull();
    for (const tab of ["file", "setup", "checkLog", "prView", "issueView"] as const) {
      expect(focusedAgentFor({ ...base, activeTab: tab })).toBeNull();
    }
  });
});

describe("remoteControlTab", () => {
  const claude = (id: string) => extraTabRow(id, "agent", "Claude Code", "Claude");
  const codex = (id: string) => extraTabRow(id, "agent", "Codex", "Codex");

  // The tab a started task minted is created first, so "first Claude tab" names it
  // without anything recording that it was the start. Two panes under one name
  // collide, which is why exactly one tab gets it.
  it("gives the claim to the worktree's first Claude tab only", () => {
    expect(remoteControlTab([claude("w1"), claude("a2"), claude("a3")])).toBe("w1");
  });

  // Codex cannot use it at all (see its launch spec), so a Codex tab standing
  // first must not swallow the claim and leave the Claude tab without a name.
  it("skips Codex and shell tabs, and claims nothing without a Claude tab", () => {
    expect(remoteControlTab([codex("c1"), claude("w1")])).toBe("w1");
    expect(remoteControlTab([extraTabRow("t1", "terminal", "Terminal 2")])).toBeNull();
  });
});

describe("hasLivePane", () => {
  // Sessions minted before every agent lived in a tab still carry the bare key.
  it("sees a worktree's tab panes and the bare pre-tabs key", () => {
    expect(hasLivePane(new Set(["tree:AK-1:tab:a1"]), "AK-1")).toBe(true);
    expect(hasLivePane(new Set(["tree:AK-1"]), "AK-1")).toBe(true);
  });

  // The separator is load-bearing: a plain `startsWith` would let AK-1 claim
  // AK-12's panes and report the wrong worktree as running.
  it("does not mistake another worktree whose id starts the same", () => {
    expect(hasLivePane(new Set(["tree:AK-12:tab:a1", "tree:AK-1x"]), "AK-1")).toBe(false);
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
  /** A ticket-tracked worktree with no PR — the ordinary case the others vary. */
  const ticketed = { isBase: false, hasPr: false, hasTicket: true };

  // The queue is what you do about the PR, so it sits right after the PR's tab.
  it("offers the PR and its AI work queue only once the branch has one", () => {
    expect(availableFileTabs(ticketed)).toEqual(["issue", "files", "changes", "history"]);
    expect(availableFileTabs({ ...ticketed, hasPr: true })).toEqual([
      "issue",
      "files",
      "changes",
      "history",
      "pr",
      "aiWork",
    ]);
  });

  // A worktree cut from a plain branch has no Linear issue by its slug, and
  // offering a tab onto a ticket that doesn't exist put an error toast on screen.
  // It loses nothing else: it still has a branch, a diff, a history and a PR.
  it("drops only the Issue pane on the base entry and on a ticket-less worktree", () => {
    expect(availableFileTabs({ ...ticketed, isBase: true })).not.toContain("issue");
    expect(availableFileTabs({ isBase: false, hasPr: true, hasTicket: false })).toEqual([
      "files",
      "changes",
      "history",
      "pr",
      "aiWork",
    ]);
  });
});

/** One dot, two signals. The strip has room for exactly one per tab, so which
 *  one wins is a real decision — see {@link aiWorkDot}. */
describe("aiWorkDot", () => {
  // A count is "there is work here"; a stale brief is "what you are reading may
  // no longer be true". The second is the one you need to see, so it wins.
  it("shows the accent for open items, but a stale brief beats the count", () => {
    expect(aiWorkDot(false, 0)).toBeNull();
    expect(aiWorkDot(false, 3)).toBe("var(--accent)");
    expect(aiWorkDot(true, 3)).toBe(palette.amber);
  });
});

describe("resolveFileTab", () => {
  const task = { isBase: false, hasPr: true, hasTicket: true };

  it("keeps every pane the worktree actually has", () => {
    for (const tab of availableFileTabs(task)) {
      expect(resolveFileTab(tab, task)).toBe(tab);
    }
  });

  // The Issue pane is the persisted default, and a remembered PR pane outlives
  // its PR: either would leave the user on a pane the strip no longer shows. The
  // base checkout can still carry a PR, so its AI work pane survives.
  it("falls back to Changes off a pane the worktree no longer has", () => {
    expect(resolveFileTab("issue", { ...task, isBase: true, hasPr: false })).toBe("changes");
    expect(resolveFileTab("issue", { ...task, hasTicket: false })).toBe("changes");
    expect(resolveFileTab("pr", { ...task, hasPr: false })).toBe("changes");
    expect(resolveFileTab("aiWork", { ...task, hasPr: false })).toBe("changes");
    expect(resolveFileTab("aiWork", { ...task, isBase: true })).toBe("aiWork");
  });
});

/** Minimal WorktreeTab fixture. */
function extraTabRow(
  id: string,
  kind: TabKind,
  title: string,
  agentKind: AgentKind = "Codex",
): WorktreeTab {
  // `pr` is set only on the review kinds; these are agent/terminal tabs.
  return {
    id,
    worktreeId: "AK-1",
    kind,
    agentKind: kind === "terminal" ? null : agentKind,
    title,
    pr: null,
    account: null,
    url: null,
  };
}

describe("defaultTabTitle", () => {
  // The tab a start mints is named after its provider like every other agent tab.
  // Terminals number from 2: the primary Terminal tab is #1 implicitly.
  it("names each kind on its own, numbering from 2 against its own titles", () => {
    expect(defaultTabTitle("agent", "Codex", [])).toBe("Codex");
    expect(defaultTabTitle("agent", "Codex", [extraTabRow("a", "agent", "Codex")])).toBe("Codex 2");
    expect(defaultTabTitle("agent", "Claude", [extraTabRow("a", "agent", "Codex")])).toBe(
      "Claude Code",
    );
    expect(defaultTabTitle("terminal", null, [extraTabRow("a", "terminal", "Terminal 2")])).toBe(
      "Terminal 3",
    );
    expect(defaultTabTitle("agent", "Codex", [extraTabRow("a", "terminal", "Terminal 2")])).toBe(
      "Codex",
    );
  });

  it("takes the first free name after renames leave gaps", () => {
    expect(defaultTabTitle("agent", "Codex", [extraTabRow("a", "agent", "Debugging")])).toBe(
      "Codex",
    );
    const taken = [extraTabRow("a", "agent", "Codex"), extraTabRow("b", "agent", "Codex 3")];
    expect(defaultTabTitle("agent", "Codex", taken)).toBe("Codex 2");
  });
});
