/**
 * The rail's mounting rules. Both assertions here guard non-idempotent effects:
 * `AiReviewPane` spawns a PTY and checks the PR out, so *when it mounts* is a
 * correctness property, not a rendering detail.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewPr } from "../../bindings";

const model = vi.hoisted(() => ({
  infoCollapsed: false,
  infoWidth: 400,
  toggleInfo: vi.fn(),
  setInfoWidth: vi.fn(),
  repo: "acme/app",
}));
vi.mock("./model", () => ({ useReviewsModel: () => model }));

// Counts *mounts* (an empty-dep effect), not renders — a remount is exactly the
// bug being guarded against: a second PTY and a second checkout.
const ai = vi.hoisted(() => ({ mounts: 0 }));
vi.mock("./AiReviewPane", async () => {
  const { useEffect } = await import("react");
  return {
    AiReviewPane: () => {
      useEffect(() => {
        ai.mounts++;
      }, []);
      return <div data-testid="ai-pane" />;
    },
  };
});

vi.mock("./ReviewBriefSection", () => ({ ReviewBriefSection: () => <div /> }));
vi.mock("./ReviewIssuePane", () => ({ ReviewIssuePane: () => <div data-testid="issue-pane" /> }));
vi.mock("./PrThreadCard", () => ({ PrThreadCard: () => <div /> }));
vi.mock("./CommentComposer", () => ({ CommentComposer: () => <div /> }));
vi.mock("../../components/Markdown", () => ({ Markdown: () => <div /> }));
vi.mock("../../lib/useEdgeResize", () => ({ useEdgeResize: () => ({}) }));
vi.mock("../../lib/queries", () => ({
  usePrDetail: () => ({ data: { files: [], threads: [], comments: [], body: "" } }),
  useAddPrConversationComment: () => ({ mutate: vi.fn(), isPending: false }),
  useReviewDrafts: () => ({ data: [] }),
}));

import { PrInfoPanel } from "./PrInfoPanel";

const pr = { id: "p1", number: 7, repo: "acme/app", title: "[AK-1] thing" } as ReviewPr;

beforeEach(() => {
  ai.mounts = 0;
  model.infoCollapsed = false;
});

describe("PrInfoPanel", () => {
  it("doesn't mount the AI session until it has been opened", () => {
    render(<PrInfoPanel pr={pr} tab="description" onTabChange={vi.fn()} aiOpened={false} />);
    expect(ai.mounts).toBe(0);
    expect(screen.queryByTestId("ai-pane")).toBeNull();
  });

  // Selecting another rail tab must hide the session, never unmount it: remounting
  // re-spawns the PTY and re-checks-out the PR.
  it("keeps the opened AI session mounted while another tab is shown", () => {
    const { rerender } = render(
      <PrInfoPanel pr={pr} tab="ai" onTabChange={vi.fn()} aiOpened={true} />,
    );
    expect(ai.mounts).toBe(1);

    rerender(<PrInfoPanel pr={pr} tab="issue" onTabChange={vi.fn()} aiOpened={true} />);
    expect(screen.getByTestId("issue-pane")).toBeTruthy();
    expect(screen.getByTestId("ai-pane")).toBeTruthy();
    expect(ai.mounts).toBe(1);
  });

  // The regression this rail's `hidden` (rather than `return null`) exists for:
  // ⌘L used to be able to kill a live session.
  it("keeps the AI session mounted when the rail is collapsed", () => {
    const { rerender } = render(
      <PrInfoPanel pr={pr} tab="ai" onTabChange={vi.fn()} aiOpened={true} />,
    );
    expect(ai.mounts).toBe(1);

    model.infoCollapsed = true;
    rerender(<PrInfoPanel pr={pr} tab="ai" onTabChange={vi.fn()} aiOpened={true} />);
    expect(screen.getByTestId("ai-pane")).toBeTruthy();
    expect(ai.mounts).toBe(1);
  });
});
