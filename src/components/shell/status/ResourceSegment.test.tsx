import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ResourceUsage } from "../../../bindings";
import { ResourceSegment } from "./ResourceSegment";

// The segment is a leaf over one query hook, so mocking the data layer is enough
// to render it without a Tauri backend.
let usage: ResourceUsage | undefined;

vi.mock("../../../lib/queries", () => ({
  useResourceUsage: () => ({ data: usage, refetch: vi.fn(), isFetching: false }),
}));

/**
 * The snapshot that produced the bug: a 14-core machine, a summed `pcpu` in the
 * hundreds, and the app's own subtree carrying most of it. Read off the panel
 * that reported "812.5% ∑ CPU, 7.79 GB ∑ RSS".
 */
function snapshot(overrides: Partial<ResourceUsage> = {}): ResourceUsage {
  return {
    sampledAtMs: 1_700_000_000_000,
    coreCount: 14,
    totalRssBytes: 7.79e9,
    totalCpuPct: 812.5,
    repos: [
      {
        repo: "santree",
        cpuPct: 700,
        rssBytes: 7.6655e9,
        worktrees: [
          {
            id: "santree",
            label: "santree",
            cpuPct: 700,
            rssBytes: 7.6655e9,
            terminals: [
              {
                sessionId: null,
                label: "santree",
                pid: 6702,
                cpuPct: 699.5,
                rssBytes: 7.66e9,
                live: true,
              },
              // Alive but nearly idle: the row still has to read as running.
              {
                sessionId: null,
                label: "caffeinate",
                pid: 10406,
                cpuPct: 0.5,
                rssBytes: 4.5e6,
                live: true,
              },
              {
                sessionId: null,
                label: "git",
                pid: 10407,
                cpuPct: 0,
                rssBytes: 1e6,
                live: false,
              },
            ],
          },
        ],
      },
      {
        repo: "acme/app",
        cpuPct: 112.5,
        rssBytes: 1.245e8,
        worktrees: [
          {
            id: "AK-1",
            label: "Fix login",
            cpuPct: 112.5,
            rssBytes: 1.245e8,
            terminals: [
              {
                sessionId: 3,
                label: "claude",
                pid: 20001,
                cpuPct: 112.5,
                rssBytes: 1.245e8,
                live: true,
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

/** Open the panel and hand back its menu. */
function openPanel(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: /Resource manager/ }));
  return screen.getByRole("menu");
}

/** The summary line, located by the one label only it carries. */
function header(menu: HTMLElement): HTMLElement {
  const cores = within(menu).getByText(/^of \d+ cores$/);
  if (!cores.parentElement) throw new Error("summary line has no row");
  return cores.parentElement;
}

describe("ResourceSegment", () => {
  it("renders CPU as a share of the machine, never the raw per-core sum", () => {
    usage = snapshot();
    render(<ResourceSegment />);
    const menu = openPanel();

    // 812.5% of one core across 14 cores is 58% of the machine. The raw figure
    // is the one that read as impossible, so it must not appear anywhere.
    expect(within(header(menu)).getByText("58.0%")).toBeTruthy();
    expect(within(menu).queryByText("812.5%")).toBeNull();
    expect(within(menu).queryByText("699.5%")).toBeNull();

    // The denominator is on-screen, not only in a tooltip.
    expect(within(menu).getByText("of 14 cores")).toBeTruthy();

    // Repo, worktree and terminal rows share the total's scale, or the tree
    // would not add up to the summary above it.
    expect(within(menu).getAllByText("50.0%")).toHaveLength(3);
    expect(within(menu).getAllByText("8.0%")).toHaveLength(3);
  });

  it("keeps a nearly idle process distinguishable from a stopped one", () => {
    usage = snapshot();
    render(<ResourceSegment />);
    const menu = openPanel();

    // 0.5% of one core is 0.036% of the machine: rounding that to "0.0%" would
    // make a tree of live helpers look dead.
    expect(within(menu).getByText("<0.1%")).toBeTruthy();
    expect(within(menu).getByText("0%")).toBeTruthy();
  });

  it("explains both metrics without the tooltip being the only route", () => {
    usage = snapshot();
    render(<ResourceSegment />);
    const menu = openPanel();
    const summary = header(menu);

    const cpu = within(summary).getByText(/Share of all logical cores/);
    const rss = within(summary).getByText(/Summed resident set size/);
    expect(cpu.className).toContain("sr-only");
    expect(rss.className).toContain("sr-only");

    // The same copy is on the hoverable figures.
    expect(within(summary).getByText("58.0%").getAttribute("title")).toMatch(
      /Share of all logical cores/,
    );
    expect(within(summary).getByText("7.79 GB").getAttribute("title")).toMatch(
      /Summed resident set size/,
    );
  });

  it("never divides by zero when the snapshot has no core count", () => {
    // Not reachable from our own backend, which never sends 0, but a payload
    // cached by an older build would otherwise render "Infinity%".
    usage = snapshot({ coreCount: 0, totalCpuPct: 50 });
    render(<ResourceSegment />);
    const menu = openPanel();

    expect(within(header(menu)).getByText("50.0%")).toBeTruthy();
  });
});
