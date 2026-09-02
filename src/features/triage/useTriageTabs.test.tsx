/**
 * The workspace's window management, as a model: the ticket is always there,
 * an investigation tab is the union of stored ∪ live ∪ opened-here, the shell
 * is live ∪ opened-here, and "what am I looking at" resolves against what is
 * actually open.
 */
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TriageSession } from "../../bindings";
import { TerminalsProvider, useTerminals } from "../terminal/TerminalsContext";

const state = vi.hoisted(() => ({
  stored: [] as TriageSession[],
  closeSession: vi.fn(),
}));
vi.mock("../../lib/queries", () => ({
  useStartedInvestigations: () => ({ data: state.stored }),
  useCloseInvestigationSession: () => ({ mutate: state.closeSession }),
}));

import { useTriageTabs } from "./useTriageTabs";

const wrapper = ({ children }: { children: ReactNode }) => (
  <TerminalsProvider>{children}</TerminalsProvider>
);

function mount(ticketId = "AK-1") {
  return renderHook(
    () => ({ tabs: useTriageTabs("acme/app", ticketId), registry: useTerminals() }),
    { wrapper },
  );
}

describe("useTriageTabs", () => {
  beforeEach(() => {
    state.stored = [];
    state.closeSession.mockClear();
  });

  it("opens on the ticket, with nothing else open", () => {
    const { result } = mount();
    expect(result.current.tabs.active).toBe("linear");
    expect(result.current.tabs.providers).toEqual([]);
    expect(result.current.tabs.hasShell).toBe(false);
  });

  /** `started_investigations` strips the `triage:` prefix, so a stored row's
   *  `refId` is the bare ticket id. Matching it against the surface key is how
   *  no tab ever came back after a restart, and no pane ever offered to resume. */
  it("brings a stored investigation back as a tab, matched by the bare ticket id", () => {
    state.stored = [
      { refId: "AK-1", agentKind: "Codex" },
      { refId: "AK-2", agentKind: "Claude" },
    ];
    const { result } = mount("AK-1");

    expect(result.current.tabs.providers).toEqual(["Codex"]);
    expect(result.current.tabs.hasStored("Codex")).toBe(true);
    expect(result.current.tabs.hasStored("Claude")).toBe(false);
  });

  it("lists a live pane as a tab, and a live shell as the shell tab", () => {
    const { result } = mount();
    act(() => {
      result.current.registry.open({
        title: "AK-1",
        source: "triage",
        refId: "triage:AK-1",
        agent: { kind: "Claude", repo: "acme/app", termKey: "triage:AK-1" },
      });
      // No provider: the pane on the same surface that is not an investigation.
      result.current.registry.open({ title: "AK-1", source: "triage", refId: "triage:AK-1" });
      // Another ticket's pane is not ours.
      result.current.registry.open({
        title: "AK-2",
        source: "triage",
        refId: "triage:AK-2",
        agent: { kind: "Codex", repo: "acme/app", termKey: "triage:AK-2" },
      });
    });

    expect(result.current.tabs.providers).toEqual(["Claude"]);
    expect(result.current.tabs.hasShell).toBe(true);
  });

  it("unions stored, live and opened-here providers, in menu order", () => {
    state.stored = [{ refId: "AK-1", agentKind: "Claude" }];
    const { result } = mount();
    act(() => result.current.tabs.openAgent("Codex"));

    expect(result.current.tabs.providers).toEqual(["Codex", "Claude"]);
    expect(result.current.tabs.active).toBe("agent:Codex");
  });

  it("closing an investigation drops its tab, falls back to the ticket and forgets the session", () => {
    const { result } = mount();
    act(() => result.current.tabs.openAgent("Codex"));
    expect(result.current.tabs.active).toBe("agent:Codex");

    act(() => result.current.tabs.closeAgent("Codex"));

    expect(result.current.tabs.providers).toEqual([]);
    expect(result.current.tabs.active).toBe("linear");
    expect(state.closeSession).toHaveBeenCalledWith({ ticketId: "AK-1", agent: "Codex" });
  });

  it("the shell opens in front and closing it falls back to the ticket", () => {
    const { result } = mount();
    act(() => result.current.tabs.openShell());
    expect(result.current.tabs.active).toBe("shell");
    expect(result.current.tabs.hasShell).toBe(true);

    act(() => result.current.tabs.closeShell());
    expect(result.current.tabs.active).toBe("linear");
    expect(result.current.tabs.hasShell).toBe(false);
  });

  /** One rule for "what am I looking at": a remembered tab that isn't open
   *  resolves to the ticket, so closing needs no fallback of its own. */
  it("resolves a remembered tab against what is open", () => {
    const { result } = mount();
    act(() => result.current.tabs.select("agent:Claude"));
    expect(result.current.tabs.active).toBe("linear");

    act(() => result.current.tabs.openAgent("Claude"));
    expect(result.current.tabs.active).toBe("agent:Claude");
    act(() => result.current.tabs.select("linear"));
    expect(result.current.tabs.active).toBe("linear");
    expect(result.current.tabs.providers).toEqual(["Claude"]);
  });
});
