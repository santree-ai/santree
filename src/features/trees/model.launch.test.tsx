/**
 * A run is the launcher's; Trees follows it.
 *
 * Reported twice as "the worktree is created and nothing starts in it": a start
 * handed to the Trees workspace only ran once that workspace was on screen for
 * that project, and its pane was only hosted while its tab was the active one.
 * Now every start goes to the app shell's launcher, which mints the tab and
 * begins the run wherever the user is — and this workspace's whole part is to
 * land on the right tab when it shows that worktree, and to tell the launcher
 * which pane it is actually hosting.
 */
import { render } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Worktree, WorktreeTab } from "../../bindings";

const A = "acme/app";

const wt = (id: string, over: Partial<Worktree> = {}): Worktree => ({
  id,
  title: id,
  status: null,
  addLines: 0,
  delLines: 0,
  dirty: false,
  ahead: 0,
  behind: 0,
  unpushed: 0,
  remoteBehind: 0,
  pullConflict: false,
  agent: "Codex",
  activity: null,
  branch: `santree/${id}`,
  path: `/tmp/${id}`,
  project: null,
  baseBranch: "main",
  setupRan: false,
  pending: false,
  ...over,
});

const row = (id: string, worktreeId: string): WorktreeTab => ({
  id,
  worktreeId,
  kind: "agent",
  agentKind: "Codex",
  title: "Codex",
  pr: null,
});

/** The route the provider reads its project and selection off. */
const route = vi.hoisted(() => ({
  search: { project: "acme/app", tree: "AK-1" } as { project?: string; tree?: string },
  listeners: new Set<() => void>(),
  go(next: { project?: string; tree?: string }) {
    this.search = next;
    for (const l of [...this.listeners]) l();
  },
}));

vi.mock("@tanstack/react-router", async () => {
  const { useEffect, useReducer } = await import("react");
  return {
    useSearch: () => {
      const [, bump] = useReducer((n: number) => n + 1, 0);
      useEffect(() => {
        route.listeners.add(bump);
        return () => void route.listeners.delete(bump);
      }, []);
      return route.search;
    },
    useNavigate:
      () =>
      ({ search }: { search: (prev: typeof route.search) => typeof route.search }) =>
        route.go(typeof search === "function" ? search(route.search) : search),
  };
});

/** The query cache and the app shell's run state, mutable so a test can play
 *  out a sequence; every mocked hook re-renders on `notify`. */
const store = vi.hoisted(() => ({
  worktrees: [] as unknown[],
  tabs: [] as unknown[],
  launchAgents: new Map<string, { repo: string; tabId: string }>(),
  settingUp: new Set<string>(),
  listeners: new Set<() => void>(),
  notify() {
    for (const l of [...this.listeners]) l();
  },
}));

vi.mock("../../lib/queries", async () => {
  const { useEffect, useReducer } = await import("react");
  const subscribe = () => {
    const [, bump] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
      store.listeners.add(bump);
      return () => void store.listeners.delete(bump);
    }, []);
  };
  return {
    useRepos: () => ({ data: [{ name: A }] }),
    useWorktrees: () => {
      subscribe();
      return { data: store.worktrees, isLoading: false };
    },
    useBaseWorktree: () => ({ data: null, isLoading: false }),
    useWorktreePrs: () => ({ data: [] }),
    useTasks: () => ({ data: [] }),
    useTriageDetail: () => ({ data: undefined }),
    useWorktreeTabs: () => {
      subscribe();
      return { data: store.tabs };
    },
    useAddWorktreeTab: () => ({ mutate: vi.fn() }),
    useRenameWorktreeTab: () => ({ mutate: vi.fn() }),
    useRemoveWorktreeTab: () => ({ mutate: vi.fn() }),
  };
});

const setVisibleWorktree = vi.hoisted(() => vi.fn());

vi.mock("../../state/AppContext", () => ({
  useAppUi: () => ({
    treeFocus: null,
    consumeTreeFocus: vi.fn(),
    fixCiLaunch: null,
    consumeFixCiLaunch: vi.fn(),
    pendingLaunches: [],
    pendingDeletes: new Set<string>(),
    removePendingDelete: vi.fn(),
    setFocusedAgent: vi.fn(),
  }),
}));

