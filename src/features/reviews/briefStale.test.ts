import { describe, expect, it } from "vitest";

import type { ReviewBrief } from "../../bindings";
import { reviewBriefStale } from "./briefStale";

function brief(over: Partial<ReviewBrief> = {}): ReviewBrief {
  return {
    agentKind: "Codex",
    summary: "Adds the AI work pane.",
    readingOrder: [],
    watchOuts: [],
    questions: [],
    truncated: false,
    headSha: "head-2",
    generatedAtMs: 1_756_000_000_000,
    ...over,
  };
}

describe("reviewBriefStale", () => {
  it("is stale once the PR's head has moved past the brief", () => {
    expect(reviewBriefStale(brief({ headSha: "head-1" }), "head-2")).toBe(true);
  });

  it("is fresh while the heads agree", () => {
    expect(reviewBriefStale(brief(), "head-2")).toBe(false);
  });

  // Neither half is a claim on its own: no brief is "not reviewed", and a PR whose
  // head we haven't loaded is unknown. Amber on either would be an invented status.
  it("says nothing when there is no brief or no head to compare against", () => {
    expect(reviewBriefStale(null, "head-2")).toBe(false);
    expect(reviewBriefStale(brief(), undefined)).toBe(false);
  });
});
