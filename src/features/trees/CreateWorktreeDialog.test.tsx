/**
 * The source picker is an autocomplete, not a list box.
 *
 * It shipped as an always-open results panel with a fixed height, which
 * reserved that space whether or not anyone was choosing and pushed Parent
 * worktree and the buttons down the dialog. The behaviour below is what makes
 * it a *floating* picker instead, and none of it is visible to the pure
 * `createWorktree` unit tests — the dialog had no render test at all, so the
 * old shape passed every gate.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const onClose = vi.fn();

const spies = vi.hoisted(() => ({
  navigate: vi.fn(),
  requestTreeFocus: vi.fn(),
  requestLaunch: vi.fn(),
  addPendingLaunches: vi.fn(),
  /** The create mutation: resolves at once with the worktree it was asked for. */
  create: vi.fn(
    (
      vars: { issueId: string; title: string },
      opts: { onSuccess: (wt: { id: string; title: string }) => void },
    ) => opts.onSuccess({ id: vars.issueId, title: vars.title }),
  ),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => spies.navigate }));

vi.mock("../../state/AppContext", () => ({
  useApp: () => ({ settings: null }),
  useAppUi: () => ({
    requestTreeFocus: spies.requestTreeFocus,
    requestLaunch: spies.requestLaunch,
    addPendingLaunches: spies.addPendingLaunches,
  }),
}));

vi.mock("../../lib/queries", () => ({
  // RepoAvatar's reads: the repo list (for where a project lives) and a
  // Daedalus project's icon. Neither matters here.
  useRepos: () => ({ data: [] }),
  useDaedalusIcon: () => ({ data: null, status: "success" }),
  useTicketProvider: () => "Linear",
  WORK_AGENT_KEY: "work_agent",
  // Only the fields the dialog reads. This used to also carry `state` and
  // `stateType`, which exist on no domain type — an untyped `vi.mock` factory
  // is exactly where an invented field survives, so keep this to what is real.
  useTasks: () => ({
    data: [{ id: "AK-1", title: "Tighten the rate limiter", project: "Platform" }],
    isLoading: false,
  }),
  useRepoBranches: () => ({ data: [], isLoading: false }),
  useRepoReach: () => ({
    remote: false,
    readable: true,
    gitOff: undefined,
    runOff: undefined,
    agentOff: () => undefined,
  }),
  // Two shapes the parent picker has to render: a ticket worktree, whose branch
  // is far longer than its name, and a branch-sourced one, whose name *is* its
  // branch. Neither id may collide with a ticket above, or that ticket's row
  // would come back disabled ("already has a worktree").
  useWorktrees: () => ({
    data: [
      {
        id: "AK-42",
        title: "Rework the queue drain",
        branch: "santree/ak-42-rework-the-queue-drain-and-its-backpressure",
      },
      { id: "feature-spike", title: "feature/spike", branch: "feature/spike" },
    ],
  }),
  useResolvedSetting: () => ({ data: null }),
  useCreateWorktree: () => ({ mutate: spies.create, isPending: false }),
}));

import { CreateWorktreeDialog } from "./CreateWorktreeDialog";

const open = () => {
  onClose.mockClear();
  render(<CreateWorktreeDialog repo="acme/app" onClose={onClose} />);
  return screen.getByRole("combobox", { name: /search tickets/i });
};

/**
 * A ticket picked here is a started task, and starts the way every other start
 * does — through the launch channel, with a placeholder to keep it alive until
 * the worktree list catches up. The dialog used to only navigate: the worktree
 * appeared, and no agent, tab or session ever did.
 */
describe("CreateWorktreeDialog creating", () => {
  it("starts the task when the source is a ticket", () => {
    const field = open();
    fireEvent.click(field);
    fireEvent.click(screen.getByText("Tighten the rate limiter"));
    fireEvent.click(screen.getByRole("button", { name: "Create worktree" }));

    expect(spies.create).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "acme/app", issueId: "AK-1" }),
      expect.anything(),
    );
    expect(spies.addPendingLaunches).toHaveBeenCalledWith([
      expect.objectContaining({ repo: "acme/app", id: "AK-1", project: "Platform" }),
    ]);
    expect(spies.requestLaunch).toHaveBeenCalledWith("acme/app", "AK-1");
    expect(spies.requestTreeFocus).not.toHaveBeenCalled();
    expect(spies.navigate).toHaveBeenCalledWith({
      to: "/trees",
      search: { project: "acme/app", tree: "AK-1" },
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/**
 * Both pickers are the same floating autocomplete. The parent picker is the one
 * the user caught dropped open over the fields it sits above, because it opened
 * on focus while the dialog autofocuses on mount.
 */
describe.each([
  ["source", /search tickets/i, "Tighten the rate limiter"],
  ["parent", /parent worktree/i, "Rework the queue drain"],
] as const)("CreateWorktreeDialog %s picker", (_name, label, row) => {
  const field = () => screen.getByRole("combobox", { name: label });

  /** The regression this file exists for: closed, the list occupies nothing. */
  it("renders no result list on mount, and focus alone never opens it", () => {
    open();
    fireEvent.focus(field());
    expect(field()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.queryByText(row)).not.toBeInTheDocument();
  });

  // A floating list is no descendant of its input; `aria-controls` is the only
  // thing associating the two for a screen reader.
  it("opens the list when the user asks, and wires it to the field", () => {
    open();
    fireEvent.click(field());
    const list = screen.getByRole("listbox");
    expect(field()).toHaveAttribute("aria-expanded", "true");
    expect(field()).toHaveAttribute("aria-controls", list.id);
    expect(within(list).getByText(row)).toBeInTheDocument();
  });

  /** A pointer press on a row must not blur the field first — that would close
   *  the list on blur and the click would land on nothing. */
  it("keeps focus in the field when a row is pressed", () => {
    open();
    fireEvent.click(field());
    expect(fireEvent.mouseDown(screen.getByText(row))).toBe(false);
  });

  /** Escape belongs to the list first: dismissing suggestions must not also
   *  throw away everything typed into the dialog. */
  it("closes the list on Escape without closing the dialog", () => {
    open();
    fireEvent.click(field());
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

/** A branch-sourced worktree is named after its branch — printing the string
 *  twice on one row is noise, not detail. */
it("doesn't repeat the branch of a parent worktree named after it", () => {
  open();
  fireEvent.click(screen.getByRole("combobox", { name: /parent worktree/i }));
  expect(screen.getAllByText("feature/spike")).toHaveLength(1);
});
