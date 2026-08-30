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

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

vi.mock("../../state/AppContext", () => ({
  useApp: () => ({ activeRepo: "acme/app", setActiveRepo: vi.fn(), settings: null }),
  useAppUi: () => ({ requestTreeFocus: vi.fn() }),
}));

vi.mock("../../lib/queries", () => ({
  WORK_AGENT_KEY: "work_agent",
  useTasks: () => ({
    data: [
      {
        id: "AK-1",
        title: "Tighten the rate limiter",
        project: "Platform",
        state: "Todo",
        stateType: "unstarted",
      },
    ],
    isLoading: false,
  }),
  useRepoBranches: () => ({ data: [], isLoading: false }),
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
  useCreateManualWorktree: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { CreateWorktreeDialog } from "./CreateWorktreeDialog";

const open = () => {
  onClose.mockClear();
  render(<CreateWorktreeDialog repo="acme/app" onClose={onClose} />);
  return screen.getByRole("combobox", { name: /search tickets/i });
};

describe("CreateWorktreeDialog source picker", () => {
  /** The regression this file exists for: closed, the list occupies nothing. */
  it("renders no result list on open — autofocus alone must not summon it", () => {
    open();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.queryByText("Tighten the rate limiter")).not.toBeInTheDocument();
  });

  it("opens the list when the user asks, and reports it on the combobox", () => {
    const field = open();
    expect(field).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(field);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(field).toHaveAttribute("aria-expanded", "true");
    // The list is wired to the field by id, since a floating list is not a DOM
    // descendant a screen reader would otherwise associate with it.
    expect(field).toHaveAttribute("aria-controls", screen.getByRole("listbox").id);
  });

  /** A pointer press on a row must not blur the field first — that would close
   *  the list on blur and the click would land on nothing. */
  it("keeps focus in the field when a row is pressed", () => {
    const field = open();
    fireEvent.click(field);
    const row = screen.getByText("Tighten the rate limiter");
    const prevented = !fireEvent.mouseDown(row);
    expect(prevented).toBe(true);
  });

  /** Escape belongs to the list first: dismissing suggestions must not also
   *  throw away everything typed into the dialog. */
  it("closes the list on Escape without closing the dialog", () => {
    const field = open();
    fireEvent.click(field);
    fireEvent.change(field, { target: { value: "rate" } });
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

/**
 * The parent picker is the same autocomplete one field down — and the one the
 * user caught dropped open over the fields it sits above, because it still
 * opened on focus while the dialog autofocuses on mount.
 */
describe("CreateWorktreeDialog parent picker", () => {
  const parentField = () => screen.getByRole("combobox", { name: /parent worktree/i });
  const LONG_BRANCH = "santree/ak-42-rework-the-queue-drain-and-its-backpressure";

  it("renders closed on mount, and focus alone never opens it", () => {
    open();
    const field = parentField();
    expect(field).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    // The mechanism behind the report: this field used to open on focus, and
    // the dialog hands focus out on mount — a Tab away from the source field
    // dropped the whole worktree list over the fields under it.
    fireEvent.focus(field);
    expect(field).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Rework the queue drain")).not.toBeInTheDocument();
  });

  it("opens the list when the user asks, and wires it to the field", () => {
    open();
    const field = parentField();
    fireEvent.click(field);
    const list = screen.getByRole("listbox");
    expect(field).toHaveAttribute("aria-expanded", "true");
    // A floating list is no descendant of its input; `aria-controls` is the
    // only thing associating the two.
    expect(field).toHaveAttribute("aria-controls", list.id);
    expect(within(list).getByText("Rework the queue drain")).toBeInTheDocument();
  });

  it("keeps focus in the field when a row is pressed", () => {
    open();
    fireEvent.click(parentField());
    const prevented = !fireEvent.mouseDown(screen.getByText("Rework the queue drain"));
    expect(prevented).toBe(true);
  });

  it("closes the list on Escape without closing the dialog", () => {
    open();
    const field = parentField();
    fireEvent.click(field);
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  /** The name is what you pick by, the branch is how you tell two apart. jsdom
   *  lays nothing out, so the guard is on the order plus the classes that do
   *  the layout: an uncapped branch is what squeezed the name to one letter. */
  it("leads with the name and keeps the branch to a capped, truncated tail", () => {
    open();
    fireEvent.click(parentField());
    const branch = screen.getByText(LONG_BRANCH);
    expect(screen.getByText("Rework the queue drain").closest("button")).toBe(
      branch.closest("button"),
    );
    expect(branch.closest("button")?.textContent?.startsWith("Rework the queue drain")).toBe(true);
    expect(branch.className).toContain("max-w-[45%]");
    expect(branch.className).toContain("truncate");
  });

  /** A branch-sourced worktree is named after its branch — printing the string
   *  twice on one row is noise, not detail. */
  it("doesn't repeat the branch of a worktree named after it", () => {
    open();
    fireEvent.click(parentField());
    expect(screen.getAllByText("feature/spike")).toHaveLength(1);
  });
});
