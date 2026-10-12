import { describe, expect, it } from "vitest";

import type { ProjectMilestoneRef } from "../bindings";
import { changeSizeOf, groupByMilestone, groupByProject, showProjectGroups } from "./WorkSignals";

const milestone = (id: string, name: string, sortOrder: number | null): ProjectMilestoneRef => ({
  id,
  name,
  sortOrder,
  targetDate: null,
});

describe("groupByMilestone", () => {
  it("uses Linear order, then name and id, with no milestone last, keeping row order inside", () => {
    const items = [
      { id: "unassigned", milestone: null },
      { id: "z", milestone: milestone("z", "Zulu", 1) },
      { id: "b", milestone: milestone("b", "Alpha", 1) },
      { id: "a", milestone: milestone("a", "Alpha", 1) },
      { id: "first", milestone: milestone("first", "First", 0) },
      { id: "first-2", milestone: milestone("first", "First", 0) },
    ];

    const groups = groupByMilestone(items, (item) => item.milestone);
    expect(groups.map((group) => group.key)).toEqual(["first", "a", "b", "z", "No milestone"]);
    expect(groups[0].items.map((item) => item.id)).toEqual(["first", "first-2"]);
  });
});

const project = (name: string) => ({ name, color: null, icon: null, targetDate: null });

describe("groupByProject", () => {
  // Linear publishes no manual order for projects, so the caller's own ordering
  // (attention, in the sidebar) is what decides which band leads.
  it("keeps the order the first row of each project had, with no project last", () => {
    const items = [
      { id: "AK-1", project: null },
      { id: "AK-2", project: project("Infra") },
      { id: "AK-3", project: project("Core") },
      { id: "AK-4", project: project("Infra") },
    ];

    expect(
      groupByProject(items, (item) => item.project).map((g) => [g.key, g.items.map((i) => i.id)]),
    ).toEqual([
      ["Infra", ["AK-2", "AK-4"]],
      ["Core", ["AK-3"]],
      ["No Project", ["AK-1"]],
    ]);
  });

  // The backend names a project-less issue "No Project" itself, so a row with no
  // project at all belongs in that same band and not in a second one beside it.
  it("folds the backend's own project-less name into the trailing band", () => {
    const groups = groupByProject(
      [
        { id: "AK-1", project: project("No Project") },
        { id: "AK-2", project: null },
      ],
      (item) => item.project,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.id)).toEqual(["AK-1", "AK-2"]);
  });
});

describe("showProjectGroups", () => {
  // Stricter than the milestone rule on purpose: a lone project heading only
  // restates the section it sits inside, named or not.
  it("keeps the headings only once there are two bands to tell apart", () => {
    expect(showProjectGroups([])).toBe(false);
    expect(showProjectGroups([{ key: "Core" }])).toBe(false);
    expect(showProjectGroups([{ key: "No Project" }])).toBe(false);
    expect(showProjectGroups([{ key: "Core" }, { key: "No Project" }])).toBe(true);
  });
});

describe("changeSizeOf", () => {
  // Every file counts as reading (the same 300 lines across thirty files is
  // thirty context switches), and a deletion weighs a third of an addition
  // (checking removed code has no callers is quicker than reading new code).
  it("steps at 500 and 2,500 of weighted lines and files", () => {
    expect(changeSizeOf(479, 0, 1)).toBe("Small");
    expect(changeSizeOf(480, 0, 1)).toBe("Medium");
    expect(changeSizeOf(2479, 0, 1)).toBe("Medium");
    expect(changeSizeOf(2480, 0, 1)).toBe("Large");
    expect(changeSizeOf(300, 0, 30)).toBe("Medium");
    expect(changeSizeOf(0, 1200, 3)).toBe("Small");
    expect(changeSizeOf(1200, 0, 3)).toBe("Medium");
    expect(changeSizeOf(0, 1200, 3)).toBe("Small");
    expect(changeSizeOf(1200, 0, 3)).toBe("Medium");
  });
});
