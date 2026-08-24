import { describe, expect, it } from "vitest";

import { composeDraftBody, splitDraftBody } from "./draftBody";

describe("draft bodies", () => {
  it("joins a comment and its suggestion the way GitHub reads them", () => {
    expect(composeDraftBody({ body: "  this leaks  ", suggestion: null })).toBe("this leaks");
    expect(composeDraftBody({ body: "this leaks", suggestion: "drop(guard);" })).toBe(
      "this leaks\n\n```suggestion\ndrop(guard);\n```",
    );
  });

  it("grows the fence past backticks inside the suggestion", () => {
    // Reviewing a Markdown file: a three-backtick fence would end the block early
    // and leak the rest of the suggestion into the comment as prose.
    const out = composeDraftBody({ body: "fix", suggestion: "```rust\nlet x = 1;\n```" });
    expect(out).toContain("````suggestion\n");
    expect(out.endsWith("\n````")).toBe(true);
  });

  it("round-trips through the editor without losing the split", () => {
    for (const draft of [
      { body: "this leaks", suggestion: "drop(guard);" },
      { body: "fix", suggestion: "```rust\nlet x = 1;\n```" },
      { body: "just prose", suggestion: null },
      { body: "", suggestion: "only a suggestion" },
    ]) {
      expect(splitDraftBody(composeDraftBody(draft))).toEqual({
        body: draft.body,
        suggestion: draft.suggestion,
      });
    }
  });

  it("leaves a mid-body block alone", () => {
    // The user is writing *about* a suggestion. Hoisting it would move their words.
    const text = "before\n\n```suggestion\nx\n```\n\nafter";
    expect(splitDraftBody(text)).toEqual({ body: text, suggestion: null });
  });
});
