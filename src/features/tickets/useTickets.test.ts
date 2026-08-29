import { describe, expect, it } from "vitest";

import type { Task, Worktree } from "../../bindings";
import { buildTicketGroups, type TicketFoldInput } from "./useTickets";

function task(id: string, repoProject: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    project: repoProject,
    projectMilestone: null,
    projectColor: null,
    projectIcon: null,
    projectTargetDate: null,
    parentId: null,
    priority: "None",
    estimate: null,
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

function worktree(id: string): Worktree {
  return {
    id,
    title: id,
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
    branch: `feature/${id}`,
    path: `/tmp/${id}`,
    project: null,
    baseBranch: "main",
    setupRan: false,
    pending: false,
  };
}

function fold(overrides: Partial<TicketFoldInput> = {}) {
  return buildTicketGroups({
    repos: [],
    tasks: new Map(),
    worktrees: new Map(),
    prs: new Map(),
    agents: [],
    seen: {},
    nowMs: Date.now(),
    actionableOnly: true,
    ...overrides,
  });
}

describe("buildTicketGroups", () => {
  it("keeps first-seen project order across repos, and ticket order within one", () => {
    const { groups } = fold({
      repos: ["one", "two"],
      tasks: new Map([
        ["one", [task("A-2", "Beta"), task("A-1", "Alpha"), task("A-3", "Beta")]],
        ["two", [task("B-1", "Alpha")]],
      ]),
    });

    expect(groups.map((g) => g.key)).toEqual(["Beta", "Alpha"]);
    expect(groups[0].count).toBe(2);
    expect(groups[1].milestones[0].items.map((r) => r.task.id)).toEqual(["A-1", "B-1"]);
  });

  it("lists a ticket carried by several repos once, remembering where it can run", () => {
    const { groups, summary } = fold({
      repos: ["one", "two"],
      tasks: new Map([
        ["one", [task("A-1", "Alpha")]],
        ["two", [task("A-1", "Alpha")]],
      ]),
    });

    const rows = groups.flatMap((g) => g.milestones.flatMap((m) => m.items));
    expect(rows).toHaveLength(1);
    expect(rows[0].repos).toEqual(["one", "two"]);
    expect(rows[0].repo).toBe("one");
    expect(summary).toMatchObject({ total: 1, projects: 1, ready: 1 });
  });

  it("makes the repo holding the worktree the ticket's home, whichever came first", () => {
    const { groups, summary } = fold({
      repos: ["one", "two"],
      tasks: new Map([
        ["one", [task("A-1", "Alpha")]],
        ["two", [task("A-1", "Alpha")]],
      ]),
      worktrees: new Map([["two", [worktree("A-1")]]]),
    });

    const [row] = groups[0].milestones[0].items;
    expect(row.repo).toBe("two");
    expect(row.worktree).not.toBeNull();
    // Started work is no longer on offer.
    expect(summary.ready).toBe(0);
  });

  it("keeps the same identifier apart when it belongs to two orgs", () => {
    const { groups, summary } = fold({
      repos: ["one", "two"],
      orgOf: new Map([
        ["one", "Linear · Acme"],
        ["two", "Linear · Globex"],
      ]),
      tasks: new Map([
        ["one", [task("A-1", "Alpha")]],
        ["two", [task("A-1", "Alpha")]],
      ]),
    });

    expect(groups.map((g) => g.key)).toEqual(["Linear · Acme Alpha", "Linear · Globex Alpha"]);
    expect(summary).toMatchObject({ total: 2, projects: 1 });
  });

  it("omits a repo whose tasks have not arrived instead of grouping it empty", () => {
    const { groups } = fold({
      repos: ["one", "two"],
      tasks: new Map([["one", [task("A-1", "Alpha")]]]),
    });

    const rows = groups.flatMap((g) => g.milestones.flatMap((m) => m.items));
    expect(rows.map((r) => r.repos)).toEqual([["one"]]);
  });

  it("names a blocker it holds, and counts the ticket as blocked", () => {
    const blocked = task("A-2", "Alpha", { ready: false, blockedBy: ["A-9", "A-1"] });
    const { groups, summary } = fold({
      repos: ["one"],
      tasks: new Map([["one", [blocked, task("A-1", "Alpha")]]]),
    });

    const rows = groups[0].milestones[0].items;
    expect(rows[0].blockedBy).toBe("A-1");
    expect(rows[1].blockedBy).toBeNull();
    expect(summary).toMatchObject({ ready: 1, blocked: 1 });
  });

  it("drops context tickets only while the actionable filter is on", () => {
    const tasks = new Map([
      ["one", [task("A-1", "Alpha"), task("A-2", "Alpha", { actionable: false })]],
    ]);

    expect(fold({ repos: ["one"], tasks }).summary.total).toBe(1);
    expect(fold({ repos: ["one"], tasks, actionableOnly: false }).summary.total).toBe(2);
  });
});
