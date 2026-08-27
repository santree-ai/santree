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
    headRefId: null,
    baseRef: "main",
    baseRefId: null,
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
    aiDraftCount: 0,
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

  it("organizes category rows by project and exposes urgency, effort and comments", () => {
    const mine = { ...inbox.mine[0], commentCount: 4, aiDraftCount: 2 };
    const ticket: TicketRef = {
      identifier: "AK-483",
      title: "Booking webhook retries",
      priority: "High",
      project: "Booking Platform",
      projectColor: "#4493f8",
      projectIcon: null,
      projectTargetDate: "2026-09-30",
      projectMilestone: null,
    };
    render(
      <ReviewsSidebarView
        inbox={{ ...inbox, mine: [mine] }}
        loading={false}
        total={3}
        activeId={null}
        onSelect={vi.fn()}
        ticketFor={(pr) => (pr.id === mine.id ? ticket : undefined)}
      />,
    );

    expect(screen.getByRole("button", { name: /Booking Platform/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "High priority" })).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: /Small review/ })).not.toHaveLength(0);
    expect(screen.getByTitle("4 comments")).toHaveTextContent("4");
    expect(screen.getByTitle("2 AI draft comments")).toHaveTextContent("2");
    expect(screen.getByTitle(/Project target date/)).toHaveTextContent(/due/i);
  });

  it("groups project PRs by milestone and nests stacked branches inside that milestone", () => {
    const parent = pr("parent", 700, "Parent PR", "acme/platform", {
      headRefId: "REF-parent",
    });
    const child = pr("child", 701, "Child PR", "acme/platform", {
      headRefId: "REF-child",
      baseRefId: "REF-parent",
    });
    const tickets = new Map<string, TicketRef>([
      [
        "parent",
        {
          identifier: "AK-700",
          title: "Parent",
          priority: "None",
          project: "Platform",
          projectColor: null,
          projectIcon: null,
          projectTargetDate: null,
          projectMilestone: {
            id: "milestone-beta",
            name: "Beta",
            targetDate: "2026-09-15",
            sortOrder: 1,
          },
        },
      ],
      [
        "child",
        {
          identifier: "AK-701",
          title: "Child",
          priority: "None",
          project: "Platform",
          projectColor: null,
          projectIcon: null,
          projectTargetDate: null,
          projectMilestone: {
            id: "milestone-beta",
            name: "Beta",
            targetDate: "2026-09-15",
            sortOrder: 1,
          },
        },
      ],
    ]);
    const { container } = render(
      <ReviewsSidebarView
        inbox={{ mine: [], requested: [parent, child], teams: [] }}
        loading={false}
        total={2}
        activeId={null}
        onSelect={vi.fn()}
        ticketFor={(item) => tickets.get(item.id)}
      />,
    );

    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByTitle(/Milestone target date/)).toHaveTextContent(/due/i);
    const rows = [...container.querySelectorAll<HTMLElement>("[data-pr-id]")];
    expect(rows.map((row) => row.dataset.prId)).toEqual(["parent", "child"]);
    expect(rows.map((row) => row.dataset.stackDepth)).toEqual(["0", "1"]);

    const milestoneHeading = screen.getByRole("button", { name: "Collapse milestone Beta" });
    expect(milestoneHeading).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(milestoneHeading);
    expect(screen.queryByText("Parent PR")).not.toBeInTheDocument();
    expect(screen.queryByText("Child PR")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand milestone Beta" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("orders My PRs, direct requests, then every team", () => {
    const twoTeams = {
      ...inbox,
      teams: [
        ...inbox.teams,
        {
          slug: "voice",
          name: "Voice",
          prs: [pr("t2", 499, "Tune call routing", "acme/voice")],
        },
      ],
    };
    render(
      <ReviewsSidebarView
        inbox={twoTeams}
        loading={false}
        total={4}
        activeId={null}
        onSelect={vi.fn()}
      />,
    );
    const headings = screen
      .getAllByText(/Needs your review|Team · Engineering|Team · Voice|My PRs/)
      .map((el) => el.textContent);
    expect(headings).toEqual(["My PRs", "Needs your review", "Team · Engineering", "Team · Voice"]);
  });

  it("collapses My PRs and direct requests independently and remembers them", () => {
    const { unmount } = render(
      <ReviewsSidebarView
        inbox={inbox}
        loading={false}
        total={3}
        activeId={null}
        onSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /My PRs/ }));
    fireEvent.click(screen.getByRole("button", { name: /Needs your review/ }));
    expect(screen.queryByText("Booking webhook retries")).not.toBeInTheDocument();
    expect(screen.queryByText("Tighten rate limiter")).not.toBeInTheDocument();
    expect(screen.getByText("Migrate billing jobs")).toBeInTheDocument();

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
    expect(screen.getByRole("button", { name: /My PRs/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: /Needs your review/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
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
    expect(screen.getByText("Reviewed, waiting on author")).toBeInTheDocument();
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
    expect(screen.queryByText("Reviewed, waiting on author")).not.toBeInTheDocument();
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
        priority: "High",
        project: "Voice",
        projectColor: null,
        projectIcon: null,
        projectTargetDate: null,
        projectMilestone: null,
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

    fireEvent.click(screen.getByRole("button", { name: /Voice/ }));
    expect(screen.queryByText("Tighten rate limiter")).not.toBeInTheDocument();
  });

  it("renders a direct-and-team request only in the direct section", () => {
    render(
      <ReviewsSidebarView
        inbox={{
          ...inbox,
          teams: [{ ...inbox.teams[0], prs: [inbox.requested[0], ...inbox.teams[0].prs] }],
        }}
        loading={false}
        total={3}
        activeId={null}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getAllByText("Tighten rate limiter")).toHaveLength(1);
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
