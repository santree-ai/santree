/**
 * The ticket page renders with nothing around it — no view provider, no host
 * state — because a main-area tab has none to offer. What it must get right on
 * its own: draw the frame from whatever the host already knew before the fetch
 * lands, and never call a ticket missing while it is still being asked for.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TriageDetail } from "../bindings";

const linear = vi.hoisted(() => ({
  detail: undefined as TriageDetail | null | undefined,
  refresh: vi.fn(),
  setState: vi.fn(),
}));
vi.mock("../lib/queries", () => ({
  useTriageDetail: () => ({ data: linear.detail }),
  useRefreshTriage: () => ({ refresh: linear.refresh, fetching: false }),
  useTriageSetState: () => ({ mutate: linear.setState }),
  useLinearReadOnly: () => false,
}));
vi.mock("./IssueDiscussion", () => ({
  DiscussionPane: () => <div data-testid="discussion" />,
  DiscussionSkeleton: () => <div data-testid="discussion-skeleton" />,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { IssuePage } from "./IssuePage";

const detail = {
  id: "AK-1",
  title: "Throttle the login endpoint",
  priority: "High",
  state: "In Review",
  stateId: "s1",
  states: [{ id: "s1", name: "In Review", color: "#0f0", type: "started" }],
  url: "https://linear.app/acme/issue/AK-1",
  author: "sam",
  authorAvatarUrl: null,
  createdAtMs: 1_756_000_000_000,
  labels: ["bug"],
  project: null,
  slaBreachMs: null,
  snoozedUntilMs: null,
  description: "",
  comments: [],
} as unknown as TriageDetail;

describe("IssuePage", () => {
  // A host with the ticket's row in hand (Triage's queue) gets the frame at once.
  it("draws the header from the summary before the detail lands", () => {
    linear.detail = undefined;
    render(
      <IssuePage
        repo="acme/app"
        ticketId="AK-1"
        summary={{
          title: "Throttle the login endpoint",
          priority: "High",
          slaBreachMs: null,
          snoozedUntilMs: null,
        }}
      />,
    );
    expect(screen.getByText("AK-1")).toBeInTheDocument();
    expect(screen.getByText("Throttle the login endpoint")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(screen.getByTestId("discussion-skeleton")).toBeInTheDocument();
    expect(screen.queryByText("No linked ticket")).toBeNull();
  });

  // A host with only the id (a worktree, a PR) still gets the id, the actions
  // and a skeleton where the name goes — never the id standing in for a title.
  it("waits with a skeleton when it has nothing but the id", () => {
    linear.detail = undefined;
    render(<IssuePage repo="acme/app" ticketId="AK-1" />);
    expect(screen.getByText("AK-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(screen.getByTestId("discussion-skeleton")).toBeInTheDocument();
    expect(screen.queryByText("No linked ticket")).toBeNull();
  });

  it("renders the discussion, and the host's actions, once the detail lands", () => {
    linear.detail = detail;
    render(
      <IssuePage
        repo="acme/app"
        ticketId="AK-1"
        actions={<button type="button">Investigate</button>}
      />,
    );
    expect(screen.getByText("Throttle the login endpoint")).toBeInTheDocument();
    expect(screen.getByText("sam")).toBeInTheDocument();
    expect(screen.getByText("bug")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Investigate" })).toBeInTheDocument();
    expect(screen.getByTestId("discussion")).toBeInTheDocument();
    expect(screen.queryByTestId("discussion-skeleton")).toBeNull();
  });

  // The other way to have no ticket: an id Linear has no issue for.
  it("says there is no ticket when Linear has no issue by that id", () => {
    linear.detail = null;
    render(<IssuePage repo="acme/app" ticketId="AK-9" />);
    expect(screen.getByText("No linked ticket")).toBeInTheDocument();
    expect(screen.getByText("Linear has no issue AK-9.")).toBeInTheDocument();
    expect(screen.queryByTestId("discussion-skeleton")).toBeNull();
  });
});
