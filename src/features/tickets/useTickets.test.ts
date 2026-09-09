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

  describe("teams", () => {
    const team = (key: string, name: string | null = null) => ({ team: { key, name } });

    /** The switcher's entries are tallied over every row, in name order, with
     *  the name taken from whichever row carried one — a blocker knows only
     *  its key. */
    it("lists every team on the page by name, with a count each", () => {
      const { teams } = fold({
        repos: ["one"],
        tasks: new Map([
          [
            "one",
            [
              task("MS-1", "Alpha", team("MSG", "Messaging")),
              task("AK-1", "Alpha", team("AK")),
              task("AK-2", "Beta", team("AK", "App")),
              task("MS-2", "Beta", team("MSG")),
            ],
          ],
        ]),
      });
      expect(teams).toEqual([
        { key: "AK", name: "App", count: 2 },
        { key: "MSG", name: "Messaging", count: 2 },
      ]);
    });

    /** "All": a team's groups sit together, teams in the switcher's order, and
     *  a project spanning two teams is one group under each. */
    it("orders the groups by team, splitting a project that spans two", () => {
      const { groups, picked } = fold({
        repos: ["one"],
        tasks: new Map([
          [
            "one",
            [
              task("MS-1", "Alpha", team("MSG", "Messaging")),
              task("AK-1", "Alpha", team("AK", "App")),
              task("MS-2", "Beta", team("MSG", "Messaging")),
              task("X-1", "Alpha"),
            ],
          ],
        ]),
      });
      expect(picked).toEqual([]);
      expect(groups.map((g) => [g.team?.key ?? null, g.project])).toEqual([
        ["AK", "Alpha"],
        ["MSG", "Alpha"],
        ["MSG", "Beta"],
        [null, "Alpha"],
      ]);
      expect(groups[1].team).toEqual({ key: "MSG", name: "Messaging" });
    });

    it("keeps only the picked teams' rows, and tallies the others all the same", () => {
      const { groups, teams, picked, summary } = fold({
        repos: ["one"],
        tasks: new Map([
          [
            "one",
            [
              task("MS-1", "Alpha", team("MSG", "Messaging")),
              task("AK-1", "Alpha", team("AK", "App")),
              task("AK-2", "Beta", team("AK", "App")),
            ],
          ],
        ]),
        teams: ["MSG"],
      });
      expect(picked).toEqual(["MSG"]);
      expect(groups.map((g) => g.milestones.flatMap((m) => m.items.map((r) => r.task.id)))).toEqual(
        [["MS-1"]],
      );
      expect(summary).toMatchObject({ total: 1, projects: 1 });
      expect(teams.map((t) => [t.key, t.count])).toEqual([
        ["AK", 2],
        ["MSG", 1],
      ]);
    });

    /** The pick outlives the tickets that made it: a stored team with nothing
     *  on the page shows every team, not an empty page. */
    it("falls back to every team when the pick names none on the page", () => {
      const { groups, picked } = fold({
        repos: ["one"],
        tasks: new Map([["one", [task("AK-1", "Alpha", team("AK", "App"))]]]),
        teams: ["MSG"],
      });
      expect(picked).toEqual([]);
      expect(groups).toHaveLength(1);
    });

    /** The pick is a set: two of three teams show, in team order, the third
     *  gone; a picked key with no rows drops out and the rest still applies. */
    it("shows any set of teams together, dropping a picked key that has no rows", () => {
      const rows = new Map([
        [
          "one",
          [
            task("MS-1", "Alpha", team("MSG", "Messaging")),
            task("AK-1", "Alpha", team("AK", "App")),
            task("OP-1", "Beta", team("OPS", "Ops")),
          ],
        ],
      ]);
      const two = fold({ repos: ["one"], tasks: rows, teams: ["OPS", "MSG"] });
      expect(two.picked).toEqual(["OPS", "MSG"]);
      expect(two.groups.map((g) => g.team?.key)).toEqual(["MSG", "OPS"]);

      const stale = fold({ repos: ["one"], tasks: rows, teams: ["DES", "AK"] });
      expect(stale.picked).toEqual(["AK"]);
      expect(stale.groups.map((g) => g.team?.key)).toEqual(["AK"]);
    });
  });

  it("drops context tickets only while the actionable filter is on", () => {
    const tasks = new Map([
      ["one", [task("A-1", "Alpha"), task("A-2", "Alpha", { actionable: false })]],
    ]);

    expect(fold({ repos: ["one"], tasks }).summary.total).toBe(1);
    expect(fold({ repos: ["one"], tasks, actionableOnly: false }).summary.total).toBe(2);
  });
});
