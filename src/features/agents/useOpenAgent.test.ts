/**
 * The cross-view handoff that "take me to this agent" depends on.
 *
 * Untested until a worktree running three agents made the gap visible: every
 * row in the sidebar navigated to the *first* tab, because the origin's `tabId`
 * was dropped here and the Trees model then reset the main area unconditionally.
 * Clicking the Claude row landed you in the Codex terminal.
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  navigate: vi.fn(),
  requestTreeFocus: vi.fn(),
  requestTriageFocus: vi.fn(),
  requestReviewFocus: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => spies.navigate }));

vi.mock("../../state/AppContext", () => ({
  useAppUi: () => ({
    requestTreeFocus: spies.requestTreeFocus,
    requestTriageFocus: spies.requestTriageFocus,
    requestReviewFocus: spies.requestReviewFocus,
  }),
}));

import type { AgentKind } from "../../bindings";
import { parseTermKey } from "./registry";
import { useOpenAgent } from "./useOpenAgent";

function open(
  termKey: string,
  repo: string | null = "acme/app",
  agentKind: AgentKind | null = null,
) {
  vi.clearAllMocks();
  const { result } = renderHook(() => useOpenAgent());
  result.current({ repo, origin: parseTermKey(termKey), agentKind });
}

describe("useOpenAgent", () => {
  /** A `tree` session predates tabs, so there is no tab to name — `null` says so, so
   *  the model moves there rather than leaving whatever tab was last open. */
  it("names no tab for a session minted before tabs existed", () => {
    open("tree:AK-1");
    expect(spies.requestTreeFocus).toHaveBeenCalledWith("acme/app", "AK-1", { tab: null });
    expect(spies.navigate).toHaveBeenCalledWith({
      to: "/trees",
      search: { project: "acme/app", tree: "AK-1" },
    });
  });

  /** The bug this file exists for: the tab id must survive the handoff. */
  it("sends an extra tab's session to that tab, not to the first one", () => {
    open("tree:AK-373:tab:05242dca");
    expect(spies.requestTreeFocus).toHaveBeenCalledWith("acme/app", "AK-373", {
      tab: "05242dca",
    });
  });

  /** Opening an agent says nothing about which right-panel pane you wanted.
   *  Naming one here is how a click in the History pane jumped to the ticket. */
  it("never names a right-panel pane", () => {
    open("tree:AK-373:tab:05242dca");
    const [, , focus] = spies.requestTreeFocus.mock.calls[0];
    expect(focus).not.toHaveProperty("pane");
  });

  /** The session's own project travels in the url. There is no app-wide "active
   *  project" to switch any more, so this is the whole handoff — and a session in
   *  a project you are not looking at opens without disturbing anything else. */
  it("carries the session's project in the route", () => {
    open("tree:AK-1", "acme/other");
    expect(spies.navigate).toHaveBeenCalledWith({
      to: "/trees",
      search: { project: "acme/other", tree: "AK-1" },
    });
    expect(spies.requestTreeFocus).toHaveBeenCalledWith("acme/other", "AK-1", { tab: null });
  });

  /** A session santree cannot attribute to a project has nowhere to open: the
   *  url would name no workspace, and the focus request no tree. */
  it("asks for no worktree when the session belongs to no known project", () => {
    open("tree:AK-1", null);
    expect(spies.requestTreeFocus).not.toHaveBeenCalled();
  });

  /** The ticket rides in the route (so the sidebar's row lights on arrival) and
   *  the focus request names only the tab — the provider whose investigation
   *  this session is. */
  it("routes a triage session to its ticket's workspace, on the provider's tab", () => {
    open("triage:AK-9", "acme/app", "Codex");
    expect(spies.requestTriageFocus).toHaveBeenCalledWith("AK-9", "Codex");
    expect(spies.navigate).toHaveBeenCalledWith({ to: "/triage", search: { ticket: "AK-9" } });
    expect(spies.requestTreeFocus).not.toHaveBeenCalled();
  });

  /** A session santree cannot attribute to a provider still opens its ticket —
   *  on the Linear tab, rather than on a guessed agent's. */
  it("names no agent tab for a triage session whose provider is unknown", () => {
    open("triage:AK-9", "acme/app", null);
    expect(spies.requestTriageFocus).toHaveBeenCalledWith("AK-9", undefined);
  });

  /** A session santree can't attribute to a surface must go nowhere at all,
   *  rather than dumping the user on an arbitrary worktree. */
  it("does nothing for an unattributable session", () => {
    open("something-else");
    expect(spies.navigate).not.toHaveBeenCalled();
    expect(spies.requestTreeFocus).not.toHaveBeenCalled();
  });
});
