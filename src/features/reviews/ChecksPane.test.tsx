import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PrCheck, ReviewPr } from "../../bindings";

const spies = vi.hoisted(() => ({ checks: [] as PrCheck[], loading: false }));

vi.mock("../../lib/queries", () => ({
  usePrDetail: () => ({ data: { checks: spies.checks }, isLoading: spies.loading }),
  usePrCheckLog: () => ({ data: null, isLoading: false }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { ChecksPane } from "./ChecksPane";

function check(over: Partial<PrCheck> = {}): PrCheck {
  return {
    name: "test (ubuntu-latest)",
    status: "Success",
    description: "GitHub Actions",
    url: null,
    steps: [],
    annotations: [],
    jobId: null,
    runId: null,
    startedAt: null,
    completedAt: null,
    ...over,
  };
}

const pr = { id: "p1", repo: "acme/api", number: 7 } as ReviewPr;

/**
 * The wait used to be four paragraph bars over a tall grey block — the generic
 * "a document is loading" placeholder, on a tab that has never held a document.
 * A skeleton that doesn't match what replaces it rearranges the page at the
 * moment the read lands, which is the one moment it should be still.
 */
describe("ChecksPane while the read is in flight", () => {
  it("claims nothing about the outcome while it waits", () => {
    spies.loading = true;
    render(<ChecksPane pr={pr} />);
    spies.loading = false;

    expect(screen.queryByText(/No checks reported/)).not.toBeInTheDocument();
  });
});

describe("ChecksPane", () => {
  /** A running check is the one you're waiting on, so it heads the list — and
   *  wears the pulsing dot rather than a glyph, which would read as a verdict. */
  it("puts running checks above the finished ones, marked as active", () => {
    spies.checks = [
      check({ name: "lint" }),
      check({ name: "docs", status: "Skipped" }),
      check({ name: "e2e", status: "Pending" }),
    ];
    const { container } = render(<ChecksPane pr={pr} />);

    const headers = screen.getAllByTitle(/⌘-click for all/);
    expect(headers.map((h) => h.textContent?.trim())).toEqual([
      "1 running",
      "✓ 1 passed",
      "↷ 1 skipped",
    ]);
    expect(screen.getByRole("img", { name: "running" })).toBeInTheDocument();
    expect(container.querySelectorAll(".animate-pulse").length).toBe(2);
  });
});
