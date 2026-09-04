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
  finishedSetups,
  focusedAgentFor,
  hasLivePane,
  isTreeLaunchDead,
  type MainTab,
  mergeWorktrees,
  openMainTabs,
  pendingWorktree,
  prDiffModeFor,
  remoteControlTab,
  resolveActiveTab,
  resolveFileTab,
  shouldHoldTerminal,
  startTabFor,
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
    expect(startTabFor(true, "t1")).toBe("setup");
  });

  it("opens the tab the agent is starting in when the preference is off", () => {
    expect(startTabFor(false, "t1")).toBe("tab:t1");
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

  // The PR and ticket pages are opened on purpose and stay; a picked file comes
  // and goes. Putting the file after them is what keeps them from shifting.
  it("keeps the reference views ahead of a file that opens later", () => {
    expect(openMainTabs({ ...base, hasIssueView: true, hasFile: true })).toEqual([
      "issueView",
      "file",
    ]);
  });

  // A worktree with every tab closed can still be showing a diff or a setup log —
  // those are views of the work, not tabs the workspace owns.
  it("keeps the on-demand views when no tab is open", () => {
    expect(openMainTabs({ ...base, hasFile: true })).toEqual(["file"]);
  });
});

describe("resolveActiveTab", () => {
  const open = (o: Partial<Parameters<typeof openMainTabs>[0]>) =>
    openMainTabs({
      tabIds: ["a1"],
      hasPrView: false,
      hasIssueView: false,
      hasFile: false,
      hasSetup: false,
      hasCheckLog: false,
      ...o,
    });

  it("defaults a never-visited worktree to its first tab", () => {
    expect(resolveActiveTab(undefined, open({}))).toBe("tab:a1");
  });

  it("keeps a remembered tab as-is", () => {
    expect(resolveActiveTab("tab:a1", open({}))).toBe("tab:a1");
  });

  it("keeps the File tab only while a file is actually open", () => {
    expect(resolveActiveTab("file", open({ hasFile: true }))).toBe("file");
    expect(resolveActiveTab("file", open({}))).toBe("tab:a1");
  });

  // A remembered "prView" survives a reload; the PR it showed may not have. The
  // gate is the same one that decides whether the right panel has a PR pane.
  it("keeps the PR and ticket views only while the worktree has them", () => {
    expect(resolveActiveTab("prView", open({ hasPrView: true }))).toBe("prView");
    expect(resolveActiveTab("prView", open({}))).toBe("tab:a1");
    expect(resolveActiveTab("issueView", open({ hasIssueView: true }))).toBe("issueView");
    expect(resolveActiveTab("issueView", open({}))).toBe("tab:a1");
  });

  it("keeps the Setup tab only while setup is running for THIS worktree", () => {
    expect(resolveActiveTab("setup", open({ hasSetup: true }))).toBe("setup");
    // A different worktree's setup superseded the single setupFor slot, so this
    // one contributes no Setup tab at all.
    expect(resolveActiveTab("setup", open({}))).toBe("tab:a1");
  });

  it("keeps a remembered tab only while that tab still exists", () => {
    expect(resolveActiveTab("tab:b2", open({ tabIds: ["a1", "b2"] }))).toBe("tab:b2");
    expect(resolveActiveTab("tab:b2", open({ tabIds: ["a1"] }))).toBe("tab:a1");
  });

  // The log itself is deliberately not persisted, so a remembered "checkLog" tab
  // routinely comes back with an empty slot — after a reload, or on a worktree
  // whose log was closed elsewhere.
  it("keeps the check-log tab only while a log is actually open", () => {
    expect(resolveActiveTab("checkLog", open({ hasCheckLog: true }))).toBe("checkLog");
    expect(resolveActiveTab("checkLog", open({}))).toBe("tab:a1");
  });

  it("resolves to nothing at all once every tab is closed", () => {
    expect(resolveActiveTab("tab:a1", [])).toBeNull();
    expect(resolveActiveTab(undefined, [])).toBeNull();
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

  it("has nothing to point at with no worktree open", () => {
    expect(focusedAgentFor({ ...base, activeId: "" })).toBeNull();
  });

  // Every tab closed: the main area is showing the empty surface, so the status
  // bar's meter has no session to scope itself to either.
  it("has nothing to point at when no tab is open", () => {
    expect(focusedAgentFor({ ...base, activeTab: null })).toBeNull();
  });

  // A "+ Terminal" tab runs a shell in the worktree, not an agent — the meter
  // must not fall back to an agent tab beside it.
  it("has nothing to point at on a plain Terminal tab", () => {
    const tabs = [extraTabRow("t1", "terminal", "Terminal 2")];
    expect(focusedAgentFor({ ...base, activeTab: "tab:t1", tabs })).toBeNull();
  });

  it("has nothing to point at for a tab that no longer exists", () => {
    expect(focusedAgentFor({ ...base, activeTab: "tab:gone" })).toBeNull();
  });

  // A diff, a setup log, a job log, the PR page and the ticket page are all
  // things you read *about* the work, not the work running — the meter belongs
  // to a session on screen.
  it("has nothing to point at while the main area shows a view rather than a tab row", () => {
    for (const tab of ["file", "setup", "checkLog", "prView", "issueView"] as const) {
      expect(focusedAgentFor({ ...base, activeTab: tab })).toBeNull();
    }
  });
});

describe("defaultTabTitle on a started task's tab", () => {
  // The tab a start mints is named after the provider it runs, like every other
  // agent tab — which is why the strip no longer needs a special case to avoid
  // calling a Codex pane "Terminal".
  it("names it after the provider, not after the pane", () => {
    expect(defaultTabTitle("agent", "Codex", [])).toBe("Codex");
    expect(defaultTabTitle("agent", "Claude", [])).toBe("Claude Code");
  });
});

describe("remoteControlTab", () => {
  const claude = (id: string) => extraTabRow(id, "agent", "Claude Code", "Claude");
  const codex = (id: string) => extraTabRow(id, "agent", "Codex", "Codex");

  // The tab a started task minted is created first, so "first Claude tab" names it
  // without anything having to record that it was the start.
  it("gives the claim to the worktree's first Claude tab", () => {
    expect(remoteControlTab([claude("w1"), claude("a2")])).toBe("w1");
  });

  // Two panes under one name collide, which is the whole reason for the rule.
  it("gives it to exactly one tab", () => {
    const tabs = [claude("w1"), claude("a2"), claude("a3")];
    expect(tabs.filter((t) => remoteControlTab(tabs) === t.id)).toHaveLength(1);
  });

  // Codex cannot use it at all (see its launch spec), so a Codex tab standing
  // first must not swallow the claim and leave the Claude tab without a name.
  it("skips a Codex tab standing first", () => {
    expect(remoteControlTab([codex("c1"), claude("w1")])).toBe("w1");
  });

  it("skips a plain shell, and claims nothing when there is no Claude tab", () => {
    expect(remoteControlTab([extraTabRow("t1", "terminal", "Terminal 2")])).toBeNull();
    expect(remoteControlTab([])).toBeNull();
  });
});

describe("hasLivePane", () => {
  it("sees a worktree's tab panes", () => {
    expect(hasLivePane(new Set(["tree:AK-1:tab:a1"]), "AK-1")).toBe(true);
  });

  // Sessions minted before every agent lived in a tab still carry the bare key.
  it("sees the bare key a pre-tabs session still uses", () => {
    expect(hasLivePane(new Set(["tree:AK-1"]), "AK-1")).toBe(true);
  });

  // The separator is load-bearing: a plain `startsWith` would let AK-1 claim
  // AK-12's panes and report the wrong worktree as running.
  it("does not mistake another worktree whose id starts the same", () => {
    expect(hasLivePane(new Set(["tree:AK-12:tab:a1", "tree:AK-1x"]), "AK-1")).toBe(false);
  });

  it("is false with nothing live", () => {
    expect(hasLivePane(new Set(), "AK-1")).toBe(false);
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

  // The queue is what you do about the PR, so it sits against the PR's own tab
  // rather than at the end of the strip.
  it("puts the AI work queue directly after the PR", () => {
    const tabs = availableFileTabs({ ...ticketed, hasPr: true });
    expect(tabs[tabs.indexOf("pr") + 1]).toBe("aiWork");
  });

  it("drops the Issue pane on the base entry — it has no ticket", () => {
    expect(availableFileTabs({ ...ticketed, isBase: true })).not.toContain("issue");
  });

  // A worktree cut from a plain branch: santree keys it by a branch slug, Linear
  // has no issue by that name, and offering a tab onto a ticket that doesn't exist
  // is what put an error toast on screen.
  it("drops the Issue pane on a worktree with no Linear ticket", () => {
    expect(availableFileTabs({ ...ticketed, hasTicket: false })).toEqual([
      "files",
      "changes",
      "history",
    ]);
  });

  // …and loses nothing else with it: a ticket-less worktree is still a worktree,
  // with a branch, a diff, a session history and — once pushed — a PR.
  it("keeps every other pane on a ticket-less worktree", () => {
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
  const task = { isBase: false, hasPr: true, hasTicket: true };

  it("keeps every pane the worktree actually has", () => {
    for (const tab of availableFileTabs(task)) {
      expect(resolveFileTab(tab, task)).toBe(tab);
    }
  });

  it("falls back off the Issue pane for the base entry — it has no ticket", () => {
    expect(resolveFileTab("issue", { ...task, isBase: true, hasPr: false })).toBe("changes");
  });

  // The Issue pane is the persisted default, so the *first* worktree a user opens
  // after cutting one from a plain branch lands here — it has to fall back rather
  // than resolve to a pane the strip is no longer showing.
  it("falls back off the Issue pane on a worktree with no Linear ticket", () => {
    expect(resolveFileTab("issue", { ...task, hasTicket: false })).toBe("changes");
  });

  // The strip hides these when there's no PR, so a remembered one would leave the
  // user on a pane with no tab to get back to.
  it("falls back off the PR panes when the branch has no pull request", () => {
    expect(resolveFileTab("pr", { ...task, hasPr: false })).toBe("changes");
    expect(resolveFileTab("aiWork", { ...task, hasPr: false })).toBe("changes");
  });

  // The base checkout can still carry a PR (a branch pushed from the repo root),
  // so the AI work pane survives there even though the ticket pane doesn't.
  it("keeps the AI work pane on the base entry when it has a pull request", () => {
    expect(resolveFileTab("aiWork", { ...task, isBase: true })).toBe("aiWork");
  });

  it("leaves the other panes alone without a ticket or a PR", () => {
    const plain = { isBase: true, hasPr: false, hasTicket: false };
    expect(resolveFileTab("files", plain)).toBe("files");
    expect(resolveFileTab("history", plain)).toBe("history");
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
  };
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
