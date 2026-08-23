import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ChangedFile } from "../../bindings";
import { DevFilesPane } from "./DevFilesPane";

const spies = vi.hoisted(() => ({
  addRepo: vi.fn(),
  commit: vi.fn(),
  push: vi.fn(),
  status: vi.fn(),
}));

vi.mock("../../lib/queries", () => ({
  queryKeys: { devInfo: (p: string) => ["dev-info", p] },
  useAddRepo: () => ({ mutate: spies.addRepo, isPending: false }),
  useCommitMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useCommitWorktree: () => ({ mutate: spies.commit, isPending: false }),
  usePushWorktree: () => ({ mutate: spies.push, isPending: false }),
  useStageAction: () => ({ mutateAsync: vi.fn() }),
  useWorktreeFileDiff: () => ({ data: undefined }),
  useWorktreeFileSource: () => ({ data: undefined }),
  useWorktreeFiles: () => ({ data: ["src/a.ts", "src/b.ts"] }),
  useWorktreeStatus: () => spies.status(),
}));

vi.mock("../../state/AppContext", () => ({ useApp: () => ({ accent: "#2dd4a7" }) }));

beforeAll(() => {
  // @git-diff-view (pulled in by DiffViewer) measures text against a 2D canvas,
  // which jsdom doesn't implement.
  HTMLCanvasElement.prototype.getContext = (() => ({
    font: "",
    measureText: (t: string) => ({ width: t.length * 7 }),
  })) as unknown as HTMLCanvasElement["getContext"];
});

function changed(over: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: "src/a.ts",
    status: "Modified",
    staged: false,
    binary: false,
    additions: 1,
    deletions: 0,
    ...over,
  } as ChangedFile;
}

const pane = (repoName: string | null, files: ChangedFile[] | undefined = []) => {
  spies.status.mockReturnValue({ data: files });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DevFilesPane repoPath="/checkout" repoName={repoName} />
    </QueryClientProvider>,
  );
};

describe("DevFilesPane", () => {
  it("offers to add a checkout that isn't in the repo list", () => {
    // The pane reads the tree through the shared worktree commands, which address
    // a repo by name — without one there is nothing to read.
    const { getByText } = pane(null);
    fireEvent.click(getByText("Add this checkout"));
    expect(spies.addRepo).toHaveBeenCalledWith("/checkout", expect.anything());
  });

  it("commits everything when nothing is staged", () => {
    const { getByPlaceholderText, getByText } = pane("acme/santree", [changed()]);
    fireEvent.change(getByPlaceholderText("Commit message (stages all)"), {
      target: { value: "  fix the thing  " },
    });
    fireEvent.click(getByText("Commit 1"));
    expect(spies.commit).toHaveBeenCalledWith(
      { message: "fix the thing", stageAll: true },
      expect.anything(),
    );
  });

  it("commits only what's staged once something is", () => {
    const { getByPlaceholderText, getByText } = pane("acme/santree", [
      changed({ staged: true }),
      changed({ path: "src/b.ts" }),
    ]);
    fireEvent.change(getByPlaceholderText("Commit message (1 staged)"), {
      target: { value: "just that one" },
    });
    fireEvent.click(getByText("Commit 1"));
    expect(spies.commit).toHaveBeenCalledWith(
      { message: "just that one", stageAll: false },
      expect.anything(),
    );
  });

  it("won't commit an empty message", () => {
    const { getByText } = pane("acme/santree", [changed()]);
    expect(getByText("Commit 1").closest("button")?.disabled).toBe(true);
  });

  it("says so when the checkout is clean", () => {
    const { container } = pane("acme/santree", []);
    expect(container.textContent).toContain("Nothing to commit");
  });
});
