/**
 * The main-area tab bar's real logic: pruning a tab whose process has exited (and
 * only a *dead* one — a mis-prune closes a tab the user is still using, or
 * strands one that isn't), and closing a tab tearing its PTY session down with
 * it. Plus the new-tab menu's digit shortcuts, which mount and unmount with the
 * menu.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentKind, TabKind, WorktreeTab } from "../../bindings";
import { seedSplit } from "../../components/split/testing";
import type { TerminalTabs } from "../terminal/orchestrator";
import { TerminalsProvider, useTerminals } from "../terminal/TerminalsContext";
import { MainTabBar } from "./MainTabBar";
import { type MainTab, openMainTabs } from "./model";

/** The Trees model slice the bar reads, dialled per test. */
const trees = vi.hoisted(() => ({
  activeId: "AK-1",
  tabs: [] as WorktreeTab[],
  active: { agent: "Claude" },
  selectedFile: null as string | null,
  setupFor: null as string | null,
  closeFileTab: vi.fn(),
  addTab: vi.fn<(kind: TabKind, agentKind?: AgentKind) => string | null>(),
  closeTab: vi.fn<(id: string) => void>(),
  renameTab: vi.fn(),
  reach: {
    remote: false,
    readable: true,
    gitOff: undefined as string | undefined,
    runOff: undefined as string | undefined,
    /** What `agentOff(kind)` answers, per provider. */
    off: {} as Partial<Record<AgentKind, string>>,
    agentOff: (kind?: AgentKind): string | undefined => (kind ? trees.reach.off[kind] : undefined),
  },
}));

vi.mock("./model", async (importOriginal) => {
  const model = await importOriginal<typeof import("./model")>();
  const { useTestSplit } = await import("../../components/split/testing");
  return {
    ...model,
    // A real split controller over the tabs the slice has open, so selecting a
    // tab is the layout's own answer rather than a spy's.
    useTrees: () => ({ ...trees, split: useTestSplit(openOf(model.openMainTabs)) }),
  };
});

/** The slice's open tabs, in the model's own order. */
function openOf(openMainTabs: typeof import("./model").openMainTabs): MainTab[] {
  return openMainTabs({
    tabIds: trees.tabs.map((t) => t.id),
    hasPrView: false,
    hasIssueView: false,
    hasFile: trees.selectedFile !== null,
    hasSetup: trees.setupFor !== null && trees.setupFor === trees.activeId,
    hasCheckLog: false,
  });
}

vi.mock("../../lib/queries", () => ({
  useTicketProvider: () => "Linear",
  // "Continue on account": no extra logins, so no tab menu.
  useRepos: () => ({ data: [] }),
  useAgentAccounts: () => ({ data: [] }),
  useTabSessionAccounts: () => new Map(),
  useSetTerminalSessionAccount: () => ({ mutateAsync: vi.fn() }),
  useAgentAuth: () => ({ data: { connected: true } }),
  useCodexAccount: () => ({ data: { connected: q.macCodex } }),
  useCodexHealth: () => ({ data: { available: q.macCodex } }),
}));

/** Whether this Mac's Codex is signed in — asked only for a project here. */
const q = vi.hoisted(() => ({ macCodex: true }));

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
  account: null,
});

const refIdOf = (id: string) => `tree:${trees.activeId}:tab:${id}`;

function mount() {
  return render(
    <TerminalsProvider>
      <MainTabBar renderTab={() => null} empty={null} />
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
  localStorage.clear();
  trees.activeId = "AK-1";
  trees.tabs = [];
  trees.selectedFile = null;
  trees.setupFor = null;
  trees.addTab.mockClear();
  trees.closeTab.mockClear();
  trees.reach.runOff = undefined;
  trees.reach.remote = false;
  trees.reach.off = {};
  q.macCodex = true;
});

