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
  model.infoCollapsed = false;
});

describe("PrInfoPanel", () => {
  it("shows the pull request description without an Ask AI rail", () => {
    render(<PrInfoPanel pr={pr} tab="description" onTabChange={vi.fn()} />);
    expect(screen.queryByText("Ask AI")).toBeNull();
  });

  it("shows the linked issue tab", () => {
    render(<PrInfoPanel pr={pr} tab="issue" onTabChange={vi.fn()} />);
    expect(screen.getByTestId("issue-pane")).toBeTruthy();
  });
});
