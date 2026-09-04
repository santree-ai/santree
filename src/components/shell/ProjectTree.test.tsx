import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewInbox, TicketRef } from "../../bindings";
import { BULK_TOGGLE_HINT } from "../../lib/disclosure";
import type { LinearGroupBy } from "../../lib/queries";
import type { TreeFocus } from "../../state/AppContext";
import { worktree as fxWorktree } from "../../test/fixtures";
import { BAND_LABEL_X, CARD_GLYPH, CARD_INSET, CARD_LABEL_X } from "../WorkSignals";
import type { PrAgents, ProjectReviews } from "./ProjectReviewsSection";
import { ProjectSection, ProjectTree } from "./ProjectTree";
import {
  type AgentNode,
  type LinearProjectNode,
  milestoneKey,
  type ProjectNode,
  type ProjectTreeModel,
  projectKey,
  repoKey,
  type WorktreeNode,
} from "./useProjectTree";

// The rows under the header stand up the query client and the app context; this
// file is about the header itself.
// Recorded rather than rendered: this file is about the tree's own wiring, and
// "is this row lit" is a prop the tree computes, not markup the row owns.
vi.mock("./WorktreeRow", () => ({
  WorktreeRow: (props: { node: { worktree: { id: string } }; selected: boolean }) => {
    rendered.worktrees.push({ id: props.node.worktree.id, selected: props.selected });
    return null;
  },
}));
vi.mock("../../features/trees/CreateWorktreeDialog", () => ({ CreateWorktreeDialog: () => null }));
// The PR row's menu reads worktrees and the review checkout through the query
// layer; it has its own test.
vi.mock("./ReviewPrMenu", () => ({
  ReviewPrMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../chrome/RepoAvatar", () => ({ RepoAvatar: () => null }));
vi.mock("../../features/agents/useOpenAgent", () => ({ useOpenAgent: () => vi.fn() }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => route.navigate,
  // Runs the tree's real selector against a fake location, so the "is Reviews
  // open on this project" rule is the one under test rather than a stub of it.
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({
      location: {
        pathname: route.reviewsProject === null ? "/trees" : "/reviews",
        search:
          route.reviewsProject === null
            ? { project: route.openTree?.repo, tree: route.openTree?.id }
            : { project: route.reviewsProject, pr: route.openPrUrl },
      },
    }),
}));

/** The two app-level values the tree reads, mutable so a test can hand it a
 *  focus request and re-render. Partial mocks throughout: every other export of
 *  these modules is still the real one, so nothing in the tree's import graph
 *  loses a binding it never asked to have stubbed. */
const ui = vi.hoisted(() => ({
  treeFocus: null as TreeFocus | null,
  requestTreeFocus: vi.fn(),
}));
const model = vi.hoisted(() => ({ current: null as unknown }));

/** The router state the tree reads: which project Reviews is open on, if any. */
const route = vi.hoisted(() => ({
  reviewsProject: null as string | null,
  /** The workspace the url has open — `?project=`/`?tree=` on `/trees`, which is
   *  where the tree reads its lit row from now that no app state holds one. */
  openTree: null as { repo: string; id: string } | null,
  /** The `?pr=` the Reviews route carries — the rail's own selection. */
  openPrUrl: undefined as string | undefined,
  navigate: vi.fn(),
  openPr: vi.fn(),
}));

/** What the mocked rows were handed on the last render. */
const rendered = vi.hoisted(() => ({ worktrees: [] as { id: string; selected: boolean }[] }));

/** The inbox behind the per-project Reviews rows. `undefined` is the read still
 *  being in flight, which must render nothing rather than a row full of zeroes. */
const reviews = vi.hoisted(() => ({ inbox: undefined as unknown }));

/** What the repo's merge-queue read answers. `undefined` is the read in flight,
 *  a `null` queue is a repo whose default branch has none — three facts, one
 *  shape (see `MergeQueueView`). */
const mergeQueue = vi.hoisted(() => ({ view: undefined as unknown }));

vi.mock("../../state/AppContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/AppContext")>()),
  useAppUi: () => ui,
}));
// Real `reviewCountsByProject` on a stubbed read: the counts under test are the
// production rule, only the fetch is faked.
vi.mock("../../lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/queries")>();
  return {
    ...actual,
    useReviews: () => ({ data: reviews.inbox }),
    useReviewCountsByProject: () =>
      actual.reviewCountsByProject(reviews.inbox as ReviewInbox | undefined),
    // The Reviews section's nesting: off here, which is also the app default, so
    // neither the setting read nor the Linear resolve it feeds needs a client.
    useSetting: () => ({ data: undefined }),
    usePrTicketsByRepo: () => new Map(),
    useMergeQueue: () => ({ data: mergeQueue.view }),
  };
});
// The inbox fallback for a PR row: it reaches for a QueryClient this file has no
// reason to stand up, and what it does with a url is `openPr`'s own test.
vi.mock("../../lib/openPr", () => ({ useOpenPr: () => route.openPr }));
vi.mock("./useProjectTree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useProjectTree")>()),
  useProjectTree: () => model.current,
}));

function project(over: Partial<ProjectNode> = {}): ProjectNode {
  return {
    repo: "stoscanini/santree",
    label: "santree",
    base: null,
    linearProjects: [],
    showProjects: false,
    worktreeCount: 6,
    attention: { level: "idle", at: 0 },
    loading: false,
    ...over,
  };
}

