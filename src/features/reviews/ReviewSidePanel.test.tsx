/**
 * What the Reviews rail is allowed to be. The rules are decisions rather than
 * rendering details: the rail is what you consult while reading a PR (the main
 * area is the PR itself, so a PR pane here would be the same thing twice), it
 * never opens on a pane that has nothing in it, and the three panes that read the
 * branch on disk keep their tabs whether or not the PR has been checked out —
 * a strip whose tabs come and go as you click around it is worse than one with
 * an honest empty state.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChangedFile, ReviewCheckout, ReviewPr, Worktree } from "../../bindings";

const model = vi.hoisted(() => ({
  infoCollapsed: false,
  infoWidth: 400,
  toggleInfo: vi.fn(),
  setInfoWidth: vi.fn(),
  repo: "acme/app",
  focusFile: vi.fn(),
  openAiReview: vi.fn(),
}));
vi.mock("./model", () => ({ useReviewsModel: () => model }));

// Reaches the router and the query client to create the PR's worktree; the panel
// only needs the launcher to exist.
vi.mock("./useStartWork", () => ({
  useStartWorkFromReviews: () => ({ start: vi.fn(), starting: false }),
}));

// The header owns `reviewTreeId` and imports half the PR chrome with it; only
// the id matters here.
vi.mock("./ReviewHeader", () => ({
  reviewTreeId: (pr: { repo: string; number: number }) => `review-${pr.repo}-${pr.number}`,
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../state/AppContext", () => ({
  useApp: () => ({ setActiveRepo: vi.fn() }),
  useAppUi: () => ({
    addPendingLaunches: vi.fn(),
    removePendingLaunch: vi.fn(),
    requestTreeFocus: vi.fn(),
  }),
}));

vi.mock("../../components/IssuePane", () => ({
  IssuePane: () => <div data-testid="issue-pane" />,
}));
vi.mock("./AiWorkPane", () => ({
  AiWorkPane: () => <div data-testid="ai-work-pane" />,
  aiWorkDot: () => null,
}));
// The three panes Trees owns stand in for themselves: what matters here is which
// one the rail picked, and whether it picked one at all.
vi.mock("../trees/AllFilesList", () => ({
  AllFilesList: () => <div data-testid="files-pane" />,
}));
vi.mock("../trees/GitPanel", () => ({ GitPanel: () => <div data-testid="changes-pane" /> }));
vi.mock("../trees/SessionHistory", () => ({
  SessionHistory: () => <div data-testid="history-pane" />,
}));
vi.mock("../../lib/useEdgeResize", () => ({ useEdgeResize: () => ({}) }));

const world = vi.hoisted(() => ({
  worktrees: [] as Worktree[],
  /** The AI review's detached checkout, when one has been made for this PR. */
  reviewCheckout: null as ReviewCheckout | null,
  status: undefined as ChangedFile[] | undefined,
  /** Every `(repo, worktreeId)` the status read was mounted with — the gate that
   *  keeps a PR with no checkout from reading one. */
  statusCalls: [] as [string, string][],
  removed: [] as unknown[],
  pulls: [] as string[],
}));
vi.mock("../../lib/queries", () => ({
  useReviewWorkItems: () => ({ data: [] }),
  usePrReviewBrief: () => ({ data: undefined }),
  // Both reads are `enabled: !!repo` in the real hooks, and that gate is what a
  // repo-less PR relies on — so the stand-ins honour it.
  // `usePrCheckout` falls back to a registered project named after the PR's slug
  // when the inbox didn't attribute one — the rule the header used to apply.
  useRepos: () => ({ data: [] }),
  useWorktrees: (repo: string) => ({ data: repo ? world.worktrees : [] }),
  useWorktreePrs: () => ({ data: [] }),
  useReviewCheckout: () => ({ data: world.reviewCheckout }),
  useCreateWorktree: () => ({ mutate: vi.fn(), isPending: false }),
  // "Keep as a worktree" — the only thing the tree action does once the PR is
  // already checked out, since there is one checkout per PR to keep.
  usePromoteReviewWorktree: () => ({ mutate: vi.fn(), isPending: false }),
  // The checkout bar's third action: a review checkout is a worktree Trees does
  // not list, so this bar is the only place it can be removed from.
  useRemoveReviewWorkspace: () => ({
    mutate: (v: unknown) => world.removed.push(v),
    isPending: false,
  }),
  usePullRemoteWorktree: () => ({
    mutate: (id: string) => world.pulls.push(id),
    isPending: false,
  }),
  useWorktreeStatus: (repo: string, id: string) => {
    world.statusCalls.push([repo, id]);
    return { data: world.status };
  },
}));

