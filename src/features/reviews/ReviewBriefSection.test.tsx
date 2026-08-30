import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ReviewPr } from "../../bindings";

const review = vi.hoisted(() => ({
  open: vi.fn(),
  tabs: [] as { source: string; refId: string; agent?: { kind: string } }[],
}));

/** A live review pane: the PR's own `term_key` as the ref — never decorated with
 *  the provider — and the agent running it beside. */
const reviewPane = (kind: string) => ({
  source: "review",
  refId: "ai-review:acme/app#7",
  agent: { kind },
});

vi.mock("../../lib/queries", () => ({
  REVIEW_AGENT_KEY: "review_agent",
  usePrReviewBrief: () => ({ data: undefined, isLoading: false }),
  useResolvedSetting: () => ({ data: "Codex" }),
}));

vi.mock("../terminal/TerminalsContext", () => ({
  useTerminals: () => ({ tabs: review.tabs }),
}));

import { ReviewBriefSection } from "./ReviewBriefSection";

const pr = {
  id: "pr-7",
  repo: "acme/app",
  number: 7,
  headSha: "abc123",
} as ReviewPr;

describe("ReviewBriefSection", () => {
  it("brands the open action with the active review provider", () => {
    review.tabs = [reviewPane("Codex")];

    render(
      <ReviewBriefSection
        pr={pr}
        activeReviewAgent="Codex"
        santreeRepo="acme/app"
        onJump={vi.fn()}
        onStartReview={review.open}
      />,
    );

    expect(screen.getByRole("button", { name: "Open Codex review" })).toBeInTheDocument();
    expect(screen.queryByText(/Open AI review/i)).toBeNull();
  });

  /** The Trees host renders the brief beside a PR it can't start a session for
   *  from this pane, and a button that does nothing is worse than no button. */
  it("renders read-only when the host can't start a review", () => {
    review.tabs = [reviewPane("Codex")];

    render(
      <ReviewBriefSection
        pr={pr}
        activeReviewAgent="Codex"
        santreeRepo="acme/app"
        onJump={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: /review/i })).toBeNull();
  });
});
