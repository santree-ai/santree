import { describe, expect, it } from "vitest";

import type { TriageTicket } from "../../bindings";
import { manualRankAt, moveTicket, parseTriageOrder, triageLanes } from "./order";

function ticket(id: string, overrides: Partial<TriageTicket> = {}): TriageTicket {
  return {
    id,
    title: id,
    priority: "None",
    estimate: null,
    project: null,
    projectColor: null,
    projectIcon: null,
    projectTargetDate: null,
    dueDate: null,
    sortOrder: null,
    createdAtMs: 1,
    meta: "unassigned",
    team: "SAN",
    slaBreachMs: null,
    snoozedUntilMs: null,
    mine: true,
    ...overrides,
  };
}

describe("triage ordering", () => {
  it("defaults unknown stored values to attention", () => {
    expect(parseTriageOrder("mystery")).toBe("attention");
    expect(parseTriageOrder(null)).toBe("attention");
  });

  it("keeps investigations and snoozed issues outside the sorted queue", () => {
    const lanes = triageLanes(
      [
        ticket("queue-later", { dueDate: "2026-09-02" }),
        ticket("snoozed", { snoozedUntilMs: 20 }),
        ticket("running", { dueDate: "2026-10-01" }),
        ticket("queue-first", { dueDate: "2026-09-01" }),
      ],
      "due-date",
      (candidate) => (candidate.id === "running" ? 0 : 2),
    );

    expect(lanes.investigations.map(({ id }) => id)).toEqual(["running"]);
    expect(lanes.queue.map(({ id }) => id)).toEqual(["queue-first", "queue-later"]);
    expect(lanes.snoozed.map(({ id }) => id)).toEqual(["snoozed"]);
  });

  it("orders attention by SLA, due date, priority, then age", () => {
    const lanes = triageLanes(
      [
        ticket("low", { priority: "Low", createdAtMs: 1 }),
        ticket("urgent", { priority: "Urgent", createdAtMs: 2 }),
        ticket("due", { dueDate: "2026-08-26" }),
        ticket("sla", { slaBreachMs: 3 }),
      ],
      "attention",
      () => 2,
    );
    expect(lanes.queue.map(({ id }) => id)).toEqual(["sla", "due", "urgent", "low"]);
  });

  it("moves a ticket and calculates a rank between its new neighbors", () => {
    const reordered = moveTicket(
      [
        ticket("a", { sortOrder: 0 }),
        ticket("b", { sortOrder: 100 }),
        ticket("c", { sortOrder: 200 }),
      ],
      "c",
      "b",
    );
    expect(reordered.map(({ id }) => id)).toEqual(["a", "c", "b"]);
    expect(manualRankAt(reordered, 1)).toBe(50);
  });

  it("leaves room when moving to either edge", () => {
    const items = [ticket("a", { sortOrder: 100 }), ticket("b", { sortOrder: 200 })];
    expect(manualRankAt(items, 0)).toBe(-824);
    expect(manualRankAt(items, 1)).toBe(1124);
  });

  it("fails closed when Linear did not supply neighboring manual ranks", () => {
    expect(manualRankAt([ticket("a"), ticket("b")], 0)).toBeNull();
  });
});
