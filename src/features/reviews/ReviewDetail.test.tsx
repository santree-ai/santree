/**
 * The Pull Request tab's own rules — its sections, their counts, and where the
 * diffstat rides — plus the AI review's, which are correctness rather than
 * rendering: that pane spawns a PTY and checks the PR out, so opening a PR must
 * not cost a checkout and switching tabs must not restart the session. The rail's
 * landing tab is here too, because it is the one thing the rail can't decide for
 * itself — it is resolved per pull request, where the PR is known. The strip that
 * hosts all of this is ReviewTabBar's own test.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewPr } from "../../bindings";
import { PR_COLUMN } from "./prLayout";

const model = vi.hoisted(() => ({
  active: {
    id: "p1",
    number: 7,
    repo: "acme/app",
    title: "[AK-1] thing",
    headRef: "santree/ak-1-thing",
    checks: "Success",
    additions: 120,
    deletions: 8,
    changedFiles: 4,
  } as ReviewPr,
  showMergeQueue: false,
  fileFocus: null,
  focusFile: vi.fn(),
  aiReviewRequest: 0,
  infoCollapsed: false,
  toggleInfo: vi.fn(),
  repo: "acme/app",
  /** The inbox, for the one thing this file reads off it: whether the open PR
   *  is the viewer's own. */
  inbox: undefined as { mine: { id: string }[] } | undefined,
}));
vi.mock("./model", () => ({ useReviewsModel: () => model }));

const ai = vi.hoisted(() => ({ mounts: 0 }));
vi.mock("./AiReviewSessionPane", async () => {
  const { useEffect } = await import("react");
  return {
    aiReviewTermKey: () => "review:acme/app#7",
    AiReviewSessionPane: () => {
      useEffect(() => {
        ai.mounts++;
      }, []);
      return <div data-testid="ai-review-pane" />;
    },
  };
});

vi.mock("./PrReviewPane", () => ({ PrReviewPane: () => <div data-testid="pr-pane" /> }));
// The strip is its own test; this stand-in only has to name the tabs it was
// handed and select or close them, without needing a terminal registry.
vi.mock("./ReviewTabBar", () => ({
  ReviewTabBar: ({ tabs }: { tabs: ReviewTabs }) => (
    <div data-testid="tab-bar">
      {(
        [
          "pr",
          ...(tabs.issueViewOpen ? ["issueView"] : []),
          ...tabs.providers.map(aiTab),
        ] as ReviewMainTab[]
      ).map((t) => (
        <button key={t} type="button" onClick={() => tabs.select(t)}>
          {t}
        </button>
      ))}
      {tabs.issueViewOpen && (
        <button type="button" onClick={tabs.closeIssueView}>
          Close Linear
        </button>
      )}
    </div>
  ),
}));
vi.mock("./PrCheckout", () => ({ usePrCheckout: () => checkout }));
vi.mock("../../state/AgentRuns", () => ({
  useAgentRuns: () => ({ setVisibleWorktree: vi.fn() }),
  // The tab strip asks for it optionally, to run the setup script the worktree
  // dialog offered. Null here: nothing in these cases asked for one.
  useOptionalAgentRuns: () => null,
}));
vi.mock("./ChecksPane", () => ({ ChecksPane: () => <div data-testid="checks-pane" /> }));
// Renders the tab it was handed, which is what the landing-tab rule is about —
// and the ticket pane's one way out into the main area.
vi.mock("./ReviewSidePanel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ReviewSidePanel")>()),
  ReviewSidePanel: ({ tab, onOpenIssueView }: { tab: string; onOpenIssueView?: () => void }) => (
    <div data-testid="rail">
      {tab}
      <button type="button" onClick={onOpenIssueView}>
        Open in a tab
      </button>
    </div>
  ),
}));
vi.mock("../../components/IssuePage", () => ({
  IssuePage: ({ ticketId }: { ticketId: string }) => <div data-testid="issue-page">{ticketId}</div>,
}));
vi.mock("./PrConversationPane", () => ({
  PrConversationPane: () => <div data-testid="conversation-pane" />,
}));
vi.mock("./PrCommitsPane", () => ({ PrCommitsPane: () => <div data-testid="commits-pane" /> }));
// Only what the host decides for it is under test here: whether it was handed a
// checkout to offer the tree actions off.
vi.mock("./ReviewHeader", () => ({
  ReviewHeader: ({ checkout }: { checkout?: unknown }) => (
    <div data-testid="header">{checkout ? "with checkout" : "own"}</div>
  ),
}));
vi.mock("./MergeQueuePane", () => ({ MergeQueuePane: () => <div /> }));
vi.mock("../../lib/queries", () => ({
  REVIEW_AGENT_KEY: "review.agent",
  useAgentAuth: () => ({ data: { connected: true } }),
  useCodexAccount: () => ({ data: { connected: true } }),
  useCodexHealth: () => ({ data: { available: true } }),
  useResolvedSetting: () => ({ data: "Codex" }),
  useReviewDrafts: () => ({ data: drafts }),
  useSessionProviders: () => ({ data: storedProviders }),
  useCloseReviewSession: () => ({ mutate: vi.fn(), isPending: false }),
  useResumeWorktreeSession: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePrDetail: () => ({ data: detail }),
  useWorktreeTabs: () => ({ data: [] }),
  useAddWorktreeTab: () => ({ mutate: vi.fn() }),
  useRenameWorktreeTab: () => ({ mutate: vi.fn() }),
  useRemoveWorktreeTab: () => ({ mutate: vi.fn() }),
}));

