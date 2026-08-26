import { describe, expect, it } from "vitest";

import type { Task, Worktree } from "../../bindings";
import { countLaunchSuccesses, deriveIssueState, launchPlan, stackBase } from "./model";

/** Minimal Task fixture — only `ready` varies across the matrix below. */
function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "AK-1",
    title: "Task AK-1",
    priority: "None",
    estimate: null,
    project: "Core",
    projectColor: null,
    projectIcon: null,
    projectTargetDate: null,
    projectMilestone: null,
    status: "Todo",
    ready: true,
    blockedBy: [],
    actionable: true,
    assignee: null,
    assigneeAvatarUrl: null,
    x: 0,
    y: 0,
    ...overrides,
  };
}

/** Minimal Worktree fixture — only `id`/`branch` matter to `stackBase`. */
function worktree(id: string, branch = `santree/${id.toLowerCase()}`): Worktree {
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
    branch,
    path: "/tmp/x",
    project: null,
    baseBranch: "main",
    setupRan: true,
    pending: false,
  };
}

const byId = (...wts: Worktree[]) => new Map(wts.map((w) => [w.id, w]));

describe("stackBase", () => {
  // The bug this guards: AK-275 (blocked by AK-274, which is already in review in
  // its own worktree) launched from master instead of AK-274's branch, so it
  // didn't have the code it was written to build on.
  it("returns the blocker's branch when a blocker already has a worktree", () => {
    expect(stackBase(taskBlockedBy("AK-274"), byId(worktree("AK-274")))).toEqual({
      ticket: "AK-274",
      branch: "santree/ak-274",
    });
  });

  it("returns null when no blocker has a worktree (nothing to stack on)", () => {
    expect(stackBase(taskBlockedBy("AK-274"), byId(worktree("AK-999")))).toBeNull();
  });

  it("returns null for a ready task even if a done blocker still has a worktree", () => {
    const ready = task({ ready: true, blockedBy: ["AK-274"] });
    expect(stackBase(ready, byId(worktree("AK-274")))).toBeNull();
  });

  it("picks the first blocker that has a worktree, skipping ones that don't", () => {
    const t = task({ ready: false, blockedBy: ["AK-100", "AK-274", "AK-300"] });
    expect(stackBase(t, byId(worktree("AK-274"), worktree("AK-300")))?.ticket).toBe("AK-274");
  });

  // A worktree with no branch can't be branched from — advertising it as the chain
  // base would send an empty `base` to `createWorktree`.
  it("skips a worktree with no branch", () => {
    expect(stackBase(taskBlockedBy("AK-274"), byId(worktree("AK-274", "")))).toBeNull();
  });
});

function taskBlockedBy(id: string): Task {
  return task({ ready: false, blockedBy: [id] });
}

describe("launchPlan", () => {
  const stacks = (base: string) => () => ({
    ticket: base,
    branch: `santree/${base.toLowerCase()}`,
  });
  const never = () => null;

  it("a single ready ticket asks nothing and leaves setup to the plain preference", () => {
    const plan = launchPlan([task()], { batchSetup: "ask", askBase: true, stackOn: never });
    expect(plan).toEqual({ askSetup: false, askStack: false, setup: null, stacking: [] });
  });

  it("a single stacking ticket asks only about the base", () => {
    const plan = launchPlan([taskBlockedBy("AK-274")], {
      batchSetup: "ask",
      askBase: true,
      stackOn: stacks("AK-274"),
    });
    expect(plan.askStack).toBe(true);
    expect(plan.askSetup).toBe(false);
    expect(plan.stacking).toEqual([{ id: "AK-1", base: "AK-274" }]);
  });

  // The whole point of the setting: off ⇒ no dialog, and the launch still stacks
  // (the caller passes `stack: true` when nothing was asked).
  it("with the preference off, a stacking ticket asks nothing", () => {
    const plan = launchPlan([taskBlockedBy("AK-274")], {
      batchSetup: "ask",
      askBase: false,
      stackOn: stacks("AK-274"),
    });
    expect(plan.askStack).toBe(false);
    expect(plan.stacking).toEqual([{ id: "AK-1", base: "AK-274" }]);
  });

  it("a batch with nothing stacking asks only about setup", () => {
    const plan = launchPlan([task({ id: "AK-1" }), task({ id: "AK-2" })], {
      batchSetup: "ask",
      askBase: true,
      stackOn: never,
    });
    expect(plan).toEqual({ askSetup: true, askStack: false, setup: false, stacking: [] });
  });

  // batch_setup already answered ("always") ⇒ only the base question is left, and
  // the resolved setup answer rides along so the dialog doesn't drop it.
  it("a batch with setup already decided still carries that answer while asking the base", () => {
    const blocked = task({ id: "AK-2", ready: false, blockedBy: ["AK-274"] });
    const plan = launchPlan([task({ id: "AK-1" }), blocked], {
      batchSetup: "always",
      askBase: true,
      stackOn: (t) => (t.ready ? null : { ticket: "AK-274", branch: "santree/ak-274" }),
    });
    expect(plan).toEqual({
      askSetup: false,
      askStack: true,
      setup: true,
      stacking: [{ id: "AK-2", base: "AK-274" }],
    });
  });

  // The dialog names the blocker the launch will actually branch from. With two
  // blockers and only the second started, `blockedBy[0]` would name the wrong one.
  it("reports the blocker stackOn resolved to, not the first one listed", () => {
    const t = task({ id: "AK-9", ready: false, blockedBy: ["AK-100", "AK-274"] });
    const plan = launchPlan([t], {
      batchSetup: "ask",
      askBase: true,
      stackOn: stacks("AK-274"),
    });
    expect(plan.stacking).toEqual([{ id: "AK-9", base: "AK-274" }]);
  });
});

