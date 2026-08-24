/**
 * The AI review tab's mounting rules. Same property `PrInfoPanel.test.tsx` guards
 * for the rail: the pane spawns a PTY and checks the PR out, so *when it mounts*
 * is correctness, not a rendering detail. Opening a PR must not cost a checkout,
 * and switching tabs must not restart the session.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewPr } from "../../bindings";

const model = vi.hoisted(() => ({
  active: {
    id: "p1",
    number: 7,
    repo: "acme/app",
    title: "thing",
    checks: "Success",
  } as ReviewPr,
  showMergeQueue: false,
  fileFocus: null,
  aiReviewRequest: 0,
  infoCollapsed: false,
  toggleInfo: vi.fn(),
  repo: "acme/app",
}));
vi.mock("./model", () => ({ useReviewsModel: () => model }));

const ai = vi.hoisted(() => ({ mounts: 0 }));
vi.mock("./AiReviewSessionPane", async () => {
  const { useEffect } = await import("react");
  return {
    AiReviewSessionPane: () => {
      useEffect(() => {
        ai.mounts++;
      }, []);
      return <div data-testid="ai-review-pane" />;
    },
  };
});

vi.mock("./PrReviewPane", () => ({ PrReviewPane: () => <div data-testid="pr-pane" /> }));
vi.mock("./ChecksPane", () => ({ ChecksPane: () => <div data-testid="checks-pane" /> }));
vi.mock("./PrInfoPanel", () => ({ PrInfoPanel: () => <div /> }));
vi.mock("./ReviewHeader", () => ({ ReviewHeader: () => <div /> }));
vi.mock("./MergeQueuePane", () => ({ MergeQueuePane: () => <div /> }));
vi.mock("../../lib/queries", () => ({ useReviewDrafts: () => ({ data: drafts }) }));

import { ReviewDetail } from "./ReviewDetail";

let drafts: unknown[] = [];

beforeEach(() => {
  ai.mounts = 0;
  drafts = [];
  model.aiReviewRequest = 0;
});

describe("ReviewDetail", () => {
  it("doesn't launch the AI review just because a PR is open", () => {
    render(<ReviewDetail />);
    expect(screen.getByText("AI review")).toBeInTheDocument();
    expect(ai.mounts).toBe(0);
    expect(screen.queryByTestId("ai-review-pane")).toBeNull();
  });

  it("opens the tab when the rail asks for it, and keeps it mounted after", () => {
    model.aiReviewRequest = 1;
    render(<ReviewDetail />);
    expect(ai.mounts).toBe(1);
    expect(screen.getByTestId("ai-review-pane")).toBeInTheDocument();

    // Back to the diff: the pane hides rather than unmounting, or the session and
    // its checkout would be thrown away on every tab switch.
    screen.getByText("Pull request").click();
    expect(ai.mounts).toBe(1);
    expect(screen.getByTestId("ai-review-pane")).toBeInTheDocument();
  });

  it("counts the drafts on the tab, so they're visible from the diff", () => {
    drafts = [{ id: "d1" }, { id: "d2" }];
    render(<ReviewDetail />);
    expect(screen.getByText("2")).toBeInTheDocument();
  });
});
