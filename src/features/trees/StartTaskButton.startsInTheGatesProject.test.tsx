/**
 * Where "Start a task" puts the worktree.
 *
 * The bug this pins: a Linear ticket belongs to an *org*, and several registered
 * projects routinely resolve to the same org (one with no explicit link takes the
 * only connected one). So the workspace you happen to be looking at was never an
 * answer to "where does this ticket run" — but it was the answer this button
 * gave, silently, because `createWorktree` was bound to a global "active project"
 * that no UI had set since the project switcher was removed. Starting a canary
 * ticket from the santree workspace cut the worktree in the santree checkout, and
 * the Work default project (Settings → Work) was never consulted, so nothing
 * asked and nothing warned.
 *
 * Both directions are asserted here, because only the pair is the contract: the
 * create lands in the project the gate names, and the project on screen is not
 * consulted at all.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Task } from "../../bindings";

const WORK_DEFAULT = "acme/app";
/** The workspace the user is looking at — deliberately NOT the Work default. */
const ON_SCREEN = "acme/other";

const create = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
const addPendingLaunches = vi.hoisted(() => vi.fn());

function task(id: string): Task {
  return {
    id,
    title: `Task ${id}`,
    priority: "None",
    estimate: null,
    cycle: null,
    dueDate: null,
    project: "Core",
    projectColor: null,
    projectIcon: null,
    projectTargetDate: null,
    projectMilestone: null,
    parentId: null,
    status: "Todo",
    ready: true,
    blockedBy: [],
    actionable: true,
    assignee: null,
    assigneeAvatarUrl: null,
    x: 0,
    y: 0,
  };
}

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

vi.mock("../../lib/queries", () => ({
  WORK_AGENT_KEY: "work_agent",
  // The read scope resolves to the Work default, and both projects share the
  // org — which is exactly the situation that made the old behaviour possible.
  useWorkScopeRepo: () => WORK_DEFAULT,
  useOrgSiblings: () => [WORK_DEFAULT, ON_SCREEN],
  useTasks: () => ({ data: [task("AK-411")] }),
  useResolvedSetting: () => ({ data: "Codex" }),
  useCreateWorktree: () => ({ mutate: create, isPending: false }),
}));

// The gate has its own tests; here it stands for "the Work default answered".
vi.mock("../../state/WorkRepoGate", () => ({
  useWorkRepoGate: () => () => Promise.resolve(WORK_DEFAULT),
}));

vi.mock("../../state/AppContext", () => ({
  useApp: () => ({ settings: { defaultAgent: "Claude" } }),
  useAppUi: () => ({
    addPendingLaunches,
    removePendingLaunch: vi.fn(),
    requestTreeLaunch: vi.fn(),
    pendingDeletes: new Set<string>(),
  }),
}));

vi.mock("./model", () => ({
  NO_PROJECT: "No Project",
  // The workspace on screen: a different project, with nothing checked out.
  useTrees: () => ({ worktrees: [] }),
}));

import { StartTaskButton } from "./StartTaskButton";

describe("StartTaskButton", () => {
  it("creates the worktree in the project the gate names, not the one on screen", async () => {
    render(<StartTaskButton />);

    fireEvent.click(screen.getByTitle("Start a task in a new worktree"));
    fireEvent.click(await screen.findByText("AK-411"));

    // The promise the gate resolves is what the create waits on.
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({ repo: WORK_DEFAULT, issueId: "AK-411" });
    expect(create.mock.calls[0][0].repo).not.toBe(ON_SCREEN);
  });

  // The placeholder and the navigation have to agree with the create, or the
  // "Creating workspace…" row appears in a project the worktree never lands in
  // and the user is left watching the wrong rail.
  it("shows the placeholder and opens the workspace in that same project", async () => {
    render(<StartTaskButton />);

    fireEvent.click(screen.getByTitle("Start a task in a new worktree"));
    fireEvent.click(await screen.findByText("AK-411"));

    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(addPendingLaunches).toHaveBeenCalledWith([
      expect.objectContaining({ repo: WORK_DEFAULT, id: "AK-411" }),
    ]);
    expect(navigate).toHaveBeenCalledWith({
      to: "/trees",
      search: { project: WORK_DEFAULT, tree: "AK-411" },
    });
  });
});