describe("MainTabBar", () => {
  describe("pruning dead tabs", () => {
    // A tab is its process: a shell or agent that exits leaves nothing to show, so
    // the tab goes rather than lingering as a dead one to ✕ by hand (Session
    // history is what reopens a quit agent's conversation).
    it("closes a terminal, agent or Fix-CI tab once its process exits", () => {
      trees.tabs = [tab("t1", "terminal"), tab("c1", "agent"), tab("f1", "fixCi")];
      mount();
      for (const id of ["t1", "c1", "f1"]) spawn(id);
      expect(trees.closeTab).not.toHaveBeenCalled();

      for (const id of ["t1", "c1", "f1"]) kill(id);

      expect(trees.closeTab.mock.calls.map(([id]) => id).sort()).toEqual(["c1", "f1", "t1"]);
    });

    // A freshly-opened tab has no session for a beat (the pane mounts, then the
    // PTY registers), and a tab restored by a restart has never been live. Pruning
    // on "no session" alone would sweep either before it ever ran.
    it("leaves a tab that has never been live alone", () => {
      trees.tabs = [tab("t1", "terminal"), tab("c1", "agent")];
      const { rerender } = mount();

      rerender(
        <TerminalsProvider>
          <MainTabBar renderTab={() => null} empty={null} />
          <Probe />
        </TerminalsProvider>,
      );

      expect(trees.closeTab).not.toHaveBeenCalled();
    });
  });

  // Closing the tab by hand must tear the PTY down too, or the shell/agent keeps
  // running and its session lingers under a dead name in the global Terminal tab.
  it("closing a tab tears down its PTY session", () => {
    trees.tabs = [tab("t1", "terminal")];
    mount();
    spawn("t1");
    expect(liveRefIds()).toContain(refIdOf("t1"));

    fireEvent.click(screen.getByRole("button", { name: "Close Terminal 2" }));

    expect(liveRefIds()).not.toContain(refIdOf("t1"));
    expect(trees.closeTab).toHaveBeenCalledWith("t1");
  });

  // Closing the last tab must still leave a way back: the bar (and its "+") stays,
  // which is what the empty surface below it points at.
  it("leaves an empty strip that still offers a new tab", () => {
    mount();

    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /New tab/ })).toBeInTheDocument();
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

    // A Daedalus project on a live link: its terminals and agents run on the
    // box, with the box's CLIs — this Mac's Codex sign-in doesn't matter —
    // and a CLI the box lacks keeps its row, disabled, saying so.
    it("starts a Daedalus project's agents on the box, except one it lacks", () => {
      trees.reach.remote = true;
      q.macCodex = false;
      trees.reach.off = { Codex: "Codex isn't installed on Daedalus" };
      mount();
      openMenu();
      const codex = screen.getByRole("button", { name: /Codex/ });
      expect(codex).toBeDisabled();
      expect(codex).toHaveAttribute("title", "Codex isn't installed on Daedalus");
      expect(screen.getByRole("button", { name: /Claude Code/ })).toBeEnabled();

      press("1");
      expect(trees.addTab).not.toHaveBeenCalled();
      press("2");
      expect(trees.addTab).toHaveBeenCalledWith("agent", "Claude");
      openMenu();
      press("3");
      expect(trees.addTab).toHaveBeenCalledWith("terminal");
    });

    it("offers nothing while Daedalus is out of reach", () => {
      trees.reach.runOff = "Unavailable until santree can reach Daedalus";
      trees.reach.off = { Codex: trees.reach.runOff, Claude: trees.reach.runOff };
      mount();
      openMenu();
      expect(screen.queryByRole("button", { name: /Codex/ })).toBeNull();
      expect(screen.getByRole("button", { name: "New tab" })).toBeDisabled();
    });

    // The digits belong to the menu only while it's open — otherwise a stray "1"
    // anywhere in Trees would spawn a session.
    it("stops listening for digits once the menu closes", () => {
      mount();
      openMenu();
      openMenu(); // ⌘T toggles it shut again

      press("1");

      expect(trees.addTab).not.toHaveBeenCalled();
    });
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
  /** A worktree's tabs: the one a task started in, plus `n` more. */
  const sessions = (n: number): WorktreeTab[] => [
    {
      id: "w1",
      worktreeId: trees.activeId,
      kind: "agent",
      agentKind: "Claude",
      title: "Claude Code",
      pr: null,
      account: null,
    },
    ...Array.from({ length: n }, (_, i) => ({
      id: `t${i + 1}`,
      worktreeId: trees.activeId,
      kind: "agent" as const,
      agentKind: "Codex" as const,
      title: `Session ${i + 1}`,
      pr: null,
      account: null,
    })),
  ];
  const tabNames = () => screen.getAllByRole("tab").map((t) => t.textContent);

  beforeEach(() => {
    trees.active = { agent: "Claude" };
    trees.tabs = sessions(4);
  });
  afterEach(() => {
    rect?.mockRestore();
    rect = null;
  });

  // Below the floor the strip stops squeezing and starts hiding: a 40px sliver
  // of a label identifies nothing.
  it("drops the tabs past the shrink floor into an overflow menu that still reaches them", () => {
    paneWidth(300);
    mount();

    expect(tabNames()).toEqual(["Claude Code", "Session 1"]);
    fireEvent.click(screen.getByRole("button", { name: "Show 3 hidden tabs" }));
    fireEvent.click(screen.getByRole("button", { name: "Session 4" }));

    expect(screen.getByRole("tab", { name: "Session 4" })).toHaveAttribute("aria-selected", "true");
  });

  // You can't switch away from a tab you can no longer see — and a hidden active
  // tab would strand the tablist with no `tabIndex=0` element, the keyboard's
  // only way in. So it takes the last visible slot instead of being dropped.
  it("never hides the active tab", () => {
    seedSplit(openOf(openMainTabs), "tab:t4");
    paneWidth(300);
    mount();

    expect(tabNames()).toEqual(["Claude Code", "Session 4"]);
    const active = screen.getByRole("tab", { name: "Session 4" });
    expect(active).toHaveAttribute("aria-selected", "true");
    expect(active).toHaveAttribute("tabindex", "0");
  });

  it("keeps the active tab when only one fits", () => {
    seedSplit(openOf(openMainTabs), "tab:t2");
    paneWidth(60);
    mount();

    expect(tabNames()).toEqual(["Session 2"]);
  });
});
