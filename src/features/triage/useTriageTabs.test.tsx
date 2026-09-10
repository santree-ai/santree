/**
 * The workspace's window management, as a model: the ticket is always there,
 * an investigation tab is the union of stored ∪ live ∪ opened-here, the ticket's
 * own tabs are its `worktree_tabs` rows, and "what am I looking at" resolves
 * against what is actually open.
 */
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TriageSession, WorktreeTab } from "../../bindings";
import { TerminalsProvider, useTerminals } from "../terminal/TerminalsContext";

const state = vi.hoisted(() => ({
  stored: [] as TriageSession[],
  rows: [] as WorktreeTab[],
  closeSession: vi.fn(),
  addRow: vi.fn(),
  removeRow: vi.fn(),
  renameRow: vi.fn(),
}));
vi.mock("../../lib/queries", () => ({
  useStartedInvestigations: () => ({ data: state.stored }),
  useCloseInvestigationSession: () => ({ mutate: state.closeSession }),
  useWorktreeTabs: () => ({ data: state.rows }),
  useAddWorktreeTab: () => ({ mutate: state.addRow }),
  useRemoveWorktreeTab: () => ({ mutate: state.removeRow }),
  useRenameWorktreeTab: () => ({ mutate: state.renameRow }),
}));
// The title rule is the Trees model's and tested there; here a row only needs
// one, and the Trees model drags every query hook along with it.
vi.mock("../trees/model", () => ({
  defaultTabTitle: (kind: string, agent: string | null) =>
    kind === "terminal" ? "Terminal" : (agent ?? "Agent"),
}));

import { useTriageTabs } from "./useTriageTabs";

const wrapper = ({ children }: { children: ReactNode }) => (
  <TerminalsProvider>{children}</TerminalsProvider>
);

const row = (id: string, worktreeId = "triage:AK-1"): WorktreeTab => ({
  id,
  worktreeId,
  kind: "terminal",
  agentKind: null,
  title: "Terminal",
  pr: null,
});

function mount(ticketId = "AK-1", repo = "acme/app") {
  return renderHook(() => ({ tabs: useTriageTabs(repo, ticketId), registry: useTerminals() }), {
    wrapper,
  });
}

describe("useTriageTabs", () => {
  beforeEach(() => {
    state.stored = [];
    state.rows = [];
    state.closeSession.mockClear();
    state.addRow.mockClear();
    state.removeRow.mockClear();
    state.renameRow.mockClear();
  });

  it("opens on the ticket, with nothing else open", () => {
    const { result } = mount();
    expect(result.current.tabs.active).toBe("linear");
    expect(result.current.tabs.providers).toEqual([]);
    expect(result.current.tabs.rows).toEqual([]);
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

  it("lists a live investigation pane as a tab, and only this ticket's", () => {
    const { result } = mount();
    act(() => {
      result.current.registry.open({
        title: "AK-1",
        source: "triage",
        refId: "triage:AK-1",
        agent: { kind: "Claude", repo: "acme/app", termKey: "triage:AK-1" },
      });
      // A row's pane keys under the row, not the surface: not an investigation.
      result.current.registry.open({
        title: "Claude Code",
        source: "triage",
        refId: "triage:AK-1:tab:side",
        agent: { kind: "Codex", repo: "acme/app", termKey: "triage:AK-1:tab:side" },
      });
      // Another ticket's pane is not ours.
      result.current.registry.open({
        title: "AK-2",
        source: "triage",
        refId: "triage:AK-2",
        agent: { kind: "Codex", repo: "acme/app", termKey: "triage:AK-2" },
      });
    });

    expect(result.current.tabs.providers).toEqual(["Claude"]);
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

  /** The rows hang off the ticket's surface key: that is the owner the row is
   *  stored under, and what tells AK-1's rows from AK-2's and from a worktree's. */
  it("lists the rows stored under the ticket's surface, and no others", () => {
    state.rows = [row("a"), row("b", "triage:AK-2"), row("c", "AK-1")];
    const { result } = mount("AK-1");
    expect(result.current.tabs.rows.map((t) => t.id)).toEqual(["a"]);
  });

  it("adds a row under the ticket's surface, in front, and drops it on close", () => {
    const { result, rerender } = mount();
    act(() => result.current.tabs.addTab("agent", "Claude"));

    expect(state.addRow).toHaveBeenCalledTimes(1);
    const added = state.addRow.mock.calls[0][0] as WorktreeTab;
    expect(added).toMatchObject({
      worktreeId: "triage:AK-1",
      kind: "agent",
      agentKind: "Claude",
      title: "Claude",
      pr: null,
    });
    // The optimistic patch lands the row; the tab then resolves to it.
    state.rows = [added];
    rerender();
    expect(result.current.tabs.active).toBe(`tab:${added.id}`);

    act(() => result.current.tabs.closeTab(added.id));
    expect(state.removeRow).toHaveBeenCalledWith(added.id);
    state.rows = [];
    rerender();
    expect(result.current.tabs.active).toBe("linear");
  });

  it("a terminal row carries no provider", () => {
    const { result } = mount();
    act(() => result.current.tabs.addTab("terminal"));
    expect(state.addRow.mock.calls[0][0]).toMatchObject({
      kind: "terminal",
      agentKind: null,
      title: "Terminal",
    });
  });

  /** No project, no row: there is nowhere to run and no repo to store it under.
   *  The gate asks before this is reached; this is the guard behind it. */
  it("adds nothing without a project", () => {
    const { result } = mount("AK-1", "");
    act(() => result.current.tabs.addTab("terminal"));
    expect(state.addRow).not.toHaveBeenCalled();
  });

  it("renames a row, and refuses a blank title", () => {
    const { result } = mount();
    act(() => result.current.tabs.renameTab("a", "  Notes  "));
    expect(state.renameRow).toHaveBeenCalledWith({ id: "a", title: "Notes" });
    act(() => result.current.tabs.renameTab("a", "   "));
    expect(state.renameRow).toHaveBeenCalledTimes(1);
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
