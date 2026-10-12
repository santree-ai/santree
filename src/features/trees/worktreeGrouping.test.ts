import { describe, expect, it } from "vitest";

import type { Worktree } from "../../bindings";
import { stackWorktrees } from "./worktreeGrouping";

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

/** `[id, depth]` pairs — the shape the rows are actually rendered in. */
const shape = (list: Worktree[]) =>
  stackWorktrees(list).map(({ worktree: w, depth }) => [w.id, depth]);

describe("stackWorktrees", () => {
  // The AK-274 → AK-275 case: a worktree branched off a sibling nests under it,
  // siblings stay adjacent in their original order, and every level of a chain
  // keeps its own indentation. Worktrees cut from the default branch stay flat.
  it("nests stacked worktrees under the one they branched off, at every depth", () => {
    const a = worktree("AK-1");
    const b = worktree("AK-2", a.branch);
    const b2 = worktree("AK-3", a.branch);
    const c = worktree("AK-4", b.branch);
    expect(shape([a, b, b2, c, worktree("AK-9")])).toEqual([
      ["AK-1", 0],
      ["AK-2", 1],
      ["AK-4", 2],
      ["AK-3", 1],
      ["AK-9", 0],
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

  // Nesting is computed per group, so a parent in another band is simply absent
  // here — the child renders flat rather than being dragged out of its own group.
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
  // it), but a cycle must not recurse forever or silently drop rows from the list.
  it("still renders every worktree if the bases somehow form a cycle", () => {
    const a = worktree("AK-1", "santree/ak-2");
    const b = worktree("AK-2", "santree/ak-1");
    const out = shape([a, b]);
    expect(out).toHaveLength(2);
    expect(out.map(([id]) => id).sort()).toEqual(["AK-1", "AK-2"]);
  });
});
