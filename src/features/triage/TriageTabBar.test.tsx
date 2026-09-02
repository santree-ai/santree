/**
 * The Triage strip's own rules: the ticket is a tab like any other except that
 * it can't be closed, each investigation beside it is an agent tab that ends the
 * way every agent tab does, the shell after them ends its own process and no
 * one else's, and the "+" offers only what the ticket doesn't have yet.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TriageTicket } from "../../bindings";
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

/** The model the bar draws, dialled per test. */
function tabsModel(over: Partial<TriageTabs> = {}): TriageTabs {
  return {
    active: "linear",
    select: vi.fn(),
    providers: [],
    hasStored: () => false,
    openAgent: vi.fn(),
    closeAgent: vi.fn(),
    hasShell: false,
    openShell: vi.fn(),
    closeShell: vi.fn(),
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

  it("puts one closable tab per investigating provider after it, then the shell", () => {
    mount(tabsModel({ providers: ["Codex", "Claude"], hasShell: true }));

    expect(tabNames()).toEqual(["Linear", "Codex", "Claude Code", "Terminal"]);
    expect(screen.getByRole("button", { name: "Close Codex" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Close Claude Code" })).toBeVisible();
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

  /** The shell shares the investigations' surface key; the provider being
   *  absent is what tells its pane apart, so its ✕ must find only that one. */
  it("ends the shell's own PTY and leaves the investigation on the same surface alone", () => {
    const tabs = tabsModel({ providers: ["Codex"], hasShell: true });
    mount(tabs);
    act(() => {
      registry.open({
        title: "AK-1",
        source: "triage",
        refId: "triage:AK-1",
        agent: { kind: "Codex", repo: "acme/app", termKey: "triage:AK-1" },
      });
      registry.open({ title: "AK-1", source: "triage", refId: "triage:AK-1" });
    });

    fireEvent.click(screen.getByRole("button", { name: "Close Terminal" }));

    expect(registry.tabs.map((t) => t.agent?.kind)).toEqual(["Codex"]);
    expect(tabs.closeShell).toHaveBeenCalledTimes(1);
    expect(tabs.closeAgent).not.toHaveBeenCalled();
  });

  it("offers only the providers without a tab, and opens the one picked", () => {
    const tabs = tabsModel({ providers: ["Codex"] });
    mount(tabs);
    fireEvent.click(screen.getByRole("button", { name: /New tab/ }));

    expect(screen.queryByRole("button", { name: "Investigate with Codex" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Investigate with Claude Code" }));
    expect(tabs.openAgent).toHaveBeenCalledWith("Claude");
  });

  it("offers a terminal after the providers, until the ticket has one", () => {
    const tabs = tabsModel({ providers: ["Codex"] });
    const { unmount } = mount(tabs);
    fireEvent.click(screen.getByRole("button", { name: /New tab/ }));
    fireEvent.click(screen.getByRole("button", { name: "Open a terminal" }));
    expect(tabs.openShell).toHaveBeenCalledTimes(1);
    unmount();

    mount(tabsModel({ providers: ["Codex"], hasShell: true }));
    fireEvent.click(screen.getByRole("button", { name: /New tab/ }));
    expect(screen.queryByRole("button", { name: "Open a terminal" })).toBeNull();
  });

  it('drops the "+" once every provider and the shell have a tab', () => {
    mount(tabsModel({ providers: ["Codex", "Claude"], hasShell: true }));
    expect(screen.queryByRole("button", { name: /New tab/ })).toBeNull();
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
