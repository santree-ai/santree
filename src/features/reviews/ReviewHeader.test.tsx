import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewPr, Worktree, WorktreePr } from "../../bindings";
import { worktree as fxWorktree } from "../../test/fixtures";

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
  useCreateWorktree: () => ({ mutate: state.mutate, isPending: false }),
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
  headRefId: null,
  baseRef: "main",
  baseRefId: null,
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
  aiDraftCount: 0,
  reviewers: [],
  updatedAt: "2026-08-24T10:00:00Z",
  createdAt: "2026-08-23T10:00:00Z",
  waitingSince: "2026-08-23T10:00:00Z",
  headCommittedAt: "2026-08-24T09:00:00Z",
  viewerReview: null,
} satisfies ReviewPr;

/** Deliberately NOT on `pr.headRef`. `existingTree` is a two-armed lookup —
 *  linked by PR url, or matched by branch — and a fixture that satisfies both at
 *  once lets either arm be deleted with the suite still green. */
const existing = fxWorktree("AK-42", { title: "Fix the thing", branch: "someone/unrelated" });

beforeEach(() => {
  state.mine = false;
  state.repos = [{ name: "acme/app" }];
  state.worktrees = [];
  state.worktreePrs = [];
  vi.clearAllMocks();
});

describe("ReviewHeader tree action", () => {
  it("wraps all header actions instead of clipping them behind the info rail", () => {
    render(<ReviewHeader pr={pr} />);

    const branchAction = screen.getByTitle(`Copy branch — ${pr.headRef}`);
    expect(branchAction.parentElement).toHaveClass("flex-wrap");
    expect(branchAction).toBeVisible();
    expect(screen.getByRole("button", { name: "Open as tree" })).toBeVisible();
    expect(screen.getByTitle("Open on GitHub")).toBeVisible();
    expect(screen.getByRole("button", { name: "Hide details (⌘L)" })).toBeVisible();
  });

  it("does not offer Open as tree for the viewer's own PR", () => {
    state.mine = true;
    render(<ReviewHeader pr={pr} />);
    expect(screen.queryByRole("button", { name: "Open as tree" })).not.toBeInTheDocument();
  });

  it("focuses an existing PR tree instead of trying to create another checkout", () => {
    state.worktrees = [existing];
    state.worktreePrs = [
      { issueId: existing.id, repo: pr.repo, number: pr.number, url: pr.url, state: "Open" },
    ];
    render(<ReviewHeader pr={pr} />);

    fireEvent.click(screen.getByRole("button", { name: "View tree" }));
    expect(state.mutate).not.toHaveBeenCalled();
    expect(state.requestTreeFocus).toHaveBeenCalledWith(existing.id);
    expect(state.navigate).toHaveBeenCalledWith({ to: "/trees" });
  });

  /** The other arm: someone checked the branch out before the PR was linked, so
   *  there is no `worktreePrs` row — the branch match is all santree has. */
  it("focuses a tree already sitting on the PR's branch, with no PR link recorded", () => {
    state.worktrees = [{ ...existing, branch: pr.headRef }];
    state.worktreePrs = [];
    render(<ReviewHeader pr={pr} />);

    fireEvent.click(screen.getByRole("button", { name: "View tree" }));
    expect(state.mutate).not.toHaveBeenCalled();
    expect(state.requestTreeFocus).toHaveBeenCalledWith(existing.id);
  });

  it("creates an unowned PR tree without assigning a provider", () => {
    render(<ReviewHeader pr={pr} />);
    fireEvent.click(screen.getByRole("button", { name: "Open as tree" }));

    // The placeholder is merged straight into the sidebar's worktree list, so a
    // project on it opens a band exactly as a stored one would.
    expect(state.addPendingLaunches).toHaveBeenCalledWith([
      expect.objectContaining({ id: reviewTreeId(pr), agent: null, project: null }),
    ]);
    expect(state.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: reviewTreeId(pr),
        launch: { type: "pr", prRepo: pr.repo, branch: pr.headRef },
        agent: null,
      }),
      expect.any(Object),
    );
    // The origin has no project field to fill in, which is the point.
    expect(state.mutate.mock.calls[0][0]).not.toHaveProperty("project");
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