type SectionOverrides = {
  open?: boolean;
  showEmptyReviews?: boolean;
  onSelectWorktree?: (id: string, pane?: string) => void;
  reviewGroupBy?: LinearGroupBy;
  reviewTickets?: Map<string, TicketRef>;
  reviews?: ProjectReviews | null;
  reviewsOpen?: boolean;
  onToggleReviews?: () => void;
  onOpenMergeQueue?: () => void;
  onOpenPrInInbox?: (pr: { url: string }) => void;
  prAgents?: PrAgents;
};

let agentSeq = 0;
/** One AI review session, as the tree files it under a pull request. */
function reviewAgent(over: Partial<AgentNode["entry"]> = {}): AgentNode {
  agentSeq += 1;
  return {
    entry: {
      sessionId: `s${agentSeq}`,
      agentKind: "Claude",
      purpose: "AI review",
      message: null,
      state: null,
      openable: true,
      updatedAtMs: null,
      ...over,
    } as AgentNode["entry"],
    unseen: false,
    attention: { level: "idle", at: agentSeq },
  };
}

function renderSection(over: Partial<ProjectNode> = {}, section: SectionOverrides = {}) {
  return render(
    <ProjectSection
      project={project(over)}
      open={section.open ?? true}
      isBandOpen={() => true}
      openWorktreeId={null}
      onToggle={vi.fn()}
      onToggleBand={vi.fn()}
      onSelectWorktree={section.onSelectWorktree ?? vi.fn()}
      onOpenAgent={vi.fn()}
      onCreateWorktree={vi.fn()}
      reviews={section.reviews ?? null}
      // Opted in by default here so a quiet fixture still renders the section
      // under test; the *product* default is off, pinned by its own case below.
      showEmptyReviews={section.showEmptyReviews ?? true}
      reviewGroupBy={section.reviewGroupBy}
      reviewTickets={section.reviewTickets}
      reviewsOpen={section.reviewsOpen ?? false}
      onToggleReviews={section.onToggleReviews ?? vi.fn()}
      onOpenMergeQueue={section.onOpenMergeQueue ?? vi.fn()}
      onOpenPrInInbox={section.onOpenPrInInbox ?? vi.fn()}
      prAgents={section.prAgents}
    />,
  );
}

/** One project's review state, as the tree hands it to a section. `groups` is
 *  what the open section draws; the counts are what the folded one says. */
function reviewsFor(
  over: Partial<ProjectReviews["counts"]> = {},
  groups: ProjectReviews["groups"] = [],
): ProjectReviews {
  return {
    connected: true,
    counts: { direct: 0, team: 0, total: 0, teams: [], ...over },
    groups,
  };
}

/** One block of an expanded section, with `n` PRs in it. */
function group(key: string, label: string, n: number): ProjectReviews["groups"][number] {
  return {
    key,
    label,
    title: null,
    prs: Array.from({ length: n }, (_, i) => ({
      id: `${key}-${i}`,
      number: i + 1,
      title: `${label} ${i + 1}`,
      url: `https://github.com/acme/app/pull/${key}-${i + 1}`,
      repo: "acme/app",
      headRef: "feature",
    })) as ProjectReviews["groups"][number]["prs"],
  };
}

/** The band a stretched toggle is stretched over — where its words actually live. */
function band(toggle: HTMLElement): HTMLElement {
  return toggle.parentElement as HTMLElement;
}

/** The header's worktree count, found by the noun it carries for a screen reader
 *  — a bare number is not a fact. */
function worktreeCount(): HTMLElement {
  return screen.getByText("worktrees").parentElement as HTMLElement;
}

/** A header count's digit slot: the one child whose width is reserved. */
function digitsOf(count: HTMLElement): HTMLElement {
  return count.querySelector("[class*='min-w-']") as HTMLElement;
}

describe("ProjectSection header", () => {
  /** Both header counts are permanent reference — the ask was to read them at a
   *  glance — so the worktree count is not gated on hover, and it sits with its
   *  own glyph rather than as a bare number beside the chevron. */
  it("shows the worktree count at rest, beside its own glyph", () => {
    renderSection();
    const count = worktreeCount();
    expect(count).toHaveTextContent("6");
    expect(count.className).not.toContain("opacity-0");
    expect(count.querySelector("svg")).toBeInTheDocument();
  });

  /** Folded, the counts are all that is left of the project; they stay. */
  it("keeps the worktree count on a folded project", () => {
    renderSection({}, { open: false });
    expect(worktreeCount()).toHaveTextContent("6");
  });

  /** A quiet project is silent, not a nought — the rule the reviews count
   *  already follows, so the two glyphs can't disagree about what zero means. */
  it("drops the worktree count at zero once the read has landed", () => {
    renderSection({ worktreeCount: 0 });
    expect(screen.queryByText("worktrees")).not.toBeInTheDocument();
  });

  /** The slot is reserved, not conditional: the row must not resize when the
   *  read finally lands. This has bitten this rail three times — always as a
   *  control that occupied no space until it appeared. */
  it("reserves the count's slot while the read is still in flight", () => {
    renderSection({ loading: true });
    const count = worktreeCount();
    // No digits until the read lands — "0" beside skeleton rows is a claim —
    // but the width is already spoken for.
    expect(count).toHaveTextContent(/^worktrees$/);
    expect(digitsOf(count).className).toContain("min-w-[13px]");
  });

  /** The repo header carries no attention dot: the rows beneath it already say
   *  which worktree needs a human, and a second dot on the parent restated it
   *  while adding permanent colour to a rail that is open all day. Removed
   *  deliberately — this asserts it stays gone. */
  it("shows no attention dot on the repo header, even at needs-you", () => {
    renderSection({ attention: { level: "needs-you", at: 1 } });
    expect(screen.queryByRole("img", { name: "Needs you" })).not.toBeInTheDocument();
  });
});

