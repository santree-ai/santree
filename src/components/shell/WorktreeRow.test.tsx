import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Worktree } from "../../bindings";
import type { WorktreeNode } from "./useProjectTree";
import { WorktreeRow } from "./WorktreeRow";

// The row's right-click menu and PR mark reach for the query client, the router
// and the app context on mount; what this file is about is what line one says.
vi.mock("./WorktreeMenu", () => ({
  WorktreeMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../PrChip", () => ({ PrMark: () => null }));

function worktree(over: Partial<Worktree> = {}): Worktree {
  return {
    id: "SAN-1",
    title: "Collapse the seven tabs",
    branch: "santree/san-1",
    path: "/tmp/san-1",
    pending: false,
    ...over,
  } as Worktree;
}

function node(over: Partial<WorktreeNode> = {}): WorktreeNode {
  return {
    worktree: worktree(),
    depth: 0,
    primary: false,
    prs: [],
    task: null,
    agents: [],
    attention: { level: "idle", at: 0 },
    ...over,
  };
}

function renderRow(over: Partial<WorktreeNode> = {}) {
  return render(
    <WorktreeRow
      repo="santree"
      node={node(over)}
      indent={30}
      selected={false}
      onSelect={vi.fn()}
      onOpenPage={vi.fn()}
      onOpenAgent={vi.fn()}
    />,
  );
}

describe("WorktreeRow", () => {
  /** The repo's own checkout is not a ticket, and a column of identical cards
   *  gives you nothing to tell it apart by. A word does it — and it has to be a
   *  word, because the glyph beside it is decorative to a screen reader. Every
   *  other card in the section is a piece of work, so it stays untagged. */
  it("tags the repo's own checkout, and only that one", () => {
    const { unmount } = renderRow({
      primary: true,
      worktree: worktree({ id: "main", title: "main" }),
    });
    expect(screen.getByText("primary")).toBeInTheDocument();
    unmount();
    renderRow();
    expect(screen.queryByText("primary")).toBeNull();
  });

  /** A worktree that is still being created has no branch and no glyph to show. */
  it("says what is happening while a worktree is being created", () => {
    renderRow({ worktree: worktree({ pending: true }) });
    expect(screen.getByText(/Creating Collapse the seven tabs/)).toBeInTheDocument();
    expect(screen.queryByText("primary")).toBeNull();
  });
});
