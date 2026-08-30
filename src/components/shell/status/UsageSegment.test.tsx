import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ApiBudgetWindow,
  ClaudeRateLimitWindow,
  ClaudeUsageFetch,
  GithubApiBudget,
  LinearApiBudget,
  SessionUsageLive,
} from "../../../bindings";
import { UsageSegment } from "./UsageSegment";

// The segment is a leaf over the usage hooks: mock the data layer so it renders
// without a Tauri backend. Both providers stay silent here — what these tests
// are about is the service half of the cluster (GitHub, Linear).
let github: GithubApiBudget | null | undefined;
let linear: LinearApiBudget[] | undefined;
let account: ClaudeUsageFetch | undefined;
let stored: ClaudeRateLimitWindow[] | undefined;
let live: SessionUsageLive[] | undefined;
const githubEnabled = vi.fn();
const linearEnabled = vi.fn();
const githubRefetch = vi.fn();
const linearRefetch = vi.fn();

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

vi.mock("../../../lib/queries", () => ({
  useClaudeAccountUsage: () => ({ data: account, refetch: vi.fn(), isFetching: false }),
  useClaudeGlobalCapture: () => ({ data: undefined }),
  useClaudeRateLimits: () => ({ data: stored }),
  useCodexAccount: () => ({ data: undefined }),
  useCodexHealth: () => ({ data: undefined }),
  useCodexRateLimits: () => ({ data: undefined, refetch: vi.fn(), isFetching: false }),
  useSessionUsageLive: () => ({ data: live }),
  useGithubApiBudget: (enabled: boolean) => {
    githubEnabled(enabled);
    return { data: github, refetch: githubRefetch, isFetching: false };
  },
  useLinearApiBudget: (enabled: boolean) => {
    linearEnabled(enabled);
    return { data: linear, refetch: linearRefetch, isFetching: false };
  },
}));

const HOUR = 3_600_000;

function pool(kind: ApiBudgetWindow["kind"], remaining: number, limit: number): ApiBudgetWindow {
  return { kind, limit, remaining, resetsAtMs: Date.now() + HOUR };
}

function org(slug: string, name: string, windows: ApiBudgetWindow[]): LinearApiBudget {
  return { slug, name, windows, observedAtMs: Date.now() };
}

/** Open the panel and hand back its menu. */
function openPanel(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: /Usage/ }));
  return screen.getByRole("menu");
}