/**
 * The project's review inbox, as a row in its section.
 *
 * The row is how Reviews is reached at all now that the global nav entry is gone,
 * so what it does and doesn't render is the whole feature: a number that means
 * "still needs you", nothing at all when nothing does, and the count moved onto
 * the header when the section is folded away over it.
 */
describe("ProjectSection reviews section", () => {
  beforeEach(() => {
    mergeQueue.view = undefined;
  });

  it("carries the project's review count while it is folded", () => {
    renderSection({}, { reviews: reviewsFor({ direct: 3, total: 3 }) });
    const heading = screen.getByRole("button", { name: /santree reviews/ });
    expect(heading).toHaveAttribute("aria-expanded", "false");
    // The toggle is stretched over the band, so the words are its siblings.
    expect(band(heading)).toHaveTextContent("Reviews");
    expect(band(heading)).toHaveTextContent("3");
  });

  /** The resting state of a quiet project is silence. */
  it("renders nothing on a quiet project by default", () => {
    renderSection({}, { reviews: reviewsFor(), showEmptyReviews: false });
    expect(screen.queryByRole("button", { name: /reviews/i })).not.toBeInTheDocument();
  });

  /** Turned on, a nought is what makes the feature's *absence* legible: one repo
   *  showing Reviews while the two beside it show nothing reads as santree only
   *  knowing about the first. Folded, so it costs one line. */
  it("keeps a folded section and a nought once asked to", () => {
    renderSection({}, { reviews: reviewsFor(), showEmptyReviews: true });
    const heading = screen.getByRole("button", { name: /santree reviews/ });
    expect(band(heading)).toHaveTextContent("0");
  });

  /** Unknown is not empty. Without a `gh` token every count is zero for a reason
   *  a zero cannot state, so the heading stays — and drops the number instead. */
  it("keeps the heading but drops the number when GitHub isn't connected", () => {
    renderSection({}, { reviews: { connected: false, counts: reviewsFor().counts, groups: [] } });
    const heading = screen.getByRole("button", { name: /santree reviews/ });
    expect(heading).toHaveAccessibleName("Expand santree reviews — GitHub isn't connected");
    expect(band(heading)).not.toHaveTextContent("0");
  });

  /** The read landing later than the tree must not make the section assert a zero
   *  in the meantime — `null` is "we haven't looked yet". */
  it("renders nothing while the inbox read is still in flight", () => {
    renderSection({}, { reviews: null });
    expect(screen.queryByRole("button", { name: /reviews/i })).not.toBeInTheDocument();
  });

  /** The split is the heading's second job and it can't cost a line, so it rides
   *  on the hover and the accessible name — the same text for both, since a
   *  breakdown only a pointer can reach is one half the users never get. */
  it("names who is waiting — you, and the teams — in the hover and the label", () => {
    renderSection(
      {},
      { reviews: reviewsFor({ direct: 3, team: 5, total: 8, teams: ["acme/eng", "acme/voice"] }) },
    );
    const heading = screen.getByRole("button", { name: /santree reviews/ });
    expect(heading).toHaveAccessibleName(
      "Expand santree reviews — 3 for you · 5 via @acme/eng, @acme/voice",
    );
    expect(heading).toHaveAttribute(
      "title",
      // The bulk-toggle hint trails every disclosure's tooltip — see
      // `lib/disclosure`; the line above it is what this test is about.
      `santree reviews — 3 for you · 5 via @acme/eng, @acme/voice\n${BULK_TOGGLE_HINT}`,
    );
  });

  /** Folded, the header is all that is left of the project — without the count on
   *  it, "does anything need me" costs one expand per project. */
  it("carries the reviews count on the header while the whole project is folded", () => {
    renderSection({}, { open: false, reviews: reviewsFor({ direct: 2, total: 2 }) });
    expect(screen.queryByRole("button", { name: /santree reviews/ })).not.toBeInTheDocument();
    // The number alone is not a fact; a screen reader gets the noun too.
    const badge = screen.getByText(/reviews waiting on you/).parentElement as HTMLElement;
    expect(badge).toHaveTextContent("2");
    // The badge sits under the header's stretched toggle, so its own tooltip could
    // never open — the breakdown rides on the header's instead.
    expect(screen.getByRole("button", { name: "Expand santree" })).toHaveAttribute(
      "title",
      `stoscanini/santree\n2 for you — reviews waiting on you\n${BULK_TOGGLE_HINT}`,
    );
  });

  /** Open, the count stays: it is reference to read at a glance, not a stand-in
   *  for a folded section — and its breakdown stays on the header's tooltip
   *  with it. */
  it("keeps the reviews count on the header once the project is open", () => {
    renderSection({}, { open: true, reviews: reviewsFor({ direct: 2, total: 2 }) });
    const badge = screen.getByText(/reviews waiting on you/).parentElement as HTMLElement;
    expect(badge).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: "Collapse santree" })).toHaveAttribute(
      "title",
      `stoscanini/santree\n2 for you — reviews waiting on you\n${BULK_TOGGLE_HINT}`,
    );
  });

  /** Zero is silence, not a nought: a quiet project's header carries the worktree
   *  count alone, and its tooltip has nothing to add. */
  it("shows no reviews count while nothing is waiting", () => {
    renderSection({}, { open: true, reviews: reviewsFor({ total: 0 }) });
    expect(screen.queryByText(/reviews waiting on you/)).not.toBeInTheDocument();
    expect(worktreeCount()).toHaveTextContent("6");
    expect(screen.getByRole("button", { name: "Collapse santree" })).toHaveAttribute(
      "title",
      `stoscanini/santree\n${BULK_TOGGLE_HINT}`,
    );
  });

  /** The heading folds; it is not a destination. The rows inside it are, which is
   *  why the heading itself carries no second control to open one — the
   *  hover-revealed "open the inbox" button that used to sit here was removed. */
  it("folds on the heading and offers nothing else on it", () => {
    const onToggleReviews = vi.fn();
    renderSection({}, { reviews: reviewsFor({ direct: 1, total: 1 }), onToggleReviews });
    fireEvent.click(screen.getByRole("button", { name: /santree reviews/ }));
    expect(onToggleReviews).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Open the Reviews view/ })).not.toBeInTheDocument();
  });

  /** The blocks are the point of opening it: who asked, and for what. Each one
   *  carries its own count, which is why the heading drops the total here — it
   *  would only restate the sum of the blocks. */
  it("draws one block per asker when open, and drops the total from the heading", () => {
    renderSection(
      {},
      {
        reviewsOpen: true,
        reviews: reviewsFor({ direct: 2, team: 1, total: 3 }, [
          group("direct", "Assigned to me", 2),
          group("team:acme/eng", "Team · Engineering", 1),
        ]),
      },
    );
    expect(band(screen.getByRole("button", { name: /santree reviews/ }))).not.toHaveTextContent(
      "3",
    );
    expect(
      screen.getByRole("button", { name: "Collapse review group Assigned to me" }),
    ).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: "Open Assigned to me 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Team · Engineering 1" })).toBeInTheDocument();
  });

  /** Connected and quiet is a real answer, and better said than left as an empty
   *  expansion that reads like a failed load. */
  it("says so when an open section has nothing in it", () => {
    renderSection({}, { reviewsOpen: true, reviews: { ...reviewsFor(), connected: false } });
    expect(screen.getByText("Sign in to GitHub to see reviews")).toBeInTheDocument();
  });

  /**
   * Reported: clicking a PR row opened the *worktree* it shares a checkout with.
   * The two rows are separate entities — one is here to be reviewed, the other to
   * be worked in — so a row that says "review this" must not land in the editor,
   * even when the same work is a few lines below it in the same tree.
   */
  it("opens the pull request, never the worktree that shares its checkout", () => {
    const onSelectWorktree = vi.fn();
    const onOpenPrInInbox = vi.fn();
    const direct = group("direct", "Assigned to me", 1);
    const node: WorktreeNode = {
      worktree: fxWorktree("ak-1"),
      depth: 0,
      primary: false,
      // The worktree carries this very PR, which is what used to divert the click.
      prs: [
        { issueId: "ak-1", repo: "acme/app", number: 1, url: direct.prs[0].url, state: "Open" },
      ],
      task: null,
      agents: [],
      attention: { level: "idle", at: 0 },
    };
    renderSection(
      {
        linearProjects: [
          {
            key: "Core",
            label: "Core",
            color: "#888",
            icon: null,
            targetDate: null,
            showMilestones: false,
            worktreeCount: 1,
            milestones: [{ key: "m1", label: "M1", targetDate: null, worktrees: [node] }],
          },
        ],
      },
      {
        reviewsOpen: true,
        reviews: reviewsFor({ direct: 1, total: 1 }, [direct]),
        onSelectWorktree,
        onOpenPrInInbox,
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Assigned to me 1" }));
    expect(onOpenPrInInbox).toHaveBeenCalled();
    expect(onSelectWorktree).not.toHaveBeenCalled();
  });
});

