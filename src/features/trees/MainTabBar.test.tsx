/**
 * The main-area tab bar's two pieces of real logic: pruning a dead terminal tab
 * (and only a *dead* one — a mis-prune closes a tab the user is still using, or
 * strands one that isn't), and closing a tab tearing its PTY session down with it.
 * Plus the new-tab menu's digit shortcuts, which mount and unmount with the menu.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TabKind, WorktreeTab } from "../../bindings";
import type { TerminalTabs } from "../terminal/orchestrator";
import { TerminalsProvider, useTerminals } from "../terminal/TerminalsContext";
import { MainTabBar } from "./MainTabBar";
import type { MainTab } from "./model";

/** The Trees model slice the bar reads, dialled per test. */
const trees = vi.hoisted(() => ({
  activeId: "AK-1",
  activeTab: "terminal" as MainTab,
  extraTabs: [] as WorktreeTab[],
  active: { agent: "Claude" },
  selectedFile: null as string | null,
  setupFor: null as string | null,
  setActiveTab: vi.fn(),
  closeFileTab: vi.fn(),
  addTab: vi.fn<(kind: TabKind) => void>(),
  closeTab: vi.fn<(id: string) => void>(),
  renameTab: vi.fn(),
}));

vi.mock("./model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model")>()),
  useTrees: () => trees,
}));

/** Leaks the terminal registry so a test can spawn/kill the PTY sessions the bar
 *  watches (the real orchestrator — sessions are plain state). */
let registry: TerminalTabs;
function Probe() {
  registry = useTerminals();
  return null;
}

const tab = (id: string, kind: TabKind): WorktreeTab => ({
  id,
  worktreeId: trees.activeId,
  kind,
  title: kind === "claude" ? "Claude" : "Terminal 2",
});

const refIdOf = (id: string) => `tree:${trees.activeId}:tab:${id}`;

function mount() {
  return render(
    <TerminalsProvider>
      <MainTabBar />
      <Probe />
    </TerminalsProvider>,
  );
}

const spawn = (id: string) =>
  act(() => {
    registry.open({ title: id, source: "issue", refId: refIdOf(id) });
  });
const kill = (id: string) =>
  act(() => {
    const live = registry.tabs.find((t) => t.refId === refIdOf(id));
    if (live) registry.close(live.key);
  });
const liveRefIds = () => registry.tabs.map((t) => t.refId);

beforeEach(() => {
  trees.activeId = "AK-1";
  trees.activeTab = "terminal";
  trees.extraTabs = [];
  trees.selectedFile = null;
  trees.setupFor = null;
  trees.addTab.mockClear();
  trees.closeTab.mockClear();
});

describe("MainTabBar", () => {
  describe("pruning dead tabs", () => {
    // An extra *terminal* tab is its shell: once the shell exits there's nothing
    // left to show, so the tab goes rather than lingering as a dead one to ✕ by hand.
    it("closes an extra terminal tab once its shell exits", () => {
      trees.extraTabs = [tab("t1", "terminal")];
      mount();
      spawn("t1");
      expect(trees.closeTab).not.toHaveBeenCalled();

      kill("t1");

      expect(trees.closeTab).toHaveBeenCalledWith("t1");
    });

    // A freshly-opened tab has no session for a beat — the pane mounts, then the
    // PTY registers. Pruning on "no session" alone would close the tab in that gap,
    // before it ever ran.
    it("leaves a tab whose session hasn't registered yet alone", () => {
      trees.extraTabs = [tab("t1", "terminal")];
      const { rerender } = mount();

      rerender(
        <TerminalsProvider>
          <MainTabBar />
          <Probe />
        </TerminalsProvider>,
      );

      expect(trees.closeTab).not.toHaveBeenCalled();
    });

    // A Claude tab's session is meant to outlive its process: quitting claude shows
    // the resume pane, and the tab comes back after an app restart.
    it("keeps a Claude tab whose process exited (it's resumable)", () => {
      trees.extraTabs = [tab("c1", "claude")];
      mount();
      spawn("c1");

      kill("c1");

      expect(trees.closeTab).not.toHaveBeenCalled();
    });

    it("keeps a Fix-CI tab whose process exited (a Claude session too)", () => {
      trees.extraTabs = [tab("f1", "fixCi")];
      mount();
      spawn("f1");

      kill("f1");

      expect(trees.closeTab).not.toHaveBeenCalled();
    });
  });

  // Closing the tab by hand must tear the PTY down too, or the shell/agent keeps
  // running and its session lingers under a dead name in the global Terminal tab.
  it("closing an extra tab tears down its PTY session", () => {
    trees.extraTabs = [tab("t1", "terminal")];
    mount();
    spawn("t1");
    expect(liveRefIds()).toContain(refIdOf("t1"));

    fireEvent.click(screen.getByRole("button", { name: "Close Terminal 2" }));

    expect(liveRefIds()).not.toContain(refIdOf("t1"));
    expect(trees.closeTab).toHaveBeenCalledWith("t1");
  });

  describe("the new-tab menu", () => {
    /** ⌘T opens the menu (the bar is on screen ⇒ a worktree is active). */
    const openMenu = () =>
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", metaKey: true }));
      });
    const press = (key: string) =>
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });

    it("opens with ⌘T; 1 adds a Claude tab, 2 a terminal", () => {
      mount();
      openMenu();
      expect(screen.getByRole("button", { name: /Claude/ })).toBeInTheDocument();

      press("1");
      expect(trees.addTab).toHaveBeenCalledWith("claude");

      openMenu();
      press("2");
      expect(trees.addTab).toHaveBeenCalledWith("terminal");
    });

    it("swallows 3 (Web is WIP) instead of opening a tab", () => {
      mount();
      openMenu();

      press("3");

      expect(trees.addTab).not.toHaveBeenCalled();
    });

    // The digits belong to the menu only while it's open — otherwise a stray "1"
    // anywhere in Trees would spawn a Claude session.
    it("stops listening for digits once the menu closes", () => {
      mount();
      openMenu();
      openMenu(); // ⌘T toggles it shut again

      press("1");

      expect(trees.addTab).not.toHaveBeenCalled();
    });
  });
});
