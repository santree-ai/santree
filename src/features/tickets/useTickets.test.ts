import { describe, expect, it } from "vitest";

import { agentEntry, NOW, STALE, task, worktree } from "../../test/fixtures";
import { buildTicketGroups, type TicketFoldInput } from "./useTickets";

function fold(overrides: Partial<TicketFoldInput> = {}) {
  return buildTicketGroups({
    repos: [],
    tasks: new Map(),
    worktrees: new Map(),
    prs: new Map(),
    agents: [],
    seen: {},
    // The shared fixture clock, not the wall clock: `buildTicketGroups` feeds
    // this to `levelOf`, whose first tier is `nowMs - updatedAtMs <= 30min`, and
    // every shared agent fixture is stamped `NOW`. A live `Date.now()` here
    // makes any agent passed in years stale, so the fresh-hook tier of the
    // attention join silently reports "idle" instead.
    nowMs: NOW,
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

  /** The row's dot is `highest` over its agents' `levelOf`, and `levelOf`'s first
   *  tier is the hook event while it is still fresh — which is only reachable
   *  because `nowMs` is the same fixed clock the agent fixtures are stamped
   *  against. With a live `Date.now()` here every entry read as long-stale and
   *  this came back `idle` no matter what the agents were doing. */
  it("takes a row's attention from the busiest agent on its ticket", () => {
    const { groups } = fold({
      repos: ["one"],
      tasks: new Map([["one", [task("A-1", "Alpha")]]]),
      agents: [
        agentEntry({ bucket: "working", repo: "one", termKey: "tree:A-1", sessionId: "s1" }),
        agentEntry({ bucket: "attention", repo: "one", termKey: "tree:A-1", sessionId: "s2" }),
      ],
    });

    const [row] = groups[0].milestones[0].items;
    expect(row.agents.map((a) => a.sessionId)).toEqual(["s1", "s2"]);
    expect(row.attention.level).toBe("needs-you");
  });

  /** Same agents, one stale hook event: the row falls back to rest rather than
   *  asserting a reading nothing has confirmed in half an hour. */
  it("lets a row's attention decay once its agent's last event goes stale", () => {
    const { groups } = fold({
      repos: ["one"],
      tasks: new Map([["one", [task("A-1", "Alpha")]]]),
      agents: [
        agentEntry({ bucket: "working", repo: "one", termKey: "tree:A-1", updatedAtMs: STALE }),
      ],
    });

    expect(groups[0].milestones[0].items[0].attention.level).toBe("idle");
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