/**
 * The merge queue is a property of the repo, not of any one pull request, so it
 * sits in the section rather than inside a block. `MergeQueueView` distinguishes
 * three facts — we could not ask, this repo has no queue, the queue is empty —
 * and only the last of them is a number worth showing.
 */
describe("ProjectSection merge queue", () => {
  const queueRow = () => screen.queryByRole("button", { name: /Open the merge queue/ });
  const open = () => renderSection({}, { reviewsOpen: true, reviews: reviewsFor() });

  it("says nothing while the read is still in flight", () => {
    mergeQueue.view = undefined;
    open();
    expect(queueRow()).toBeNull();
  });

  /** Two different silences, and neither of them is a queue: a repo without one
   *  can never have a row, and a `gh` that could not be asked has no answer. */
  it("says nothing when the repo has no queue, or GitHub could not be asked", () => {
    mergeQueue.view = { repo: "acme/app", githubConnected: true, queue: null };
    const first = open();
    expect(queueRow()).toBeNull();
    first.unmount();

    mergeQueue.view = { repo: "acme/app", githubConnected: false, queue: null };
    open();
    expect(queueRow()).toBeNull();
  });

  /** An enabled queue with nothing in it is a real answer, and the one zero here
   *  worth printing. */
  it("shows an enabled queue with a zero when nothing is waiting to merge", () => {
    mergeQueue.view = {
      repo: "acme/app",
      githubConnected: true,
      queue: { repo: "acme/app", branch: "main", entries: [] },
    };
    open();
    expect(queueRow()).toHaveTextContent("Merge queue");
    expect(queueRow()).toHaveTextContent("0");
  });

  it("counts the entries waiting, and opens the queue on click", () => {
    const onOpenMergeQueue = vi.fn();
    mergeQueue.view = {
      repo: "acme/app",
      githubConnected: true,
      queue: { repo: "acme/app", branch: "main", entries: [{ prNumber: 1 }, { prNumber: 2 }] },
    };
    renderSection({}, { reviewsOpen: true, reviews: reviewsFor(), onOpenMergeQueue });
    expect(queueRow()).toHaveTextContent("2");

    fireEvent.click(queueRow() as HTMLElement);
    expect(onOpenMergeQueue).toHaveBeenCalled();
  });
});

