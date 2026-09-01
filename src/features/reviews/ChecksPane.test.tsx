import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PrCheck, ReviewPr } from "../../bindings";

const spies = vi.hoisted(() => ({ checks: [] as PrCheck[] }));

vi.mock("../../lib/queries", () => ({
  usePrDetail: () => ({ data: { checks: spies.checks }, isLoading: false }),
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

  it("renders nothing active when every check has finished", () => {
    spies.checks = [check({ name: "lint" })];
    const { container } = render(<ChecksPane pr={pr} />);
    expect(container.querySelector(".animate-pulse")).toBeNull();
  });
});
