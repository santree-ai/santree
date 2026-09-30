import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MoveChanges, Worktree } from "../../bindings";
import type { MoveRemainingChangesVars } from "../../lib/queries";
import { GitPanel } from "./GitPanel";
import { SplitEditor } from "./SplitEditor";

const mocked = vi.hoisted(() => ({
  preview: {} as MoveChanges,
  fetching: false,
  mutate: vi.fn(),
  runSetup: vi.fn(),
  onCreated: undefined as
    | ((result: MoveChanges, vars: MoveRemainingChangesVars) => void)
    | undefined,
  refetch: vi.fn(),
  setActive: vi.fn(),
  closeSplit: vi.fn(),
  setFileTab: vi.fn(),
  stage: vi.fn(),
  setSetting: vi.fn(),
  view: null as string | null,
  reach: { runOff: undefined as string | undefined },
}));
vi.mock("../../lib/queries", () => ({
  useMoveChangesPreview: () => ({
    data: mocked.preview,
    refetch: mocked.refetch,
    isFetching: mocked.fetching,
    error: null,
  }),
  useMoveRemainingChanges: (_repo: string, _source: string, onCreated: typeof mocked.onCreated) => {
    mocked.onCreated = onCreated;
    return { mutate: mocked.mutate, isPending: false, error: null };
  },
  useRepoBranches: () => ({ data: [{ name: "feature" }], isLoading: false, isError: false }),
  useTasks: () => ({ data: [{ id: "AK-456", title: "Notifications UI" }] }),
  useWorktreeBranchChanges: () => ({ data: [] }),
  TREES_CHANGES_VIEW_KEY: "trees-changes-view",
  useSetting: () => ({ data: mocked.view }),
  useSetSetting: () => ({ mutate: mocked.setSetting }),
  useStageAction: () => ({ mutate: mocked.stage, mutateAsync: mocked.stage }),
}));
vi.mock("./model", () => ({ useTrees: () => mocked, BASE_ID: "__base__" }));
vi.mock("./CommitBox", () => ({ CommitBox: () => <div>Commit controls</div> }));
vi.mock("../../state/toast", () => ({ toast: { success: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  mocked.fetching = false;
  mocked.view = null;
  mocked.reach.runOff = undefined;
  mocked.preview = {
    id: "move-1",
    sourceId: "AK-123",
    sourceBranch: "feature",
    head: "a".repeat(40),
    snapshotTree: "b".repeat(40),
    indexTree: "c".repeat(40),
    files: ["api.ts", "ui.ts"],
    ticketId: "AK-123",
    branch: null,
    worktreeId: "split-1",
    stashOid: null,
    completed: false,
    sourceHasChanges: false,
  };
});
const show = () =>
  render(<SplitEditor repo="test" worktree={{ id: "AK-123", ahead: 1 } as Worktree} />);

describe("move remaining changes", () => {
  it("labels loading as reading changes rather than waiting for a commit", () => {
    mocked.fetching = true;
    show();
    expect(screen.getByText("Updating remaining changes…")).toBeInTheDocument();
  });
  it("explains the commit-first flow and moves all listed files with the inherited ticket", () => {
    show();
    expect(screen.getByText(/Commit what belongs here/)).toBeInTheDocument();
    expect(screen.getByText(/Staging is preserved/)).toBeInTheDocument();
    expect(screen.getByText(/2 files will move/)).toBeInTheDocument();
    expect(screen.getByLabelText("Branch name")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Ticket" })).toHaveTextContent("AK-123");
    fireEvent.change(screen.getByLabelText("Branch name"), {
      target: { value: "notifications-ui" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create child branch" }));
    expect(mocked.mutate).toHaveBeenCalledWith(
      {
        id: "move-1",
        runSetup: false,
        branch: "notifications-ui",
        ticketId: "AK-123",
        destination: { id: "split-1", baseBranch: "feature", project: null },
      },
      expect.any(Object),
    );
    expect(
      screen.getByRole("checkbox", { name: "Run setup in the child branch" }),
    ).not.toBeChecked();
    mocked.onCreated?.({ ...mocked.preview, completed: true }, mocked.mutate.mock.calls[0][0]);
    expect(mocked.runSetup).not.toHaveBeenCalled();
    const callbacks = mocked.mutate.mock.calls[0][1];
    callbacks.onSuccess({ ...mocked.preview, completed: true });
    expect(mocked.setActive).toHaveBeenCalledWith("split-1");
    expect(mocked.closeSplit).toHaveBeenCalledOnce();
  });
  it("runs setup only in the created child when explicitly checked", () => {
    show();
    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "child" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Run setup in the child branch" }));
    fireEvent.click(screen.getByRole("button", { name: "Create child branch" }));
    const vars = mocked.mutate.mock.calls[0][0];
    expect(vars.runSetup).toBe(true);
    expect(mocked.runSetup).not.toHaveBeenCalled();
    mocked.onCreated?.({ ...mocked.preview, completed: true }, vars);
    expect(mocked.runSetup).toHaveBeenCalledExactlyOnceWith("split-1");
  });

  it("offers no setup where nothing runs yet, and splits without it", () => {
    mocked.reach.runOff = "Coming soon for Daedalus projects";
    show();
    const setup = screen.getByRole("checkbox", { name: "Run setup in the child branch" });
    expect(setup).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "child" } });
    fireEvent.click(screen.getByRole("button", { name: "Create child branch" }));
    expect(mocked.mutate.mock.calls[0][0].runSetup).toBe(false);
  });
  it("allows a new branch name and ticket override", () => {
    show();
    fireEvent.change(screen.getByLabelText("Branch name"), {
      target: { value: "notifications-ui" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ticket" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search tickets" }), {
      target: { value: "Notifications" },
    });
    fireEvent.click(screen.getByRole("menuitem", { name: /AK-456/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create child branch" }));
    expect(mocked.mutate).toHaveBeenCalledWith(
      {
        id: "move-1",
        runSetup: false,
        branch: "notifications-ui",
        ticketId: "AK-456",
        destination: { id: "split-1", baseBranch: "feature", project: null },
      },
      expect.any(Object),
    );
  });
  it("allows clearing the inherited ticket or entering an uncached ticket ID", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Ticket" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "No ticket" }));
    expect(screen.getByRole("button", { name: "Ticket" })).toHaveTextContent("No ticket");
    fireEvent.click(screen.getByRole("button", { name: "Ticket" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search tickets" }), {
      target: { value: "AK-999" },
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Use ticket AK-999" }));
    expect(screen.getByRole("button", { name: "Ticket" })).toHaveTextContent("AK-999");
  });
  it("keeps destination fields visible but disables creation when no changes remain", () => {
    mocked.preview.files = [];
    show();
    expect(screen.getByText("No uncommitted changes to move.")).toBeInTheDocument();
    expect(screen.getByLabelText("Branch name")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Ticket" })).toHaveTextContent("AK-123");
    expect(screen.getByRole("button", { name: "Create child branch" })).toBeDisabled();
  });
  it("requires a commit of this branch’s own before creation", () => {
    render(<SplitEditor repo="test" worktree={{ id: "AK-123", ahead: 0 } as Worktree} />);
    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "ui" } });
    expect(screen.getByRole("button", { name: "Create child branch" })).toBeDisabled();
    expect(screen.getByText(/Commit the first part on this branch before/)).toBeInTheDocument();
  });
  it("retains the destination while refreshing after a commit and uses the new preview", () => {
    const view = show();
    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "ui" } });
    fireEvent.click(screen.getByRole("button", { name: "Ticket" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /AK-456/ }));
    mocked.fetching = true;
    view.rerender(<SplitEditor repo="test" worktree={{ id: "AK-123", ahead: 1 } as Worktree} />);
    expect(screen.getByRole("button", { name: "Create child branch" })).toBeDisabled();
    mocked.fetching = false;
    mocked.preview = { ...mocked.preview, id: "refreshed", files: ["ui.ts"] };
    view.rerender(<SplitEditor repo="test" worktree={{ id: "AK-123", ahead: 2 } as Worktree} />);
    expect(screen.getByLabelText("Branch name")).toHaveValue("ui");
    expect(screen.getByRole("button", { name: "Ticket" })).toHaveTextContent("AK-456");
    expect(screen.getByText(/1 file will move/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create child branch" }));
    expect(mocked.mutate).toHaveBeenCalledWith(
      {
        id: "refreshed",
        runSetup: false,
        branch: "ui",
        ticketId: "AK-456",
        destination: { id: "split-1", baseBranch: "feature", project: null },
      },
      expect.any(Object),
    );
  });
  it("keeps the destination fixed when retrying an interrupted move", () => {
    mocked.preview.branch = "feature-next";
    show();
    expect(screen.getByLabelText("Branch name")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry move" }));
    expect(mocked.mutate).toHaveBeenCalledWith(
      {
        id: "move-1",
        runSetup: false,
        branch: "feature-next",
        ticketId: "AK-123",
        destination: { id: "split-1", baseBranch: "feature", project: null },
      },
      expect.any(Object),
    );
  });
});

it("shares the Changes list for staging and opening diffs while keeping the split form", () => {
  const onOpen = vi.fn();
  render(
    <GitPanel
      repo="test"
      worktreeId="AK-123"
      worktree={null}
      status={[
        {
          path: "src/ui.ts",
          oldPath: null,
          status: "Modified",
          staged: false,
          addLines: 1,
          delLines: 0,
          binary: false,
        },
      ]}
      selectedPath={null}
      selectedScope="working"
      onOpen={onOpen}
      splitForm={<SplitEditor repo="test" worktree={{ id: "AK-123", ahead: 1 } as Worktree} />}
    />,
  );
  expect(screen.getByText("Commit controls")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "ui" } });
  fireEvent.click(screen.getByText("ui.ts"));
  expect(onOpen).toHaveBeenCalledWith("src/ui.ts", "working");
  expect(screen.getByLabelText("Branch name")).toHaveValue("ui");
  expect(mocked.closeSplit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTitle("Tree view"));
  expect(mocked.setSetting).toHaveBeenCalledWith({
    scope: "app",
    key: "trees-changes-view",
    value: "tree",
  });
  fireEvent.click(screen.getByRole("button", { name: "Stage src/ui.ts" }));
  expect(mocked.stage).toHaveBeenCalledWith({ action: "stage", path: "src/ui.ts" });
});

it("keeps split controls collapsed until requested and lets the disclosure collapse them", () => {
  function Panel() {
    const [open, setOpen] = useState(false);
    return (
      <GitPanel
        repo="test"
        worktreeId="AK-123"
        worktree={null}
        status={[]}
        selectedPath={null}
        selectedScope="working"
        onSplit={() => setOpen(true)}
        onCloseSplit={() => setOpen(false)}
        splitForm={
          open ? (
            <SplitEditor repo="test" worktree={{ id: "AK-123", ahead: 1 } as Worktree} />
          ) : undefined
        }
      />
    );
  }
  render(<Panel />);
  const toggle = screen.getByRole("button", { name: "Split branch" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByLabelText("Branch name")).not.toBeInTheDocument();
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByLabelText("Branch name")).toBeVisible();
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByLabelText("Branch name")).not.toBeInTheDocument();
});