describe("deriveIssueState", () => {
  // --- ready, no worktree: selected/ready pass through as given -----------

  it("ready + no worktree + selected: honors selected and reports ready, not chainable/blocked", () => {
    const state = deriveIssueState(task({ ready: true }), {
      selected: true,
      baseFor: () => null,
    });
    expect(state).toEqual({
      started: false,
      selected: true,
      chainBase: null,
      chainable: false,
      ready: true,
      blocked: false,
    });
  });

  it("ready + no worktree + not selected: reports ready with selected false", () => {
    const state = deriveIssueState(task({ ready: true }), {
      selected: false,
      baseFor: () => null,
    });
    expect(state).toEqual({
      started: false,
      selected: false,
      chainBase: null,
      chainable: false,
      ready: true,
      blocked: false,
    });
  });

  // --- ready, has worktree: started wins, selected forced off, ready off --

  it("ready + has worktree: started true, selected forced false, ready false", () => {
    const state = deriveIssueState(task({ ready: true }), {
      selected: true,
      baseFor: () => null,
      hasWorktree: true,
    });
    expect(state.started).toBe(true);
    expect(state.selected).toBe(false);
    expect(state.ready).toBe(false);
    expect(state.chainable).toBe(false);
    expect(state.blocked).toBe(false);
  });

  // --- blocked, no worktree, valid chain base: chainable -------------------

  it("blocked + valid chain base + no worktree: chainable true with the given chainBase, not blocked", () => {
    const state = deriveIssueState(task({ ready: false }), {
      selected: false,
      baseFor: () => "AK-BASE",
    });
    expect(state).toEqual({
      started: false,
      selected: false,
      chainBase: "AK-BASE",
      chainable: true,
      ready: false,
      blocked: false,
    });
  });

  // --- blocked, has worktree: worktree existing takes precedence over chaining --

  it("blocked + has worktree: started true, NOT chainable even though a valid chain base exists", () => {
    const state = deriveIssueState(task({ ready: false }), {
      selected: true,
      baseFor: () => "AK-BASE",
      hasWorktree: true,
    });
    expect(state.started).toBe(true);
    expect(state.chainable).toBe(false);
    expect(state.selected).toBe(false);
    expect(state.ready).toBe(false);
    // `blocked` is also false here: the `!started` guard means a started task
    // is never reported as blocked either — started is the exclusive terminal
    // state once a real worktree exists. Note chainBase itself is still
    // computed from baseFor() (it isn't gated on `started`), so it stays
    // "AK-BASE" — only `chainable` is suppressed.
    expect(state.blocked).toBe(false);
    expect(state.chainBase).toBe("AK-BASE");
  });

  // --- blocked, no worktree, no valid chain base: plain blocked ------------

  it("blocked + no valid chain base + no worktree: plain blocked, not chainable", () => {
    const state = deriveIssueState(task({ ready: false }), {
      selected: false,
      baseFor: () => null,
    });
    expect(state).toEqual({
      started: false,
      selected: false,
      chainBase: null,
      chainable: false,
      ready: false,
      blocked: true,
    });
  });

  // --- regression guard for the documented past bug: an omitted `hasWorktree` --
  // (the field is optional, so a caller can drop it and still type-check; that
  // silently makes every ticket look not-started, which manifested as a wrong
  // RDY badge in the graph/sidebar).

  it("omitting hasWorktree entirely treats the task as not-started (the historical caller-omission bug)", () => {
    const state = deriveIssueState(task({ ready: true }), {
      selected: false,
      baseFor: () => null,
      // hasWorktree intentionally omitted
    });
    expect(state.started).toBe(false);
    expect(state.ready).toBe(true);
  });

  it("baseFor is only consulted when the task isn't already ready", () => {
    let calls = 0;
    deriveIssueState(task({ ready: true }), {
      selected: false,
      baseFor: () => {
        calls += 1;
        return "AK-BASE";
      },
    });
    expect(calls).toBe(0);
  });
});

describe("countLaunchSuccesses", () => {
  // launch() catches a rejected createWorktree and resolves it to `null` (so
  // one failed create doesn't reject the whole Promise.allSettled batch) —
  // these fixtures mirror the shape `results` actually has at the call site.

  it("all successes: count equals N", () => {
    const results: PromiseSettledResult<string | null>[] = [
      { status: "fulfilled", value: "wt-1" },
      { status: "fulfilled", value: "wt-2" },
      { status: "fulfilled", value: "wt-3" },
    ];
    expect(countLaunchSuccesses(results)).toBe(3);
  });

  it("some failures (fulfilled-with-null): counts only the real successes, not N", () => {
    const results: PromiseSettledResult<string | null>[] = [
      { status: "fulfilled", value: "wt-1" },
      { status: "fulfilled", value: null },
      { status: "fulfilled", value: "wt-3" },
      { status: "fulfilled", value: null },
    ];
    expect(countLaunchSuccesses(results)).toBe(2);
  });

  it("a genuinely rejected result (uncaught) is also not counted", () => {
    const results: PromiseSettledResult<string | null>[] = [
      { status: "fulfilled", value: "wt-1" },
      { status: "rejected", reason: new Error("boom") },
    ];
    expect(countLaunchSuccesses(results)).toBe(1);
  });

  it("all failures: count is 0, not N", () => {
    const results: PromiseSettledResult<string | null>[] = [
      { status: "fulfilled", value: null },
      { status: "fulfilled", value: null },
    ];
    expect(countLaunchSuccesses(results)).toBe(0);
  });
});
