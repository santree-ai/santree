import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewPr, Worktree, WorktreePr } from "../../bindings";
import { worktree as fxWorktree } from "../../test/fixtures";

const state = vi.hoisted(() => ({
  infoCollapsed: false,
  repos: [{ name: "acme/app" }],
  worktrees: [] as Worktree[],
  worktreePrs: [] as WorktreePr[],
  /** `undefined` is the read still in flight, which the sentence must survive. */
  detail: undefined as { commits: unknown[] } | undefined,
  /** The AI review's checkout, when one has been cut. What decides whether the
   *  tree action is offering to check anything out at all. */
  reviewCheckout: undefined as unknown,
  mutate: vi.fn(),

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
  usePrDetail: () => ({ data: state.detail }),
  useReviewCheckout: () => ({ data: state.reviewCheckout }),
  usePromoteReviewWorktree: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("../../state/AppContext", () => ({
  useAppUi: () => ({
    addPendingLaunches: state.addPendingLaunches,
    removePendingLaunch: state.removePendingLaunch,
    requestTreeFocus: state.requestTreeFocus,
  }),
}));
vi.mock("./PrLabels", () => ({ PrLabels: () => null }));
// `usePrCheckout` reads the santree repo off the view model; the header itself
// reads nothing from it.
vi.mock("./model", () => ({
  useReviewsModel: () => ({
    repo: "acme/app",
    infoCollapsed: state.infoCollapsed,
    toggleInfo: vi.fn(),
  }),
}));

import { reviewTreeId } from "./checkoutSource";
import { usePrCheckout } from "./PrCheckout";
import { PR_COLUMN } from "./prLayout";
import { commitPhrase, ReviewHeader } from "./ReviewHeader";
import { WorktreeGateProvider } from "./WorktreeGate";

/** The header as Reviews hosts it for someone else's PR: with the PR's checkout,
 *  so the tree actions are on offer. */
function Header({ pr }: { pr: ReviewPr }) {
  const checkout = usePrCheckout(pr);
  return <ReviewHeader pr={pr} checkout={checkout} />;
}

const pr = {
  id: "PR_node",
  number: 42,
  title: "Fix the thing",
  url: "https://github.com/acme/app/pull/42",
  repo: "acme/app",
  project: null,
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
  state.infoCollapsed = false;
  state.repos = [{ name: "acme/app" }];
  state.worktrees = [];
  state.worktreePrs = [];
  state.detail = undefined;
  state.reviewCheckout = undefined;
  vi.clearAllMocks();
});

/** GitHub's shape: the number is part of how a PR is named, and the row under the
 *  title says in one sentence what merging it would do. */
describe("ReviewHeader identity", () => {
  it("puts the number in the heading rather than on a line above it", () => {
    render(<Header pr={pr} />);

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Fix the thing #42");
  });

  it("writes the merge sentence with the count once the detail read lands", () => {
    state.detail = { commits: [{}, {}, {}] };
    render(<Header pr={pr} />);

    expect(screen.getByText(/wants to merge 3 commits into/)).toBeVisible();
    expect(screen.getByText(pr.baseRef)).toBeVisible();
    expect(screen.getByTitle(`Copy branch — ${pr.headRef}`)).toBeVisible();
  });

  it("says it without a count while that read is in flight, rather than guessing", () => {
    render(<Header pr={pr} />);

    expect(screen.getByText(/wants to merge commits into/)).toBeVisible();
    expect(screen.queryByText(/0 commits/)).not.toBeInTheDocument();
  });

  it("names the PR's state, and calls an unready open PR a draft", () => {
    const { unmount } = render(<Header pr={pr} />);
    expect(screen.getByTitle("Open pull request")).toBeVisible();
    unmount();

    render(<Header pr={{ ...pr, isDraft: true }} />);
    expect(screen.getByTitle("Draft pull request")).toBeVisible();
  });

  /**
   * Reported: the base branch ended one row and the head branch started the
   * next. "into X from Y" is a comparison, and it stops reading as one the
   * moment the two halves are on different lines — so the row never wraps and
   * the branch names ellipsize instead, which is what they already do at their
   * 240/300px caps on a wide window.
   */
  it("keeps the whole merge sentence on one row, ellipsizing the branches", () => {
    state.detail = { commits: [{}] };
    render(<Header pr={pr} />);

    const base = screen.getByText(pr.baseRef);
    const row = base.parentElement as HTMLElement;
    expect(row.className).not.toContain("flex-wrap");
    // Both branches are in it, and both give up width before the line does.
    expect(row).toContainElement(screen.getByTitle(`Copy branch — ${pr.headRef}`));
    expect(base.className).toContain("truncate");
    expect(base).toHaveAttribute("title", pr.baseRef);
  });

  /** The diffstat rides the tab strip now — two of them on one screen would read
   *  as two different measurements. */
  it("leaves the diffstat to the tab strip", () => {
    render(<Header pr={pr} />);
    expect(screen.queryByText(`+${pr.additions}`)).not.toBeInTheDocument();
  });
});

describe("commitPhrase", () => {
  it("counts commits, and stays silent rather than saying zero of them", () => {
    expect(commitPhrase(3)).toBe("3 commits");
    expect(commitPhrase(1)).toBe("1 commit");
    // A pull request with no commits does not exist, so "0 commits" could only
    // ever be santree describing its own pending fetch as the PR's shape.
    expect(commitPhrase(null)).toBe("commits");
  });
});

/** The title used to start at the pane's left edge while the body under it
 *  started in a centred column — two left edges on one page. */
it("draws its content in the page column", () => {
  const { container } = render(<Header pr={pr} />);
  const band = container.firstElementChild as HTMLElement;
  // The rule spans the page; the content inside it is the column.
  expect(band.className).toContain("border-b");
  const column = band.firstElementChild as HTMLElement;
  for (const c of PR_COLUMN.split(" ")) expect(column.classList.contains(c)).toBe(true);
});

/** The header carried five rows: repo slug, title, the merge sentence, a status
 *  row, then reviewers and labels. Two of them were saying things said elsewhere
 *  — the slug repeats the sidebar section you clicked from, and the check rollup
 *  repeats the Checks tab's own glyph a few pixels below. */
describe("ReviewHeader identity", () => {
  it("puts the review verdict beside the number, not on a row of its own", () => {
    render(<Header pr={{ ...pr, reviewDecision: "Approved" } as ReviewPr} />);

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent(`#${pr.number}`);
    expect(heading).toHaveTextContent(/approved/i);
  });

  it("drops the repo breadcrumb and the check rollup", () => {
    render(<Header pr={pr} />);

    expect(screen.queryByText(pr.repo)).not.toBeInTheDocument();
    expect(screen.queryByText(/checks (failing|passing)/i)).not.toBeInTheDocument();
  });
});

describe("ReviewHeader tree action", () => {
  /** The actions wrap so a narrow window never hides one behind the info rail.
   *  The branch line below them does the opposite — see "keeps the whole merge
   *  sentence on one row": there, the two branches being side by side is the
   *  point, and the names ellipsize to buy the room. */
  it("wraps all header actions instead of clipping them behind the info rail", () => {
    render(<Header pr={pr} />);

    const branchAction = screen.getByTitle(`Copy branch — ${pr.headRef}`);
    expect(screen.getByRole("button", { name: "Open in GitHub" }).parentElement).toHaveClass(
      "flex-wrap",
    );
    expect(branchAction).toBeVisible();
    expect(screen.getByRole("button", { name: "Open as tree" })).toBeVisible();
    // Named, not just glyphed: "Open" alone read as "open the pull request",
    // which is the one thing this view is already doing.
    expect(screen.getByRole("button", { name: "Open in GitHub" })).toBeVisible();
    // It carries the repo slug the breadcrumb row used to spend a line on.
    expect(screen.getByRole("button", { name: "Open in GitHub" })).toHaveAttribute(
      "title",
      `Open ${pr.repo}#${pr.number} on GitHub`,
    );
  });

  /** The rail's toggle changes host between the rail's own header and the main
   *  tab strip — never this one. It used to appear here when the rail collapsed,
   *  which put it on a header only the Pull Request tab shows: collapse the rail
   *  from an agent tab and the way back was gone. */
  it("leaves the rail toggle to the tab strip, collapsed or not", () => {
    const railToggle = { name: /panel|details/i };
    const { unmount } = render(<Header pr={pr} />);
    expect(screen.queryByRole("button", railToggle)).not.toBeInTheDocument();
    unmount();

    state.infoCollapsed = true;
    render(<Header pr={pr} />);
    expect(screen.queryByRole("button", railToggle)).not.toBeInTheDocument();
  });

  /** The host says so by withholding the checkout: Reviews does for a PR in the
   *  inbox's "mine" list, and Trees — which only ever shows your own PR, beside
   *  its worktree — never passes one at all. */
  it("does not offer Open as tree for the viewer's own PR", () => {
    render(<ReviewHeader pr={pr} />);
    expect(screen.queryByRole("button", { name: "Open as tree" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View tree" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open in GitHub" })).toBeVisible();
  });

  it("focuses an existing PR tree instead of trying to create another checkout", () => {
    state.worktrees = [existing];
    state.worktreePrs = [
      { issueId: existing.id, repo: pr.repo, number: pr.number, url: pr.url, state: "Open" },
    ];
    render(<Header pr={pr} />);

    fireEvent.click(screen.getByRole("button", { name: "View tree" }));
    expect(state.mutate).not.toHaveBeenCalled();
    expect(state.requestTreeFocus).toHaveBeenCalledWith("acme/app", existing.id);
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/trees",
      search: { project: "acme/app", tree: existing.id },
    });
  });

  /** The other arm: someone checked the branch out before the PR was linked, so
   *  there is no `worktreePrs` row — the branch match is all santree has. */
  it("focuses a tree already sitting on the PR's branch, with no PR link recorded", () => {
    state.worktrees = [{ ...existing, branch: pr.headRef }];
    state.worktreePrs = [];
    render(<Header pr={pr} />);

    fireEvent.click(screen.getByRole("button", { name: "View tree" }));
    expect(state.mutate).not.toHaveBeenCalled();
    expect(state.requestTreeFocus).toHaveBeenCalledWith("acme/app", existing.id);
  });

  /** Through the shared gate now: the header used to hold its own copy of this
   *  flow, which cut the worktree with no confirmation at all. */
  it("creates an unowned PR tree without assigning a provider", async () => {
    render(
      <WorktreeGateProvider>
        <Header pr={pr} />
      </WorktreeGateProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open as tree" }));
    expect(state.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create worktree" }));
    await waitFor(() => expect(state.mutate).toHaveBeenCalled());

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
    render(<Header pr={pr} />);
    expect(screen.getByRole("button", { name: "Open as tree" })).toBeDisabled();
  });
});

/**
 * Reported: "why do we have the 'Open as tree' button if the tree is technically
 * already downloaded" — asked while the rail listed the branch's files and an AI
 * review sat beside them. Those files are the review's own detached checkout, so
 * the button is right and its name was not: it does not open the PR, it adds the
 * worktree that keeps work.
 */
describe("ReviewHeader tree action once the AI review has a checkout", () => {
  const reviewCheckout = { repo: "acme/app", worktree: fxWorktree("review", { branch: "abc123" }) };

  it("offers to keep the checkout, not to cut a second one", () => {
    state.reviewCheckout = reviewCheckout;
    render(<Header pr={pr} />);

    expect(screen.queryByRole("button", { name: "Open as tree" })).not.toBeInTheDocument();
    const action = screen.getByRole("button", { name: "Keep as a worktree" });
    // There is one checkout per pull request, so the only thing left to do with
    // it is drop the review label — same directory, same branch.
    expect(action).toHaveAttribute("title", expect.stringContaining("same checkout"));
  });

  /** The rename is only for the case the reporter hit. With nothing checked out
   *  the original name is the honest one. */
  it("stays 'Open as tree' when nothing is checked out at all", () => {
    render(<Header pr={pr} />);
    expect(screen.getByRole("button", { name: "Open as tree" })).toBeInTheDocument();
  });

  /** A real worktree already answers the question the button asks, and "View
   *  tree" is what it says there — the review checkout must not talk over it. */
  it("still says View tree when the PR has a worktree of its own", () => {
    state.reviewCheckout = reviewCheckout;
    state.worktrees = [{ ...existing, branch: pr.headRef }];
    render(<Header pr={pr} />);

    expect(screen.getByRole("button", { name: "View tree" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add a worktree" })).not.toBeInTheDocument();
  });
});

describe("reviewTreeId", () => {
  it("does not collide when separators move between owner and repo", () => {
    expect(reviewTreeId({ repo: "a-b/c", number: 1 })).not.toBe(
      reviewTreeId({ repo: "a/b-c", number: 1 }),
    );
  });
});
