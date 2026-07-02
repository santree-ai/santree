import { describe, expect, it } from "vitest";

import type { TaskStatus } from "../bindings";
import { agentLabel, agentSlug, statusColor, statusLabel } from "./colors";

describe("theme color/label maps", () => {
  it("maps every task status to a label and color", () => {
    // Iterate statusLabel's own keys (the canonical source of every TaskStatus
    // variant) rather than a hand-copied list, so a new variant is covered here
    // automatically instead of silently slipping through untested.
    for (const status of Object.keys(statusLabel) as TaskStatus[]) {
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
