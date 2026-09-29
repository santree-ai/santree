import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MoveChanges, Worktree } from "../../bindings";
import { SplitEditor } from "./SplitEditor";

const mocked = vi.hoisted(() => ({
  preview: {} as MoveChanges,
  fetching: false,
  mutate: vi.fn(),
  refetch: vi.fn(),
  setActive: vi.fn(),
  closeSplit: vi.fn(),
  setFileTab: vi.fn(),
  rightCollapsed: true,
  toggleRightPanel: vi.fn(),
}));
vi.mock("../../lib/queries", () => ({
  useMoveChangesPreview: () => ({
    data: mocked.preview,
    refetch: mocked.refetch,
    isFetching: mocked.fetching,
    error: null,
  }),
  useMoveRemainingChanges: () => ({ mutate: mocked.mutate, isPending: false, error: null }),
  useRepoBranches: () => ({ data: [{ name: "feature" }], isLoading: false, isError: false }),
  useTasks: () => ({ data: [] }),
}));
vi.mock("./model", () => ({ useTrees: () => mocked }));
vi.mock("../../state/toast", () => ({ toast: { success: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  mocked.fetching = false;
  mocked.rightCollapsed = true;
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
    expect(screen.getByText("api.ts")).toBeInTheDocument();
    expect(screen.getByLabelText("Branch name")).toHaveValue("");
    expect(screen.getByLabelText("Ticket")).toHaveValue("AK-123");
    fireEvent.change(screen.getByLabelText("Branch name"), {
      target: { value: "notifications-ui" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create child branch" }));
    expect(mocked.mutate).toHaveBeenCalledWith(
      { id: "move-1", branch: "notifications-ui", ticketId: "AK-123" },
      expect.any(Object),
    );
    const callbacks = mocked.mutate.mock.calls[0][1];
    callbacks.onSuccess({ ...mocked.preview, completed: true });
    expect(mocked.setActive).toHaveBeenCalledWith("split-1");
    expect(mocked.closeSplit).toHaveBeenCalledOnce();
  });
  it("allows a new branch name and ticket override", () => {
    show();
    fireEvent.change(screen.getByLabelText("Branch name"), {
      target: { value: "notifications-ui" },
    });
    fireEvent.change(screen.getByLabelText("Ticket"), {
      target: { value: "AK-456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create child branch" }));
    expect(mocked.mutate).toHaveBeenCalledWith(
      { id: "move-1", branch: "notifications-ui", ticketId: "AK-456" },
      expect.any(Object),
    );
  });
  it("opens the commit sidebar without closing the walkthrough or moving changes", () => {
    const view = show();
    fireEvent.click(screen.getByRole("button", { name: "Open commit panel" }));
    expect(mocked.setFileTab).toHaveBeenCalledWith("changes");
    expect(mocked.toggleRightPanel).toHaveBeenCalledTimes(1);
    expect(mocked.closeSplit).not.toHaveBeenCalled();
    expect(mocked.mutate).not.toHaveBeenCalled();

    mocked.rightCollapsed = false;
    view.rerender(<SplitEditor repo="test" worktree={{ id: "AK-123", ahead: 1 } as Worktree} />);
    fireEvent.click(screen.getByRole("button", { name: "Open commit panel" }));
    expect(mocked.toggleRightPanel).toHaveBeenCalledTimes(1);
  });
  it("keeps destination fields visible but disables creation when no changes remain", () => {
    mocked.preview.files = [];
    show();
    expect(screen.getByText("No uncommitted changes to move.")).toBeInTheDocument();
    expect(screen.getByLabelText("Branch name")).toBeEnabled();
    expect(screen.getByLabelText("Ticket")).toHaveValue("AK-123");
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
    fireEvent.change(screen.getByLabelText("Ticket"), { target: { value: "AK-456" } });
    mocked.fetching = true;
    view.rerender(<SplitEditor repo="test" worktree={{ id: "AK-123", ahead: 1 } as Worktree} />);
    expect(screen.getByRole("button", { name: "Create child branch" })).toBeDisabled();
    mocked.fetching = false;
    mocked.preview = { ...mocked.preview, id: "refreshed", files: ["ui.ts"] };
    view.rerender(<SplitEditor repo="test" worktree={{ id: "AK-123", ahead: 2 } as Worktree} />);
    expect(screen.getByLabelText("Branch name")).toHaveValue("ui");
    expect(screen.getByLabelText("Ticket")).toHaveValue("AK-456");
    expect(screen.queryByText("api.ts")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create child branch" }));
    expect(mocked.mutate).toHaveBeenCalledWith(
      { id: "refreshed", branch: "ui", ticketId: "AK-456" },
      expect.any(Object),
    );
  });
  it("keeps the destination fixed when retrying an interrupted move", () => {
    mocked.preview.branch = "feature-next";
    show();
    expect(screen.getByLabelText("Branch name")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry move" }));
    expect(mocked.mutate).toHaveBeenCalledWith(
      { id: "move-1", branch: "feature-next", ticketId: "AK-123" },
      expect.any(Object),
    );
  });
});
