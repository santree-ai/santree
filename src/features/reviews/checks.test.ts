import { describe, expect, it } from "vitest";

import type { CheckStatus, PrCheck } from "../../bindings";
import { checkStatusMeta } from "../../theme/colors";
import { groupChecks, SKIPPED_KEY, toggleCollapsed } from "./checks";

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
  });

  it("omits sections with no checks", () => {
    expect(groupChecks([check("lint", "Success")]).map((s) => s.key)).toEqual(["Success"]);
    expect(groupChecks([])).toEqual([]);
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

describe("toggleCollapsed", () => {
  const keys = ["Failure", "Success", SKIPPED_KEY];

  it("collapses an expanded section and expands a collapsed one", () => {
    const collapsed = toggleCollapsed(new Set([SKIPPED_KEY]), "Failure", keys, false);
    expect([...collapsed].sort()).toEqual(["Failure", SKIPPED_KEY]);
    expect([...toggleCollapsed(collapsed, SKIPPED_KEY, keys, false)]).toEqual(["Failure"]);
  });

  it("⌘-click on an expanded section collapses every section", () => {
    expect(toggleCollapsed(new Set([SKIPPED_KEY]), "Failure", keys, true)).toEqual(new Set(keys));
  });

  it("⌘-click on a collapsed section expands every section", () => {
    expect(toggleCollapsed(new Set(keys), SKIPPED_KEY, keys, true)).toEqual(new Set());
  });

  it("does not mutate the set it is given", () => {
    const before = new Set([SKIPPED_KEY]);
    toggleCollapsed(before, "Failure", keys, false);
    expect(before).toEqual(new Set([SKIPPED_KEY]));
  });
});
