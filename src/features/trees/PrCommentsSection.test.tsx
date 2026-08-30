/**
 * The conversation card's geometry is the thing under test here.
 *
 * The queue action is hover-revealed, and these cards are stacked: if the button
 * *mounts* on hover it occupies nothing at rest, so pointing at a card resizes
 * its header and the card jumps out from under the pointer. So the slot is
 * always in flow and only its opacity changes — which is exactly the kind of
 * detail a later "simplify this" edit reverts, hence the assertions on how it is
 * hidden, not just on whether it is there.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PrComment, ReviewPr, ReviewWorkItem } from "../../bindings";

const spies = vi.hoisted(() => ({
  addItem: vi.fn(),
  selectFile: vi.fn(),
  comments: [] as PrComment[],
  items: [] as ReviewWorkItem[],
}));

vi.mock("../../lib/queries", () => ({
  usePrDetail: () => ({ data: { comments: spies.comments, threads: [], headSha: "abc123" } }),
  useReviewDrafts: () => ({ data: [] }),
  useReviewWorkItems: () => ({ data: spies.items }),
  useAddReviewWorkItem: () => ({ mutate: spies.addItem, isPending: false }),
}));

vi.mock("./model", () => ({ useTrees: () => ({ selectFile: spies.selectFile }) }));

import { PrCommentsSection } from "./PrCommentsSection";

const BODY = "The retry budget is gone on this path.";

function comment(over: Partial<PrComment> = {}): PrComment {
  return {
    author: "github-actions",
    authorAvatarUrl: "",
    body: BODY,
    createdAt: "2026-08-01T10:00:00Z",
    kind: "Issue",
    path: null,
    isPending: false,
    isBot: true,
    ...over,
  };
}

function workItem(over: Partial<ReviewWorkItem> = {}): ReviewWorkItem {
  return {
    id: "w1",
    prRepo: "acme/api",
    prNumber: 7,
    body: BODY,
    done: false,
    source: "manual",
    sourceId: null,
    path: null,
    line: null,
    startLine: null,
    onRight: null,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const pr = { id: "p1", repo: "acme/api", number: 7 } as ReviewPr;

function renderSection(comments: PrComment[], items: ReviewWorkItem[] = []) {
  spies.addItem.mockClear();
  spies.comments = comments;
  spies.items = items;
  return render(<PrCommentsSection pr={pr} />);
}

describe("the comment card's queue action", () => {
  it("holds its space at rest, so hovering can't resize the card", () => {
    renderSection([comment()]);
    const button = screen.getByRole("button", { name: "Queue this comment" });

    // Present before any pointer goes near it: the slot is reserved, not
    // conjured. `hidden` (display:none) would take it back out of flow and put
    // the reflow straight back.
    expect(button).toBeInTheDocument();
    expect(button.className).toContain("opacity-0");
    expect(button.className).not.toContain("hidden");

    // And the timestamp is not the thing that yields to it — it stays put,
    // visible, in its own box beside the action.
    const time = screen.getByText(/ago$/);
    expect(time.className).not.toMatch(/hidden/);
  });

  it("queues the comment body for the agent", () => {
    renderSection([comment()]);
    fireEvent.click(screen.getByRole("button", { name: "Queue this comment" }));
    expect(spies.addItem).toHaveBeenCalledWith(
      expect.objectContaining({ body: BODY, source: "manual", sourceId: null }),
    );
  });

  it("reads as already queued once the body is in the queue", () => {
    renderSection([comment()], [workItem()]);
    const button = screen.getByRole("button", { name: "Already in the queue" });
    // Queued is state, not an affordance: it stays visible off-hover, and there
    // is nothing left to click.
    expect(button.className).not.toContain("opacity-0");
    expect(button).toBeDisabled();
  });

  it("keeps the slot when a review has no body to queue", () => {
    const { container } = renderSection([comment({ body: "", kind: "Review" })]);
    expect(screen.queryByRole("button", { name: /queue/i })).not.toBeInTheDocument();
    // The empty slot still reserves its width, so timestamps line up down the
    // stack whether or not a comment carries text.
    expect(container.querySelector(".h-4.w-4")).toBeInTheDocument();
  });
});
