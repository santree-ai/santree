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
  it("summarizes the run by outcome", () => {
    renderSection([
      check({ name: "a", status: "Success" }),
      check({ name: "b", status: "Success" }),
      check({ name: "c", status: "Failure" }),
    ]);
    expect(screen.getByText("passing").previousSibling).toHaveTextContent("2");
    expect(screen.getByText("failing").previousSibling).toHaveTextContent("1");
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

  it("expands a check to its metadata, not its output", () => {
    renderSection([check()]);
    fireEvent.click(screen.getByRole("button", { name: /test \(ubuntu-latest\)/ }));

    expect(screen.getByText("Status:")).toBeInTheDocument();
    expect(screen.getByText("check #2")).toBeInTheDocument();
    expect(screen.getByText("workflow #1")).toBeInTheDocument();
    // The log itself is a main-area view, reached from here.
    expect(screen.getByText("View full details")).toBeInTheDocument();
  });

  /** A status context has no Actions run behind it, so there is no log to open —
   *  and CLAUDE.md forbids rendering a control that can't do anything. */
  it("offers no log for a check with no job", () => {
    renderSection([check({ status: "Success", jobId: null, runId: null })]);
    fireEvent.click(screen.getByRole("button", { name: /test \(ubuntu-latest\)/ }));
    expect(screen.queryByText("View full details")).toBeNull();
  });

  it("queues a failing check by name", () => {
    renderSection([check()]);
    fireEvent.click(screen.getByRole("button", { name: /test \(ubuntu-latest\)/ }));
    fireEvent.click(screen.getByText("Add to queue"));

    expect(spies.addItem).toHaveBeenCalledWith(
      expect.objectContaining({ source: "check", sourceId: "test (ubuntu-latest)" }),
    );
  });

  it("won't offer to queue a check that passed", () => {
    renderSection([check({ status: "Success" })]);
    fireEvent.click(screen.getByRole("button", { name: /test \(ubuntu-latest\)/ }));
    expect(screen.queryByText("Add to queue")).toBeNull();
  });

  it("says so when the check is already queued", () => {
    renderSection([check()], [{ source: "check", sourceId: "test (ubuntu-latest)" }]);
    fireEvent.click(screen.getByRole("button", { name: /test \(ubuntu-latest\)/ }));
    expect(screen.getByText("In queue")).toBeInTheDocument();
  });

  it("opens the log in the main area with what it needs to fetch it", () => {
    renderSection([check()]);
    fireEvent.click(screen.getByRole("button", { name: /test \(ubuntu-latest\)/ }));
    fireEvent.click(screen.getByText("View full details"));

    expect(spies.showCheckLog).toHaveBeenCalledWith({
      jobId: 2,
      name: "test (ubuntu-latest)",
      url: "https://github.com/acme/api/actions/runs/1/job/2",
      prRepo: "acme/api",
    });
  });
});
