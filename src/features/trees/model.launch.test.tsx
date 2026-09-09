/**
 * A launch belongs to the project it was started for, not to the project the
 * workspace happens to be showing.
 *
 * Reported: "Start a task" created the worktree and no agent ever ran in it —
 * no tab, no session, nothing in Session history. The launch had been started
 * into one project while Trees was open on another, and the register that keeps
 * it alive is cleared cross-repo by the sidebar. The provider, scoped to the
 * project on screen, then saw neither a worktree nor a placeholder for it and
 * declared the launch dead.
 */
import { render } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Worktree } from "../../bindings";

const A = "acme/app";
const B = "acme/api";

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

/** The route the provider reads its project and selection off. */
const route = vi.hoisted(() => ({
  search: { project: "acme/app", tree: "__base__" } as { project?: string; tree?: string },
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

/** Every project's worktrees, as the shared query cache holds them. */
const store = vi.hoisted(() => ({
  worktrees: new Map<string, unknown[]>(),
  listeners: new Set<() => void>(),
  notify() {
    for (const l of [...this.listeners]) l();
  },
}));

/** The app-wide launch registers, mutable so a test can play out the sequence. */
const ui = vi.hoisted(() => ({
  treeLaunch: null as unknown,
  pendingLaunches: [] as unknown[],
  consumeTreeLaunch: vi.fn(),
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
    useRepos: () => ({ data: [{ name: A }, { name: B }] }),
    useResolvedBoolSetting: () => ({ value: false, isFetched: true }),
    TREES_RUN_SETUP_KEY: "trees_run_setup",
    useWorktrees: (repo: string) => {
      subscribe();
      return { data: store.worktrees.get(repo) ?? [], isLoading: false };
    },
    useBaseWorktree: () => ({ data: null, isLoading: false }),
    useWorktreePrs: () => ({ data: [] }),
    useTasks: () => ({ data: [] }),
    useTriageDetail: () => ({ data: undefined }),
    useWorktreeTabs: () => ({ data: [] }),
    useAddWorktreeTab: () => ({ mutate: addTabRow }),
    useRenameWorktreeTab: () => ({ mutate: vi.fn() }),
    useRemoveWorktreeTab: () => ({ mutate: vi.fn() }),
  };
});

const addTabRow = vi.hoisted(() => vi.fn());
const beginRun = vi.hoisted(() => vi.fn());
const setVisibleWorktree = vi.hoisted(() => vi.fn());

vi.mock("../../state/AppContext", async () => {
  const { useEffect, useReducer } = await import("react");
  return {
    useAppUi: () => {
      const [, bump] = useReducer((n: number) => n + 1, 0);
      useEffect(() => {
        store.listeners.add(bump);
        return () => void store.listeners.delete(bump);
      }, []);
      return {
        treeLaunch: ui.treeLaunch,
        consumeTreeLaunch: ui.consumeTreeLaunch,
        treeFocus: null,
        consumeTreeFocus: vi.fn(),
        fixCiLaunch: null,
        consumeFixCiLaunch: vi.fn(),
        pendingLaunches: ui.pendingLaunches,
        pendingDeletes: new Set<string>(),
        removePendingDelete: vi.fn(),
        setFocusedAgent: vi.fn(),
      };
    },
  };
});

vi.mock("../../state/AgentRuns", () => ({
  useAgentRuns: () => ({
    beginRun,
    runSetup: vi.fn(),
    isSettingUp: () => false,
    setVisibleWorktree,
    launchAgents: new Map(),
  }),
}));

vi.mock("../terminal/TerminalsContext", () => ({ useTerminals: () => ({ tabs: [] }) }));
vi.mock("./useWorktreeDeletion", () => ({
  useWorktreeDeletion: () => ({ deleteWorktree: vi.fn(), deleteWorktrees: vi.fn() }),
}));
vi.mock("../../components/PrChip", () => ({ primaryPr: (list: unknown[]) => list[0] ?? null }));

import { TreesProvider } from "./model";

describe("TreesProvider · a launch into another project", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
    // The real consume clears the register; a spy that only records would let
    // the effect start the same launch again on the next render, forever.
    ui.consumeTreeLaunch.mockImplementation(() => {
      ui.treeLaunch = null;
      store.notify();
    });
    store.worktrees = new Map([
      [A, [wt("__base__"), wt("AK-1")]],
      [B, []],
    ]);
    // Trees is open on project A; the launch is for project B.
    route.search = { project: A, tree: "AK-1" };
    ui.treeLaunch = { repo: B, id: "AK-9" };
    ui.pendingLaunches = [{ repo: B, id: "AK-9", title: "AK-9", project: null, agent: "Codex" }];
  });

  /** The sidebar clears the placeholder register cross-repo the moment the real
   *  worktree lands — it reads every project, this provider reads one. */
  function worktreeLandsInB() {
    act(() => {
      store.worktrees.set(B, [wt("AK-9")]);
      ui.pendingLaunches = [];
      store.notify();
    });
  }

  it("does not kill it while the workspace is showing a different project", () => {
    render(<TreesProvider>{null}</TreesProvider>);

    worktreeLandsInB();

    expect(ui.consumeTreeLaunch).not.toHaveBeenCalled();
  });

  /** The off-screen launcher skips whatever Trees is showing, because that
   *  worktree's own pane hosts its terminal. Told once at mount, it kept skipping
   *  the worktree open *before* the click — whose pane is gone, so nobody hosts
   *  its queued launch and the agent never spawns. */
  it("publishes the selection the route arrived at, not only the one it mounted on", () => {
    render(<TreesProvider>{null}</TreesProvider>);
    expect(setVisibleWorktree).toHaveBeenLastCalledWith({ repo: A, id: "AK-1" });

    // A sidebar click: the url changes without passing through the view's own
    // `select`, which is the only writer the launcher used to hear from.
    act(() => route.go({ project: A, tree: "__base__" }));

    expect(setVisibleWorktree).toHaveBeenLastCalledWith({ repo: A, id: "__base__" });
  });

  it("starts the agent when the workspace reaches the launch's project", () => {
    render(<TreesProvider>{null}</TreesProvider>);
    worktreeLandsInB();

    act(() => route.go({ project: B, tree: "AK-9" }));

    expect(addTabRow).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: "AK-9", kind: "agent", agentKind: "Codex" }),
    );
    expect(beginRun).toHaveBeenCalledWith(B, "AK-9", expect.any(String));
  });
});
