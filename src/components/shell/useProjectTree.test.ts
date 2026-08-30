import { describe, expect, it } from "vitest";

import type { Task, Worktree, WorktreePr } from "../../bindings";
import type { AgentBucket, AgentEntry, AgentOriginKind } from "../../features/agents/registry";
import type { SeenMap } from "../../lib/attention";
import { PROJECT_FALLBACK } from "../../theme/colors";
import { buildProjectNode, groupAgentsByWorktree, worktreeKey } from "./useProjectTree";

const NOW = 1_700_000_000_000;

function worktree(id: string, over: Partial<Worktree> = {}): Worktree {
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
    path: `/tmp/${id}`,
    project: "Core",
    baseBranch: "master",
    setupRan: true,
    pending: false,
    ...over,
  } as Worktree;
}

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    project: "Core",
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
    ...over,
  } as Task;
}

function entry(
  over: Partial<AgentEntry> & { sessionId: string; bucket: AgentBucket } & {
    originKind?: AgentOriginKind;
    ticket?: string | null;
  },
): AgentEntry {
  const { originKind = "tree", ticket = "AK-1", ...rest } = over;
  return {
    agentKind: "Claude",
    state: "active",
    origin: { kind: originKind, ticket, tabId: null, pr: null },
    repo: "acme/app",
    termKey: `tree:${ticket}`,
    cwd: "/repo",
    message: null,
    updatedAtMs: NOW,
    live: true,
    tabKey: null,
    openable: true,
    ticket,
    project: "Core",
    projectColor: null,
    projectIcon: null,
    purpose: "work",
    title: "Task",
    subtitle: null,
    worktree: null,
    ...rest,
  } as AgentEntry;
}

const noSeen: SeenMap = {};

/** The fold's own inputs, so a test only has to name what it is about.
 *  `groupBy` defaults to the app's own default — today's milestone-only tree. */
function build(over: Partial<Parameters<typeof buildProjectNode>[0]> = {}) {
  return buildProjectNode({
    repo: "acme/app",
    worktrees: [],
    base: null,
    tasks: [],
    prs: [],
    agentsByWorktree: new Map(),
    groupBy: "milestone",
    ...over,
  });
}

/** `[id, depth]` per milestone band, flattened across the project level — the
 *  shape the sidebar renders whenever project grouping is off. */
const bands = (node: ReturnType<typeof build>) =>
  node.linearProjects.flatMap((p) =>
    p.milestones.map((m) => m.worktrees.map((w) => [w.worktree.id, w.depth])),
  );

/** The whole nesting: project label → milestone label → worktree ids. */
const shape = (node: ReturnType<typeof build>) =>
  node.linearProjects.map((p) => [
    p.label,
    p.milestones.map((m) => [m.label, m.worktrees.map((w) => w.worktree.id)]),
  ]);

/** Every worktree id the tree renders, in render order — with duplicates kept,
 *  so a row filed into two bands shows up as one. */
const rendered = (node: ReturnType<typeof build>) =>
  node.linearProjects.flatMap((p) =>
    p.milestones.flatMap((m) => m.worktrees.map((w) => w.worktree.id)),
  );

const milestone = (id: string, name: string, sortOrder: number) => ({
  id,
  name,
  targetDate: null,
  sortOrder,
});

const firstRow = (node: ReturnType<typeof build>) =>
  node.linearProjects[0]?.milestones[0]?.worktrees[0];

describe("worktreeKey", () => {
  it("qualifies the worktree with its repo, because two repos routinely carry the same ticket id", () => {
    expect(worktreeKey("acme/app", "AK-1")).not.toBe(worktreeKey("acme/api", "AK-1"));
  });

  // A raw NUL makes git classify the file as binary, which silently drops it from
  // every diff, grep and review. This has regressed more than once.
  it("separates the two halves with a printable control char, never a NUL byte", () => {
    expect(worktreeKey("acme/app", "AK-1")).not.toContain("\0");
  });
});

