import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProjectSection } from "./ProjectTree";
import type { ProjectNode } from "./useProjectTree";

// The rows under the header stand up the query client and the app context; this
// file is about the header itself.
vi.mock("./WorktreeRow", () => ({ INDENT_PX: 14, WorktreeRow: () => null }));
vi.mock("../../features/trees/CreateWorktreeDialog", () => ({ CreateWorktreeDialog: () => null }));

function project(over: Partial<ProjectNode> = {}): ProjectNode {
  return {
    repo: "stoscanini/santree",
    label: "santree",
    base: null,
    linearProjects: [],
    showProjects: false,
    worktreeCount: 6,
    attention: { level: "idle", at: 0 },
    loading: false,
    ...over,
  };
}

function renderSection(over: Partial<ProjectNode> = {}) {
  return render(
    <ProjectSection
      project={project(over)}
      open
      isBandOpen={() => true}
      openWorktreeId={null}
      onToggle={vi.fn()}
      onToggleBand={vi.fn()}
      onSelectWorktree={vi.fn()}
      onOpenAgent={vi.fn()}
      onCreateWorktree={vi.fn()}
    />,
  );
}

/** The header's trailing count. */
function countSlot(container: HTMLElement): HTMLElement {
  return container.querySelector(".tabular-nums") as HTMLElement;
}

describe("ProjectSection header", () => {
  /** The count is hover-revealed, not hover-*rendered*. `opacity: 0` keeps the
   *  number in the accessibility tree, so a screen reader — which has no hover —
   *  still reaches it. */
  it("keeps the hover-only count in the DOM at rest", () => {
    const { container } = renderSection();
    const slot = countSlot(container);
    expect(slot).toBeInTheDocument();
    expect(slot).toHaveTextContent("6");
    expect(slot.className).toContain("opacity-0");
  });

  /** Hover and keyboard focus reveal the same thing: a control or a fact you can
   *  only reach with a pointer is unreachable from the keyboard. */
  it("reveals the count on hover and on keyboard focus alike", () => {
    const { container } = renderSection();
    const slot = countSlot(container);
    expect(slot.className).toContain("group-hover:opacity-100");
    expect(slot.className).toContain("group-focus-within:opacity-100");
  });

  /** The slot is reserved, not conditional: the row must not resize under the
   *  pointer that revealed it, nor when the read finally lands. This has bitten
   *  this rail three times — always as a control that occupied no space until it
   *  appeared. */
  it("reserves the count's slot while the read is still in flight", () => {
    const { container } = renderSection({ loading: true });
    const slot = countSlot(container);
    expect(slot).toBeInTheDocument();
    // No digits until the read lands — "0" beside skeleton rows is a claim —
    // but the width is already spoken for.
    expect(slot).toHaveTextContent("");
    expect(slot.className).toContain("min-w-[13px]");
  });

  /** The repo header carries no attention dot: the rows beneath it already say
   *  which worktree needs a human, and a second dot on the parent restated it
   *  while adding permanent colour to a rail that is open all day. Removed
   *  deliberately — this asserts it stays gone. */
  it("shows no attention dot on the repo header, even at needs-you", () => {
    renderSection({ attention: { level: "needs-you", at: 1 } });
    expect(screen.queryByRole("img", { name: "Needs you" })).not.toBeInTheDocument();
  });
});
