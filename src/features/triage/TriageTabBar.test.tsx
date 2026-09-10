/**
 * The Triage strip's own rules: the ticket is a tab like any other except that
 * it can't be closed, each investigation beside it is an agent tab that ends the
 * way every agent tab does, the ticket's own rows after them end their own
 * process and no one else's, and the "+" opens sessions and terminals — never
 * an investigation, which is the ticket page's to start.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TriageTicket, WorktreeTab } from "../../bindings";
import { triageTicket } from "../../test/fixtures";
import type { TerminalTabs } from "../terminal/orchestrator";
import { TerminalsProvider, useTerminals } from "../terminal/TerminalsContext";

vi.mock("../../lib/queries", () => ({
  useAgentAuth: () => ({ data: { connected: true } }),
  useCodexAccount: () => ({ data: { connected: true } }),
  useCodexHealth: () => ({ data: { available: true } }),
}));

import { TriageTabBar } from "./TriageTabBar";
import type { TriageTabs } from "./useTriageTabs";

const ticket: TriageTicket = triageTicket("AK-1");

const row = (id: string, kind: WorktreeTab["kind"], title: string): WorktreeTab => ({
  id,
  worktreeId: "triage:AK-1",
  kind,
  agentKind: kind === "terminal" ? null : "Codex",
  title,
  pr: null,
});

/** The model the bar draws, dialled per test. */
function tabsModel(over: Partial<TriageTabs> = {}): TriageTabs {
  return {
    active: "linear",
    select: vi.fn(),
    providers: [],
    hasStored: () => false,
    openAgent: vi.fn(),
    closeAgent: vi.fn(),
    rows: [],
    addTab: vi.fn(),
    closeTab: vi.fn(),
    renameTab: vi.fn(),
    ...over,
  };
}

/** Leaks the terminal registry so a test can spawn the PTY sessions the bar
 *  watches (the real orchestrator — sessions are plain state). */
let registry: TerminalTabs;
function Probe() {
  registry = useTerminals();
  return null;
}

const onToggleRight = vi.fn();

function mount(tabs: TriageTabs, rightCollapsed = false) {
  return render(
    <TerminalsProvider>
      <TriageTabBar
        ticket={ticket}
        tabs={tabs}
        rightCollapsed={rightCollapsed}
        onToggleRight={onToggleRight}
      />
      <Probe />
    </TerminalsProvider>,
  );
}

const tabNames = () => screen.getAllByRole("tab").map((t) => t.textContent);

describe("TriageTabBar", () => {
  /** It is not a stored row — it is what the workspace *is*, so there is
   *  nothing for a ✕ to close it to. */
  it("leads with the ticket, and offers no way to close it", () => {
    mount(tabsModel());

    expect(tabNames()).toEqual(["Linear"]);
    expect(screen.queryByRole("button", { name: "Close Linear" })).not.toBeInTheDocument();
  });

  it("puts one closable tab per investigating provider after it, then the ticket's rows", () => {
    mount(
      tabsModel({
        providers: ["Codex", "Claude"],
        rows: [row("a", "agent", "Codex 2"), row("b", "terminal", "Terminal")],
      }),
    );

    expect(tabNames()).toEqual(["Linear", "Codex", "Claude Code", "Codex 2", "Terminal"]);
    expect(screen.getByRole("button", { name: "Close Codex" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Close Claude Code" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Close Codex 2" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Close Terminal" })).toBeVisible();
  });

  /** A tab is its process: the ✕ ends the PTY and then forgets the session. Only
   *  that provider's — one ticket holds one investigation per provider, and
   *  closing one must not end the other's. */
  it("tears down the provider's live session when its tab is closed", () => {
    const tabs = tabsModel({ providers: ["Codex", "Claude"] });
    mount(tabs);
    act(() => {
      for (const kind of ["Codex", "Claude"] as const) {
        registry.open({
          title: "AK-1",
          source: "triage",
          refId: "triage:AK-1",
          agent: { kind, repo: "acme/app", termKey: "triage:AK-1" },
        });
      }
    });

    fireEvent.click(screen.getByRole("button", { name: "Close Codex" }));

    expect(registry.tabs.map((t) => t.agent?.kind)).toEqual(["Claude"]);
    expect(tabs.closeAgent).toHaveBeenCalledWith("Codex");
    expect(tabs.closeAgent).toHaveBeenCalledTimes(1);
  });

  /** A row's pane keys under the row (`triage:<ticket>:tab:<id>`), so its ✕
   *  finds exactly that one — not the investigation on the ticket's own key,
   *  and not another row's. */
  it("ends a row's own PTY and leaves the investigation and the other rows alone", () => {
    const tabs = tabsModel({
      providers: ["Codex"],
      rows: [row("a", "terminal", "Terminal"), row("b", "terminal", "Terminal 2")],
    });
    mount(tabs);
    act(() => {
      registry.open({
        title: "AK-1",
        source: "triage",
        refId: "triage:AK-1",
        agent: { kind: "Codex", repo: "acme/app", termKey: "triage:AK-1" },
      });
      registry.open({ title: "Terminal", source: "triage", refId: "triage:AK-1:tab:a" });
      registry.open({ title: "Terminal 2", source: "triage", refId: "triage:AK-1:tab:b" });
    });

    fireEvent.click(screen.getByRole("button", { name: "Close Terminal" }));

    expect(registry.tabs.map((t) => t.refId)).toEqual(["triage:AK-1", "triage:AK-1:tab:b"]);
    expect(tabs.closeTab).toHaveBeenCalledWith("a");
    expect(tabs.closeAgent).not.toHaveBeenCalled();
  });

  /** A row is its process: once a session the strip has seen live is gone, the
   *  row goes with it rather than lingering dead. */
  it("drops a row whose process has ended", () => {
    const tabs = tabsModel({ rows: [row("a", "terminal", "Terminal")] });
    mount(tabs);
    act(() => {
      registry.open({ title: "Terminal", source: "triage", refId: "triage:AK-1:tab:a" });
    });
    act(() => {
      registry.close(registry.tabs[0].key);
    });
    expect(tabs.closeTab).toHaveBeenCalledWith("a");
  });

  /** The "+" opens the ticket's own tabs, as many as you like, and never an
   *  investigation — that starts from the ticket page. */
  it("always offers a session of each provider and a terminal, and never an investigation", () => {
    const tabs = tabsModel({
      providers: ["Codex", "Claude"],
      rows: [row("a", "terminal", "Terminal")],
    });
    mount(tabs);
    fireEvent.click(screen.getByRole("button", { name: /New tab/ }));

    expect(screen.queryByRole("button", { name: /Investigate with/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open a Claude Code session" }));
    expect(tabs.addTab).toHaveBeenCalledWith("agent", "Claude");

    fireEvent.click(screen.getByRole("button", { name: /New tab/ }));
    fireEvent.click(screen.getByRole("button", { name: "Open a terminal" }));
    expect(tabs.addTab).toHaveBeenCalledWith("terminal");
  });

  /** The rail's own header carries the toggle while it is open; the strip only
   *  takes it over once the rail is gone, so the control is never drawn twice. */
  it("shows the panel toggle only while the rail is collapsed", () => {
    const { unmount } = mount(tabsModel());
    expect(screen.queryByRole("button", { name: "Show panel" })).toBeNull();
    unmount();

    mount(tabsModel(), true);
    fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
    expect(onToggleRight).toHaveBeenCalledTimes(1);
  });
});
