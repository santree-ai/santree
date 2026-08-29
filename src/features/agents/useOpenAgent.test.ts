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
  setActiveRepo: vi.fn(),
  requestTreeFocus: vi.fn(),
  requestTriageFocus: vi.fn(),
  requestReviewFocus: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => spies.navigate }));

vi.mock("../../state/AppContext", () => ({
  useApp: () => ({ activeRepo: "acme/app", setActiveRepo: spies.setActiveRepo }),
  useAppUi: () => ({
    requestTreeFocus: spies.requestTreeFocus,
    requestTriageFocus: spies.requestTriageFocus,
    requestReviewFocus: spies.requestReviewFocus,
  }),
}));

import { parseTermKey } from "./registry";
import { useOpenAgent } from "./useOpenAgent";

function open(termKey: string, repo: string | null = "acme/app") {
  vi.clearAllMocks();
  const { result } = renderHook(() => useOpenAgent());
  result.current({ repo, origin: parseTermKey(termKey) });
}

describe("useOpenAgent", () => {
  /** A `tree` session IS the main work terminal — `null` names it explicitly, so
   *  the model moves there rather than leaving whatever tab was last open. */
  it("sends a main-terminal session to the main terminal", () => {
    open("tree:AK-1");
    expect(spies.requestTreeFocus).toHaveBeenCalledWith("AK-1", { tab: null });
    expect(spies.navigate).toHaveBeenCalledWith({ to: "/trees" });
  });

  /** The bug this file exists for: the tab id must survive the handoff. */
  it("sends an extra tab's session to that tab, not to the first one", () => {
    open("tree:AK-373:tab:05242dca");
    expect(spies.requestTreeFocus).toHaveBeenCalledWith("AK-373", { tab: "05242dca" });
  });

  /** Opening an agent says nothing about which right-panel pane you wanted.
   *  Naming one here is how a click in the History pane jumped to the ticket. */
  it("never names a right-panel pane", () => {
    open("tree:AK-373:tab:05242dca");
    const [, focus] = spies.requestTreeFocus.mock.calls[0];
    expect(focus).not.toHaveProperty("pane");
  });

  it("switches repo first when the session belongs to another one", () => {
    open("tree:AK-1", "acme/other");
    expect(spies.setActiveRepo).toHaveBeenCalledWith("acme/other");
  });

  it("leaves the repo alone when the session is already in the active one", () => {
    open("tree:AK-1", "acme/app");
    expect(spies.setActiveRepo).not.toHaveBeenCalled();
  });

  it("routes a triage session to triage", () => {
    open("triage:AK-9");
    expect(spies.requestTriageFocus).toHaveBeenCalledWith("AK-9");
    expect(spies.navigate).toHaveBeenCalledWith({ to: "/triage" });
    expect(spies.requestTreeFocus).not.toHaveBeenCalled();
  });

  /** A session santree can't attribute to a surface must go nowhere at all,
   *  rather than dumping the user on an arbitrary worktree. */
  it("does nothing for an unattributable session", () => {
    open("something-else");
    expect(spies.navigate).not.toHaveBeenCalled();
    expect(spies.requestTreeFocus).not.toHaveBeenCalled();
  });
});