import { changesDot } from "../trees/FilePickerPanel";
import { REVIEW_CHECKOUT_NOTE } from "./checkoutSource";
import { defaultRailTab, type RailTab, ReviewSidePanel } from "./ReviewSidePanel";

const pr = {
  id: "p1",
  number: 7,
  repo: "acme/app",
  project: "acme/app",
  title: "[AK-1] thing",
  headRef: "santree/ak-1-thing",
  baseRef: "main",
  headSha: "head-1",
  url: "https://github.com/acme/app/pull/7",
} as ReviewPr;

/** The PR's own checkout, as the worktree list would carry it. */
const checkout = { id: "review-acme/app-7", branch: pr.headRef, remoteBehind: 0 } as Worktree;

/** The AI review's detached checkout — a row the worktree list never returns,
 *  whose `branch` carries the commit it sits at. */
const REVIEW_ID = "review-checkout-4-acme-3-app-7";
const reviewed = (sha: string): ReviewCheckout => ({
  repo: "acme/app",
  worktree: { id: REVIEW_ID, branch: sha, remoteBehind: 0 } as Worktree,
});

const file = (path: string): ChangedFile => ({
  path,
  oldPath: null,
  status: "Modified",
  staged: false,
  addLines: 1,
  delLines: 0,
  binary: false,
});

function mount(tab: RailTab, state: Partial<typeof world> = {}) {
  Object.assign(
    world,
    {
      worktrees: [],
      reviewCheckout: null,
      status: undefined,
      statusCalls: [],
      pulls: [],
    },
    state,
  );
  return render(
    <ReviewSidePanel pr={pr} tab={tab} onTabChange={vi.fn()} activeReviewAgent={null} />,
  );
}

beforeEach(() => {
  Object.assign(world, {
    worktrees: [],
    reviewCheckout: null,
    status: undefined,
    statusCalls: [],
    pulls: [],
  });
});

const tabNames = () => screen.getAllByRole("tab").map((t) => t.getAttribute("aria-label"));

/** A tab's dot, by the inline background the strip paints it with (the selected
 *  tab's underline is the other `aria-hidden` span, and carries no style). */
function dotOf(label: string): string | null {
  const tab = screen.getByRole("tab", { name: label });
  return tab.querySelector<HTMLElement>("span[aria-hidden][style]")?.style.background ?? null;
}