vi.mock("../../state/AgentRuns", async () => {
  const { useEffect, useReducer } = await import("react");
  const subscribe = () => {
    const [, bump] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
      store.listeners.add(bump);
      return () => void store.listeners.delete(bump);
    }, []);
  };
  return {
    useAgentRuns: () => {
      subscribe();
      return {
        runSetup: vi.fn(),
        isSettingUp: (id: string) => store.settingUp.has(id),
        isInitialSetup: (id: string) => store.settingUp.has(id),
        setVisibleWorktree,
        launchAgents: store.launchAgents,
      };
    },
  };
});

vi.mock("../terminal/TerminalsContext", () => ({ useTerminals: () => ({ tabs: [] }) }));
vi.mock("./useWorktreeDeletion", () => ({
  useWorktreeDeletion: () => ({ deleteWorktree: vi.fn(), deleteWorktrees: vi.fn() }),
}));
vi.mock("../../components/PrChip", () => ({ primaryPr: (list: unknown[]) => list[0] ?? null }));

import { TreesProvider, useTrees } from "./model";

let model: ReturnType<typeof useTrees>;
function Probe() {
  model = useTrees();
  return null;
}
const mount = () =>
  render(
    <TreesProvider>
      <Probe />
    </TreesProvider>,
  );

/** The launcher minted the run's tab and queued the agent for it. */
function runBegins(id: string, tabId: string) {
  act(() => {
    store.tabs = [...store.tabs, row(tabId, id)];
    store.launchAgents = new Map(store.launchAgents).set(id, { repo: A, tabId });
    store.notify();
  });
}

describe("TreesProvider · following a run", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
    route.search = { project: A, tree: "AK-1" };
    store.worktrees = [wt("AK-1"), wt("AK-2")];
    store.tabs = [row("t1", "AK-1")];
    store.launchAgents = new Map();
    store.settingUp = new Set();
  });

  it("lands on the tab a run begins in, for the worktree on screen", () => {
    mount();
    expect(model.activeTab).toBe("tab:t1");

    runBegins("AK-1", "t9");

    expect(model.activeTab).toBe("tab:t9");
  });

  /** The setup script runs before the agent: the Setup tab first, then the
   *  agent's tab once its launch is queued — with nothing more from the user. */
  it("shows the Setup tab while the initial setup runs, then the agent's tab", () => {
    mount();
    act(() => {
      store.settingUp = new Set(["AK-1"]);
      store.notify();
    });
    expect(model.activeTab).toBe("setup");

    act(() => {
      store.settingUp = new Set();
    });
    runBegins("AK-1", "t9");
    expect(model.activeTab).toBe("tab:t9");
  });

  /** A run followed once stays followed: the user's own tab pick afterwards is
   *  not undone by the next re-render of the same inputs. */
  it("follows a run once, and leaves a later manual pick alone", () => {
    mount();
    runBegins("AK-1", "t9");
    act(() => model.setActiveTab("tab:t1"));
    expect(model.activeTab).toBe("tab:t1");

    act(() => store.notify());

    expect(model.activeTab).toBe("tab:t1");
  });

  /** The launcher runs a task in a worktree the user isn't looking at; when they
   *  next open that worktree it is on the agent's tab, not whatever it had. */
  it("follows a run in a worktree that is not on screen, so opening it lands on the tab", () => {
    mount();
    runBegins("AK-2", "t9");
    expect(model.activeTab).toBe("tab:t1");

    act(() => route.go({ project: A, tree: "AK-2" }));

    expect(model.activeTab).toBe("tab:t9");
  });

  /** The launcher hosts every queued launch except the one whose pane is on
   *  screen — which is a *tab*, not a worktree: a worktree showing another tab,
   *  or nothing at all, hosts nothing. That distinction is the bug this fixes. */
  it("tells the launcher which tab it is hosting, and none when the main area is empty", () => {
    mount();
    expect(setVisibleWorktree).toHaveBeenLastCalledWith({ repo: A, id: "AK-1", tab: "t1" });

    act(() => {
      store.tabs = [];
      store.notify();
    });
    expect(setVisibleWorktree).toHaveBeenLastCalledWith({ repo: A, id: "AK-1", tab: null });

    // A sidebar click: the url changes without passing through the view's own
    // `select`, which is the only writer the launcher used to hear from.
    act(() => route.go({ project: A, tree: "AK-2" }));
    expect(setVisibleWorktree).toHaveBeenLastCalledWith({ repo: A, id: "AK-2", tab: null });
  });
});
