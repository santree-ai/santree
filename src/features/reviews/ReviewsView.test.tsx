import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ReviewInbox, ReviewPr } from "../../bindings";
import { ticketIdFor } from "./ReviewDetail";
import { ReviewsSidebarView } from "./ReviewsSidebar";

function pr(id: string, number: number, title: string, repo: string): ReviewPr {
  return {
    id,
    number,
    title,
    url: `https://github.com/${repo}/pull/${number}`,
    repo,
    headRef: `you/pr-${number}`,
    author: "you",
    authorAvatarUrl: "",
    state: "Open",
    isDraft: false,
    reviewDecision: "ReviewRequired",
    checks: "Success",
    additions: 10,
    deletions: 2,
    commentCount: 0,
    reviewers: [],
    updatedAt: "2026-06-29T12:00:00Z",
  };
}

const inbox: ReviewInbox = {
  mine: [pr("m1", 483, "Booking webhook retries", "acme/booking-agent")],
  requested: [pr("r1", 512, "Tighten rate limiter", "acme/booking-agent")],
  teams: [
    {
      slug: "eng",
      name: "Engineering",
      prs: [pr("t1", 498, "Migrate billing jobs", "acme/platform")],
    },
  ],
};

describe("ReviewsSidebarView", () => {
  it("renders the three categories with their PRs", () => {
    render(
      <ReviewsSidebarView
        inbox={inbox}
        loading={false}
        total={3}
        activeId="m1"
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText("My PRs")).toBeInTheDocument();
    expect(screen.getByText("Review requests")).toBeInTheDocument();
    expect(screen.getByText("Team · Engineering")).toBeInTheDocument();
    expect(screen.getByText("Booking webhook retries")).toBeInTheDocument();
    expect(screen.getByText("Tighten rate limiter")).toBeInTheDocument();
    expect(screen.getByText("Migrate billing jobs")).toBeInTheDocument();
  });

  it("shows an empty state when there are no PRs", () => {
    render(
      <ReviewsSidebarView
        inbox={{ mine: [], requested: [], teams: [] }}
        loading={false}
        total={0}
        activeId={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("No open pull requests")).toBeInTheDocument();
  });
});

describe("ticketIdFor", () => {
  it("prefers the [AK-123] tag in the PR title", () => {
    expect(ticketIdFor({ title: "[AK-201] Booking webhook", headRef: "you/whatever-9" })).toBe(
      "AK-201",
    );
  });

  it("falls back to the head branch, upper-cased", () => {
    expect(
      ticketIdFor({
        title: "Hide unactioned service-ticket sources in AI explanation",
        headRef: "jonathansandoval/msg-5033-ai-explanation-servi",
      }),
    ).toBe("MSG-5033");
  });

  it("does not false-match prose like 'service-ticket' in the title", () => {
    expect(
      ticketIdFor({ title: "Fix the service-ticket bug", headRef: "feature/no-id" }),
    ).toBeNull();
  });

  it("returns null when neither title nor branch carries an id", () => {
    expect(ticketIdFor({ title: "Plain title", headRef: "you/pr88" })).toBeNull();
  });
});
