/**
 * The one claim this segment makes: the numbers belong to the agent tab you are
 * looking at. It used to join the *open worktree* to its main terminal, which is
 * a different claim — `openWorktree` deliberately outlives a navigation, so the
 * meter followed you onto Triage and Settings, and inside Trees it metered the
 * work session while you were reading a second agent's tab.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionState, SessionUsageLive } from "../../../bindings";
import type { FocusedAgent } from "../../../state/AppContext";
import { SessionSegment } from "./SessionSegment";

let pathname = "/trees";
let focusedAgent: FocusedAgent | null = null;
let sessions: SessionState[] = [];
let live: SessionUsageLive[] = [];

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname } }),
}));

vi.mock("../../../state/AppContext", () => ({ useAppUi: () => ({ focusedAgent }) }));

vi.mock("../../../lib/queries", () => ({
  CLAUDE_STATUS_LINE_KEY: "claude_status_line",
  useBoolSetting: () => ({ value: true, loading: false, isFetched: true }),
  useSessionStates: () => ({ data: sessions }),
  useSessionUsageLive: () => ({ data: live }),
}));

function session(sessionId: string, termKey: string): SessionState {
  return {
    agentKind: "Claude",
    sessionId,
    state: "Working",
    event: "Stop",
    cwd: "/tmp/ak-1",
    message: null,
    transcriptPath: null,
    updatedAtMs: Date.now(),
    repo: "acme/app",
    termKey,
  };
}

function usage(sessionId: string, usedPct: number, costUsd: number | null): SessionUsageLive {
  return {
    agentKind: "Claude",
    sessionId,
    usedPct,
    inputTokens: 100_000,
    contextSize: 1_000_000,
    model: "claude-opus-5",
    costUsd,
    updatedAtMs: Date.now(),
  };
}

const workSession = session("work", "tree:AK-1");
const tabSession = session("tab", "tree:AK-1:tab:a1");

describe("SessionSegment", () => {
  beforeEach(() => {
    pathname = "/trees";
    focusedAgent = { repo: "acme/app", termKey: "tree:AK-1", agentKind: "Claude" };
    sessions = [workSession, tabSession];
    live = [usage("work", 40, 1.5), usage("tab", 70, 9)];
  });

  it("meters the focused tab's own session, not the worktree's work session", () => {
    focusedAgent = { repo: "acme/app", termKey: "tree:AK-1:tab:a1", agentKind: "Claude" };
    render(<SessionSegment />);
    // 70 raw → 84 shown (the shared 1.2x nudge), not the work session's 48.
    expect(screen.getByText("84%")).toBeTruthy();
    expect(screen.queryByText("48%")).toBeNull();
  });

  /** The whole point of scoping it: the meter is workspace chrome, and Triage,
   *  Reviews and Settings have no agent tab on screen to meter. */
  it("renders nothing away from the workspace, even with a focus still published", () => {
    pathname = "/reviews";
    const { container } = render(<SessionSegment />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when no agent tab is focused", () => {
    focusedAgent = null;
    const { container } = render(<SessionSegment />);
    expect(container).toBeEmptyDOMElement();
  });

  /** A session that has never rendered a status line — and any provider santree
   *  captures no usage for — has no number, and no number is the honest answer. */
  it("renders nothing for a focused session with no usage captured", () => {
    focusedAgent = { repo: "acme/app", termKey: "tree:AK-1", agentKind: "Claude" };
    live = [];
    const { container } = render(<SessionSegment />);
    expect(container).toBeEmptyDOMElement();
  });

  /** `termKey` is unique per repo only *within* a repo — `tree:AK-1` can exist
   *  in two checkouts, and metering the wrong one is worse than metering none. */
  it("won't match a session from another repo", () => {
    focusedAgent = { repo: "other/app", termKey: "tree:AK-1", agentKind: "Claude" };
    const { container } = render(<SessionSegment />);
    expect(container).toBeEmptyDOMElement();
  });
});
