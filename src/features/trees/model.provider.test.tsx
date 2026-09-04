/**
 * The behaviours of `TreesProvider` that cannot be tested through its pure
 * helpers.
 *
 * 1. Picking a file moves the **main** area and leaves the right panel's pane
 *    alone. It matters most for the AI work pane, whose brief is a list of files
 *    you open one after another — a `selectFile` that also reset the pane would
 *    send the reader back to the ticket after every entry — but it holds for the
 *    Files, Changes and PR panes too, which are equally lists you click down.
 * 2. A worktree with no tab rows is showing nothing at all, and closing the last
 *    of them puts it back there — there is no tab the workspace keeps for itself.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Worktree, WorktreePr, WorktreeTab } from "../../bindings";

/** The route the provider reads its selection off, and the navigation that
 *  writes it. A real store rather than a spy: `setActive` *is* a navigation now,
 *  so a mock that dropped the write would leave every tab test selecting
 *  nothing. */
const route = vi.hoisted(() => ({
  search: { project: "acme/app" } as { project?: string; tree?: string },
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

const worktree = {
  id: "AK-1",
  title: "Task AK-1",
  status: null,
  addLines: 0,
  delLines: 0,
  dirty: false,
  ahead: 0,
  behind: 0,
  unpushed: 0,
  remoteBehind: 0,
  pullConflict: false,
  agent: "Claude",
  activity: null,
  branch: "santree/ak-1",
  path: "/tmp/ak-1",
  project: null,
  baseBranch: "main",
  setupRan: true,
  pending: false,
} satisfies Worktree;

const pr = { issueId: "AK-1", repo: "acme/app", number: 7 } as WorktreePr;

/** The tab rows, as the DB would hold them. The real add/remove mutations patch
 *  the query cache optimistically, so a write re-renders every reader; the mock
 *  keeps that promise with a listener set rather than a cache. Without it a close
 *  would mutate the array and nothing would re-read it — the provider's own tab
 *  resolution, which is what these tests exercise, would never run again. */
const rows = vi.hoisted(() => ({
  tabs: [] as WorktreeTab[],
  listeners: new Set<() => void>(),
  write(tabs: WorktreeTab[]) {
    this.tabs = tabs;
    for (const l of [...this.listeners]) l();
  },
}));

vi.mock("../../lib/queries", async () => {
  const { useEffect, useReducer } = await import("react");
  return {
    useRepos: () => ({ data: [{ name: "acme/app", tracker: "Linear · Acme" }] }),
    useResolvedBoolSetting: () => ({ value: false, isFetched: true }),
    TREES_RUN_SETUP_KEY: "trees_run_setup",
    useWorktrees: () => ({ data: [worktree], isLoading: false }),
    useBaseWorktree: () => ({ data: null, isLoading: false }),
    useWorktreePrs: () => ({ data: [pr] }),
    useTasks: () => ({ data: [] }),
    // `undefined` is "Linear hasn't answered yet", which is how the model treats
    // a worktree it has no verdict on: the Issue pane stays available.
    useTriageDetail: () => ({ data: undefined }),
    useWorktreeTabs: () => {
      const [, bump] = useReducer((n: number) => n + 1, 0);
      useEffect(() => {
        rows.listeners.add(bump);
        return () => void rows.listeners.delete(bump);
      }, []);
      return { data: rows.tabs };
    },
    useAddWorktreeTab: () => ({
      mutate: (t: WorktreeTab) => rows.write([...rows.tabs, t]),
    }),
    useRenameWorktreeTab: () => ({ mutate: vi.fn() }),
    useRemoveWorktreeTab: () => ({
      mutate: (id: string) => rows.write(rows.tabs.filter((t) => t.id !== id)),
    }),
  };
});

vi.mock("../../components/PrChip", () => ({
  primaryPr: (list: WorktreePr[]) => list[0] ?? null,
}));

vi.mock("../../state/AppContext", () => ({
  useAppUi: () => ({
    treeLaunch: null,
    consumeTreeLaunch: vi.fn(),
    treeFocus: null,
    consumeTreeFocus: vi.fn(),
    fixCiLaunch: null,
    consumeFixCiLaunch: vi.fn(),
    pendingLaunches: [],
    removePendingLaunch: vi.fn(),
    pendingDeletes: new Set<string>(),
    removePendingDelete: vi.fn(),
    setFocusedAgent: vi.fn(),
  }),
}));

vi.mock("../../state/AgentRuns", () => ({
  useAgentRuns: () => ({
    beginRun: vi.fn(),
    runSetup: vi.fn(),
    isSettingUp: () => false,
    setVisibleWorktree: vi.fn(),
  }),
}));

vi.mock("../terminal/TerminalsContext", () => ({ useTerminals: () => ({ tabs: [] }) }));

vi.mock("./useWorktreeDeletion", () => ({
  useWorktreeDeletion: () => ({ deleteWorktree: vi.fn(), deleteWorktrees: vi.fn() }),
}));

import { TreesProvider, useTrees } from "./model";

function Probe() {
  const {
    fileTab,
    activeTab,
    selectedFile,
    setActive,
    setFileTab,
    selectFile,
    closeFileTab,
    closeTab,
    addTab,
    tabs,
  } = useTrees();
  return (
    <div>
      <button type="button" onClick={() => setActive("AK-1")}>
        open worktree
      </button>
      <button type="button" onClick={closeFileTab}>
        close file
      </button>
      <button type="button" onClick={() => addTab("terminal")}>
        open terminal
      </button>
      <button type="button" onClick={() => tabs[0] && closeTab(tabs[0].id)}>
        close first tab
      </button>
      <button type="button" onClick={() => setFileTab("aiWork")}>
        show AI work queue
      </button>
      <button type="button" onClick={() => selectFile("src/lib/queries.ts", "branch")}>
        pick file
      </button>
      <output data-testid="pane">{fileTab}</output>
      <output data-testid="main">{activeTab ?? "none"}</output>
      <output data-testid="file">{selectedFile ?? "none"}</output>
    </div>
  );
}

function open() {
  render(
    <TreesProvider>
      <Probe />
    </TreesProvider>,
  );
  fireEvent.click(screen.getByText("open worktree"));
  fireEvent.click(screen.getByText("show AI work queue"));
}

describe("TreesProvider · selectFile", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    rows.tabs = [];
    route.search = { project: "acme/app" };
  });

  it("opens the file in the main area and leaves the right panel where it is", () => {
    open();
    expect(screen.getByTestId("pane")).toHaveTextContent("aiWork");

    fireEvent.click(screen.getByText("pick file"));

    expect(screen.getByTestId("pane")).toHaveTextContent("aiWork");
    expect(screen.getByTestId("main")).toHaveTextContent("file");
    expect(screen.getByTestId("file")).toHaveTextContent("src/lib/queries.ts");
  });
});

describe("TreesProvider · tabs", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    rows.tabs = [];
    route.search = { project: "acme/app" };
  });

  // No tab is privileged, so a worktree nobody has opened a tab on is showing
  // nothing — which is what puts the welcome surface on screen.
  it("starts a worktree with nothing open", () => {
    open();

    expect(screen.getByTestId("main")).toHaveTextContent("none");
  });

  it("opens a tab and falls back to nothing when it closes", () => {
    open();

    fireEvent.click(screen.getByText("open terminal"));
    expect(screen.getByTestId("main")).not.toHaveTextContent("none");

    fireEvent.click(screen.getByText("close first tab"));
    expect(screen.getByTestId("main")).toHaveTextContent("none");
  });

  // Closing the File tab used to fall back to a tab that was always there. With
  // no tabs at all the pane must say so rather than select one that isn't in the
  // strip.
  it("falls back to nothing when the last remaining view is closed", () => {
    open();
    fireEvent.click(screen.getByText("pick file"));
    expect(screen.getByTestId("main")).toHaveTextContent("file");

    fireEvent.click(screen.getByText("close file"));

    expect(screen.getByTestId("main")).toHaveTextContent("none");
  });
});
