import { describe, expect, it } from "vitest";

import { modelMeta, modelVersion } from "./colors";

describe("model labels", () => {
  it("folds versions into one family key but keeps a distinct version label", () => {
    // The chart draws one bar per family; hover names the exact version.
    expect(modelMeta("claude-opus-4-8").key).toBe("opus");
    expect(modelMeta("claude-opus-4-7").key).toBe("opus");
    expect(modelMeta("claude-sonnet-5").key).toBe("sonnet");
    expect(modelMeta("claude-fable-5").label).toBe("Fable");
    expect(modelVersion("claude-opus-4-8")).toBe("Opus 4.8");
    expect(modelVersion("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelVersion("claude-fable-5")).toBe("Fable 5");
    expect(modelVersion("gpt-5")).toBe("gpt-5"); // unknown family → raw id
  });
});
