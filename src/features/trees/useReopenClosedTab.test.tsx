import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorktreeSession } from "../../bindings";

/** What the model is asking for, and what the sessions read has come back with. */
const state = vi.hoisted(() => ({
  reopenTab: null as { worktreeId: string; tabId: string } | null,
  activeId: "AK-1",
  sessions: undefined as WorktreeSession[] | undefined,
  resumingId: null as string | null,
}));
const spies = vi.hoisted(() => ({ resume: vi.fn(), consume: vi.fn() }));

vi.mock("./model", () => ({
  useTrees: () => ({
    repo: "acme/web",
    activeId: state.activeId,
    reopenTab: state.reopenTab,
    consumeReopenTab: spies.consume,
  }),
}));
vi.mock("../../lib/queries", () => ({
  useWorktreeSessions: () => ({ data: state.sessions }),
}));
vi.mock("./useResumeSession", () => ({
  useResumeSessionInWorktree: () => ({ resume: spies.resume, resumingId: state.resumingId }),
}));

import { useReopenClosedTab } from "./useReopenClosedTab";

function session(over: Partial<WorktreeSession> = {}): WorktreeSession {
  return {
    sessionId: "s1",
    agentKind: "Claude",
    termKey: "tree:AK-1:tab:t1",
    messageCount: 4,
    ...over,
  } as WorktreeSession;
}

function Host() {
  useReopenClosedTab();
  return null;
}

beforeEach(() => {
  state.reopenTab = null;
  state.activeId = "AK-1";
  state.sessions = undefined;
  state.resumingId = null;
  spies.resume.mockClear();
  spies.consume.mockClear();
});

/**
 * Reported: an exited agent is listed in the rail but has no tab, and clicking
 * it does nothing. A tab is its process — the row goes when the process exits —
 * so the click asked to be taken somewhere that no longer exists. The
 * conversation is still on disk, and the registry already says what opening a
 * session with no live PTY means: resume it.
 */
describe("useReopenClosedTab", () => {
  it("resumes the conversation the closed tab was holding", () => {
    state.reopenTab = { worktreeId: "AK-1", tabId: "t1" };
    state.sessions = [session({ termKey: "tree:AK-1:tab:other" }), session()];
    render(<Host />);

    expect(spies.resume).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1" }));
    expect(spies.consume).toHaveBeenCalled();
  });

  /** An empty list mid-fetch is "we haven't looked", not "there is nothing" —
   *  acting on it would drop the request the user just made. */
  it("waits for the sessions read rather than giving up on an empty one", () => {
    state.reopenTab = { worktreeId: "AK-1", tabId: "t1" };
    render(<Host />);

    expect(spies.resume).not.toHaveBeenCalled();
    expect(spies.consume).not.toHaveBeenCalled();
  });

  /** The resumer mints its tab in whatever worktree Trees is showing, so acting
   *  before the selection lands would put the conversation in the wrong tree. */
  it("does nothing until the worktree it names is the active one", () => {
    state.reopenTab = { worktreeId: "AK-2", tabId: "t1" };
    state.sessions = [session()];
    render(<Host />);

    expect(spies.resume).not.toHaveBeenCalled();
    expect(spies.consume).not.toHaveBeenCalled();
  });

  /** No session behind the tab is nothing to reopen — but the request is still
   *  consumed, or it re-fires on every refetch. */
  it("consumes a request it has no conversation for", () => {
    state.reopenTab = { worktreeId: "AK-1", tabId: "gone" };
    state.sessions = [session()];
    render(<Host />);

    expect(spies.resume).not.toHaveBeenCalled();
    expect(spies.consume).toHaveBeenCalled();
  });

  it("stays out of the way while a resume is already in flight", () => {
    state.reopenTab = { worktreeId: "AK-1", tabId: "t1" };
    state.sessions = [session()];
    state.resumingId = "s9";
    render(<Host />);

    expect(spies.resume).not.toHaveBeenCalled();
  });
});
