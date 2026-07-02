import { describe, expect, it } from "vitest";

import type { Task } from "../../bindings";
import { layoutGraph, NODE_H, NODE_W } from "./layout";

/** Minimal Task fixture — only the fields layoutGraph reads vary across cases. */
function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "AK-1",
    title: "Task AK-1",
    project: "Core",
    projectColor: null,
    projectIcon: null,
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
    const { pos, boxes } = layoutGraph([]);
    expect(pos.size).toBe(0);
    expect(boxes).toEqual([]);
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
  });
});
