import { describe, expect, it } from "vitest";

import type { ProjectMilestoneRef, Task } from "../../bindings";
import { groupTasksForSidebar } from "./IssueSidebar";

const milestone = (id: string, sortOrder: number): ProjectMilestoneRef => ({
  id,
  name: id,
  sortOrder,
  targetDate: null,
});

function task(id: string, project: string, projectMilestone: ProjectMilestoneRef | null): Task {
  return {
    id,
    project,
    projectMilestone,
    actionable: true,
    title: id,
    priority: "None",
    estimate: null,
    projectColor: null,
    projectIcon: null,
    projectTargetDate: null,
    status: "Todo",
    ready: true,
    blockedBy: [],
    assignee: null,
    assigneeAvatarUrl: null,
    x: 0,
    y: 0,
  };
}

describe("groupTasksForSidebar", () => {
  it("keeps project and row order while sorting milestones inside each project", () => {
    const groups = groupTasksForSidebar([
      task("AK-3", "Second seen first", milestone("later", 2)),
      task("AK-1", "First seen second", null),
      task("AK-2", "Second seen first", milestone("sooner", 1)),
      task("AK-4", "Second seen first", milestone("later", 2)),
    ]);

    expect(groups.map((group) => group.project)).toEqual([
      "Second seen first",
      "First seen second",
    ]);
    expect(
      groups[0]?.milestones.map((group) => [group.key, group.items.map((item) => item.id)]),
    ).toEqual([
      ["sooner", ["AK-2"]],
      ["later", ["AK-3", "AK-4"]],
    ]);
  });

  it("omits non-actionable tasks without producing empty groups", () => {
    const hidden = { ...task("AK-2", "Hidden", null), actionable: false };
    expect(groupTasksForSidebar([task("AK-1", "Visible", null), hidden])).toHaveLength(1);
  });
});