describe("groupAgentsByWorktree", () => {
  it("files a tree agent under its own repo's worktree, not another repo's same-named one", () => {
    const mine = entry({ sessionId: "s1", bucket: "working", repo: "acme/app" });
    const theirs = entry({ sessionId: "s2", bucket: "working", repo: "acme/api" });
    const grouped = groupAgentsByWorktree([mine, theirs], noSeen, NOW);
    expect(grouped.get(worktreeKey("acme/app", "AK-1"))?.map((n) => n.entry.sessionId)).toEqual([
      "s1",
    ]);
    expect(grouped.get(worktreeKey("acme/api", "AK-1"))?.map((n) => n.entry.sessionId)).toEqual([
      "s2",
    ]);
  });

  it("keeps both terminal kinds a worktree owns — its main session and its extra tabs", () => {
    const main = entry({ sessionId: "s1", bucket: "working" });
    const tab = entry({ sessionId: "s2", bucket: "working", originKind: "tree-tab" });
    expect(
      groupAgentsByWorktree([main, tab], noSeen, NOW).get(worktreeKey("acme/app", "AK-1")),
    ).toHaveLength(2);
  });

  // A triage investigation or a PR review runs at the repo root: hanging it off a
  // worktree row would claim an ownership its term key never asserted.
  it("drops sessions that don't belong to a worktree", () => {
    const triage = entry({ sessionId: "s1", bucket: "working", originKind: "triage" });
    const review = entry({
      sessionId: "s2",
      bucket: "working",
      originKind: "review",
      ticket: null,
    });
    expect(groupAgentsByWorktree([triage, review], noSeen, NOW).size).toBe(0);
  });

  it("drops a session it cannot attribute to a repo, rather than filing it under a guess", () => {
    const orphan = entry({ sessionId: "s1", bucket: "working", repo: null });
    expect(groupAgentsByWorktree([orphan], noSeen, NOW).size).toBe(0);
  });

  it("orders a worktree's agents by attention, so the one blocked on you is the row you see first", () => {
    const idle = entry({ sessionId: "s1", bucket: "idle" });
    const blocked = entry({ sessionId: "s2", bucket: "attention" });
    const working = entry({ sessionId: "s3", bucket: "working" });
    const nodes = groupAgentsByWorktree([idle, blocked, working], noSeen, NOW).get(
      worktreeKey("acme/app", "AK-1"),
    );
    expect(nodes?.map((n) => n.entry.sessionId)).toEqual(["s2", "s3", "s1"]);
  });

  // Timestamps land at their own pace; without a final tiebreak the rows would
  // reshuffle under the cursor every time one arrived.
  it("breaks an attention tie on session id, so equal rows keep a fixed order", () => {
    const b = entry({ sessionId: "s-b", bucket: "working", updatedAtMs: NOW });
    const a = entry({ sessionId: "s-a", bucket: "working", updatedAtMs: NOW });
    const nodes = groupAgentsByWorktree([b, a], noSeen, NOW).get(worktreeKey("acme/app", "AK-1"));
    expect(nodes?.map((n) => n.entry.sessionId)).toEqual(["s-a", "s-b"]);
  });

  it("marks an agent unseen until its own row has been acknowledged at that moment", () => {
    const done = entry({ sessionId: "s1", bucket: "done", termKey: "tree:AK-1" });
    const key = worktreeKey("acme/app", "AK-1");
    expect(groupAgentsByWorktree([done], noSeen, NOW).get(key)?.[0]?.unseen).toBe(true);
    expect(groupAgentsByWorktree([done], { "tree:AK-1": NOW }, NOW).get(key)?.[0]?.unseen).toBe(
      false,
    );
  });

  // A permission prompt stays actionable however long you look at it, whereas a
  // finished agent recedes once acknowledged.
  it("decays a seen `done` agent to idle but leaves a blocked one asking", () => {
    const seen: SeenMap = { "tree:AK-1": NOW };
    const done = entry({ sessionId: "s1", bucket: "done" });
    const blocked = entry({ sessionId: "s1", bucket: "attention" });
    const key = worktreeKey("acme/app", "AK-1");
    expect(groupAgentsByWorktree([done], seen, NOW).get(key)?.[0]?.attention.level).toBe("idle");
    expect(groupAgentsByWorktree([blocked], seen, NOW).get(key)?.[0]?.attention.level).toBe(
      "needs-you",
    );
  });
});

