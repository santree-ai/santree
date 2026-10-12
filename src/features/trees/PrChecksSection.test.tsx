import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PrCheck, ReviewPr } from "../../bindings";

const spies = vi.hoisted(() => ({
  addItem: vi.fn(),
  showCheckLog: vi.fn(),
  checks: [] as PrCheck[],
  items: [] as { source: string; sourceId: string | null }[],
}));

vi.mock("../../lib/queries", () => ({
  usePrDetail: () => ({ data: { checks: spies.checks }, isLoading: false }),
  useReviewWorkItems: () => ({ data: spies.items }),
  useAddReviewWorkItem: () => ({ mutate: spies.addItem, isPending: false }),
}));

vi.mock("./model", () => ({ useTrees: () => ({ showCheckLog: spies.showCheckLog }) }));

import { PrChecksSection } from "./PrChecksSection";

function check(over: Partial<PrCheck> = {}): PrCheck {
  return {
    name: "test (ubuntu-latest)",
    status: "Failure",
    description: "GitHub Actions",
    url: "https://github.com/acme/api/actions/runs/1/job/2",
    steps: [],
    annotations: [],
    jobId: 2,
    runId: 1,
    startedAt: "2026-08-26T14:21:00Z",
    completedAt: "2026-08-26T14:24:00Z",
    ...over,
  };
}

const pr = { id: "p1", repo: "acme/api", number: 7 } as ReviewPr;

function renderSection(checks: PrCheck[], items: typeof spies.items = []) {
  spies.checks = checks;
  spies.items = items;
  const result = render(<PrChecksSection pr={pr} />);
  // The list starts collapsed (see the default-state test below), so expand
  // before asserting on rows.
  // Any tally word gets us the summary button; a mixed run has several.
  const summary = screen.getAllByText(/passing|failing|running|other/)[0];
  fireEvent.click(summary.closest("button") as HTMLElement);
  return result;
}

describe("PrChecksSection", () => {
  /** A queued/in-progress run is what you're waiting on — it gets counted by
   *  name in the summary and listed after failures but above the passed checks, rather than
   *  disappearing into the "other" tally. */
  it("summarizes the run by outcome, listing running checks above the passed ones", () => {
    renderSection([
      check({ name: "lint", status: "Success" }),
      check({ name: "docs", status: "Skipped" }),
      check({ name: "e2e", status: "Pending" }),
      check({ name: "build", status: "Pending" }),
      check({ name: "unit", status: "Failure" }),
    ]);

    expect(screen.getByText("failing").previousSibling).toHaveTextContent("1");
    expect(screen.getByText("running").previousSibling).toHaveTextContent("2");
    expect(screen.getByText("other").previousSibling).toHaveTextContent("1");

    // The section headers, in the order they render.
    const headers = screen.getAllByTitle(/⌘-click for all/);
    expect(headers.map((h) => h.textContent?.trim())).toEqual([
      "1 failed",
      "2 running",
      "1 passed",
      "1 skipped",
    ]);
  });

  /** A repo can run a hundred path-filter checks on one change. Listing them by
   *  default buries the conversation and the brief under a wall of rows — the
   *  summary line is the answer nearly every time. */
  it("starts collapsed, whatever the outcome", () => {
    spies.items = [];

    spies.checks = [check({ status: "Success" })];
    const green = render(<PrChecksSection pr={pr} />);
    expect(screen.queryByText("1 passed")).toBeNull();
    green.unmount();

    spies.checks = [check({ status: "Failure" })];
    render(<PrChecksSection pr={pr} />);
    expect(screen.queryByText("1 failed")).toBeNull();
    // ...and the summary still says what happened without expanding anything.
    expect(screen.getByText("failing")).toBeInTheDocument();
  });

  it("expands a check to its metadata, and opens its log in the main area", () => {
    renderSection([check()]);
    fireEvent.click(screen.getByRole("button", { name: /test \(ubuntu-latest\)/ }));
    expect(screen.getByText("check #2")).toBeInTheDocument();
    expect(screen.getByText("workflow #1")).toBeInTheDocument();

    fireEvent.click(screen.getByText("View full details"));
    expect(spies.showCheckLog).toHaveBeenCalledWith({
      jobId: 2,
      name: "test (ubuntu-latest)",
      url: "https://github.com/acme/api/actions/runs/1/job/2",
      prRepo: "acme/api",
    });
  });

  /** A status context has no Actions run behind it, so there is no log to open —
   *  and AGENTS.md forbids rendering a control that can't do anything. */
  it("offers no log for a check with no job, and no queueing for one that passed", () => {
    renderSection([check({ status: "Success", jobId: null, runId: null })]);
    fireEvent.click(screen.getByRole("button", { name: /test \(ubuntu-latest\)/ }));
    expect(screen.queryByText("View full details")).toBeNull();
    expect(screen.queryByText("Add to queue")).toBeNull();
  });

  it("queues a failing check by name", () => {
    renderSection([check()]);
    fireEvent.click(screen.getByRole("button", { name: /test \(ubuntu-latest\)/ }));
    fireEvent.click(screen.getByText("Add to queue"));

    expect(spies.addItem).toHaveBeenCalledWith(
      expect.objectContaining({ source: "check", sourceId: "test (ubuntu-latest)" }),
    );
  });

  it("says so when the check is already queued", () => {
    renderSection([check()], [{ source: "check", sourceId: "test (ubuntu-latest)" }]);
    fireEvent.click(screen.getByRole("button", { name: /test \(ubuntu-latest\)/ }));
    expect(screen.getByText("In queue")).toBeInTheDocument();
  });
});
