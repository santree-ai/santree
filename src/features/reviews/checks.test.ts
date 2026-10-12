import { describe, expect, it } from "vitest";

import type { CheckStatus, PrCheck } from "../../bindings";
import { checkStatusMeta } from "../../theme/colors";
import { groupChecks, SKIPPED_KEY, tallyChecks, toggleCollapsed } from "./checks";

function check(name: string, status: CheckStatus): PrCheck {
  // A bare status context: no Actions run behind it, so no ids and no timings.
  return {
    name,
    status,
    description: null,
    url: null,
    steps: [],
    annotations: [],
    jobId: null,
    runId: null,
    startedAt: null,
    completedAt: null,
  };
}

describe("groupChecks", () => {
  it("orders the sections failed → running → passed → skipped", () => {
    const sections = groupChecks([
      check("lint", "Success"),
      check("skip", "Skipped"),
      check("build", "Failure"),
      check("e2e", "Pending"),
    ]);
    expect(sections.map((s) => s.key)).toEqual(["Failure", "Pending", "Success", SKIPPED_KEY]);
    expect(sections.map((s) => s.checks.map((c) => c.name))).toEqual([
      ["build"],
      ["e2e"],
      ["lint"],
      ["skip"],
    ]);
    // A running check is the one you're waiting on: its own flagged section,
    // above the finished ones, never the trailing catch-all.
    expect(sections.filter((s) => s.running).map((s) => s.label)).toEqual(["running"]);
    // Sections with no checks are omitted.
    expect(groupChecks([check("lint", "Success")]).map((s) => s.key)).toEqual(["Success"]);
  });

  it("folds neutral checks into the trailing skipped section, after the skipped ones", () => {
    const sections = groupChecks([
      check("cancelled", "Neutral"),
      check("unchanged", "Skipped"),
      check("lint", "Success"),
    ]);
    const trailing = sections[sections.length - 1];
    expect(trailing.key).toBe(SKIPPED_KEY);
    expect(trailing.checks.map((c) => c.name)).toEqual(["unchanged", "cancelled"]);
    expect(trailing.glyph).toBe(checkStatusMeta.Skipped.glyph);
  });

  it("keeps each section's checks in their original order", () => {
    const sections = groupChecks([
      check("b", "Failure"),
      check("a", "Failure"),
      check("c", "Failure"),
    ]);
    expect(sections[0].checks.map((c) => c.name)).toEqual(["b", "a", "c"]);
  });
});

describe("tallyChecks", () => {
  // "Waiting on CI" is a different answer from "CI had nothing to say" —
  // folding a queued run into `other` is what hid it from the summary line.
  it("counts each outcome, running on its own line", () => {
    expect(
      tallyChecks([
        check("a", "Success"),
        check("b", "Failure"),
        check("c", "Pending"),
        check("d", "Pending"),
        check("e", "Skipped"),
        check("f", "Neutral"),
      ]),
    ).toEqual({ passing: 1, failing: 1, running: 2, other: 2 });
  });

  it("agrees with groupChecks on every count", () => {
    const checks = [
      check("a", "Success"),
      check("b", "Pending"),
      check("c", "Neutral"),
      check("d", "Failure"),
    ];
    const tally = tallyChecks(checks);
    const sizeOf = (key: string) => groupChecks(checks).find((s) => s.key === key)?.checks.length;
    expect(sizeOf("Success")).toBe(tally.passing);
    expect(sizeOf("Failure")).toBe(tally.failing);
    expect(sizeOf("Pending")).toBe(tally.running);
    expect(sizeOf(SKIPPED_KEY)).toBe(tally.other);
  });
});

describe("toggleCollapsed", () => {
  const keys = ["Failure", "Success", SKIPPED_KEY];

  it("collapses an expanded section and expands a collapsed one", () => {
    const collapsed = toggleCollapsed(new Set([SKIPPED_KEY]), "Failure", keys, false);
    expect([...collapsed].sort()).toEqual(["Failure", SKIPPED_KEY]);
    expect([...toggleCollapsed(collapsed, SKIPPED_KEY, keys, false)]).toEqual(["Failure"]);
  });

  it("⌘-click sets every section to the clicked one's new state", () => {
    expect(toggleCollapsed(new Set([SKIPPED_KEY]), "Failure", keys, true)).toEqual(new Set(keys));
    expect(toggleCollapsed(new Set(keys), SKIPPED_KEY, keys, true)).toEqual(new Set());
  });

  it("does not mutate the set it is given", () => {
    const before = new Set([SKIPPED_KEY]);
    toggleCollapsed(before, "Failure", keys, false);
    expect(before).toEqual(new Set([SKIPPED_KEY]));
  });
});
