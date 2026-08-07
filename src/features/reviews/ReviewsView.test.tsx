import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewInbox, ReviewPr, TicketRef } from "../../bindings";
import { ReviewsSidebarView } from "./ReviewsSidebar";

function pr(
  id: string,
  number: number,
  title: string,
  repo: string,
  over: Partial<ReviewPr> = {},
): ReviewPr {
  return {
    id,
    number,
    title,
    url: `https://github.com/${repo}/pull/${number}`,
    repo,
    headRef: `you/pr-${number}`,
    baseRef: "main",
    headSha: `sha-${number}`,
    author: "you",
    authorAvatarUrl: "",
    state: "Open",
    isDraft: false,
    reviewDecision: "ReviewRequired",
    checks: "Success",
    additions: 10,
    deletions: 2,
    changedFiles: 2,
    commentCount: 0,
    isInMergeQueue: false,
    reviewers: [],
    updatedAt: "2026-06-29T12:00:00Z",
    createdAt: "2026-06-28T12:00:00Z",
    waitingSince: "2026-06-28T12:00:00Z",
    headCommittedAt: "2026-06-28T12:00:00Z",
    viewerReview: null,
    ...over,
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
    expect(screen.getByText("Needs your review")).toBeInTheDocument();
    expect(screen.getByText("Team · Engineering")).toBeInTheDocument();
    expect(screen.getByText("Booking webhook retries")).toBeInTheDocument();
    expect(screen.getByText("Tighten rate limiter")).toBeInTheDocument();
    expect(screen.getByText("Migrate billing jobs")).toBeInTheDocument();
  });

  it("leads with the review queue, not with your own PRs", () => {
    // The whole point of the reorder: the thing you're trying to do more of is the
    // first thing in the panel.
    render(
      <ReviewsSidebarView
        inbox={inbox}
        loading={false}
        total={3}
        activeId={null}
        onSelect={vi.fn()}
      />,
    );
    const headings = screen
      .getAllByText(/Needs your review|Team · Engineering|My PRs/)
      .map((el) => el.textContent);
    expect(headings).toEqual(["Needs your review", "Team · Engineering", "My PRs"]);
  });

  it("moves a PR you've already reviewed into its own folded block", () => {
    const reviewed = {
      ...inbox,
      requested: [
        pr("r1", 512, "Tighten rate limiter", "acme/booking-agent", {
          viewerReview: { state: "Approved", submittedAt: "2026-06-29T12:00:00Z" },
        }),
      ],
    };
    render(
      <ReviewsSidebarView
        inbox={reviewed}
        loading={false}
        total={3}
        activeId={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.queryByText("Needs your review")).not.toBeInTheDocument();
    expect(screen.getByText("Reviewed — waiting on author")).toBeInTheDocument();
  });

  it("brings a reviewed PR back once the author pushes again", () => {
    const pushed = {
      ...inbox,
      requested: [
        pr("r1", 512, "Tighten rate limiter", "acme/booking-agent", {
          viewerReview: { state: "ChangesRequested", submittedAt: "2026-06-29T12:00:00Z" },
          headCommittedAt: "2026-06-30T12:00:00Z",
        }),
      ],
    };
    render(
      <ReviewsSidebarView
        inbox={pushed}
        loading={false}
        total={3}
        activeId={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("Needs your review")).toBeInTheDocument();
    expect(screen.queryByText("Reviewed — waiting on author")).not.toBeInTheDocument();
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

  it("regroups by Linear project, keeping every PR and marking the direct ones", () => {
    const tickets: Record<string, TicketRef> = {
      r1: {
        identifier: "AK-1",
        title: "t",
        project: "Voice",
        projectColor: null,
        projectIcon: null,
      },
    };
    render(
      <ReviewsSidebarView
        inbox={inbox}
        loading={false}
        total={3}
        activeId={null}
        onSelect={vi.fn()}
        grouping="project"
        onGrouping={vi.fn()}
        onSort={vi.fn()}
        ticketFor={(p) => tickets[p.id]}
      />,
    );

    expect(screen.getByText("Voice")).toBeInTheDocument();
    expect(screen.getByText("No project")).toBeInTheDocument();
    // Nothing is dropped by the regroup — all three PRs are still listed.
    expect(screen.getByText("Tighten rate limiter")).toBeInTheDocument();
    expect(screen.getByText("Booking webhook retries")).toBeInTheDocument();
    expect(screen.getByText("Migrate billing jobs")).toBeInTheDocument();
    // The category signal survives the regroup on the one direct request.
    expect(screen.getAllByText("@you")).toHaveLength(1);
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
