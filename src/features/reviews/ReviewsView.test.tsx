import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { Worktree } from "../../bindings";

// Mock the generated bridge so the view renders against fixed data, never IPC.
const worktrees: Worktree[] = [
  {
    id: "AK-201",
    title: "Booking confirmation webhook + retries",
    status: "InReview",
    addLines: 186,
    delLines: 12,
    dirty: false,
    ahead: 2,
    agent: "Codex",
    activity: "Running",
    pr: { number: 483, checks: "Running" },
  },
  {
    id: "AK-165",
    title: "Spike: Auto learn from PCA",
    status: "InProgress",
    addLines: 540,
    delLines: 121,
    dirty: true,
    ahead: 7,
    agent: "Claude",
    activity: "Running",
    pr: null, // no PR → excluded from Reviews
  },
];

vi.mock("../../bindings", () => ({
  commands: { listWorktrees: () => Promise.resolve(worktrees) },
}));

import { ReviewsList } from "./ReviewsView";

function renderWithQuery(ui: ReactNode) {
  const queryClient = new QueryClient();
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("ReviewsView", () => {
  it("lists only worktrees that have an open PR", async () => {
    renderWithQuery(<ReviewsList />);

    expect(await screen.findByText("PR #483")).toBeInTheDocument();
    expect(screen.getByText("Booking confirmation webhook + retries")).toBeInTheDocument();
    // The worktree without a PR must not appear.
    expect(screen.queryByText("Spike: Auto learn from PCA")).not.toBeInTheDocument();
  });
});
