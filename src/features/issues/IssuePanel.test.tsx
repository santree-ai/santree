/**
 * The Tickets inspector shows the ticket that was opened, and only that one.
 *
 * The list spans every project while the model's own `tasks` are the Work
 * scope's, so a ticket opened from another project — a Jira project beside a
 * Linear one — is not in `tasks`. The inspector used to stand the scope's first
 * ticket in for it, and read the detail through the scope's tracker.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "../../bindings";

const ticket = (id: string, title: string): Task => ({
  id,
  title,
  team: null,
  project: "Board",
  projectMilestone: null,
  projectColor: null,
  projectIcon: null,
  projectTargetDate: null,
  parentId: null,
  priority: "Medium",
  estimate: null,
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
});

const state = vi.hoisted(() => ({
  detailReads: [] as [string, string | null][],
  model: {} as Record<string, unknown>,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../../lib/queries", () => ({
  useTriageDetail: (repo: string, id: string | null) => {
    state.detailReads.push([repo, id]);
    return { data: undefined };
  },
}));
vi.mock("../../components/IssueDiscussion", () => ({ DiscussionContent: () => null }));
vi.mock("../../components/IssueProperties", () => ({
  factsOfTask: () => ({}),
  IssueProperties: () => null,
}));
vi.mock("../../components/WorktreeStats", () => ({ WorktreeStats: () => null }));
vi.mock("./TaskNotes", () => ({ TaskNotes: () => null }));
vi.mock("./model", () => ({ useIssues: () => state.model }));

import { IssuePanel } from "./IssuePanel";

const scopeFirst = ticket("AK-1", "The scope's first ticket");

function model(over: Record<string, unknown>) {
  state.model = {
    tasks: [scopeFirst],
    byId: new Map([[scopeFirst.id, scopeFirst]]),
    focused: null,
    focusRepo: "acme/linear-app",
    selected: {},
    isEligible: () => true,
    baseFor: () => null,
    toggle: vi.fn(),
    worktreeById: new Map(),
    prByTask: new Map(),
    goToWorktree: vi.fn(),
    revealInGraph: vi.fn(),
    queueEnabled: false,
    run: vi.fn(),
    runBackground: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  state.detailReads = [];
});

describe("IssuePanel", () => {
  it("shows a ticket opened from another project, read through that project", () => {
    model({ focused: ticket("KAN-2", "A kanban ticket"), focusRepo: "acme/jira-app" });
    render(<IssuePanel />);

    expect(screen.getByText("A kanban ticket")).toBeInTheDocument();
    expect(screen.queryByText("The scope's first ticket")).not.toBeInTheDocument();
    expect(state.detailReads).toContainEqual(["acme/jira-app", "KAN-2"]);
  });

  it("stands no other ticket in when nothing is focused", () => {
    model({ focused: null });
    render(<IssuePanel />);

    expect(screen.getByText("Select an issue to see its details.")).toBeInTheDocument();
    expect(screen.queryByText("The scope's first ticket")).not.toBeInTheDocument();
  });
});
