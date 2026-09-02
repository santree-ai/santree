import { describe, expect, it } from "vitest";

import type { Task, Worktree } from "../../bindings";
import { startCandidates } from "./StartTaskButton";

function task(id: string, ready = true): Task {
  return {
    id,
    title: `Task ${id}`,
    priority: "None",
    estimate: null,
    cycle: null,
    dueDate: null,
    project: "Core",
    projectColor: null,
    projectIcon: null,
    projectTargetDate: null,
    projectMilestone: null,
    parentId: null,
    status: "Todo",
    ready,
    blockedBy: [],
    actionable: true,
    assignee: null,
    assigneeAvatarUrl: null,
    x: 0,
    y: 0,
  };
}

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

describe("startCandidates", () => {
  it("offers ready issues with no worktree", () => {
    const tasks = [task("AK-1"), task("AK-2", false)];
    expect(startCandidates(tasks, [], new Set()).map((t) => t.id)).toEqual(["AK-1"]);
  });

  it("excludes issues that already have a worktree", () => {
    expect(startCandidates([task("AK-1")], [worktree("AK-1")], new Set())).toEqual([]);
  });

  // The Trees model hides pending deletes from `worktrees` optimistically, so a
  // ticket mid-delete looks worktree-less — offering it would race `create`
  // against the `remove` still running on the same path.
  it("excludes a ticket whose worktree is mid-delete, even though it's already hidden", () => {
    expect(startCandidates([task("AK-1")], [], new Set(["AK-1"]))).toEqual([]);
  });
});
