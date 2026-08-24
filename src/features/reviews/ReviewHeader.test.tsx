import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewPr, Worktree, WorktreePr } from "../../bindings";

const state = vi.hoisted(() => ({
  mine: false,
  repos: [{ name: "acme/app" }],
  worktrees: [] as Worktree[],
  worktreePrs: [] as WorktreePr[],
  mutate: vi.fn(),
  setActiveRepo: vi.fn(),
  addPendingLaunches: vi.fn(),
  removePendingLaunch: vi.fn(),
  requestTreeFocus: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../../lib/queries", () => ({
  useRepos: () => ({ data: state.repos }),
  useWorktrees: () => ({ data: state.worktrees }),
  useWorktreePrs: () => ({ data: state.worktreePrs }),
  useCreateReviewWorktree: () => ({ mutate: state.mutate, isPending: false }),
}));
vi.mock("../../state/AppContext", () => ({
  useApp: () => ({ setActiveRepo: state.setActiveRepo }),
  useAppUi: () => ({
    addPendingLaunches: state.addPendingLaunches,
    removePendingLaunch: state.removePendingLaunch,
    requestTreeFocus: state.requestTreeFocus,
  }),
}));
vi.mock("./PrLabels", () => ({ PrLabels: () => null }));
vi.mock("./model", () => ({
  useReviewsModel: () => ({
    infoCollapsed: false,
    toggleInfo: vi.fn(),
    inbox: { mine: state.mine ? [{ id: "PR_node" }] : [], requested: [], teams: [] },
  }),
}));

import { ReviewHeader, reviewTreeId } from "./ReviewHeader";

const pr = {
  id: "PR_node",
  number: 42,
  title: "Fix the thing",
  url: "https://github.com/acme/app/pull/42",
  repo: "acme/app",
  headRef: "feature/fix-the-thing",
  baseRef: "main",
  headSha: "abc123",
  author: "someone",
  authorAvatarUrl: "",
  state: "Open",
  isDraft: false,
  reviewDecision: "ReviewRequired",
  checks: "Success",
  isInMergeQueue: false,
  additions: 10,
  deletions: 2,
  changedFiles: 1,
  commentCount: 0,
  aiReviewCount: 0,
  reviewers: [],
  updatedAt: "2026-08-24T10:00:00Z",
  createdAt: "2026-08-23T10:00:00Z",
  waitingSince: "2026-08-23T10:00:00Z",
  headCommittedAt: "2026-08-24T09:00:00Z",
  viewerReview: null,
} satisfies ReviewPr;

const existing = {
  id: "AK-42",
  title: "Fix the thing",
  branch: pr.headRef,
} as Worktree;

beforeEach(() => {
  state.mine = false;
  state.repos = [{ name: "acme/app" }];
  state.worktrees = [];
  state.worktreePrs = [];
  vi.clearAllMocks();
});

describe("ReviewHeader tree action", () => {
  it("does not offer Open as tree for the viewer's own PR", () => {
    state.mine = true;
    render(<ReviewHeader pr={pr} />);
    expect(screen.queryByRole("button", { name: "Open as tree" })).not.toBeInTheDocument();
  });

  it("focuses an existing PR tree instead of trying to create another checkout", () => {
    state.worktrees = [existing];
    state.worktreePrs = [{ issueId: existing.id, number: pr.number, url: pr.url, state: "Open" }];
    render(<ReviewHeader pr={pr} />);

    fireEvent.click(screen.getByRole("button", { name: "View tree" }));
    expect(state.mutate).not.toHaveBeenCalled();
    expect(state.requestTreeFocus).toHaveBeenCalledWith(existing.id);
    expect(state.navigate).toHaveBeenCalledWith({ to: "/trees" });
  });

  it("creates an unowned PR tree without assigning a provider", () => {
    render(<ReviewHeader pr={pr} />);
    fireEvent.click(screen.getByRole("button", { name: "Open as tree" }));

    expect(state.addPendingLaunches).toHaveBeenCalledWith([
      expect.objectContaining({ id: reviewTreeId(pr), agent: null }),
    ]);
    expect(state.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ prRepo: pr.repo, branch: pr.headRef }),
      expect.any(Object),
    );
  });

  it("disables tree creation when the PR's repository is not registered locally", () => {
    state.repos = [];
    render(<ReviewHeader pr={pr} />);
    expect(screen.getByRole("button", { name: "Open as tree" })).toBeDisabled();
  });
});

describe("reviewTreeId", () => {
  it("does not collide when separators move between owner and repo", () => {
    expect(reviewTreeId({ repo: "a-b/c", number: 1 })).not.toBe(
      reviewTreeId({ repo: "a/b-c", number: 1 }),
    );
  });
});
