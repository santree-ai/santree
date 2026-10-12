/**
 * The one ticket pane, now that the worktree's and the pull request's are the
 * same component. Its two hosts disagree about how a ticket can be missing —
 * Trees only offers the pane when the worktree names one, Reviews always offers
 * it — so "there is no ticket here" is the case worth pinning.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TriageDetail } from "../bindings";

const detail = vi.hoisted(() => ({ data: undefined as TriageDetail | null | undefined }));
vi.mock("../lib/queries", () => ({
  useTriageDetail: () => detail,
  useTicketProvider: () => "Linear",
}));
vi.mock("./IssueDiscussion", () => ({
  DiscussionPane: () => <div data-testid="discussion" />,
  DiscussionSkeleton: () => <div data-testid="discussion-skeleton" />,
}));

import { IssuePane } from "./IssuePane";

const ticket = {
  id: "AK-1",
  title: "Throttle the login endpoint",
  priority: "High",
  state: "In Review",
  url: "https://linear.app/acme/issue/AK-1",
  author: "sam",
  authorAvatarUrl: null,
  createdAtMs: 1_756_000_000_000,
  labels: [],
} as unknown as TriageDetail;

describe("IssuePane", () => {
  // Nothing carried an id — a PR whose title and branch name no ticket.
  // …and the other way to have none: an id Linear has no issue for. Same message,
  // because neither is a failure to report.
  it("says there is no ticket when nothing named one, or Linear has none by that id", () => {
    detail.data = undefined;
    const none = render(<IssuePane repo="acme/app" ticketId={null} />);
    expect(screen.getByText("No linked ticket")).toBeInTheDocument();
    expect(screen.queryByTestId("discussion")).toBeNull();
    none.unmount();

    detail.data = null;
    render(<IssuePane repo="acme/app" ticketId="AK-9" />);
    expect(screen.getByText("No linked ticket")).toBeInTheDocument();
    expect(screen.getByText("Linear has no issue AK-9.")).toBeInTheDocument();
  });

  // Both signals, because they answer different questions: the state says how far
  // the ticket has got, the priority dot how much it matters.
  // The worktree host self-heals its cached title off `onResolvedTitle`; the
  // write is the caller's, so all the pane owes it is the live title.
  it("shows the ticket's state and title, and reports the live title to its host", () => {
    detail.data = ticket;
    const onResolvedTitle = vi.fn();
    render(<IssuePane repo="acme/app" ticketId="AK-1" onResolvedTitle={onResolvedTitle} />);
    expect(screen.getByText("In Review")).toBeInTheDocument();
    expect(screen.getByText("Throttle the login endpoint")).toBeInTheDocument();
    expect(screen.getByTestId("discussion")).toBeInTheDocument();
    expect(onResolvedTitle).toHaveBeenCalledWith("Throttle the login endpoint");
  });

  // Waiting on a fetch is not the same as having nothing: the skeleton keeps the
  // pane from reading as an empty ticket.
  it("waits for a ticket it has an id for rather than calling it missing", () => {
    detail.data = undefined;
    render(<IssuePane repo="acme/app" ticketId="AK-1" />);
    expect(screen.queryByText("No linked ticket")).toBeNull();
    expect(screen.getByTestId("discussion-skeleton")).toBeInTheDocument();
  });

  // The rail is a place to glance at a ticket; reading a long one wants the main
  // area. A host that has a tab to open passes the control; one that doesn't
  // (there is no tab to open a ticket-less PR's ticket into) gets no button.
  it("offers to open the ticket in a tab only when a host can host one", () => {
    detail.data = ticket;
    const onExpand = vi.fn();
    const { unmount } = render(<IssuePane repo="acme/app" ticketId="AK-1" onExpand={onExpand} />);
    fireEvent.click(screen.getByRole("button", { name: "Open in a tab" }));
    expect(onExpand).toHaveBeenCalledTimes(1);
    unmount();

    render(<IssuePane repo="acme/app" ticketId="AK-1" />);
    expect(screen.queryByRole("button", { name: "Open in a tab" })).toBeNull();
  });
});
