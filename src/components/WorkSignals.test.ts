import { describe, expect, it } from "vitest";

import type { ProjectMilestoneRef } from "../bindings";
import { groupByMilestone } from "./WorkSignals";

const milestone = (id: string, name: string, sortOrder: number | null): ProjectMilestoneRef => ({
  id,
  name,
  sortOrder,
  targetDate: null,
});

describe("groupByMilestone", () => {
  it("uses Linear order, then name and id, with no milestone last", () => {
    const items = [
      { id: "unassigned", milestone: null },
      { id: "z", milestone: milestone("z", "Zulu", 1) },
      { id: "b", milestone: milestone("b", "Alpha", 1) },
      { id: "a", milestone: milestone("a", "Alpha", 1) },
      { id: "first", milestone: milestone("first", "First", 0) },
    ];

    expect(groupByMilestone(items, (item) => item.milestone).map((group) => group.key)).toEqual([
      "first",
      "a",
      "b",
      "z",
      "No milestone",
    ]);
  });

  it("preserves row order inside each non-empty milestone", () => {
    const release = milestone("release", "Release", 0);
    const groups = groupByMilestone(
      [
        { id: "AK-3", milestone: release },
        { id: "AK-1", milestone: null },
        { id: "AK-2", milestone: release },
      ],
      (item) => item.milestone,
    );

    expect(groups.map((group) => [group.label, group.items.map((item) => item.id)])).toEqual([
      ["Release", ["AK-3", "AK-2"]],
      ["No milestone", ["AK-1"]],
    ]);
  });
});
