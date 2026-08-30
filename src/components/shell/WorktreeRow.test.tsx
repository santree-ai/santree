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
      onOpenPane={vi.fn()}
      onOpenAgent={vi.fn()}
    />,
  );
}

describe("WorktreeRow", () => {
  /** The repo's own checkout is not a ticket, and a column of identical cards
   *  gives you nothing to tell it apart by. A word does it — and it has to be a
   *  word, because the glyph beside it is decorative to a screen reader. */
  it("tags the repo's own checkout", () => {
    renderRow({ primary: true, worktree: worktree({ id: "main", title: "main" }) });
    expect(screen.getByText("primary")).toBeInTheDocument();
  });

  /** …and only that one. Every other card in the section is a piece of work. */
  it("leaves an ordinary worktree untagged", () => {
    renderRow();
    expect(screen.queryByText("primary")).toBeNull();
  });

  /** The glyph leads the line, ahead of the name — the earlier trailing position
   *  put it where the tag now is. */
  it("leads the primary row with the branch glyph, before the title", () => {
    const { container } = renderRow({ primary: true });
    const row = container.querySelector(".tree-card > div") as HTMLElement;
    const glyph = row.querySelector("svg") as SVGElement;
    const title = screen.getByText("Collapse the seven tabs");
    // DOCUMENT_POSITION_FOLLOWING: the title comes after the glyph.
    expect(glyph.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /** Guards the oscillation this row has already been through: a mint pill, then
   *  a dashed edge in its place, now a grey tag. The edge keyed off `data-primary`
   *  on the card — nothing should put a treatment back on the card itself. */
  it("draws no edge on the card", () => {
    const { container } = renderRow({ primary: true });
    expect(container.querySelector("[data-primary]")).toBeNull();
  });

  /** A worktree that is still being created has no branch and no glyph to show. */
  it("says what is happening while a worktree is being created", () => {
    renderRow({ worktree: worktree({ pending: true }) });
    expect(screen.getByText(/Creating Collapse the seven tabs/)).toBeInTheDocument();
    expect(screen.queryByText("primary")).toBeNull();
  });
});
