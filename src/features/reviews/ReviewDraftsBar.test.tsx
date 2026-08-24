/**
 * The batch publish is the one place in the AI-review flow that reaches GitHub, so
 * what it sends, what it refuses to send, and what it says when it only half works
 * are the things worth pinning down.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewDraft } from "../../bindings";
import type { CommentTarget } from "./commentTarget";
import { ReviewDraftsBar } from "./ReviewDraftsBar";

const spies = vi.hoisted(() => ({ publish: vi.fn() }));

vi.mock("../../lib/queries", () => ({
  usePublishReviewDrafts: () => ({ mutateAsync: spies.publish, isPending: false }),
}));

function draft(over: Partial<ReviewDraft> = {}): ReviewDraft {
  return {
    id: "d1",
    prRepo: "acme/api",
    prNumber: 7,
    headSha: "abc123",
    path: "src/retry.ts",
    line: 42,
    startLine: null,
    onRight: true,
    body: "This retries forever.",
    suggestion: null,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const target: CommentTarget = {
  prRepo: "acme/api",
  number: 7,
  prId: "PR_1",
  headSha: "abc123",
  pendingReviewId: "R_1",
};

beforeEach(() => {
  spies.publish.mockReset();
  spies.publish.mockResolvedValue({ published: 2, reviewId: "R_1", failed: null });
});

describe("ReviewDraftsBar", () => {
  it("sends every draft on the current head, and skips the rest", async () => {
    const drafts = [
      draft({ id: "d1" }),
      draft({ id: "d2", line: 50 }),
      // Written before a push: publishing refuses it, so it isn't offered.
      draft({ id: "old", headSha: "0000000" }),
    ];
    render(<ReviewDraftsBar target={target} drafts={drafts} />);
    expect(screen.getByText("3 AI drafts")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Add all to review"));
    expect(screen.getByText(/written against an earlier commit is skipped/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Add 2 to review"));

    await waitFor(() => expect(spies.publish).toHaveBeenCalledWith(["d1", "d2"]));
  });

  it("reports how far a partial publish got, and keeps the dialog open", async () => {
    // "Added 2 of 5" is actionable; a bare failure would leave the user guessing
    // which half landed under their name.
    spies.publish.mockResolvedValue({
      published: 2,
      reviewId: "R_1",
      failed: { draftId: "d3", error: "GitHub said no." },
    });
    render(
      <ReviewDraftsBar
        target={target}
        drafts={[draft({ id: "d1" }), draft({ id: "d2" }), draft({ id: "d3" })]}
      />,
    );
    fireEvent.click(screen.getByText("Add all to review"));
    fireEvent.click(screen.getByText("Add 3 to review"));

    expect(await screen.findByText(/Added 2 of 3/)).toBeInTheDocument();
    expect(screen.getByText(/The rest are still here/)).toBeInTheDocument();
  });

  it("offers nothing to send when every draft predates the current head", () => {
    render(<ReviewDraftsBar target={target} drafts={[draft({ headSha: "0000000" })]} />);
    const button = screen.getByText("Add all to review").closest("button");
    expect(button).toBeDisabled();
  });
});
