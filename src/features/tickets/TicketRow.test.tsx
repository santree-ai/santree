import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Task, Worktree } from "../../bindings";
import { IDLE } from "../../lib/attention";
import { TicketRow } from "./TicketRow";
import type { TicketRow as Row } from "./useTickets";

// The menu's Linear rows need the repo's org; the row is otherwise pure props.
vi.mock("../../lib/queries", () => ({
  useLinearIssueUrl: () => (id: string) => `https://linear.app/acme/issue/${id}`,
}));

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
  cycle: null,
  dueDate: null,
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
    repos: ["acme/app"],
    task,
    worktree: null,
    prs: [],
    agents: [],
    attention: IDLE,
    blockedBy: null,
    ...overrides,
  };
}

const START = /start in a new worktree/;

describe("TicketRow", () => {
  /** The green pill is both the state and the action: it reads "Ready" at rest
   *  and "Start" under the pointer, with one accessible name throughout. */
  it("offers a start action and the work signals for a startable ticket", () => {
    const onStart = vi.fn();
    render(<TicketRow row={row()} indent={0} onOpen={vi.fn()} onStart={onStart} />);

    const start = screen.getByRole("button", { name: START });
    expect(start).toHaveTextContent("Ready");
    expect(start).toHaveTextContent("Start");
    expect(screen.getByTitle("High priority")).toBeInTheDocument();
    expect(screen.getByTitle("3 point estimate")).toBeInTheDocument();
    expect(screen.getByText("content.metadata")).toBeInTheDocument();

    fireEvent.click(start);
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ repo: "acme/app" }), {
      background: false,
    });
  });

  /** Whose it is, on every row — yours included. The face used to be reserved
   *  for someone else's ticket, which read as "not you" rather than as the
   *  assignee. */
  it("shows the assignee on an actionable row too", () => {
    render(
      <TicketRow
        row={row({ task: { ...task, assignee: "Ada Lovelace" } })}
        indent={0}
        onOpen={vi.fn()}
        onStart={vi.fn()}
      />,
    );
    expect(screen.getByText("AL")).toBeInTheDocument();
  });

  /** The row itself is one stretched control, so a click anywhere on it — the
   *  bars, a chip — opens the ticket. */
  it("opens the ticket from anywhere on the row", () => {
    const onOpen = vi.fn();
    render(<TicketRow row={row()} indent={0} onOpen={onOpen} onStart={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /^Open AK-276/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ repo: "acme/app" }));
  });

  /** The queue mark sits in the row's gutter; ⌘-click on the row is the same
   *  gesture. Neither exists for a row the active repo can't launch. */
  it("queues from the gutter mark and by ⌘-click, and only when offered", () => {
    const onOpen = vi.fn();
    const onToggleQueue = vi.fn();
    const { rerender } = render(
      <TicketRow
        row={row()}
        indent={35}
        onOpen={onOpen}
        onStart={vi.fn()}
        onToggleQueue={onToggleQueue}
      />,
    );

    const mark = screen.getByRole("checkbox", { name: "Add AK-276 to the launch queue" });
    expect(mark).toHaveAttribute("aria-checked", "false");
    fireEvent.click(mark);
    expect(onToggleQueue).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /^Open AK-276/ }), { metaKey: true });
    expect(onToggleQueue).toHaveBeenCalledTimes(2);
    expect(onOpen).not.toHaveBeenCalled();

    rerender(
      <TicketRow
        row={row()}
        indent={35}
        queued
        onOpen={onOpen}
        onStart={vi.fn()}
        onToggleQueue={onToggleQueue}
      />,
    );
    expect(
      screen.getByRole("checkbox", { name: "Remove AK-276 from the launch queue" }),
    ).toHaveAttribute("aria-checked", "true");

    rerender(<TicketRow row={row()} indent={35} onOpen={onOpen} onStart={vi.fn()} />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Open AK-276/ }), { metaKey: true });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("names the blocker instead of offering a start", () => {
    render(
      <TicketRow
        row={row({ task: { ...task, ready: false, blockedBy: ["AK-1"] }, blockedBy: "AK-1" })}
        indent={0}
        onOpen={vi.fn()}
        onStart={vi.fn()}
      />,
    );

    expect(screen.getByText(/Blocked/)).toHaveTextContent("Blocked · AK-1");
    expect(screen.queryByRole("button", { name: START })).not.toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
  });

  it("says who is on a ticket that already has a worktree", () => {
    render(<TicketRow row={row({ worktree })} indent={0} onOpen={vi.fn()} onStart={vi.fn()} />);

    expect(screen.getByText("worktree · Claude")).toBeInTheDocument();
    // Started work is not on offer again.
    expect(screen.queryByRole("button", { name: START })).not.toBeInTheDocument();
  });
});

/** The right-click menu: the pill's and the mark's actions in words, the
 *  background run, and the ticket's own address. Its rows follow the row's
 *  state exactly as the pill and the mark do. */
describe("TicketRow menu", () => {
  const rows = () => screen.getAllByRole("menuitem").map((el) => el.textContent);
  const open = () => fireEvent.contextMenu(screen.getByRole("button", { name: /^Open AK-276/ }));

  it("offers the run, the queue and the Linear rows on a startable ticket", () => {
    const onStart = vi.fn();
    const onToggleQueue = vi.fn();
    render(
      <TicketRow
        row={row()}
        indent={0}
        onOpen={vi.fn()}
        onStart={onStart}
        onToggleQueue={onToggleQueue}
      />,
    );
    open();
    expect(rows()).toEqual([
      "Run",
      "Run in the background",
      "Add to queue",
      "Open in Linear",
      "Copy ticket id",
      "Copy link",
    ]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Run in the background" }));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ repo: "acme/app" }), {
      background: true,
    });
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Add to queue" }));
    expect(onToggleQueue).toHaveBeenCalledOnce();
  });

  /** Where a ticket several projects carry starts is settled once, by the list
   *  (the Work default, or a question) — the pill and Run take that answer, and
   *  the menu offers the one way past it for a single run. */
  it("offers to pick the project for a ticket several carry, past the default", () => {
    const onStart = vi.fn();
    render(
      <TicketRow
        row={row({ repos: ["acme/app", "acme/infra"] })}
        indent={0}
        onOpen={vi.fn()}
        onStart={onStart}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: START }));
    expect(onStart).toHaveBeenLastCalledWith(expect.anything(), { background: false });

    open();
    expect(rows()).toContain("Run in another project…");
    fireEvent.click(screen.getByRole("menuitem", { name: "Run in another project…" }));
    expect(onStart).toHaveBeenLastCalledWith(expect.anything(), {
      background: false,
      pick: true,
    });
  });

  it("offers the worktree already on a started ticket instead of a run", () => {
    const onOpenWorktree = vi.fn();
    render(
      <TicketRow
        row={row({ worktree })}
        indent={0}
        onOpen={vi.fn()}
        onStart={vi.fn()}
        onOpenWorktree={onOpenWorktree}
      />,
    );
    open();
    expect(rows()).toEqual(["Open worktree", "Open in Linear", "Copy ticket id", "Copy link"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Open worktree" }));
    expect(onOpenWorktree).toHaveBeenCalledWith(expect.objectContaining({ worktree }));
  });

  it("says a queued ticket can be taken out", () => {
    render(
      <TicketRow
        row={row()}
        indent={0}
        queued
        onOpen={vi.fn()}
        onStart={vi.fn()}
        onToggleQueue={vi.fn()}
      />,
    );
    open();
    expect(screen.getByRole("menuitem", { name: "Remove from queue" })).toBeInTheDocument();
  });
});
