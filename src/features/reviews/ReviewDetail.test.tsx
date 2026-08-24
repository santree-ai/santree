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
    aiReviewTermKey: () => "review:acme/app#7",
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
vi.mock("../../lib/queries", () => ({
  REVIEW_AGENT_KEY: "review.agent",
  useAgentAuth: () => ({ data: { connected: true } }),
  useCodexAccount: () => ({ data: { connected: true } }),
  useCodexHealth: () => ({ data: { available: true } }),
  useResolvedSetting: () => ({ data: "Codex" }),
  useReviewDrafts: () => ({ data: drafts }),
  useSessionProviders: () => ({ data: storedProviders }),
}));

import { ReviewDetail } from "./ReviewDetail";

let drafts: unknown[] = [];
let storedProviders: string[] = [];

beforeEach(() => {
  ai.mounts = 0;
  drafts = [];
  storedProviders = [];
  model.aiReviewRequest = 0;
});

describe("ReviewDetail", () => {
  it("doesn't launch the AI review just because a PR is open", () => {
    render(<ReviewDetail />);
    expect(screen.getByRole("button", { name: "Review with another agent" })).toBeInTheDocument();
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

  it("counts only each provider's drafts on its tab", () => {
    drafts = [
      { id: "d1", agentKind: "Codex" },
      { id: "d2", agentKind: "Claude" },
      { id: "d3", agentKind: "Claude" },
    ];
    storedProviders = ["Codex", "Claude"];
    render(<ReviewDetail />);
    expect(screen.getByRole("tab", { name: "Codex1" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Claude Code2" })).toBeInTheDocument();
  });
});
