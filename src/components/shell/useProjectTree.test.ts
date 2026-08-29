import { describe, expect, it } from "vitest";

import type { Task, Worktree, WorktreePr } from "../../bindings";
import type { AgentBucket, AgentEntry, AgentOriginKind } from "../../features/agents/registry";
import type { SeenMap } from "../../lib/attention";
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

/** The fold's own inputs, so a test only has to name what it is about. */
function build(over: Partial<Parameters<typeof buildProjectNode>[0]> = {}) {
  return buildProjectNode({
    repo: "acme/app",
    worktrees: [],
    base: null,
    tasks: [],
    prs: [],
    agentsByWorktree: new Map(),
    ...over,
  });
}

/** `[id, depth]` per milestone band — the shape the sidebar actually renders. */
const bands = (node: ReturnType<typeof build>) =>
  node.milestones.map((m) => m.worktrees.map((w) => [w.worktree.id, w.depth]));

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
    const row = node.milestones[0]?.worktrees[0];
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
    const row = node.milestones[0]?.worktrees[0];
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
    const milestone = { id: "m1", name: "M1", targetDate: null, sortOrder: 1 };
    const node = build({
      worktrees: [parent, child],
      tasks: [task("AK-1", { projectMilestone: milestone }), task("AK-2")],
    });
    expect(node.milestones.map((m) => m.label)).toEqual(["M1", "No milestone"]);
    expect(bands(node)).toEqual([[["AK-1", 0]], [["AK-2", 0]]]);
  });

  // One nameless band is just "this repo's worktrees" — a heading over it would
  // say nothing, so the sidebar drops it.
  it("hides the milestone headings when there is only the nameless band", () => {
    expect(build({ worktrees: [worktree("AK-1")] }).showMilestones).toBe(false);
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
    expect(node.showMilestones).toBe(true);
    expect(node.milestones[0]?.targetDate).toBe("2026-01-01");
  });
});
