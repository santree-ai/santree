import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewInbox, ReviewPr } from "../../bindings";
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
    isInMergeQueue: false,
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
  beforeEach(() => localStorage.clear());

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

  it("collapses a team section on click and remembers it across mounts", () => {
    const { unmount } = render(
      <ReviewsSidebarView
        inbox={inbox}
        loading={false}
        total={3}
        activeId={null}
        onSelect={vi.fn()}
      />,
    );

    const header = screen.getByRole("button", { name: /Team · Engineering/ });
    expect(header).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(header);
    expect(screen.queryByText("Migrate billing jobs")).not.toBeInTheDocument();
    // Direct sections are unaffected.
    expect(screen.getByText("Tighten rate limiter")).toBeInTheDocument();

    // The collapse survives a remount (persisted in localStorage).
    unmount();
    render(
      <ReviewsSidebarView
        inbox={inbox}
        loading={false}
        total={3}
        activeId={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Team · Engineering/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByText("Migrate billing jobs")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Team · Engineering/ }));
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
