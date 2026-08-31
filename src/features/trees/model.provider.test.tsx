/**
 * The behaviours of `TreesProvider` that cannot be tested through its pure
 * helpers.
 *
 * 1. Picking a file moves the **main** area and leaves the right panel's pane
 *    alone. It matters most for the AI work pane, whose brief is a list of files
 *    you open one after another — a `selectFile` that also reset the pane would
 *    send the reader back to the ticket after every entry — but it holds for the
 *    Files, Changes and PR panes too, which are equally lists you click down.
 * 2. Closing the work terminal sticks (and is remembered across a restart), which
 *    is what lets a workspace end up showing nothing at all.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Worktree, WorktreePr } from "../../bindings";

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

vi.mock("../../lib/queries", () => ({
  useWorktrees: () => ({ data: [worktree], isLoading: false }),
  useBaseWorktree: () => ({ data: null, isLoading: false }),
  useWorktreePrs: () => ({ data: [pr] }),
  useTasks: () => ({ data: [] }),
  // `undefined` is "Linear hasn't answered yet", which is how the model treats a
  // worktree it has no verdict on: the Issue pane stays available.
  useTriageDetail: () => ({ data: undefined }),
  useWorktreeTabs: () => ({ data: [] }),
  useAddWorktreeTab: () => ({ mutate: vi.fn() }),
  useRenameWorktreeTab: () => ({ mutate: vi.fn() }),
  useRemoveWorktreeTab: () => ({ mutate: vi.fn() }),
}));

vi.mock("../../components/PrChip", () => ({
  primaryPr: (list: WorktreePr[]) => list[0] ?? null,
}));

vi.mock("../../state/AppContext", () => ({
  useApp: () => ({ activeRepo: "acme/app" }),
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
    setOpenWorktree: vi.fn(),
    setFocusedAgent: vi.fn(),
  }),
}));

vi.mock("../../state/AgentRuns", () => ({
  useAgentRuns: () => ({
    beginRun: vi.fn(),
    runSetup: vi.fn(),
    isSettingUp: () => false,
    runSetupOnStart: false,
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
    openMainTerminal,
    closeMainTerminal,
  } = useTrees();
  return (
    <div>
      <button type="button" onClick={() => setActive("AK-1")}>
        open worktree
      </button>
      <button type="button" onClick={closeFileTab}>
        close file
      </button>
      <button type="button" onClick={closeMainTerminal}>
        close terminal
      </button>
      <button type="button" onClick={openMainTerminal}>
        open terminal
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

describe("TreesProvider · the work terminal", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("starts open on a worktree that has never been visited", () => {
    open();

    expect(screen.getByTestId("main")).toHaveTextContent("terminal");
  });

  // The whole point: with the terminal closed and no extra tabs, the workspace
  // has nothing open, which is what puts the welcome surface on screen.
  it("closes to nothing, and re-opens on demand", () => {
    open();

    fireEvent.click(screen.getByText("close terminal"));
    expect(screen.getByTestId("main")).toHaveTextContent("none");

    fireEvent.click(screen.getByText("open terminal"));
    expect(screen.getByTestId("main")).toHaveTextContent("terminal");
  });

  // Remembered per worktree, so a restart restores the pane as it was left —
  // closing it is a decision, not a one-session accident.
  it("remembers the close across a remount", () => {
    open();
    fireEvent.click(screen.getByText("close terminal"));
    cleanup();

    open();

    expect(screen.getByTestId("main")).toHaveTextContent("none");
  });

  // Closing the File tab used to fall back to the terminal by name. With the
  // terminal closed there is nothing to fall back to, and the pane must say so
  // rather than select a tab that isn't in the strip.
  it("falls back to nothing when the last remaining tab is closed", () => {
    open();
    fireEvent.click(screen.getByText("close terminal"));
    fireEvent.click(screen.getByText("pick file"));
    expect(screen.getByTestId("main")).toHaveTextContent("file");

    fireEvent.click(screen.getByText("close file"));

    expect(screen.getByTestId("main")).toHaveTextContent("none");
  });
});
