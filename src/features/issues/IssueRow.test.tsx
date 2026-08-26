import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { IssueRow, type IssueRowVM } from "./IssueRow";

function row(overrides: Partial<IssueRowVM> = {}): IssueRowVM {
  return {
    id: "AK-276",
    title: "Preserve `content.metadata` during re-ingest",
    statusColor: "green",
    priority: "High",
    estimate: 3,
    active: false,
    selectable: true,
    selected: false,
    showRdy: true,
    showChain: false,
    chainBase: null,
    showBlocked: false,
    showWorking: false,
    rowStyle: { opacity: 1 },
    boxStyle: { border: "1px solid gray" },
    onReveal: vi.fn(),
    onToggleSelect: vi.fn(),
    onHover: vi.fn(),
    ...overrides,
  };
}

describe("IssueRow", () => {
  it("uses the shared entity card and shows real work signals", () => {
    const { container } = render(<IssueRow vm={row()} />);

    expect(container.firstElementChild).toHaveClass("entity-card");
    expect(screen.getByTitle("High priority")).toBeInTheDocument();
    expect(screen.getByTitle("3 point estimate")).toBeInTheDocument();
    expect(screen.getByText("content.metadata")).toBeInTheDocument();
  });

  it("only the current ticket takes the card highlight; queueing lives on the checkbox", () => {
    const { container } = render(<IssueRow vm={row({ active: false, selected: true })} />);

    // A queued row must not read as a selection: no card-level active state,
    // only the pressed checkbox marks it.
    expect(container.firstElementChild).toHaveAttribute("data-active", "false");
    expect(container.firstElementChild).not.toHaveAttribute("data-queued");
    expect(screen.getByRole("button", { name: "Remove from launch selection" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("marks the current ticket with the shared active state", () => {
    const { container } = render(<IssueRow vm={row({ active: true })} />);

    expect(container.firstElementChild).toHaveAttribute("data-active", "true");
  });
});
