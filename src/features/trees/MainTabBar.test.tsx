/**
 * The main-area tab bar's real logic: naming the main work tab after the agent
 * actually running in it, pruning a dead terminal tab (and only a *dead* one —
 * a mis-prune closes a tab the user is still using, or strands one that isn't),
 * and closing a tab tearing its PTY session down with it. Plus the new-tab
 * menu's digit shortcuts, which mount and unmount with the menu.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentKind, TabKind, WorktreeTab } from "../../bindings";
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
  addTab: vi.fn<(kind: TabKind, agentKind?: AgentKind) => void>(),
  closeTab: vi.fn<(id: string) => void>(),
  renameTab: vi.fn(),
}));

vi.mock("./model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model")>()),
  useTrees: () => trees,
}));

vi.mock("../../lib/queries", () => ({
  useAgentAuth: () => ({ data: { connected: true } }),
  useCodexAccount: () => ({ data: { connected: true } }),
  useCodexHealth: () => ({ data: { available: true } }),
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
  agentKind: kind === "terminal" ? null : "Codex",
  title: kind === "agent" ? "Codex" : "Terminal 2",
  pr: null,
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
      trees.extraTabs = [tab("c1", "agent")];
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

    it("opens with ⌘T; 1 adds Codex, 2 Claude, and 3 a terminal", () => {
      mount();
      openMenu();
      expect(screen.getByRole("button", { name: /Codex/ })).toBeInTheDocument();

      press("1");
      expect(trees.addTab).toHaveBeenCalledWith("agent", "Codex");

      openMenu();
      press("2");
      expect(trees.addTab).toHaveBeenCalledWith("agent", "Claude");

      openMenu();
      press("3");
      expect(trees.addTab).toHaveBeenCalledWith("terminal");
    });

    // The bar is on screen precisely when an agent is running, so focus is
    // usually in the terminal — ⌘T means nothing to a shell and must reach the
    // menu anyway, or the shortcut is dead exactly where it's needed.
    it("opens with ⌘T while the terminal has focus", () => {
      mount();
      const term = document.createElement("div");
      term.className = "xterm";
      const helper = document.createElement("textarea");
      helper.className = "xterm-helper-textarea";
      term.append(helper);
      document.body.append(term);

      act(() => {
        helper.dispatchEvent(
          new KeyboardEvent("keydown", { key: "t", metaKey: true, bubbles: true }),
        );
      });

      expect(screen.getByRole("button", { name: /Codex/ })).toBeInTheDocument();
    });

    it("ignores digits outside the three available tab choices", () => {
      mount();
      openMenu();

      press("4");

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

describe("the main work tab's name", () => {
  /** It used to read "Terminal" whatever was running in it, which on a Codex
   *  worktree put the word "Terminal" next to the Codex logomark on a tab whose
   *  content was the Codex TUI. The tab was lying about itself. */
  it("names the tab after the agent running in it", () => {
    trees.active = { agent: "Codex" };
    mount();
    expect(screen.getByRole("tab", { name: "Codex" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Terminal" })).toBeNull();
  });

  it("uses the agent's full display name", () => {
    trees.active = { agent: "Claude" };
    mount();
    expect(screen.getByRole("tab", { name: "Claude Code" })).toBeTruthy();
  });

  /** The base checkout runs a plain login shell and a fresh worktree has not
   *  launched anything yet — neither has an agent to be named after. */
  it("stays 'Terminal' when no agent has been launched", () => {
    trees.active = { agent: null } as unknown as typeof trees.active;
    mount();
    expect(screen.getByRole("tab", { name: "Terminal" })).toBeTruthy();
  });
});

/**
 * A narrow pane. Tab labels are one line, ellipsised — "Claude Code" used to
 * wrap onto two — and the strip shrinks its tabs only to a readable floor,
 * dropping the ones past it into an overflow menu rather than into slivers.
 *
 * The bar measures the tab area with `getBoundingClientRect`, which jsdom always
 * reports as 0 (read by the component as "unmeasured — show everything"), so the
 * pane width is stubbed per test.
 */
describe("fitting the tabs to the pane", () => {
  let rect: { mockRestore: () => void } | null = null;
  /** Every element reports this width; only the tab area's is ever read. */
  const paneWidth = (px: number) => {
    rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: px,
      height: 36,
      top: 0,
      left: 0,
      right: px,
      bottom: 36,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  };
  const sessions = (n: number): WorktreeTab[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `t${i + 1}`,
      worktreeId: trees.activeId,
      kind: "agent",
      agentKind: "Codex",
      title: `Session ${i + 1}`,
      pr: null,
    }));
  const tabNames = () => screen.getAllByRole("tab").map((t) => t.textContent);

  beforeEach(() => {
    trees.active = { agent: "Claude" };
    trees.extraTabs = sessions(4);
    trees.setActiveTab.mockClear();
  });
  afterEach(() => {
    rect?.mockRestore();
    rect = null;
  });

  // The bug: a flex child's automatic minimum size is its min-content width, so
  // "Claude Code" collapsed to the width of "Claude" and wrapped onto a second
  // line. The label is a `truncate` span in a `min-w-0` button instead.
  it("keeps a label on one line, ellipsised", () => {
    paneWidth(1200);
    mount();

    const label = screen.getByRole("tab", { name: "Claude Code" }).querySelector("span.truncate");
    expect(label?.textContent).toBe("Claude Code");
  });

  it("shows every tab when the pane is wide", () => {
    paneWidth(1200);
    mount();

    expect(tabNames()).toEqual(["Claude Code", "Session 1", "Session 2", "Session 3", "Session 4"]);
    expect(screen.queryByRole("button", { name: /hidden tab/ })).toBeNull();
  });

  // Below the floor the strip stops squeezing and starts hiding: a 40px sliver
  // of a label identifies nothing.
  it("drops the tabs past the shrink floor into an overflow menu", () => {
    paneWidth(300);
    mount();

    expect(tabNames()).toEqual(["Claude Code", "Session 1"]);
    expect(screen.getByRole("button", { name: "Show 3 hidden tabs" })).toBeTruthy();
  });

  it("keeps a hidden tab reachable from the overflow menu", () => {
    paneWidth(300);
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Show 3 hidden tabs" }));
    fireEvent.click(screen.getByRole("button", { name: "Session 4" }));

    expect(trees.setActiveTab).toHaveBeenCalledWith("tab:t4");
  });

  // You can't switch away from a tab you can no longer see — and a hidden active
  // tab would strand the tablist with no `tabIndex=0` element, the keyboard's
  // only way in. So it takes the last visible slot instead of being dropped.
  it("never hides the active tab", () => {
    trees.activeTab = "tab:t4";
    paneWidth(300);
    mount();

    expect(tabNames()).toEqual(["Claude Code", "Session 4"]);
    const active = screen.getByRole("tab", { name: "Session 4" });
    expect(active).toHaveAttribute("aria-selected", "true");
    expect(active).toHaveAttribute("tabindex", "0");
  });

  it("keeps the active tab even when only one fits", () => {
    trees.activeTab = "tab:t2";
    paneWidth(60);
    mount();

    expect(tabNames()).toEqual(["Session 2"]);
    expect(screen.getByRole("tab", { name: "Session 2" })).toHaveAttribute("tabindex", "0");
  });

  // The floor is the tab's own min-width, so a rendered tab can never be
  // squeezed below it by a sibling.
  it("gives every tab the shrink floor as its minimum width", () => {
    paneWidth(300);
    mount();

    expect(screen.getByRole("tab", { name: "Claude Code" }).parentElement).toHaveStyle({
      minWidth: "84px",
    });
  });
});