describe("ProjectSection reviews nesting", () => {
  /** A PR's ticket, as the tree resolves it: keyed by the id in the PR title. */
  const ticket = (id: string, project: string, milestone?: string): TicketRef =>
    ({
      identifier: id,
      title: id,
      priority: "None",
      project,
      projectColor: null,
      projectIcon: null,
      projectTargetDate: null,
      projectMilestone: milestone
        ? { id: milestone, name: milestone, targetDate: null, sortOrder: 0 }
        : null,
    }) as TicketRef;

  /** Two PRs, each naming a ticket in its title — which is how `ticketIdFor`
   *  finds one without asking GitHub about Linear. */
  function twoPrs(): ProjectReviews["groups"] {
    const block = group("direct", "Assigned to me", 2);
    block.prs = block.prs.map((pr, i) => ({ ...pr, title: `AK-${i + 1} ${pr.title}` }));
    return [block];
  }

  it("draws a heading per Linear project once there are two to tell apart", () => {
    renderSection(
      {},
      {
        reviewsOpen: true,
        reviewGroupBy: "project",
        reviewTickets: new Map([
          ["AK-1", ticket("AK-1", "Platform")],
          ["AK-2", ticket("AK-2", "Growth")],
        ]),
        reviews: reviewsFor({ direct: 2, total: 2 }, twoPrs()),
      },
    );
    expect(screen.getByRole("button", { name: "Collapse project Platform" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse project Growth" })).toBeInTheDocument();
  });

  /** One band is the block restated. A heading, a fold and an indent that say
   *  nothing is worse than the flat list the setting was turned on to improve. */
  it("suppresses the level when every PR is in the same project", () => {
    renderSection(
      {},
      {
        reviewsOpen: true,
        reviewGroupBy: "project_milestone",
        reviewTickets: new Map([
          ["AK-1", ticket("AK-1", "Platform")],
          ["AK-2", ticket("AK-2", "Platform")],
        ]),
        reviews: reviewsFor({ direct: 2, total: 2 }, twoPrs()),
      },
    );
    expect(screen.queryByRole("button", { name: /project Platform/ })).not.toBeInTheDocument();
    // …and the rows are still there, at the gutter the heading would have used.
    expect(screen.getByRole("button", { name: "Open AK-1 Assigned to me 1" })).toBeInTheDocument();
  });

  /** The milestone level is the same rule one step in: a lone "No milestone"
   *  bucket is not structure. */
  it("nests milestones inside a project, and drops a lone unassigned bucket", () => {
    renderSection(
      {},
      {
        reviewsOpen: true,
        reviewGroupBy: "project_milestone",
        reviewTickets: new Map([
          ["AK-1", ticket("AK-1", "Platform", "M1")],
          ["AK-2", ticket("AK-2", "Platform")],
        ]),
        reviews: reviewsFor({ direct: 2, total: 2 }, twoPrs()),
      },
    );
    expect(screen.getByRole("button", { name: "Collapse milestone M1" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Collapse milestone No milestone" }),
    ).toBeInTheDocument();
  });

  it("leaves the list flat when the setting is off, ticket or no ticket", () => {
    renderSection(
      {},
      {
        reviewsOpen: true,
        reviewTickets: new Map([["AK-1", ticket("AK-1", "Platform")]]),
        reviews: reviewsFor({ direct: 2, total: 2 }, twoPrs()),
      },
    );
    expect(screen.queryByRole("button", { name: /project Platform/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /milestone/ })).not.toBeInTheDocument();
  });
});

/**
 * The regression this pins, reported twice: a nested inbox that read as one flat
 * list. Rows were indented to their heading's *gutter*, which put a PR title in
 * line with the chevron above it rather than with the heading's words — so a PR
 * inside a milestone looked like a sibling of the milestone, not its contents.
 */
describe("ProjectSection reviews indentation", () => {
  const ticket = (id: string, project: string, milestone?: string): TicketRef =>
    ({
      identifier: id,
      title: id,
      priority: "None",
      project,
      projectColor: null,
      projectIcon: null,
      projectTargetDate: null,
      projectMilestone: milestone
        ? { id: milestone, name: milestone, targetDate: null, sortOrder: 0 }
        : null,
    }) as TicketRef;

  /** The gutter an element's own wrapper carries. Headings are wrapped in a padded
   *  div; a row hangs off the flex box its card sits in. */
  const gutterOf = (el: HTMLElement) =>
    Number.parseFloat((el.parentElement as HTMLElement).style.paddingLeft || "0");

  function render2(groupBy: LinearGroupBy, tickets: [string, TicketRef][]) {
    const block = group("direct", "Assigned to me", 2);
    block.prs = block.prs.map((pr, i) => ({ ...pr, title: `AK-${i + 1} ${pr.title}` }));
    return renderSection(
      {},
      {
        reviewsOpen: true,
        reviewGroupBy: groupBy,
        reviewTickets: new Map(tickets),
        reviews: reviewsFor({ direct: 2, total: 2 }, [block]),
      },
    );
  }

  /** A row hangs from the words above it. `BAND_LABEL_X` past the block heading's
   *  own gutter is where those words start. */
  it("hangs a row from its heading's label, not from its chevron", () => {
    const { container } = render2("none", []);
    const heading = screen.getByRole("button", { name: "Collapse review group Assigned to me" });
    const row = container.querySelector(".tree-card") as HTMLElement;
    // The card overhangs its own text by `CARD_INSET`, which is what the
    // highlight starts at — the text itself lands on the heading's label.
    expect(gutterOf(row) + CARD_INSET).toBe(gutterOf(heading) + BAND_LABEL_X);
  });

  /** Every drawn level pushes its rows further in than the level above it, and a
   *  heading never ends up left of the heading it sits inside. */
  it("steps in monotonically as the levels are drawn", () => {
    const flat = render2("none", []);
    const flatRow = gutterOf(flat.container.querySelector(".tree-card") as HTMLElement);
    flat.unmount();

    const nested = render2("project_milestone", [
      ["AK-1", ticket("AK-1", "Platform", "M1")],
      ["AK-2", ticket("AK-2", "Growth", "M1")],
    ]);
    const project = screen.getByRole("button", { name: "Collapse project Platform" });
    const milestone = screen.getAllByRole("button", { name: "Collapse milestone M1" })[0];
    const row = nested.container.querySelector(".tree-card") as HTMLElement;

    expect(gutterOf(project)).toBeGreaterThan(0);
    expect(gutterOf(milestone)).toBeGreaterThan(gutterOf(project));
    expect(gutterOf(row)).toBeGreaterThan(flatRow);
    // The row's text still lands on the milestone's words, one level in.
    expect(gutterOf(row) + CARD_INSET).toBe(gutterOf(milestone) + BAND_LABEL_X);
  });
});

/**
 * A PR whose branch came off another PR's branch has to *read* as one. One step
 * of indentation on its own reads as a rendering accident, so the row also draws
 * the elbow a file tree draws, and says what it is stacked on in its tooltip.
 */
describe("ProjectSection stacked PRs", () => {
  /** Two PRs, the second branched off the first — matched on GitHub's ref node
   *  ids, never on branch names, so two forks that both have a `main` can't link. */
  function chain(): ProjectReviews["groups"] {
    const block = group("direct", "Assigned to me", 2);
    block.prs = [
      { ...block.prs[0], headRefId: "ref-parent" },
      { ...block.prs[1], baseRefId: "ref-parent", baseRef: "user/parent" },
    ];
    return [block];
  }

  it("steps the child in with the connector, not padding, and names its parent branch", () => {
    const { container } = renderSection(
      {},
      { reviewsOpen: true, reviews: reviewsFor({ direct: 2, total: 2 }, chain()) },
    );
    const rows = [...container.querySelectorAll<HTMLElement>(".tree-card")];
    expect(rows).toHaveLength(2);

    // Both rows share one gutter: the child's step IS the connector, so the card
    // itself never moves and its highlight stays the same width as its parent's.
    const gutterOf = (row: HTMLElement) => (row.parentElement as HTMLElement).style.paddingLeft;
    expect(gutterOf(rows[0])).toBe(gutterOf(rows[1]));
    expect(rows[0].previousElementSibling).toBeNull();
    expect(rows[1].previousElementSibling?.getAttribute("aria-hidden")).toBe("true");

    expect(screen.getByRole("button", { name: "Open Assigned to me 2" })).toHaveAttribute(
      "title",
      expect.stringContaining("Stacked on user/parent"),
    );
  });
});

/** A PR is work with agents on it, and the rail says so in the same vocabulary a
 *  worktree card uses: sessions hang under the row, one each or folded. */
describe("ProjectSection review agents", () => {
  const oneBlock = () =>
    reviewsFor({ direct: 1, total: 1 }, [group("direct", "Assigned to me", 1)]);

  function withAgents(nodes: AgentNode[], onOpen = vi.fn()) {
    const agents: PrAgents = { listFor: () => nodes, onOpen };
    return {
      ...renderSection({}, { reviewsOpen: true, reviews: oneBlock(), prAgents: agents }),
      onOpen,
    };
  }

  it("draws nothing extra when no session is running on the PR", () => {
    const { container } = withAgents([]);
    const card = container.querySelector(".tree-card") as HTMLElement;
    // The title line and nothing else — no fold, no padding shim.
    expect(card.children).toHaveLength(1);
  });

  it("hangs a lone session under the pull request it is reviewing", () => {
    const { onOpen } = withAgents([reviewAgent({ purpose: "AI review" })]);
    const row = screen.getByRole("button", { name: /Assigned to me 1/ });
    expect(row).toBeTruthy();
    const session = screen.getByTitle("AI review · AI review");
    fireEvent.click(session);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  /** Several collapse into the same fold a worktree's agents do — and the fold is
   *  a `.tree-band`, so hovering it promises no destination of its own. */
  it("folds several sessions into one summary row", () => {
    const { container } = withAgents([reviewAgent(), reviewAgent(), reviewAgent()]);
    // Scoped to the card: the merge-queue row above it is a `.tree-row` too.
    const card = container.querySelector(".tree-card") as HTMLElement;
    const fold = screen.getByRole("button", { name: /Expand agents\./ });
    expect(fold.className).toContain("tree-band");
    expect(card.querySelectorAll(".tree-row")).toHaveLength(0);

    fireEvent.click(fold);
    expect(card.querySelectorAll(".tree-row")).toHaveLength(3);
  });

  /** The same column the worktree cards use: a session begins where its PR's
   *  title begins, so it reads as inside the card rather than beside it. */
  it("starts its sessions at the card's own label column", () => {
    const { container } = withAgents([reviewAgent()]);
    const card = container.querySelector(".tree-card") as HTMLElement;
    const title = card.firstElementChild as HTMLElement;
    const session = card.querySelector(".tree-row") as HTMLElement;
    const glyph = title.querySelector("svg") as SVGElement;
    expect(session.style.paddingLeft).toBe(`${CARD_LABEL_X}px`);
    // The title's own text column is what that number is: the card's inset, the
    // leading glyph's box, and the gap after it.
    expect(Number(glyph.getAttribute("width"))).toBe(CARD_GLYPH);
    expect(CARD_LABEL_X).toBe(CARD_INSET + CARD_GLYPH + 6);
  });
});

/** The tree's own wiring: counts come from the shared inbox read, and a click
 *  puts the project in the route so a reload lands on the same inbox. */
describe("ProjectTree reviews rows", () => {
  const REPO = "acme/app";
  const inbox = (over: Partial<ReviewInbox> = {}): ReviewInbox => ({
    mine: [],
    requested: [],
    teams: [],
    projects: [{ repo: REPO, slug: "acme/app" }],
    orgs: ["acme"],
    githubConnected: true,
    ...over,
  });
  const waiting = (id: string) =>
    ({
      id,
      project: REPO,
      viewerReview: null,
      headCommittedAt: "2026-08-24T10:00:00Z",
      // The section orders its blocks, so a row without these sorts nothing —
      // and the cast above would let it through to a crash at runtime.
      waitingSince: "2026-08-24T09:00:00Z",
      updatedAt: "2026-08-24T10:00:00Z",
      title: id,
      url: `https://github.com/acme/app/pull/${id}`,
      repo: "acme/app",
      headRef: "feature",
    }) as ReviewInbox["requested"][number];

  beforeEach(() => {
    localStorage.clear();
    route.reviewsProject = null;
    route.navigate.mockClear();
    reviews.inbox = undefined;
    mergeQueue.view = undefined;
    model.current = {
      projects: [project({ repo: REPO, label: "app" })],
      loading: false,
      markSeen: vi.fn(),
      agentsByPr: new Map(),
    };
    ui.treeFocus = null;
  });

  it("counts what still needs you, straight off the shared inbox read", () => {
    reviews.inbox = inbox({ requested: [waiting("a"), waiting("b")] });
    render(<ProjectTree />);
    expect(band(screen.getByRole("button", { name: /app reviews/ }))).toHaveTextContent("2");
  });

  /** The route carries the scope *and* the pane, so a reload lands back on the
   *  same queue rather than on the everything view — the Reviews view holds no
   *  state this row can't reach. */
  it("puts the project and the queue in the route when the merge-queue row is clicked", () => {
    reviews.inbox = inbox({ requested: [waiting("a")] });
    mergeQueue.view = {
      repo: "acme/app",
      githubConnected: true,
      queue: { repo: "acme/app", branch: "main", entries: [] },
    };
    render(<ProjectTree />);
    // The section is folded by default, and the row lives inside it.
    fireEvent.click(screen.getByRole("button", { name: /app reviews/ }));
    fireEvent.click(screen.getByRole("button", { name: /Open the merge queue/ }));
    expect(route.navigate).toHaveBeenCalledWith({
      to: "/reviews",
      search: { project: REPO, queue: true },
    });
  });

  /** A project with no GitHub `origin` can never own a review, so its row is
   *  silent forever rather than silent today — even with `gh` disconnected. */
  it("gives a project with no GitHub remote no row, connected or not", () => {
    reviews.inbox = inbox({ projects: [{ repo: REPO, slug: null }], githubConnected: false });
    render(<ProjectTree />);
    expect(screen.queryByRole("button", { name: /app reviews/ })).not.toBeInTheDocument();
  });
});

/**
 * The rail carries **one** selection, and it belongs to whichever destination is
 * on screen. Reported as a bug: a pull request was open in the main view while
 * the sidebar still lit the worktree picked before it — two highlights, neither
 * of them where the user actually was.
 */
describe("ProjectTree selection follows the visible destination", () => {
  const REPO = "acme/app";
  const PR_URL = "https://github.com/acme/app/pull/7";
  const inbox = (over: Partial<ReviewInbox> = {}): ReviewInbox => ({
    mine: [],
    requested: [],
    teams: [],
    projects: [{ repo: REPO, slug: "acme/app" }],
    orgs: ["acme"],
    githubConnected: true,
    ...over,
  });
  const waiting = (id: string, url: string) =>
    ({
      id,
      project: REPO,
      title: id,
      url,
      repo: REPO,
      headRef: "feature",
      viewerReview: null,
      headCommittedAt: "2026-08-24T10:00:00Z",
      waitingSince: "2026-08-24T09:00:00Z",
      updatedAt: "2026-08-24T10:00:00Z",
    }) as ReviewInbox["requested"][number];

  const node: WorktreeNode = {
    worktree: fxWorktree("AK-1"),
    depth: 0,
    primary: false,
    prs: [],
    task: null,
    agents: [],
    attention: { level: "idle", at: 0 },
  };

  beforeEach(() => {
    localStorage.clear();
    rendered.worktrees = [];
    route.reviewsProject = null;
    route.openPrUrl = undefined;
    reviews.inbox = inbox({ requested: [waiting("a", PR_URL), waiting("b", `${PR_URL}0`)] });
    ui.treeFocus = null;
    route.openTree = { repo: REPO, id: "AK-1" };
    model.current = {
      projects: [
        {
          ...project({ repo: REPO, label: "app" }),
          linearProjects: [
            {
              key: "Core",
              label: "Core",
              color: "#888",
              icon: null,
              targetDate: null,
              showMilestones: false,
              worktreeCount: 1,
              milestones: [{ key: "m1", label: "M1", targetDate: null, worktrees: [node] }],
            },
          ],
        },
      ],
      loading: false,
      markSeen: vi.fn(),
      agentsByPr: new Map(),
    };
  });

  it("lights the open worktree while Trees is showing", () => {
    render(<ProjectTree />);
    expect(rendered.worktrees).toContainEqual({ id: "AK-1", selected: true });
  });

  /** The worktree is still *open* — it is just not what you are looking at, and a
   *  rail that says otherwise is claiming a selection the main view doesn't have. */
  it("drops the worktree highlight the moment a pull request is the destination", () => {
    route.reviewsProject = REPO;
    route.openPrUrl = PR_URL;
    localStorage.setItem("santree.shell.projectTree.reviewsOpen", JSON.stringify({ [REPO]: true }));
    const { container } = render(<ProjectTree />);

    expect(rendered.worktrees).toContainEqual({ id: "AK-1", selected: false });
    // …and the row that IS lit is the PR the route names.
    const lit = [...container.querySelectorAll('.tree-card[data-active="true"]')];
    expect(lit).toHaveLength(1);
    expect(lit[0].textContent).toContain("a");
  });
});

/**
 * A worktree picked anywhere but here — Issues, the graph, the palette, a
 * session-history row — has to become *visible*, or the selection looks like it
 * did nothing. A click in the tree itself already is visible, and expanding on
 * top of it would move a rail the user is looking at for no reason.
 */
describe("ProjectTree reveals a selection made elsewhere", () => {
  const REPO = "acme/app";
  const row = (id: string): WorktreeNode => ({
    worktree: fxWorktree(id),
    depth: 0,
    primary: false,
    prs: [],
    task: null,
    agents: [],
    attention: { level: "idle", at: 0 },
  });
  const band = (
    key: string,
    milestones: LinearProjectNode["milestones"],
    showMilestones: boolean,
  ): LinearProjectNode => ({
    key,
    label: key,
    color: "#888",
    icon: null,
    targetDate: null,
    milestones,
    showMilestones,
    worktreeCount: 1,
  });

  /** The deepest shape: two project bands, one of them split across milestones. */
  const tree: ProjectTreeModel = {
    projects: [
      {
        ...project({ repo: REPO, label: "app", showProjects: true }),
        linearProjects: [
          band(
            "Core",
            [{ key: "m1", label: "M1", targetDate: null, worktrees: [row("AK-1")] }],
            true,
          ),
          band(
            "Infra",
            [{ key: "m2", label: "M2", targetDate: null, worktrees: [row("AK-3")] }],
            true,
          ),
        ],
      },
    ],
    loading: false,
    markSeen: vi.fn(),
    agentsByPr: new Map(),
  };

  /** Everything folded away, which is the state the bug was reported in. */
  function collapseAll() {
    localStorage.setItem(
      "santree.shell.projectTree.collapsed",
      JSON.stringify({
        [repoKey(REPO)]: true,
        [projectKey(REPO, "Core")]: true,
        [projectKey(REPO, "Infra")]: true,
        [milestoneKey(REPO, "Core", "m1")]: true,
        [milestoneKey(REPO, "Infra", "m2")]: true,
      }),
    );
  }

  beforeEach(() => {
    localStorage.clear();
    model.current = tree;
    ui.treeFocus = null;
  });

  it("expands every ancestor of a worktree selected from another view", () => {
    collapseAll();
    ui.treeFocus = { repo: REPO, id: "AK-1", pane: "issue" };
    render(<ProjectTree />);
    expect(screen.getByRole("button", { name: "Collapse app" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse project Core" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse milestone M1" })).toBeInTheDocument();
  });

  // Only expand. A fold elsewhere in the tree is the user's own curation and
  // this request has no business undoing it.
  it("leaves the bands it did not have to open exactly as it found them", () => {
    collapseAll();
    ui.treeFocus = { repo: REPO, id: "AK-1", pane: "issue" };
    render(<ProjectTree />);
    expect(screen.getByRole("button", { name: "Expand project Infra" })).toBeInTheDocument();
  });

  // The sidebar's own click already put the row on screen; re-expanding its
  // parents would move the rail under the pointer that just clicked it.
  it("expands nothing for a selection made by clicking in the tree itself", () => {
    collapseAll();
    ui.treeFocus = { repo: REPO, id: "AK-1", pane: "issue", fromSidebar: true };
    render(<ProjectTree />);
    expect(screen.getByRole("button", { name: "Expand app" })).toBeInTheDocument();
  });
});
