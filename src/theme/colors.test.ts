import { describe, expect, it } from "vitest";

import { agentLabel, agentSlug, statusColor, statusLabel } from "./colors";

describe("theme color/label maps", () => {
  it("maps every task status to a label and color", () => {
    for (const status of ["InReview", "InProgress", "Todo", "Backlog"] as const) {
      expect(statusLabel[status]).toBeTruthy();
      expect(statusColor[status]).toMatch(/^#/);
    }
  });

  it("renders In Review with a space", () => {
    expect(statusLabel.InReview).toBe("In Review");
  });

  it("gives agents full labels and lower-case slugs", () => {
    expect(agentLabel("Claude")).toBe("Claude Code");
    expect(agentSlug("Codex")).toBe("codex");
    expect(agentSlug("Claude")).toBe("claude");
  });
});