describe("ReviewSidePanel", () => {
  // The rail carries the PR in Trees because the main area is the worktree. Here
  // the main area *is* the PR, so a tab onto it would be the same content in a
  // narrower column. Everything else is a fact about the branch or the ticket.
  it("offers what you consult beside a PR, and nothing that is the PR", () => {
    mount("issue");
    expect(tabNames()).toEqual(["Issue", "Files", "Changes", "Session history", "AI work queue"]);
  });

  // The three branch panes need a checkout, which most PRs don't have — and that
  // must not change which tabs exist.
  it("offers the same five tabs with and without a local checkout", () => {
    const { unmount } = mount("issue");
    const without = tabNames();
    unmount();

    mount("issue", { worktrees: [checkout] });
    expect(tabNames()).toEqual(without);
  });

  it("renders the pane its selected tab names", () => {
    const arms: [RailTab, string][] = [
      ["issue", "issue-pane"],
      ["files", "files-pane"],
      ["changes", "changes-pane"],
      ["history", "history-pane"],
      ["aiWork", "ai-work-pane"],
    ];
    for (const [tab, pane] of arms) {
      const { unmount } = mount(tab, { worktrees: [checkout] });
      expect(screen.getByTestId(pane)).toBeTruthy();
      for (const [, other] of arms) {
        if (other !== pane) expect(screen.queryByTestId(other)).toBeNull();
      }
      unmount();
    }
  });

  // The failure this pins: a Files tab that renders the pane against no worktree
  // shows an empty tree, which reads as "this branch has no files".
  it.each<[RailTab, string]>([
    ["files", "files-pane"],
    ["changes", "changes-pane"],
    ["history", "history-pane"],
  ])("says the PR has no local checkout rather than rendering %s against none", (tab, pane) => {
    const { unmount } = mount(tab);
    expect(screen.queryByTestId(pane)).toBeNull();
    expect(screen.getByText("No local checkout")).toBeTruthy();
    // The one action that fixes it, the same one the PR header offers.
    expect(screen.getByRole("button", { name: /Open as tree/ })).toBeTruthy();
    unmount();
  });

  // A PR from a repo the user never cloned can never have a checkout, so the
  // action that would make one is offered as unavailable rather than as a click
  // that ends in a red toast.
  it("cannot offer to cut a worktree in a repo that is not a local project", () => {
    // A worktree on the same branch in another project must not be adopted: the
    // reads are keyed on the PR's own project, and it hasn't got one.
    world.worktrees = [checkout];
    render(
      <ReviewSidePanel
        pr={{ ...pr, project: null }}
        tab="files"
        onTabChange={vi.fn()}
        activeReviewAgent={null}
      />,
    );
    expect(screen.getByText("No local checkout")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Open as tree/ })).toBeDisabled();
  });

  it("reads the branch panes off the PR's own worktree once it exists", () => {
    mount("files", { worktrees: [checkout] });
    expect(screen.getByTestId("files-pane")).toBeTruthy();
    expect(screen.queryByText("No local checkout")).toBeNull();
  });

  // The bug this closes: an AI review put a real checkout on disk and the three
  // panes beside it still said there was none.
  it("falls back to the AI review's checkout, and says which one it is showing", () => {
    mount("changes", { reviewCheckout: reviewed(pr.headSha) });
    expect(screen.getByTestId("changes-pane")).toBeTruthy();
    expect(screen.queryByText("No local checkout")).toBeNull();
    // Read through the project that actually holds it, not the active repo.
    expect(world.statusCalls.at(-1)).toEqual(["acme/app", REVIEW_ID]);
    // It is pruneable and detached, so a pane that invites edits has to say so.
    expect(screen.getByText(REVIEW_CHECKOUT_NOTE)).toBeTruthy();
  });

  // The PR's own worktree wins: it is where work is kept, and the review
  // checkout is deleted on a schedule.
  it("prefers the PR's worktree over the review checkout, and drops the notice", () => {
    mount("changes", { worktrees: [checkout], reviewCheckout: reviewed("older") });
    expect(world.statusCalls.at(-1)).toEqual(["acme/app", checkout.id]);
    expect(screen.queryByText(REVIEW_CHECKOUT_NOTE)).toBeNull();
  });

  /** The PR's checkout is a branch checkout like any other now, so it catches up
   *  the way any other does — an ordinary pull, offered only while origin is
   *  actually ahead. The wholesale "move it to the PR's head" it used to need
   *  went with the detached tree it was for. */
  /** A review checkout is a worktree Trees does not list, so this bar is the only
   *  surface that names it — and therefore the only one that can offer to keep or
   *  delete it. The delete used to live in the AI review session's footer alone,
   *  which stranded the checkout the moment that tab could be closed. */
  it("offers the whole lifecycle of a checkout Trees cannot show", () => {
    mount("files", { reviewCheckout: reviewed(pr.headSha) });
    expect(screen.getByRole("button", { name: /Keep as a worktree/ })).toBeTruthy();

    screen.getByRole("button", { name: /Remove checkout/ }).click();
    expect(world.removed).toEqual([{ prRepo: pr.repo, number: pr.number, headSha: pr.headSha }]);
  });

  /** Neither belongs on a tree you already keep: it is in Trees, where removing
   *  a worktree is what that view is for. */
  it("offers neither on the PR's own worktree", () => {
    mount("files", { worktrees: [checkout] });
    expect(screen.queryByRole("button", { name: /Keep as a worktree/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove checkout/ })).toBeNull();
  });

  it("offers the review checkout a pull, on the same rule as any worktree", () => {
    const { unmount } = mount("files", { reviewCheckout: reviewed(pr.headSha) });
    expect(screen.queryByRole("button", { name: /Pull/ })).toBeNull();
    unmount();

    mount("files", {
      reviewCheckout: {
        repo: "acme/app",
        worktree: { id: REVIEW_ID, branch: "user/pr", remoteBehind: 4 } as Worktree,
      },
    });
    screen.getByRole("button", { name: /Pull 4/ }).click();
    expect(world.pulls).toEqual([REVIEW_ID]);
  });

  // The same affordance, the other case: a worktree on the branch pulls rather
  // than being re-cut, and only while its remote is actually ahead.
  it("offers a pull for the PR's worktree only while origin has commits it lacks", () => {
    const { unmount } = mount("files", { worktrees: [checkout] });
    expect(screen.queryByRole("button", { name: /Pull/ })).toBeNull();
    unmount();

    mount("files", { worktrees: [{ ...checkout, remoteBehind: 2 } as Worktree] });
    screen.getByRole("button", { name: /Pull 2/ }).click();
    expect(world.pulls).toEqual([checkout.id]);
  });

  // Same rule as the Trees strip, from the same function — two rails must not
  // disagree about whether one worktree has pending changes.
  it("dots the Changes tab from the rule Trees uses", () => {
    const { unmount } = mount("issue", { worktrees: [checkout], status: [file("a.ts")] });
    expect(dotOf("Changes")).toBe(changesDot([file("a.ts")]));
    expect(dotOf("Changes")).toBe("var(--accent)");
    unmount();

    mount("issue", { worktrees: [checkout], status: [] });
    expect(dotOf("Changes")).toBe(changesDot([]));
    expect(dotOf("Changes")).toBeNull();
  });

  // No worktree id means the status query never runs, so there is nothing to dot
  // with — rather than a dot borrowed from whichever worktree was read last.
  it("reads no worktree status at all while the PR has no checkout", () => {
    const { unmount } = mount("issue");
    expect(world.statusCalls.at(-1)).toEqual(["acme/app", ""]);
    expect(dotOf("Changes")).toBeNull();
    unmount();

    mount("issue", { worktrees: [checkout] });
    expect(world.statusCalls.at(-1)).toEqual(["acme/app", "review-acme/app-7"]);
  });

  it("stays in flex flow so resizing it also resizes the main pane", () => {
    const { container } = mount("issue");
    const panel = container.firstElementChild;

    expect(panel).toHaveClass("relative", "flex-none");
    expect(panel?.className).not.toContain("absolute");
  });
});

describe("defaultRailTab", () => {
  // A review is the code read against what it was asked to do, so the ticket
  // leads whenever there is one.
  it("lands on the ticket when the PR names one", () => {
    expect(defaultRailTab(true)).toBe("issue");
  });

  // Same rule `resolveFileTab` holds in Trees: never open on a pane that isn't
  // there. Landing a ticket-less PR on "No linked ticket" teaches nothing.
  it("falls back to the work queue when it doesn't", () => {
    expect(defaultRailTab(false)).toBe("aiWork");
  });
});
