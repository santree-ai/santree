import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SessionDetail, SessionSubagent, WorktreeSession } from "../../bindings";

const spies = vi.hoisted(() => ({
  sessions: [] as WorktreeSession[],
  detail: undefined as SessionDetail | undefined,
  subagents: [] as SessionSubagent[],
  /** Every `(sessionId, enabled)` the two lazy reads were mounted with — the
   *  gate that keeps a collapsed row from touching disk. */
  detailCalls: [] as [string, boolean][],
  subagentCalls: [] as [string, boolean][],
  reveal: vi.fn(),
}));

vi.mock("../../lib/queries", () => ({
  useWorktreeSessions: () => ({ data: spies.sessions, refetch: vi.fn(), isFetching: false }),
  useWorktreeSessionDetail: (_r: string, _i: string, sessionId: string, enabled: boolean) => {
    spies.detailCalls.push([sessionId, enabled]);
    return { data: enabled ? spies.detail : undefined };
  },
  useWorktreeSessionSubagents: (_r: string, _i: string, sessionId: string, enabled: boolean) => {
    spies.subagentCalls.push([sessionId, enabled]);
    return { data: enabled ? spies.subagents : undefined };
  },
  useRevealSessionTranscript: () => ({ mutate: spies.reveal }),
  useAddWorktreeTab: () => ({ mutateAsync: vi.fn() }),
  useResumeWorktreeSession: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("./model", () => ({
  useTrees: () => ({
    repo: "acme/app",
    activeId: "AK-1",
    active: { branch: "feat/ak-1" },
    extraTabs: [],
    setActiveTab: vi.fn(),
  }),
  defaultTabTitle: () => "Claude",
  extraTab: (id: string) => id,
}));

vi.mock("../../state/AppContext", () => ({ useApp: () => ({ activeRepo: "acme/app" }) }));
vi.mock("../agents/useAgents", () => ({ useAgentEntries: () => [] }));
vi.mock("../agents/useOpenAgent", () => ({ useOpenAgent: () => vi.fn() }));

import { SessionHistory } from "./SessionHistory";

function session(over: Partial<WorktreeSession> = {}): WorktreeSession {
  return {
    sessionId: "s1",
    agentKind: "Claude",
    termKey: null,
    title: "Refactor the parser",
    lastMessage: "Done.",
    lastMessageFrom: "Agent",
    messageCount: 12,
    subagentCount: 0,
    model: "claude-opus-4-8",
    startedAtMs: null,
    lastActivityMs: 1_700_000_000_000,
    spend: null,
    ...over,
  };
}

function subagent(over: Partial<SessionSubagent> = {}): SessionSubagent {
  return {
    agentId: "a1",
    parentAgentId: null,
    depth: 1,
    agentType: "Explore",
    description: "Find the parser",
    messageCount: 4,
    status: "Completed",
    lastActivityMs: null,
    ...over,
  };
}

function reset(sessions: WorktreeSession[]) {
  spies.sessions = sessions;
  spies.detail = undefined;
  spies.subagents = [];
  spies.detailCalls = [];
  spies.subagentCalls = [];
  spies.reveal.mockClear();
}

/** The row's own toggle, by its accessible name (the chevron has its own). */
function rowToggle(title: string) {
  return screen.getByRole("button", {
    name: new RegExp(`session: ${title}\\. (Show|Hide) details`),
  });
}

describe("SessionHistory rows", () => {
  it("expands on the row and on the chevron, and both point at the same region", () => {
    reset([session()]);
    render(<SessionHistory />);
    const row = rowToggle("Refactor the parser");
    const chevron = screen.getByRole("button", { name: /Expand Claude Code session/ });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(chevron.getAttribute("aria-controls")).toBe(row.getAttribute("aria-controls"));

    fireEvent.click(chevron);
    expect(rowToggle("Refactor the parser")).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: /Collapse Claude Code session/ }));
    expect(rowToggle("Refactor the parser")).toHaveAttribute("aria-expanded", "false");
  });

  /** Comparing two sessions side by side is the reason to expand one at all, so
   *  opening the second must not close the first. */
  it("keeps several rows open at once", () => {
    reset([session(), session({ sessionId: "s2", title: "Fix the lexer" })]);
    render(<SessionHistory />);
    fireEvent.click(rowToggle("Refactor the parser"));
    fireEvent.click(rowToggle("Fix the lexer"));
    expect(rowToggle("Refactor the parser")).toHaveAttribute("aria-expanded", "true");
    expect(rowToggle("Fix the lexer")).toHaveAttribute("aria-expanded", "true");
  });

  /** The whole point of the lazy reads: a list of collapsed rows touches no
   *  transcript, and a session with no subagents never asks for them. */
  it("reads nothing until a row is expanded, and skips subagents when there are none", () => {
    reset([session()]);
    render(<SessionHistory />);
    expect(spies.detailCalls).toEqual([]);

    fireEvent.click(rowToggle("Refactor the parser"));
    expect(spies.detailCalls.at(-1)).toEqual(["s1", true]);
    expect(spies.subagentCalls.at(-1)).toEqual(["s1", false]);
  });

  it("asks for subagents once a row with some is expanded", () => {
    reset([session({ subagentCount: 2 })]);
    spies.subagents = [
      subagent(),
      subagent({ agentId: "a2", parentAgentId: "a1", depth: 2, description: "Check the tests" }),
    ];
    render(<SessionHistory />);
    fireEvent.click(rowToggle("Refactor the parser"));
    expect(spies.subagentCalls.at(-1)).toEqual(["s1", true]);
    expect(screen.getByText("Find the parser")).toBeTruthy();
    expect(screen.getByText("Check the tests")).toBeTruthy();
  });

  it("shows the full first prompt from the lazy read, not the list's one-liner", () => {
    reset([session({ title: "Refactor the parser" })]);
    spies.detail = {
      firstPrompt: "Refactor the parser, and keep the error spans intact.",
      firstPromptTruncated: false,
      recentTurns: [{ from: "You", text: "and the lexer?" }],
      cwd: "/Users/me/repo/.santree/worktrees/AK-1",
    };
    render(<SessionHistory />);
    fireEvent.click(rowToggle("Refactor the parser"));
    expect(screen.getByText("Refactor the parser, and keep the error spans intact.")).toBeTruthy();
    expect(screen.getByText("and the lexer?")).toBeTruthy();
    // The path is compacted in the row and whole in its tooltip.
    expect(screen.getByTitle("/Users/me/repo/.santree/worktrees/AK-1").textContent).toBe(
      "…/worktrees/AK-1",
    );
  });

  /** A session with nothing on disk says so, and names what is still there —
   *  rather than rendering two empty sections. */
  it("replaces the conversation sections when nothing was saved", () => {
    reset([session({ messageCount: 0, subagentCount: 3, lastMessage: null })]);
    render(<SessionHistory />);
    fireEvent.click(rowToggle("Refactor the parser"));
    expect(screen.getByText("Conversation not saved.")).toBeTruthy();
    expect(screen.queryByText("First prompt")).toBeNull();
    const resume = screen.getByRole("button", { name: "Resume" });
    expect(resume).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/recorded no conversation/)).toBeTruthy();
  });

  /** An unpriced model sends `null`, and a `$0.00` would read as free. */
  it("omits the cost when the session has no priced model", () => {
    reset([
      session({
        spend: {
          totalTokens: 12_300,
          costUsd: null,
          models: [{ model: "mystery", totalTokens: 12_300, costUsd: null }],
        },
      }),
    ]);
    render(<SessionHistory />);
    const row = rowToggle("Refactor the parser");
    expect(within(row).getByText(/12\.3k/)).toBeTruthy();
    expect(row.textContent).not.toContain("$");
  });

  it("shows tokens and cost together when the model is priced", () => {
    reset([
      session({
        spend: {
          totalTokens: 12_300,
          costUsd: 0.41,
          models: [{ model: "claude-opus-4-8", totalTokens: 12_300, costUsd: 0.41 }],
        },
      }),
    ]);
    render(<SessionHistory />);
    const row = rowToggle("Refactor the parser");
    expect(within(row).getByText(/12\.3k/)).toBeTruthy();
    expect(within(row).getByText(/\$0\.41/)).toBeTruthy();
  });

  it("reveals the transcript by session id, never by a path", () => {
    reset([session()]);
    render(<SessionHistory />);
    fireEvent.click(rowToggle("Refactor the parser"));
    fireEvent.click(screen.getByRole("button", { name: /Open transcript/ }));
    expect(spies.reveal).toHaveBeenCalledWith("s1");
  });
});
