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

  it("uses the shared accent contract for the current and queued states", () => {
    const { container } = render(<IssueRow vm={row({ active: true, selected: true })} />);

    expect(container.firstElementChild).toHaveAttribute("data-active", "true");
    expect(container.firstElementChild).toHaveAttribute("data-queued", "true");
  });
});