describe("buildProjectNode", () => {
  // "We haven't looked yet" must not render as "this repo is empty" — the section
  // shows skeletons instead of asserting a fact it doesn't have.
  it("reports a repo whose worktrees have not landed as loading, not as empty", () => {
    const node = build({ worktrees: undefined });
    expect(node.loading).toBe(true);
    expect(node.worktreeCount).toBe(0);
  });

  it("reports an actually-empty repo as loaded, so its empty state is the truth", () => {
    expect(build({ worktrees: [] }).loading).toBe(false);
  });

  it("shortens the repo name for the header while keeping the full name as the row's id", () => {
    const node = build();
    expect(node.repo).toBe("acme/app");
    expect(node.label).toBe("app");
  });

  // The base checkout leads the section and is not a ticket, so it must never
  // pick up a task row even when a ticket happens to share its id.
  it("marks the default-branch checkout primary and leaves it ticket-less", () => {
    const node = build({
      base: worktree("master"),
      tasks: [task("master")],
    });
    expect(node.base?.primary).toBe(true);
    expect(node.base?.depth).toBe(0);
    expect(node.base?.task).toBeNull();
    expect(node.worktreeCount).toBe(0);
  });

  it("leaves `base` null for a repo with no local path, so the section can render without one", () => {
    expect(build({ base: null }).base).toBeNull();
  });

  it("attaches each worktree's Linear ticket and PRs by id", () => {
    const node = build({
      worktrees: [worktree("AK-1")],
      tasks: [task("AK-1"), task("AK-2")],
      prs: [
        { issueId: "AK-1", repo: "acme/app", number: 7, url: "u", state: "Open" } as WorktreePr,
        { issueId: "AK-2", repo: "acme/app", number: 8, url: "u", state: "Open" } as WorktreePr,
      ],
    });
    const row = firstRow(node);
    expect(row?.task?.id).toBe("AK-1");
    expect(row?.prs.map((pr) => pr.number)).toEqual([7]);
  });

  it("hangs the repo's own agents on their worktree and summarizes them as the row's dot", () => {
    const agents = groupAgentsByWorktree(
      [entry({ sessionId: "s1", bucket: "idle" }), entry({ sessionId: "s2", bucket: "attention" })],
      noSeen,
      NOW,
    );
    const node = build({ worktrees: [worktree("AK-1")], agentsByWorktree: agents });
    const row = firstRow(node);
    expect(row?.agents).toHaveLength(2);
    expect(row?.attention.level).toBe("needs-you");
  });

  it("rolls the section header's dot up from every row beneath it, base included", () => {
    const agents = groupAgentsByWorktree(
      [entry({ sessionId: "s1", bucket: "attention" })],
      noSeen,
      NOW,
    );
    expect(build({ worktrees: [worktree("AK-1")], agentsByWorktree: agents }).attention.level).toBe(
      "needs-you",
    );
    const onBase = groupAgentsByWorktree(
      [entry({ sessionId: "s1", bucket: "working", ticket: "master" })],
      noSeen,
      NOW,
    );
    expect(build({ base: worktree("master"), agentsByWorktree: onBase }).attention.level).toBe(
      "working",
    );
  });

  it("leaves a repo with nothing running at idle", () => {
    expect(build({ worktrees: [worktree("AK-1")] }).attention.level).toBe("idle");
  });

  // Attention is what makes the sidebar worth having, so it outranks the label
  // ordering rather than the other way around.
  it("sorts a worktree that needs you above one that is merely running", () => {
    const agents = groupAgentsByWorktree(
      [
        entry({ sessionId: "s1", bucket: "working", ticket: "AK-1", termKey: "tree:AK-1" }),
        entry({ sessionId: "s2", bucket: "attention", ticket: "AK-2", termKey: "tree:AK-2" }),
      ],
      noSeen,
      NOW,
    );
    const node = build({
      worktrees: [worktree("AK-1"), worktree("AK-2")],
      agentsByWorktree: agents,
    });
    expect(bands(node)).toEqual([
      [
        ["AK-2", 0],
        ["AK-1", 0],
      ],
    ]);
  });

  // Otherwise an all-idle repo would reshuffle every time a timestamp arrived.
  it("falls back to the title so an all-idle repo keeps a fixed order", () => {
    const node = build({
      worktrees: [worktree("AK-2", { title: "Zeta" }), worktree("AK-1", { title: "Alpha" })],
    });
    expect(bands(node)).toEqual([
      [
        ["AK-1", 0],
        ["AK-2", 0],
      ],
    ]);
  });

  it("nests a stacked worktree under the one it branched off", () => {
    const parent = worktree("AK-1");
    const child = worktree("AK-2", { baseBranch: parent.branch });
    expect(bands(build({ worktrees: [child, parent] }))).toEqual([
      [
        ["AK-1", 0],
        ["AK-2", 1],
      ],
    ]);
  });

  // A branch relationship must not drag a row across its planning boundary, so
  // the stacking runs inside a milestone band and never across two.
  it("keeps stacking inside a milestone band rather than pulling a child across one", () => {
    const parent = worktree("AK-1");
    const child = worktree("AK-2", { baseBranch: parent.branch });
    const node = build({
      worktrees: [parent, child],
      tasks: [task("AK-1", { projectMilestone: milestone("m1", "M1", 1) }), task("AK-2")],
    });
    expect(node.linearProjects[0]?.milestones.map((m) => m.label)).toEqual(["M1", "No milestone"]);
    expect(bands(node)).toEqual([[["AK-1", 0]], [["AK-2", 0]]]);
  });

  // One nameless band is just "this repo's worktrees" — a heading over it would
  // say nothing, so the sidebar drops it.
  it("hides the milestone headings when there is only the nameless band", () => {
    expect(build({ worktrees: [worktree("AK-1")] }).linearProjects[0]?.showMilestones).toBe(false);
  });

  it("shows the milestone headings as soon as a real milestone is one of the bands", () => {
    const node = build({
      worktrees: [worktree("AK-1")],
      tasks: [
        task("AK-1", {
          projectMilestone: { id: "m1", name: "M1", targetDate: "2026-01-01", sortOrder: 1 },
        }),
      ],
    });
    const band = node.linearProjects[0];
    expect(band?.showMilestones).toBe(true);
    expect(band?.milestones[0]?.targetDate).toBe("2026-01-01");
  });
});

