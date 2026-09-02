/**
 * The PR row's right-click menu: GitHub and the copy rows are always there, the
 * ticket's rows when the PR names one, and the checkout rows only once the PR
 * has a checkout — the review kind asked for the moment the menu opens, not
 * once per row of the inbox.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewCheckout, ReviewPr, Worktree } from "../../bindings";
import { worktree } from "../../test/fixtures";

const nav = vi.hoisted(() => ({
  navigate: vi.fn(),
  setActiveRepo: vi.fn(),
  requestTreeFocus: vi.fn(),
}));
const data = vi.hoisted(() => ({
  worktrees: [] as Worktree[],
  review: null as ReviewCheckout | null,
  /** Every repo the review-checkout read was asked about, in render order. */
  checkoutAskedFor: [] as string[],
  deleteWorktree: vi.fn(),
  removeReview: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => nav.navigate }));
vi.mock("../../state/AppContext", () => ({
  useApp: () => ({ setActiveRepo: nav.setActiveRepo }),
  useAppUi: () => ({ requestTreeFocus: nav.requestTreeFocus }),
}));
vi.mock("../../lib/queries", () => ({
  useWorktrees: () => ({ data: data.worktrees }),
  useWorktreePrs: () => ({ data: [] }),
  useReviewCheckout: (repo: string) => {
    data.checkoutAskedFor.push(repo);
    return { data: repo ? data.review : undefined };
  },
  useLinearIssueUrl: () => (id: string) => `https://linear.app/acme/issue/${id}`,
  useRemoveReviewWorkspace: () => ({ mutate: data.removeReview }),
}));
vi.mock("../../features/trees/useWorktreeDeletion", () => ({
  useWorktreeDeletion: () => ({ deleteWorktree: data.deleteWorktree }),
}));

import { ReviewPrMenu } from "./ReviewPrMenu";

function pr(over: Partial<ReviewPr> = {}): ReviewPr {
  return {
    id: "node-1",
    number: 41,
    title: "A change",
    url: "https://github.com/acme/web/pull/41",
    repo: "acme/web",
    project: "web",
    headRef: "user/some-branch",
    headRefId: null,
    baseRef: "main",
    baseRefId: null,
    headSha: "abc1234",
    author: "someone",
    authorAvatarUrl: "",
    state: "Open",
    isDraft: false,
    reviewDecision: "ReviewRequired",
    checks: "Success",
    isInMergeQueue: false,
    additions: 10,
    deletions: 5,
    changedFiles: 1,
    commentCount: 0,
    aiDraftCount: 0,
    reviewers: [],
    updatedAt: "2026-08-05T00:00:00Z",
    createdAt: "2026-08-01T00:00:00Z",
    waitingSince: "2026-08-01T00:00:00Z",
    headCommittedAt: "2026-08-01T00:00:00Z",
    viewerReview: null,
    ...over,
  };
}

function show(p: ReviewPr) {
  render(
    <ReviewPrMenu pr={p}>
      <button type="button">row</button>
    </ReviewPrMenu>,
  );
}
const open = () => fireEvent.contextMenu(screen.getByText("row"));
const rows = () => screen.getAllByRole("menuitem").map((el) => el.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  data.worktrees = [];
  data.review = null;
  data.checkoutAskedFor = [];
});

describe("ReviewPrMenu", () => {
  it("offers GitHub and the copy rows, and nothing about a checkout it doesn't have", () => {
    show(pr());
    open();
    expect(rows()).toEqual(["Open on GitHub", "Copy PR number", "Copy link", "Copy branch"]);
  });

  it("adds the ticket's rows when the PR names one", () => {
    show(pr({ title: "[AK-12] A change", headRef: "user/ak-12-a-change" }));
    open();
    expect(rows()).toContain("Open ticket in Linear");
    expect(rows()).toContain("Copy ticket id");
  });

  /** The lookup is a read of its own per PR; an inbox of forty rows must not
   *  make forty of them on render. */
  it("asks for the review checkout only once the menu opens", () => {
    show(pr());
    expect(data.checkoutAskedFor.every((repo) => repo === "")).toBe(true);
    open();
    expect(data.checkoutAskedFor).toContain("web");
  });

  it("opens the PR's own worktree in Trees, and deletes it after a confirmation", () => {
    data.worktrees = [worktree("AK-12", { branch: "user/some-branch" })];
    show(pr());
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open worktree" }));
    expect(nav.setActiveRepo).toHaveBeenCalledWith("web");
    expect(nav.requestTreeFocus).toHaveBeenCalledWith("AK-12", { fromSidebar: true });
    expect(nav.navigate).toHaveBeenCalledWith({ to: "/trees" });

    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete worktree" }));
    expect(data.deleteWorktree).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Delete worktree" });
    expect(dialog).toHaveTextContent("AK-12");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(data.deleteWorktree).toHaveBeenCalledWith("AK-12");
  });

  /** Trees doesn't list a review checkout, so there is nowhere to open it —
   *  but it can be deleted, through the review's own removal. */
  it("deletes a review checkout without offering to open it", () => {
    data.review = { repo: "web", worktree: worktree("review-4-acme-3-web-41") };
    show(pr());
    open();
    expect(rows()).not.toContain("Open worktree");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete review checkout" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(data.removeReview).toHaveBeenCalledWith({
      prRepo: "acme/web",
      number: 41,
      headSha: "abc1234",
    });
  });
});
