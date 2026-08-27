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
    depth: 0,
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

    expect(container.querySelector(".entity-card")).toBeInTheDocument();
    expect(screen.getByTitle("High priority")).toBeInTheDocument();
    expect(screen.getByTitle("3 point estimate")).toBeInTheDocument();
    expect(screen.getByText("content.metadata")).toBeInTheDocument();
  });

  it("only the current ticket takes the card highlight; queueing lives on the checkbox", () => {
    const { container } = render(<IssueRow vm={row({ active: false, selected: true })} />);

    // A queued row must not read as a selection: no card-level active state,
    // only the pressed checkbox marks it.
    const card = container.querySelector(".entity-card");
    expect(card).toHaveAttribute("data-active", "false");
    expect(card).not.toHaveAttribute("data-queued");
    expect(screen.getByRole("button", { name: "Remove from launch selection" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("marks the current ticket with the shared active state", () => {
    const { container } = render(<IssueRow vm={row({ active: true })} />);

    expect(container.querySelector(".entity-card")).toHaveAttribute("data-active", "true");
  });

  it("draws a connector gutter for a nested subtask", () => {
    const { container } = render(<IssueRow vm={row({ depth: 2 })} />);
    expect(container.querySelector("[aria-hidden]")).toHaveStyle({ width: "28px" });
  });
});
