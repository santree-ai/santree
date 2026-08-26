import { describe, expect, it } from "vitest";

import type { ProjectMilestoneRef, TicketRef, Worktree } from "../../bindings";
import { groupWorktreesForSidebar, stackWorktrees } from "./WorktreeSidebar";

/** Minimal fixture — only id/branch/baseBranch matter to the nesting. */
function worktree(id: string, baseBranch = "master", branch = `santree/${id.toLowerCase()}`) {
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
    path: `/tmp/${id}`,
    project: "Core",
    baseBranch,
    setupRan: true,
    pending: false,
  } as Worktree;
}

/** `[id, depth]` pairs — the shape the sidebar actually renders. */
const shape = (list: Worktree[]) =>
  stackWorktrees(list).map(({ worktree: w, depth }) => [w.id, depth]);

const milestone = (id: string, sortOrder: number): ProjectMilestoneRef => ({
  id,
  name: id,
  sortOrder,
  targetDate: null,
});

const ticket = (
  identifier: string,
  project: string,
  projectMilestone: ProjectMilestoneRef | null,
): TicketRef => ({
  identifier,
  title: identifier,
  priority: "None",
  project,
  projectColor: null,
  projectIcon: null,
  projectTargetDate: null,
  projectMilestone,
});

describe("stackWorktrees", () => {
  it("leaves worktrees cut from the default branch flat, in their original order", () => {
    expect(shape([worktree("AK-1"), worktree("AK-2")])).toEqual([
      ["AK-1", 0],
      ["AK-2", 0],
    ]);
  });

  // The AK-274 → AK-275 case: a worktree branched off a sibling nests under it.
  it("nests a stacked worktree under the one it branched off", () => {
    const parent = worktree("AK-274");
    const child = worktree("AK-275", parent.branch);
    expect(shape([parent, child])).toEqual([
      ["AK-274", 0],
      ["AK-275", 1],
    ]);
  });

  // Order in the incoming list is arbitrary (it's whatever the query returned), so
  // a child arriving before its parent must still end up underneath it.
  it("pulls a child up under its parent regardless of list order", () => {
    const parent = worktree("AK-274");
    const child = worktree("AK-275", parent.branch);
    expect(shape([child, worktree("AK-9"), parent])).toEqual([
      ["AK-9", 0],
      ["AK-274", 0],
      ["AK-275", 1],
    ]);
  });

  it("keeps siblings of one parent adjacent, in their original order", () => {
    const parent = worktree("AK-274");
    expect(
      shape([parent, worktree("AK-275", parent.branch), worktree("AK-276", parent.branch)]),
    ).toEqual([
      ["AK-274", 0],
      ["AK-275", 1],
      ["AK-276", 1],
    ]);
  });

  // A long chain keeps its nesting order but stops stepping in, so the cards at the
  // bottom don't get squeezed against the edge of the rail.
  it("caps the indent depth without reordering the chain", () => {
    const a = worktree("AK-1");
    const b = worktree("AK-2", a.branch);
    const c = worktree("AK-3", b.branch);
    const d = worktree("AK-4", c.branch);
    const e = worktree("AK-5", d.branch);
    expect(shape([a, b, c, d, e])).toEqual([
      ["AK-1", 0],
      ["AK-2", 1],
      ["AK-3", 2],
      ["AK-4", 3],
      ["AK-5", 3],
    ]);
  });

  // Nesting is computed per project group, so a parent in another band is simply
  // absent here — the child renders flat rather than being dragged out of its group.
  it("renders a child flat when its parent isn't in the same group", () => {
    expect(shape([worktree("AK-275", "santree/ak-274-elsewhere")])).toEqual([["AK-275", 0]]);
  });

  // Optimistic placeholders have no branch yet — an empty key would otherwise make
  // every pending worktree the parent of the next.
  it("doesn't nest pending placeholders under each other", () => {
    const a = { ...worktree("AK-1"), branch: "", baseBranch: "", pending: true } as Worktree;
    const b = { ...worktree("AK-2"), branch: "", baseBranch: "", pending: true } as Worktree;
    expect(shape([a, b])).toEqual([
      ["AK-1", 0],
      ["AK-2", 0],
    ]);
  });

  // A stacked launch knows its base the moment it starts, so the placeholder nests
  // straight away. Waiting for the create to finish showed a sub-task as a root —
  // at the top of the group, no less — for the seconds the git worktree takes.
  it("nests a pending placeholder under its parent as soon as it launches", () => {
    const parent = worktree("AK-275");
    const pending = {
      ...worktree("AK-277"),
      branch: "",
      baseBranch: parent.branch,
      pending: true,
    } as Worktree;
    // Placeholders are merged ahead of the real worktrees (see `mergeWorktrees`), so
    // the child arrives first in the list and still has to end up under its parent.
    expect(shape([pending, parent])).toEqual([
      ["AK-275", 0],
      ["AK-277", 1],
    ]);
  });

  // Can't happen through the app (a base always exists before the branch that uses
  // it), but a cycle must not recurse forever or silently drop rows from the rail.
  it("still renders every worktree if the bases somehow form a cycle", () => {
    const a = worktree("AK-1", "santree/ak-2");
    const b = worktree("AK-2", "santree/ak-1");
    const out = shape([a, b]);
    expect(out).toHaveLength(2);
    expect(out.map(([id]) => id).sort()).toEqual(["AK-1", "AK-2"]);
  });
});

describe("groupWorktreesForSidebar", () => {
  it("uses a resolved ticket project and the stored fallback for unresolved worktrees", () => {
    const resolved = worktree("AK-1");
    const pending = { ...worktree("AK-2"), project: "Stored", pending: true } as Worktree;
    const tickets = new Map([[resolved.id, ticket(resolved.id, "Live Linear", null)]]);

    expect(
      groupWorktreesForSidebar([resolved, pending], tickets).map((group) => group.project),
    ).toEqual(["Live Linear", "Stored"]);
  });

  it("sorts milestones but preserves row order and never stacks across milestones", () => {
    const parent = worktree("AK-1");
    const child = worktree("AK-2", parent.branch);
    const sibling = worktree("AK-3");
    const tickets = new Map([
      [parent.id, ticket(parent.id, "Core", milestone("later", 2))],
      [child.id, ticket(child.id, "Core", milestone("sooner", 1))],
      [sibling.id, ticket(sibling.id, "Core", milestone("later", 2))],
    ]);

    const groups = groupWorktreesForSidebar([parent, child, sibling], tickets);
    expect(
      groups[0]?.milestones.map((group) => [
        group.key,
        group.items.map(({ worktree: item, depth }) => [item.id, depth]),
      ]),
    ).toEqual([
      ["sooner", [["AK-2", 0]]],
      [
        "later",
        [
          ["AK-1", 0],
          ["AK-3", 0],
        ],
      ],
    ]);
  });
});
