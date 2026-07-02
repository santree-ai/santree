import { describe, expect, it } from "vitest";

import type { Task } from "../../bindings";
import { countLaunchSuccesses, deriveIssueState } from "./model";

/** Minimal Task fixture — only `ready` varies across the matrix below. */
function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "AK-1",
    title: "Task AK-1",
    project: "Core",
    projectColor: null,
    projectIcon: null,
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
