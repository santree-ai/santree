import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ReviewPr } from "../../bindings";

const review = vi.hoisted(() => ({
  open: vi.fn(),
  tabs: [] as { source: string; refId: string }[],
}));

vi.mock("./model", () => ({
  useReviewsModel: () => ({
    repo: "acme/app",
    focusFile: vi.fn(),
    openAiReview: review.open,
  }),
}));

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
    review.tabs = [{ source: "review", refId: "ai-review:acme/app#7::codex" }];

    render(<ReviewBriefSection pr={pr} activeReviewAgent="Codex" />);

    expect(screen.getByRole("button", { name: "Open Codex review" })).toBeInTheDocument();
    expect(screen.queryByText(/Open AI review/i)).toBeNull();
  });
});