import { ReviewDetail } from "./ReviewDetail";
import { aiTab, type ReviewMainTab, type ReviewTabs } from "./useReviewTabs";

/** A PR with no local checkout — the common case, and the one that must not stop
 *  the AI review from opening. */
const checkout = {
  repo: "acme/app",
  worktree: null,
  worktreeId: "",
  source: { worktree: null, worktreeId: "", repo: "acme/app", isReview: false },
  openAsTree: vi.fn(),
  opening: false,
  canOpen: true,
};

let drafts: unknown[] = [];
let storedProviders: string[] = [];
/** `undefined` is the detail read still in flight — the state the counts have to
 *  survive without inventing zeroes. */
let detail: { comments: unknown[]; commits: unknown[]; checks: unknown[] } | undefined;

const TICKETED_PR = model.active;

beforeEach(() => {
  ai.mounts = 0;
  drafts = [];
  storedProviders = [];
  detail = undefined;
  model.aiReviewRequest = 0;
  model.active = TICKETED_PR;
  model.inbox = undefined;
  // Most cases run against a PR with nothing checked out; the ones that need a
  // checkout set it themselves.
  checkout.worktreeId = "";
});

describe("ReviewDetail", () => {
  it("doesn't launch the AI review just because a PR is open", () => {
    render(<ReviewDetail />);
    expect(ai.mounts).toBe(0);
    expect(screen.queryByTestId("ai-review-pane")).toBeNull();
  });

  it("opens the tab when the rail asks for it, and keeps it mounted after", () => {
    model.aiReviewRequest = 1;
    render(<ReviewDetail />);
    expect(ai.mounts).toBe(1);
    expect(screen.getByTestId("ai-review-pane")).toBeInTheDocument();

    // Back to the diff: the pane hides rather than unmounting, or the session and
    // its checkout would be thrown away on every tab switch.
    screen.getByText("Files changed").click();
    expect(ai.mounts).toBe(1);
    expect(screen.getByTestId("ai-review-pane")).toBeInTheDocument();
  });

  // GitHub's own landing, and after the rail lost the description it is the only
  // place it is readable at full width.
  it("opens on the conversation, not the diff", () => {
    render(<ReviewDetail />);
    expect(screen.getByTestId("conversation-pane")).toBeInTheDocument();
    expect(screen.queryByTestId("pr-pane")).toBeNull();
  });

  it("lands the rail on the PR's ticket, and on the work queue when it has none", () => {
    const { unmount } = render(<ReviewDetail />);
    expect(screen.getByTestId("rail")).toHaveTextContent("issue");
    unmount();

    model.active = { ...model.active, title: "thing", headRef: "hand-made" } as ReviewPr;
    render(<ReviewDetail />);
    expect(screen.getByTestId("rail")).toHaveTextContent("aiWork");
  });

  it("opens the commits tab on the strip, beside the conversation and the diff", () => {
    detail = { comments: [{}, {}], commits: [{}, {}, {}], checks: [{}] };
    render(<ReviewDetail />);

    // Each count comes from what the tab actually shows; "Files changed" takes
    // GitHub's own `changedFiles` off the PR row, which the fetched list caps —
    // and its count trails the diffstat, so every tab ends with its number.
    expect(screen.getByRole("tab", { name: "Conversation2" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Commits3" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^Files changed.*4$/ })).toBeInTheDocument();

    fireEvent.click(screen.getByText("Commits"));
    expect(screen.getByTestId("commits-pane")).toBeInTheDocument();
    expect(screen.queryByTestId("conversation-pane")).toBeNull();
  });

  it("shows no count on a tab whose read hasn't landed, rather than a zero", () => {
    render(<ReviewDetail />);
    expect(screen.getByRole("tab", { name: "Conversation" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Commits" })).toBeInTheDocument();
  });

  /** A PR reviewed in an earlier launch gets its tab back from the stored
   *  session — but the tab is not the session. Mounting the pane to draw the
   *  strip would check the PR out and spawn a PTY for a tab nobody opened.
   *
   *  Checked out here, so picking the tab is the only thing under test: with no
   *  checkout the pick has a worktree to cut first and asks before it does (see
   *  `useReviewTabs.select`). */
  it("mounts a stored review session only once its tab is picked", () => {
    storedProviders = ["Codex"];
    checkout.worktreeId = "wt-1";
    render(<ReviewDetail />);
    expect(ai.mounts).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "ai:Codex" }));

    expect(ai.mounts).toBe(1);
    expect(screen.getByTestId("ai-review-pane")).toBeInTheDocument();
  });

  /** The title started at the pane's left edge while the text under it started
   *  in a centred column — two left edges on one page. The strip is the piece
   *  this file owns (the header and the panes are stubbed here); its column is
   *  asserted where each of those is real. */
  it("draws the sub-tabs in the page column, and leaves the rule to the page", () => {
    const { container } = render(<ReviewDetail />);
    const strip = container.querySelector("[role='tablist']") as HTMLElement;
    // The column is the strip's *wrapper*, and the band outside it carries the
    // page inset — the same two boxes a pane has, or the tabs land inset from
    // the body by exactly the padding they don't share. Matched on the class
    // list because `max-w-[880px]` is not a legal CSS selector.
    const column = strip.parentElement as HTMLElement;
    for (const c of PR_COLUMN.split(" ")) expect(column.classList.contains(c)).toBe(true);
    const band = column.parentElement as HTMLElement;
    expect(band.className).toContain("px-5");

    // Each tab's own padding hangs outside the column, so the first *label* — not
    // its underline's overhang — starts on the column's edge.
    expect(strip.className).toContain("-mx-3");

    // The rule is the page's, not the column's: a hairline stopping at 880px
    // would read as the page ending there.
    expect(strip.className).not.toContain("border-b border-line");
    expect(band.className).toContain("border-b");
  });

  /** A draft is a decision you have not made; a published comment is already on
   *  GitHub. The tab shows both, unsent ones first, so "what is waiting on me"
   *  is answerable without opening it. */
  it("leads the Conversation count with the AI's unsent drafts", () => {
    detail = { comments: [{}, {}], commits: [], checks: [] };
    drafts = [{ id: "d1" }, { id: "d2" }, { id: "d3" }];
    render(<ReviewDetail />);

    const conversation = screen.getByRole("tab", { name: /^Conversation/ });
    // Drafts first, then the tab's own comment count.
    expect(conversation).toHaveTextContent("32");
    expect(within(conversation).getByTitle("3 unsent AI comments")).toBeVisible();
  });

  /** A nought there would claim an AI review ran and found nothing to say. */
  it("shows no AI count on a PR with no drafts", () => {
    detail = { comments: [{}, {}], commits: [], checks: [] };
    render(<ReviewDetail />);

    expect(screen.getByRole("tab", { name: "Conversation2" })).toBeInTheDocument();
  });

  /** It describes the diff, so it belongs to the tab that shows the diff. Loose
   *  at the strip's trailing edge it read as a control measuring the page. */
  it("puts the diffstat on the Files-changed tab", () => {
    render(<ReviewDetail />);

    const files = screen.getByRole("tab", { name: /^Files changed/ });
    expect(within(files).getByRole("img", { name: "120 additions and 8 deletions" })).toBeVisible();
  });

  /** The rail's ticket pane is for glancing; reading a long thread wants the
   *  main area. The tab it opens into is this view's, so the ask crosses from the
   *  rail to the strip the way "Start AI review" does — and it closes like any
   *  other tab, back onto the pull request. */
  it("opens the PR's ticket as a Linear tab from the rail, and closes it", () => {
    render(<ReviewDetail />);
    expect(screen.queryByTestId("issue-page")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open in a tab" }));
    expect(screen.getByTestId("issue-page")).toHaveTextContent("AK-1");
    // Shown and hidden by the wrapper's one display class (no stylesheet here,
    // so it is the class that is asserted). The pull request stays mounted
    // underneath, hidden.
    expect(screen.getByTestId("issue-page").closest(".hidden")).toBeNull();
    expect(screen.getByTestId("conversation-pane").closest(".hidden")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close Linear" }));
    expect(screen.queryByTestId("issue-page")).toBeNull();
    expect(screen.getByTestId("conversation-pane").closest(".hidden")).toBeNull();
  });

  /** Your own PR is worked on in Trees; the header's offer to check it out from
   *  here is for other people's. The page is told by being handed no checkout. */
  it("withholds the checkout from the header for the viewer's own PR", () => {
    const { unmount } = render(<ReviewDetail />);
    expect(screen.getByTestId("header")).toHaveTextContent("with checkout");
    unmount();

    model.inbox = { mine: [{ id: "p1" }] };
    render(<ReviewDetail />);
    expect(screen.getByTestId("header")).toHaveTextContent("own");
  });
});
