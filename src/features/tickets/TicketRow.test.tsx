import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Task, Worktree } from "../../bindings";
import { IDLE } from "../../lib/attention";
import { TicketRow } from "./TicketRow";
import type { TicketRow as Row } from "./useTickets";

const task: Task = {
  id: "AK-276",
  title: "Preserve `content.metadata` during re-ingest",
  project: "Ingest",
  projectMilestone: null,
  projectColor: null,
  projectIcon: null,
  projectTargetDate: null,
  parentId: null,
  priority: "High",
  estimate: 3,
  status: "Todo",
  ready: true,
  blockedBy: [],
  actionable: true,
  assignee: null,
  assigneeAvatarUrl: null,
  x: 0,
  y: 0,
};

const worktree: Worktree = {
  id: "AK-276",
  title: "AK-276",
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
  branch: "feature/ak-276",
  path: "/tmp/ak-276",
  project: null,
  baseBranch: "main",
  setupRan: false,
  pending: false,
};

function row(overrides: Partial<Row> = {}): Row {
  return {
    repo: "acme/app",
    task,
    worktree: null,
    prs: [],
    agents: [],
    attention: IDLE,
    blockedBy: null,
    ...overrides,
  };
}

describe("TicketRow", () => {
  it("offers a start action and the work signals for a startable ticket", () => {
    render(<TicketRow row={row()} onOpen={vi.fn()} onStart={vi.fn()} />);

    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Start ▸")).toBeInTheDocument();
    expect(screen.getByTitle("High priority")).toBeInTheDocument();
    expect(screen.getByTitle("3 point estimate")).toBeInTheDocument();
    expect(screen.getByText("content.metadata")).toBeInTheDocument();
  });

  it("names the blocker instead of offering a start", () => {
    render(
      <TicketRow
        row={row({ task: { ...task, ready: false, blockedBy: ["AK-1"] }, blockedBy: "AK-1" })}
        onOpen={vi.fn()}
        onStart={vi.fn()}
      />,
    );

    expect(screen.getByText(/Blocked/)).toHaveTextContent("Blocked · AK-1");
    expect(screen.queryByText("Start ▸")).not.toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
  });

  it("says who is on a ticket that already has a worktree", () => {
    render(<TicketRow row={row({ worktree })} onOpen={vi.fn()} onStart={vi.fn()} />);

    expect(screen.getByText("worktree · Claude")).toBeInTheDocument();
    // Started work is not on offer again.
    expect(screen.queryByText("Start ▸")).not.toBeInTheDocument();
  });
});
