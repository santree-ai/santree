import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CommentTarget } from "./commentTarget";
import { anchorLabel, InlineCommentBox } from "./InlineCommentBox";

const spies = vi.hoisted(() => ({ add: vi.fn(), queue: vi.fn() }));

vi.mock("../../lib/queries", () => ({
  useAddPrInlineComment: () => ({ mutate: spies.add, isPending: false }),
  useAddReviewWorkItem: () => ({ mutate: spies.queue, isPending: false }),
  useGithubViewerLogin: () => ({ data: "sam" }),
}));

// new side: 10 → "const a = 1;", 11 → "const b = 2;", 12 → "const c = 3;",
// 13 → "const d = 4;".
const PATCH = [
  "@@ -10,2 +10,4 @@",
  " const a = 1;",
  "+const b = 2;",
  "+const c = 3;",
  " const d = 4;",
].join("\n");

const TARGET: CommentTarget = {
  prRepo: "acme/api",
  number: 7,
  prId: "PR_1",
  headSha: "abc123",
  pendingReviewId: null,
};

const box = (line: number, startLine: number) =>
  render(
    <InlineCommentBox
      target={TARGET}
      path="src/retry.ts"
      patch={PATCH}
      line={line}
      startLine={startLine}
      onRight
      onClose={() => {}}
    />,
  );

describe("anchorLabel", () => {
  it("names a single line the way GitHub does", () => {
    expect(anchorLabel(null, 4, true)).toBe("line R4");
    expect(anchorLabel(null, 4, false)).toBe("line L4");
  });

  it("names a range by both ends", () => {
    expect(anchorLabel(10, 14, true)).toBe("lines R10 to R14");
  });

  it("treats a range that doesn't span as a single line", () => {
    expect(anchorLabel(4, 4, true)).toBe("line R4");
  });
});

describe("InlineCommentBox", () => {
  it("posts a single-line comment with no range", () => {
    const { getByText, getByPlaceholderText, container } = box(11, 11);
    expect(container.textContent).toContain("Add a comment on line R11");

    fireEvent.change(getByPlaceholderText("Leave a comment"), { target: { value: "nit" } });
    fireEvent.click(getByText("Comment"));

    // `startLine: null`, not `11` — GitHub rejects a range whose start isn't
    // strictly before its end.
    expect(spies.add).toHaveBeenCalledWith(
      expect.objectContaining({ line: 11, startLine: null, pending: false }),
      expect.anything(),
    );
  });

  it("carries both ends of a dragged range", () => {
    const { getByText, getByPlaceholderText, container } = box(12, 10);
    expect(container.textContent).toContain("Add a comment on lines R10 to R12");

    fireEvent.change(getByPlaceholderText("Leave a comment"), { target: { value: "all three" } });
    fireEvent.click(getByText("Start a review"));

    expect(spies.add).toHaveBeenCalledWith(
      expect.objectContaining({ line: 12, startLine: 10, pending: true }),
      expect.anything(),
    );
  });

  it("prefills a suggestion with exactly the lines commented on", () => {
    const { getByText, getByPlaceholderText } = box(12, 10);
    fireEvent.click(getByText("Suggestion"));

    expect((getByPlaceholderText("Leave a comment") as HTMLTextAreaElement).value).toBe(
      "```suggestion\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```\n",
    );
  });

  it("offers no suggestion when the patch is missing a line of the range", () => {
    // 14 is past the hunk, so a prefill would silently drop it — and a suggestion
    // that omits a line it replaces deletes it.
    const { queryByText } = box(14, 13);
    expect(queryByText("Suggestion")).toBeNull();
  });

  describe("on your own PR", () => {
    const ownBox = (line: number, startLine: number) =>
      render(
        <InlineCommentBox
          target={TARGET}
          path="src/retry.ts"
          patch={PATCH}
          line={line}
          startLine={startLine}
          onRight
          onClose={() => {}}
          mode="queue"
        />,
      );

    // There is nothing to batch and nothing to approve on your own PR, so the
    // pending-review flow would be a button that leads nowhere useful.
    it("leads with the queue instead of starting a review", () => {
      const { getByText, queryByText } = ownBox(11, 11);
      expect(getByText("Add to queue")).toBeInTheDocument();
      expect(queryByText("Start a review")).toBeNull();
      // Saying something on GitHub is still one of the two useful outcomes.
      expect(getByText("Comment")).toBeInTheDocument();
    });

    it("queues the selected range as the item's anchor", () => {
      const { getByText, getByPlaceholderText } = ownBox(12, 10);
      fireEvent.change(getByPlaceholderText("Leave a comment"), {
        target: { value: "tidy this up" },
      });
      fireEvent.click(getByText("Add to queue"));

      expect(spies.queue).toHaveBeenCalledWith(
        expect.objectContaining({
          body: "tidy this up",
          source: "manual",
          path: "src/retry.ts",
          line: 12,
          startLine: 10,
          onRight: true,
        }),
        expect.anything(),
      );
    });
  });
});
