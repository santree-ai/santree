import { describe, expect, it } from "vitest";

import type { TaskStatus } from "../bindings";
import { agentLabel, agentSlug, modelMeta, modelVersion, statusColor, statusLabel } from "./colors";

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

  it("groups model versions by family and labels the family", () => {
    // Every Opus/Sonnet version shares a family key (so the chart folds them into
    // one bar) but each keeps a distinct version label for hover.
    expect(modelMeta("claude-opus-4-8").key).toBe("opus");
    expect(modelMeta("claude-opus-4-7").key).toBe("opus");
    expect(modelMeta("claude-sonnet-5").key).toBe("sonnet");
    expect(modelMeta("claude-fable-5").label).toBe("Fable");
  });

  it("renders a specific version label for hover", () => {
    expect(modelVersion("claude-opus-4-8")).toBe("Opus 4.8");
    expect(modelVersion("claude-sonnet-4-6")).toBe("Sonnet 4.6");
    expect(modelVersion("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelVersion("claude-fable-5")).toBe("Fable 5");
    expect(modelVersion("gpt-5")).toBe("gpt-5"); // unknown family → raw id
  });
});
