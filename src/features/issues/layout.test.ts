import { describe, expect, it } from "vitest";

import type { Task } from "../../bindings";
import { layoutGraph, NODE_H, NODE_W } from "./layout";

function milestone(id: string, sortOrder: number) {
  return { id, name: `Milestone ${id}`, targetDate: null, sortOrder };
}

/** Minimal Task fixture — only the fields layoutGraph reads vary across cases. */
function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "AK-1",
    title: "Task AK-1",
    priority: "None",
    estimate: null,
    project: "Core",
    projectColor: null,
    projectIcon: null,
    projectTargetDate: null,
    projectMilestone: null,
    parentId: null,
    status: "Todo",
    ready: true,
    blockedBy: [],
    actionable: true,
    assignee: null,
    assigneeAvatarUrl: null,
    x: 0,
    y: 0,
    ...overrides,
  };
}

/** A box's vertical span, for overlap checks. */
function vSpan(box: { y: number; height: number }): [number, number] {
  return [box.y, box.y + box.height];
}

describe("layoutGraph", () => {
  it("returns an empty layout for no tasks", () => {
    const { pos, boxes, milestoneBoxes } = layoutGraph([]);
    expect(pos.size).toBe(0);
    expect(boxes).toEqual([]);
    expect(milestoneBoxes).toEqual([]);
  });

  it("nests each task inside a non-overlapping milestone band", () => {
    const tasks = [
      task({ id: "A-1", project: "Alpha", projectMilestone: milestone("now", 0) }),
      task({
        id: "A-2",
        project: "Alpha",
        projectMilestone: milestone("now", 0),
        blockedBy: ["A-1"],
      }),
      task({ id: "A-3", project: "Alpha", projectMilestone: milestone("next", 1) }),
      task({ id: "A-4", project: "Alpha", projectMilestone: null }),
    ];
    const { pos, boxes, milestoneBoxes } = layoutGraph(tasks);

    expect(milestoneBoxes.map((box) => box.key)).toEqual(["now", "next", "No milestone"]);
    const projectBox = boxes[0];
    for (const box of milestoneBoxes) {
      expect(box.x).toBeGreaterThanOrEqual(projectBox.x);
      expect(box.y).toBeGreaterThanOrEqual(projectBox.y);
      expect(box.x + box.width).toBeLessThanOrEqual(projectBox.x + projectBox.width);
      expect(box.y + box.height).toBeLessThanOrEqual(projectBox.y + projectBox.height);
    }
    for (let index = 0; index < milestoneBoxes.length - 1; index++) {
      expect(milestoneBoxes[index + 1].y).toBeGreaterThan(
        milestoneBoxes[index].y + milestoneBoxes[index].height,
      );
    }
    for (const current of tasks) {
      const box = milestoneBoxes.find(
        (candidate) => candidate.key === (current.projectMilestone?.id ?? "No milestone"),
      );
      const point = pos.get(current.id);
      expect(box).toBeDefined();
      expect(point).toBeDefined();
      if (!box || !point) continue;
      expect(point.x).toBeGreaterThanOrEqual(box.x);
      expect(point.y).toBeGreaterThanOrEqual(box.y);
      expect(point.x + NODE_W).toBeLessThanOrEqual(box.x + box.width);
      expect(point.y + NODE_H).toBeLessThanOrEqual(box.y + box.height);
    }
  });

  it("keeps cross-milestone dependencies visible without merging their layouts", () => {
    const tasks = [
      task({ id: "A-1", projectMilestone: milestone("one", 0) }),
      task({ id: "A-2", projectMilestone: milestone("two", 1), blockedBy: ["A-1"] }),
    ];
    const { milestoneBoxes, pos } = layoutGraph(tasks);
    expect(milestoneBoxes.map((box) => box.key)).toEqual(["one", "two"]);
    expect(pos.get("A-1")?.y).toBeLessThan(pos.get("A-2")?.y ?? 0);
  });

  it("positions every node inside its own project band's bounding box", () => {
    const tasks = [
      task({ id: "A-1", project: "Alpha" }),
      task({ id: "A-2", project: "Alpha", blockedBy: ["A-1"] }),
      task({ id: "B-1", project: "Beta" }),
      task({ id: "B-2", project: "Beta", blockedBy: ["B-1"] }),
      task({ id: "B-3", project: "Beta", blockedBy: ["B-1"] }),
    ];
    const { pos, boxes } = layoutGraph(tasks);

    expect(boxes.map((b) => b.project)).toEqual(["Alpha", "Beta"]);
    expect(boxes.find((b) => b.project === "Alpha")?.count).toBe(2);
    expect(boxes.find((b) => b.project === "Beta")?.count).toBe(3);

    for (const t of tasks) {
      const box = boxes.find((b) => b.project === t.project);
      const p = pos.get(t.id);
      expect(box).toBeDefined();
      expect(p).toBeDefined();
      if (!box || !p) continue;
      // The node's full footprint (NODE_W x NODE_H from its top-left) must sit
      // entirely within its band's bounding box.
      expect(p.x).toBeGreaterThanOrEqual(box.x);
      expect(p.y).toBeGreaterThanOrEqual(box.y);
      expect(p.x + NODE_W).toBeLessThanOrEqual(box.x + box.width);
      expect(p.y + NODE_H).toBeLessThanOrEqual(box.y + box.height);
    }
  });

  it("omits a milestone band when every task in a project is unassigned", () => {
    const tasks = [task({ id: "A-1" }), task({ id: "A-2", blockedBy: ["A-1"] })];
    const { boxes, milestoneBoxes, pos } = layoutGraph(tasks);
    expect(boxes).toHaveLength(1);
    expect(milestoneBoxes).toEqual([]);
    expect(pos.get("A-1")?.x).toBeLessThan(pos.get("A-2")?.x ?? 0);
  });

  it("stacks project bands without vertical overlap", () => {
    const tasks = [
      task({ id: "A-1", project: "Alpha" }),
      task({ id: "A-2", project: "Alpha", blockedBy: ["A-1"] }),
      task({ id: "A-3", project: "Alpha", blockedBy: ["A-2"] }),
      task({ id: "B-1", project: "Beta" }),
      task({ id: "C-1", project: "Gamma" }),
      task({ id: "C-2", project: "Gamma", blockedBy: ["C-1"] }),
    ];
    const { boxes } = layoutGraph(tasks);
    expect(boxes).toHaveLength(3);

    for (let i = 0; i < boxes.length - 1; i++) {
      const [, end] = vSpan(boxes[i]);
      const [nextStart] = vSpan(boxes[i + 1]);
      expect(nextStart).toBeGreaterThan(end);
    }
  });

  it("orders a blocker strictly left of the task it blocks (rankdir LR)", () => {
    const tasks = [
      task({ id: "A-1", project: "Alpha" }),
      task({ id: "A-2", project: "Alpha", blockedBy: ["A-1"] }),
      task({ id: "A-3", project: "Alpha", blockedBy: ["A-2"] }),
    ];
    const { pos } = layoutGraph(tasks);
    const p1 = pos.get("A-1");
    const p2 = pos.get("A-2");
    const p3 = pos.get("A-3");
    expect(p1 && p2 && p3).toBeTruthy();
    if (!p1 || !p2 || !p3) return;
    expect(p1.x).toBeLessThan(p2.x);
    expect(p2.x).toBeLessThan(p3.x);
  });

  it("ignores a cross-project blocker for band membership (node stays in its own band)", () => {
    const tasks = [
      task({ id: "A-1", project: "Alpha" }),
      // Blocked by a task from a different project — must not be pulled into
      // Alpha's band or otherwise break layout of either band.
      task({ id: "B-1", project: "Beta", blockedBy: ["A-1"] }),
    ];
    const { pos, boxes } = layoutGraph(tasks);
    expect(boxes.map((b) => b.project)).toEqual(["Alpha", "Beta"]);
    expect(boxes.find((b) => b.project === "Alpha")?.count).toBe(1);
    expect(boxes.find((b) => b.project === "Beta")?.count).toBe(1);
    expect(pos.size).toBe(2);
  });

  it("is deterministic for the same input", () => {
    const tasks = [
      task({ id: "A-1", project: "Alpha" }),
      task({ id: "A-2", project: "Alpha", blockedBy: ["A-1"] }),
      task({ id: "B-1", project: "Beta" }),
      task({ id: "B-2", project: "Beta", blockedBy: ["B-1"] }),
    ];
    const first = layoutGraph(tasks);
    const second = layoutGraph(tasks);
    expect(Array.from(first.pos.entries())).toEqual(Array.from(second.pos.entries()));
    expect(first.boxes).toEqual(second.boxes);
    expect(first.milestoneBoxes).toEqual(second.milestoneBoxes);
  });
});
