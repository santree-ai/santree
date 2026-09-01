/**
 * The AI's draft is the user's comment before it's anyone else's. These cover the
 * three things that has to mean: they can rewrite it, they can throw it away, and
 * the only button that reaches GitHub says so.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewDraft } from "../../bindings";
import type { CommentTarget } from "./commentTarget";
import { ReviewDraftCard } from "./ReviewDraftCard";

const spies = vi.hoisted(() => ({ update: vi.fn(), remove: vi.fn(), publish: vi.fn() }));

vi.mock("../../lib/queries", () => ({
  useReviewWorkItems: () => ({ data: [] }),
  useAddReviewWorkItem: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateReviewDraft: () => ({ mutate: spies.update, isPending: false }),
  useDeleteReviewDraft: () => ({ mutate: spies.remove, isPending: false }),
  usePublishReviewDrafts: () => ({ mutate: spies.publish, isPending: false }),
}));

function draft(over: Partial<ReviewDraft> = {}): ReviewDraft {
  return {
    agentKind: "Claude",
    id: "d1",
    prRepo: "acme/api",
    prNumber: 7,
    headSha: "abc123",
    path: "src/retry.ts",
    line: 42,
    startLine: null,
    onRight: true,
    body: "This retries forever when the token is bad.",
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
  pendingReviewId: null,
};

beforeEach(() => {
  spies.update.mockClear();
  spies.remove.mockClear();
  spies.publish.mockClear();
});

describe("ReviewDraftCard", () => {
  it("says whose it is and where it goes", () => {
    render(<ReviewDraftCard draft={draft()} target={target} />);
    expect(screen.getByText("AI draft")).toBeInTheDocument();
    // Basename in the code face, anchor in words — and no "R"/"L", which is the
    // diff's coordinate rather than anything the reader was taught.
    expect(screen.getByText("retry.ts")).toBeInTheDocument();
    expect(screen.getByText("· line 42")).toBeInTheDocument();
    // No pending review yet, so sending this one starts it — the same words the
    // diff's own composer uses.
    expect(screen.getByText("Start a review")).toBeInTheDocument();
  });

  /** The card also renders in Trees' PR pane, away from its file, where two
   *  `util.py`s under different directories are the same basename. */
  it("keeps the whole path on the basename's title", () => {
    render(<ReviewDraftCard draft={draft({ path: "src/net/retry.ts" })} target={target} />);
    expect(screen.getByText("retry.ts")).toHaveAttribute("title", "src/net/retry.ts");
  });

  it("names an old-side anchor in words, never as a side letter", () => {
    render(<ReviewDraftCard draft={draft({ onRight: false, startLine: 40 })} target={target} />);
    expect(screen.getByText("· old lines 40–42")).toBeInTheDocument();
  });

  it("says 'Add to review' once a review is open", () => {
    render(<ReviewDraftCard draft={draft()} target={{ ...target, pendingReviewId: "R_1" }} />);
    expect(screen.getByText("Add to review")).toBeInTheDocument();
  });

  it("edits the body, keeping the suggestion split", () => {
    render(<ReviewDraftCard draft={draft({ suggestion: "drop(guard);" })} target={target} />);
    fireEvent.click(screen.getByText("Edit"));
    const box = screen.getByRole("textbox");
    // The box opens with what would be posted — comment and fenced suggestion as
    // one text, the way GitHub shows it.
    expect((box as HTMLTextAreaElement).value).toContain("```suggestion\ndrop(guard);\n```");
    fireEvent.change(box, { target: { value: "shorter\n\n```suggestion\ndrop(g);\n```" } });
    fireEvent.click(screen.getByText("Save"));
    expect(spies.update).toHaveBeenCalledWith({
      id: "d1",
      body: "shorter",
      suggestion: "drop(g);",
    });
  });

  it("deletes without a dialog, since nothing was ever sent", () => {
    render(<ReviewDraftCard draft={draft()} target={target} />);
    fireEvent.click(screen.getByText("Delete"));
    expect(spies.remove).toHaveBeenCalledWith("d1");
  });

  it("publishes just this one into the pending review", () => {
    render(<ReviewDraftCard draft={draft()} target={target} />);
    fireEvent.click(screen.getByText("Start a review"));
    expect(spies.publish).toHaveBeenCalledWith(["d1"]);
  });

  it("won't send a draft written against an older commit", () => {
    // Its line numbers describe code that has moved. Posting it would put the
    // user's name on a comment pointing at the wrong lines.
    render(<ReviewDraftCard draft={draft()} target={target} stale />);
    expect(screen.getByText("Older commit")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Start a review"));
    expect(spies.publish).not.toHaveBeenCalled();
  });
});
