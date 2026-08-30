import { describe, expect, it } from "vitest";

import type { TriageTicket } from "../../bindings";
import { triageTicket as ticket } from "../../test/fixtures";
import { manualRankAt, moveTicket, parseTriageOrder, type TriageOrder, triageLanes } from "./order";

/** Everything lands in the queue lane, so the assertion is about the order alone. */
function queue(order: TriageOrder, tickets: TriageTicket[]) {
  return triageLanes(tickets, order, () => 2).queue.map(({ id }) => id);
}

describe("triage ordering", () => {
  it("defaults unknown stored values to attention", () => {
    expect(parseTriageOrder("mystery")).toBe("attention");
    expect(parseTriageOrder(null)).toBe("attention");
  });

  it("keeps investigations and snoozed issues outside the sorted queue", () => {
    const lanes = triageLanes(
      [
        ticket("queue-later", 1, { dueDate: "2026-09-02" }),
        ticket("snoozed", 2, { snoozedUntilMs: 20 }),
        ticket("running", 3, { dueDate: "2026-10-01" }),
        ticket("queue-first", 4, { dueDate: "2026-09-01" }),
      ],
      "due-date",
      (candidate) => (candidate.id === "running" ? 0 : 2),
    );

    expect(lanes.investigations.map(({ id }) => id)).toEqual(["running"]);
    expect(lanes.queue.map(({ id }) => id)).toEqual(["queue-first", "queue-later"]);
    expect(lanes.snoozed.map(({ id }) => id)).toEqual(["snoozed"]);
  });

  it("orders attention by SLA, due date, priority, then age", () => {
    expect(
      queue("attention", [
        ticket("none-new", 4),
        ticket("low", 1, { priority: "Low" }),
        ticket("sla-late", 6, { slaBreachMs: 500 }),
        ticket("due", 8, { dueDate: "2026-08-26" }),
        ticket("none-old", 3),
        ticket("urgent", 2, { priority: "Urgent" }),
        ticket("sla-soon", 7, { slaBreachMs: 100 }),
      ]),
    ).toEqual(["sla-soon", "sla-late", "due", "urgent", "low", "none-old", "none-new"]);
  });

  it("orders by due date first, then priority, then age", () => {
    expect(
      queue("due-date", [
        ticket("undated-new", 2),
        ticket("due-late", 4, { dueDate: "2026-09-05" }),
        ticket("undated-old", 1),
        ticket("due-early", 5, { dueDate: "2026-09-01" }),
        ticket("undated-urgent", 3, { priority: "Urgent" }),
      ]),
    ).toEqual(["due-early", "due-late", "undated-urgent", "undated-old", "undated-new"]);
  });

  it("orders by priority first, then due date, then age", () => {
    expect(
      queue("priority", [
        ticket("none-new", 2),
        ticket("high-late", 3, { priority: "High", dueDate: "2026-09-05" }),
        ticket("urgent", 5, { priority: "Urgent" }),
        ticket("none-old", 1),
        ticket("high-early", 4, { priority: "High", dueDate: "2026-09-01" }),
      ]),
    ).toEqual(["urgent", "high-early", "high-late", "none-old", "none-new"]);
  });

  it("orders created-oldest by age alone, ignoring priority and due date", () => {
    expect(
      queue("created-oldest", [
        ticket("same-age-b", 3),
        ticket("young-urgent", 9, { priority: "Urgent", dueDate: "2026-01-01" }),
        ticket("same-age-a", 3),
        ticket("oldest", 1),
      ]),
    ).toEqual(["oldest", "same-age-a", "same-age-b", "young-urgent"]);
  });

  it("orders created-newest by age descending, with ids still ascending on a tie", () => {
    expect(
      queue("created-newest", [
        ticket("same-age-b", 3),
        ticket("young-urgent", 9, { priority: "Urgent", dueDate: "2026-01-01" }),
        ticket("same-age-a", 3),
        ticket("oldest", 1),
      ]),
    ).toEqual(["young-urgent", "same-age-a", "same-age-b", "oldest"]);
  });

  it("orders manual by Linear's rank, sinking unranked issues to the bottom by age", () => {
    expect(
      queue("manual", [
        ticket("unranked-new", 2),
        ticket("ranked-late", 4, { sortOrder: 200 }),
        ticket("unranked-old", 1),
        ticket("ranked-early", 5, { sortOrder: 100 }),
      ]),
    ).toEqual(["ranked-early", "ranked-late", "unranked-old", "unranked-new"]);
  });

  it("moves a ticket and calculates a rank between its new neighbors", () => {
    const reordered = moveTicket(
      [
        ticket("a", 1, { sortOrder: 0 }),
        ticket("b", 2, { sortOrder: 100 }),
        ticket("c", 3, { sortOrder: 200 }),
      ],
      "c",
      "b",
    );
    expect(reordered.map(({ id }) => id)).toEqual(["a", "c", "b"]);
    expect(manualRankAt(reordered, 1)).toBe(50);
  });

  it("leaves room when moving to either edge", () => {
    const items = [ticket("a", 1, { sortOrder: 100 }), ticket("b", 2, { sortOrder: 200 })];
    expect(manualRankAt(items, 0)).toBe(-824);
    expect(manualRankAt(items, 1)).toBe(1124);
  });

  it("fails closed when Linear did not supply neighboring manual ranks", () => {
    expect(manualRankAt([ticket("a", 1), ticket("b", 2)], 0)).toBeNull();
  });
});
