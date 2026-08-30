import { describe, expect, it } from "vitest";

import type { ProjectMilestoneRef } from "../bindings";
import { groupByMilestone, groupByProject, showProjectGroups } from "./WorkSignals";

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

  it("carries the project's color, icon and target date onto its group", () => {
    const [group] = groupByProject([{ id: "AK-1" }], () => ({
      name: "Core",
      color: "#abc123",
      icon: "\u{1F680}",
      targetDate: "2026-03-01",
    }));
    expect([group.color, group.icon, group.targetDate]).toEqual([
      "#abc123",
      "\u{1F680}",
      "2026-03-01",
    ]);
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