/**
 * The `linear_group_by` setting picks which levels of Linear's planning
 * structure the tree nests by. Every mode builds both levels — an ungrouped one
 * collapses into a single band whose heading is suppressed — so the sidebar has
 * one tree shape to render and a row has exactly one home in all four.
 */
describe("buildProjectNode grouping modes", () => {
  /** Two projects, three milestones, one ticket-less worktree. The fixture every
   *  mode is asked about, so the four answers are comparable. */
  const fixture = {
    worktrees: [
      worktree("AK-1"),
      worktree("AK-2"),
      worktree("AK-3"),
      // No ticket *and* no project recorded on the worktree — the fixture used to
      // inherit the helper's default project here, which quietly contradicted the
      // "no project to read" premise these cases are built on.
      worktree("AK-4", { project: null }),
    ],
    tasks: [
      task("AK-1", { project: "Core", projectMilestone: milestone("m1", "M1", 1) }),
      task("AK-2", { project: "Core", projectMilestone: milestone("m2", "M2", 2) }),
      task("AK-3", { project: "Infra" }),
      // AK-4 has no ticket at all.
    ],
  };

  /** A project's colour is the project's, not the ticket's — so a worktree whose
   *  own ticket has aged out of the active set still gets its band coloured from
   *  any live ticket in the same project. Grey only when nothing knows it. */
  it("borrows the project colour from another ticket in the same project", () => {
    const node = build({
      worktrees: [
        worktree("AK-1"),
        worktree("AK-333", { project: "KB Dupes" }),
        worktree("AK-9", { project: "Nobody Knows" }),
      ],
      tasks: [task("AK-1", { project: "KB Dupes", projectColor: "#e2c08d" })],
      groupBy: "project",
    });
    const bands = new Map(node.linearProjects.map((p) => [p.label, p.color]));
    // AK-333 resolves no ticket of its own, but AK-1's does the naming.
    expect(bands.get("KB Dupes")).toBe("#e2c08d");
    expect(bands.get("Nobody Knows")).toBe(PROJECT_FALLBACK);
  });

  /** The reported bug: a repo whose Linear org isn't connected resolves no
   *  tickets at all, so every worktree in it fell into the one unnamed band —
   *  while the project name sat on the worktree row the whole time. */
  it("groups by the worktree's own project when no ticket resolves", () => {
    const node = build({
      worktrees: [
        worktree("AK-198", { project: "Observability" }),
        worktree("AK-333", { project: "Dupes" }),
      ],
      tasks: [],
      groupBy: "project",
    });
    expect(node.linearProjects.map((p) => p.label)).toEqual(["Observability", "Dupes"]);
    expect(node.showProjects).toBe(true);
  });

  it("nests nothing under `none` — one suppressed band holding every row", () => {
    const node = build({ ...fixture, groupBy: "none" });
    expect(node.showProjects).toBe(false);
    expect(node.linearProjects[0]?.showMilestones).toBe(false);
    expect(shape(node)).toEqual([
      ["No Project", [["No milestone", ["AK-1", "AK-2", "AK-3", "AK-4"]]]],
    ]);
  });

  it("groups by project alone under `project`, leaving the milestones flat", () => {
    const node = build({ ...fixture, groupBy: "project" });
    expect(node.showProjects).toBe(true);
    expect(node.linearProjects.every((p) => p.showMilestones)).toBe(false);
    expect(shape(node)).toEqual([
      ["Core", [["No milestone", ["AK-1", "AK-2"]]]],
      ["Infra", [["No milestone", ["AK-3"]]]],
      ["No Project", [["No milestone", ["AK-4"]]]],
    ]);
  });

  // The default, and the shape the tree had before this setting existed: one
  // implicit project band whose heading is suppressed, milestones inside it.
  it("reproduces today's milestone-only tree under `milestone`", () => {
    const node = build({ ...fixture, groupBy: "milestone" });
    expect(node.showProjects).toBe(false);
    expect(node.linearProjects).toHaveLength(1);
    expect(node.linearProjects[0]?.showMilestones).toBe(true);
    expect(shape(node)).toEqual([
      [
        "No Project",
        [
          ["M1", ["AK-1"]],
          ["M2", ["AK-2"]],
          ["No milestone", ["AK-3", "AK-4"]],
        ],
      ],
    ]);
  });

  it("nests milestones inside their project under `project_milestone`", () => {
    const node = build({ ...fixture, groupBy: "project_milestone" });
    expect(node.showProjects).toBe(true);
    expect(shape(node)).toEqual([
      [
        "Core",
        [
          ["M1", ["AK-1"]],
          ["M2", ["AK-2"]],
        ],
      ],
      ["Infra", [["No milestone", ["AK-3"]]]],
      ["No Project", [["No milestone", ["AK-4"]]]],
    ]);
  });

  // A heading that suppresses itself must not take its rows with it: the answer
  // is per band, so a project split across milestones keeps its headings while
  // the project beside it, which has none, renders a flat list.
  it("decides the milestone headings per project, not per repo", () => {
    const node = build({ ...fixture, groupBy: "project_milestone" });
    expect(node.linearProjects.map((p) => [p.label, p.showMilestones])).toEqual([
      ["Core", true],
      ["Infra", false],
      ["No Project", false],
    ]);
  });

  // The band exists so that work Linear has not filed anywhere is still
  // reachable — mirroring the trailing "No milestone" band.
  it("keeps a project-less row in one trailing band rather than dropping it", () => {
    const node = build({
      worktrees: [worktree("AK-1"), worktree("AK-2", { project: null })],
      tasks: [task("AK-1", { project: "Core" })],
      groupBy: "project",
    });
    expect(node.linearProjects.map((p) => p.label)).toEqual(["Core", "No Project"]);
    expect(node.linearProjects[1]?.milestones[0]?.worktrees[0]?.worktree.id).toBe("AK-2");
  });

  // The backend already names a project-less issue "No Project", so a ticket
  // that says so and a worktree with no ticket at all mean the same thing and
  // must not open two bands that read identically.
  it("files a ticket-less row and a project-less ticket in the same band", () => {
    const node = build({
      worktrees: [worktree("AK-1"), worktree("AK-2", { project: null })],
      tasks: [task("AK-1", { project: "No Project" })],
      groupBy: "project",
    });
    expect(shape(node)).toEqual([["No Project", [["No milestone", ["AK-1", "AK-2"]]]]]);
  });

  it("never renders one worktree in two bands, whichever mode is on", () => {
    for (const groupBy of ["none", "project", "milestone", "project_milestone"] as const) {
      const ids = rendered(build({ ...fixture, groupBy }));
      expect(ids).toHaveLength(4);
      expect(new Set(ids).size).toBe(4);
    }
  });

  // Unlike a milestone, whose name and target date say something the repo header
  // doesn't, a lone project heading only restates the section it sits in.
  it("suppresses a lone project heading even when the project has a name", () => {
    const node = build({
      worktrees: [worktree("AK-1")],
      tasks: [task("AK-1", { project: "Core" })],
      groupBy: "project",
    });
    expect(node.linearProjects.map((p) => p.label)).toEqual(["Core"]);
    expect(node.showProjects).toBe(false);
  });

  it("carries the project's own color, icon and target date onto its band", () => {
    const node = build({
      worktrees: [worktree("AK-1"), worktree("AK-2")],
      tasks: [
        task("AK-1", {
          project: "Core",
          projectColor: "#ff0000",
          projectIcon: "\u{1F680}",
          projectTargetDate: "2026-03-01",
        }),
        task("AK-2", { project: "Infra" }),
      ],
      groupBy: "project",
    });
    const core = node.linearProjects[0];
    expect(core?.color).toBe("#ff0000");
    expect(core?.icon).toBe("\u{1F680}");
    expect(core?.targetDate).toBe("2026-03-01");
    expect(core?.worktreeCount).toBe(1);
    // A project Linear gave no color falls back to the shared token, never to a
    // hardcoded hex in the component.
    expect(node.linearProjects[1]?.color).toBe(PROJECT_FALLBACK);
  });

  // Attention decides the order of the rows; grouping only decides the nesting.
  // A band therefore leads because it holds the most urgent row, not because of
  // any second ranking of its own.
  it("orders the project bands by the attention of the rows inside them", () => {
    const agents = groupAgentsByWorktree(
      [
        entry({ sessionId: "s1", bucket: "working", ticket: "AK-1", termKey: "tree:AK-1" }),
        entry({ sessionId: "s2", bucket: "attention", ticket: "AK-2", termKey: "tree:AK-2" }),
      ],
      noSeen,
      NOW,
    );
    const node = build({
      worktrees: [worktree("AK-1"), worktree("AK-2")],
      tasks: [task("AK-1", { project: "Core" }), task("AK-2", { project: "Infra" })],
      agentsByWorktree: agents,
      groupBy: "project",
    });
    expect(node.linearProjects.map((p) => p.label)).toEqual(["Infra", "Core"]);
  });

  // Stacking is scoped to a band, so turning grouping off lets a child sit under
  // a parent the milestone boundary used to separate it from.
  it("stacks across a milestone boundary once the grouping stops drawing one", () => {
    const parent = worktree("AK-1");
    const child = worktree("AK-2", { baseBranch: parent.branch });
    const tasks = [
      task("AK-1", { projectMilestone: milestone("m1", "M1", 1) }),
      task("AK-2", { projectMilestone: milestone("m2", "M2", 2) }),
    ];
    expect(bands(build({ worktrees: [parent, child], tasks, groupBy: "milestone" }))).toEqual([
      [["AK-1", 0]],
      [["AK-2", 0]],
    ]);
    expect(bands(build({ worktrees: [parent, child], tasks, groupBy: "none" }))).toEqual([
      [
        ["AK-1", 0],
        ["AK-2", 1],
      ],
    ]);
  });
});