describe("UsageSegment — services", () => {
  beforeEach(() => {
    github = undefined;
    linear = undefined;
    account = undefined;
    stored = undefined;
    live = undefined;
    for (const fn of [githubEnabled, linearEnabled, githubRefetch, linearRefetch]) fn.mockClear();
  });

  /** The gate that matters: reading Linear's budget can cost a request, so a
   *  collapsed bar — which shows no service numbers at all — must not ask. */
  it("asks neither service for a budget while the panel is shut", () => {
    render(<UsageSegment />);
    expect(githubEnabled).toHaveBeenCalled();
    expect(githubEnabled).not.toHaveBeenCalledWith(true);
    expect(linearEnabled).not.toHaveBeenCalledWith(true);
  });

  it("reads both budgets once the panel opens", () => {
    render(<UsageSegment />);
    openPanel();
    expect(githubEnabled).toHaveBeenCalledWith(true);
    expect(linearEnabled).toHaveBeenCalledWith(true);
  });

  /** Refetch runs whatever `enabled` says, so the always-visible refresh button
   *  would otherwise spend a Linear request on a panel nobody has open. */
  it("leaves the services alone when refreshing a shut panel", () => {
    const { container } = render(<UsageSegment />);
    // The bar's own refresh — the panel carries a second one under the same name.
    const barRefresh = () => within(container).getByRole("button", { name: "Refresh usage" });
    fireEvent.click(barRefresh());
    expect(linearRefetch).not.toHaveBeenCalled();

    openPanel();
    fireEvent.click(barRefresh());
    expect(linearRefetch).toHaveBeenCalledTimes(1);
    expect(githubRefetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the bar to marks — no service numbers beside them", () => {
    github = { windows: [pool("Search", 28, 30)] };
    render(<UsageSegment />);
    const trigger = screen.getByRole("button", { name: /Usage/ });
    expect(trigger.textContent).not.toContain("28");
    // The marks are decorative, so the button's name is what says they're there.
    expect(trigger.getAttribute("aria-label")).toContain("GitHub and Linear API budgets");
  });

  /** "Unknown" and "empty" are different claims: `gh` signed out answers `null`
   *  and no workspace answers `[]`. Either way there is nothing to meter, and a
   *  row of zeroes would read as "you're out". */
  it("renders no row for a service that hasn't answered", () => {
    github = null;
    linear = [];
    render(<UsageSegment />);
    const menu = openPanel();
    expect(menu.textContent).not.toContain("GitHub");
    expect(menu.textContent).not.toContain("Linear");
    expect(menu.textContent).toContain("all agents");
  });

  it("renders no row for a workspace that reported no pools", () => {
    linear = [org("acme", "Acme", [])];
    render(<UsageSegment />);
    expect(openPanel().textContent).not.toContain("Linear");
  });

  it("spells each pool out with what is left of it", () => {
    github = { windows: [pool("Rest", 4982, 5000), pool("Search", 28, 30)] };
    render(<UsageSegment />);
    const menu = openPanel();
    // Labels come from the settings vocabulary, not a second one.
    expect(menu.textContent).toContain("REST");
    expect(menu.textContent).toContain("Search");
    expect(menu.textContent).toContain("4,982 / 5,000");
    expect(menu.textContent).toContain("resets in 1h");
    expect(menu.textContent).toContain("agents & services");
  });

  /** Linear's limits are per user per OAuth app, so two workspaces really are
   *  two budgets — but with one connected the name only restates the row. */
  it("names the workspace only when more than one is connected", () => {
    linear = [org("acme", "Acme", [pool("Requests", 900, 1200)])];
    const single = render(<UsageSegment />);
    expect(openPanel().textContent).not.toContain("Acme");
    single.unmount();

    linear = [
      org("acme", "Acme", [pool("Requests", 900, 1200)]),
      org("beta", "Beta Corp", [pool("Requests", 100, 1200)]),
    ];
    render(<UsageSegment />);
    const menu = openPanel();
    expect(menu.textContent).toContain("Acme");
    expect(menu.textContent).toContain("Beta Corp");
  });
});

const WEEK = 7 * 24 * HOUR;

function window(name: string, usedPct: number, resetsInMs: number): ClaudeRateLimitWindow {
  return { window: name, usedPct, resetsAtMs: Date.now() + resetsInMs, updatedAtMs: Date.now() };
}

/** The statusline rows a busy account has: the 5h window, the weekly one, and
 *  the per-model weekly window Claude reports beside them. */
const statusLineRows = [
  window("five_hour", 1, 4 * HOUR),
  window("seven_day", 43, 4 * WEEK),
  window("seven_day_fable", 59, 4 * WEEK),
];

/** Claude's block in the panel — the button whose accessible name starts with
 *  the provider's own. */
function claudeRow(menu: HTMLElement): HTMLElement {
  return within(menu).getByRole("button", { name: /^Claude/ });
}

/** How many metered lines a row drew, counted by the one thing every line
 *  carries and the row itself does not: its own countdown. */
function resetCount(row: HTMLElement): number {
  return (row.textContent?.match(/resets in/g) ?? []).length;
}

describe("UsageSegment — Claude windows", () => {
  beforeEach(() => {
    github = undefined;
    linear = undefined;
    account = undefined;
    stored = undefined;
    live = undefined;
  });

  /** Bug A. An account read that failed answers `{ windows: [], status }` — and
   *  `[]` is not nullish, so a `??` fallback never reached the statusline rows
   *  and the weekly + per-model windows vanished behind a stand-in. Two sources
   *  exist precisely so one of them being empty is survivable. */
  it("falls back to the stored statusline rows when Anthropic answers empty", () => {
    account = { windows: [], status: "Unavailable", detail: "Anthropic answered 429" };
    stored = statusLineRows;
    render(<UsageSegment />);
    const trigger = screen.getByRole("button", { name: /Usage/ });
    // The weekly window and the per-model one, spelled out beside the 5h.
    expect(trigger.textContent).toContain("1% used");
    expect(trigger.textContent).toContain("43% used");
    expect(trigger.textContent).toContain("59% used Fable");
    const menu = openPanel();
    // The panel spells the windows out where the bar abbreviates them.
    expect(menu.textContent).toContain("Weekly");
    expect(menu.textContent).toContain("Fable");
  });

  /** The whole point of the expanded row: three windows, three labelled lines,
   *  each with its own bar and its own countdown — the same shape the GitHub and
   *  Linear pools below it are drawn in. */
  it("gives every window its own labelled row", () => {
    stored = statusLineRows;
    render(<UsageSegment />);
    const row = claudeRow(openPanel());
    for (const label of ["5 hours", "Weekly", "Fable"]) {
      expect(row.textContent).toContain(label);
    }
    expect(resetCount(row)).toBe(3);
  });

  /** A window resets when it resets: the 5-hour one rolls hours before the
   *  weekly and per-model ones do, so one countdown on the name line would be
   *  wrong for two of the three rows. */
  it("counts each window down to its own reset", () => {
    stored = [window("five_hour", 52, HOUR + 57 * 60_000), window("seven_day", 64, 3 * 24 * HOUR)];
    render(<UsageSegment />);
    const row = claudeRow(openPanel());
    expect(row.textContent).toContain("resets in 1h 57m");
    expect(row.textContent).toContain("resets in 3d");
  });

  /** Whatever the account reports, not a fixed three: an account with no
   *  model-scoped window gets two rows, never a third standing empty. */
  it("renders only the windows the account actually reports", () => {
    stored = [window("five_hour", 12, HOUR), window("seven_day", 40, 2 * WEEK)];
    render(<UsageSegment />);
    const row = claudeRow(openPanel());
    expect(resetCount(row)).toBe(2);
    expect(row.textContent).not.toContain("Fable");
  });

  it("renders a single window as a single row", () => {
    stored = [window("five_hour", 7, HOUR)];
    render(<UsageSegment />);
    const row = claudeRow(openPanel());
    expect(resetCount(row)).toBe(1);
    expect(row.textContent).toContain("5 hours");
    expect(row.textContent).not.toContain("Weekly");
  });

  it("prefers Anthropic's own answer over the stored rows when it has one", () => {
    account = { windows: [window("five_hour", 12, HOUR)], status: "Ok", detail: null };
    stored = statusLineRows;
    render(<UsageSegment />);
    const trigger = screen.getByRole("button", { name: /Usage/ });
    expect(trigger.textContent).toContain("12% used");
    expect(trigger.textContent).not.toContain("43% used");
  });

  /** Bug B. The context-fill stand-in filled the row, so `note` was computed as
   *  null and the panel could never say what had actually gone wrong. A context
   *  fill is also a different quantity at a different scope — the fullest
   *  session anywhere — so showing it against a weekly budget was two readings
   *  of "55%" meaning different things. */
  it("says why there is nothing rather than metering a session's context fill", () => {
    account = {
      windows: [],
      status: "Unavailable",
      detail: "Anthropic answered 429 Too Many Requests",
    };
    live = [
      {
        agentKind: "Claude",
        sessionId: "s1",
        usedPct: 55,
        inputTokens: 550_000,
        contextSize: 1_000_000,
        model: "claude-opus-5",
        costUsd: 3,
        updatedAtMs: Date.now(),
      },
    ];
    render(<UsageSegment />);
    const menu = openPanel();
    expect(menu.textContent).toContain("Anthropic answered 429 Too Many Requests");
    expect(menu.textContent).not.toContain("Context fill");
    expect(menu.textContent).not.toContain("55");
    // No windows means no metered lines at all — not a row of zeroes, and not a
    // countdown to a reset nobody reported.
    const row = claudeRow(menu);
    expect(resetCount(row)).toBe(0);
    expect(row.textContent).not.toContain("%");
  });

  it("names the sign-in as the reason when no credential answered", () => {
    account = { windows: [], status: "NoCredentials", detail: null };
    render(<UsageSegment />);
    expect(openPanel().textContent).toContain("Sign in to Claude Code");
  });

  /** "Not signed in" is a claim, and the first read is still in flight — an
   *  unasked question must not be reported as an answer. */
  it("stays quiet about why until Anthropic has actually been asked", () => {
    render(<UsageSegment />);
    const menu = openPanel();
    expect(menu.textContent).toContain("No usage data");
    expect(menu.textContent).not.toContain("Sign in to Claude Code");
  });
});
