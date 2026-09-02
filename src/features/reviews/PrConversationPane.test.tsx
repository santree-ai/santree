import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PrDetail, PrThread, ReviewDraft, ReviewPr } from "../../bindings";

/** The one read this pane waits on. `isLoading` is what the test drives. */
const detail = vi.hoisted(() => ({
  data: undefined as PrDetail | undefined,
  isLoading: true,
}));

/** The AI's drafts, on their own read — it lands independently of the detail
 *  above, which is the whole point of the section they render in. */
const ai = vi.hoisted(() => ({ drafts: [] as ReviewDraft[] }));

vi.mock("../../lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queries")>()),
  usePrDetail: () => detail,
  useReviewDrafts: () => ({ data: ai.drafts }),
  useAddPrConversationComment: () => ({ mutate: vi.fn(), isPending: false }),
}));

/** The host's jump into the diff — a prop, so the page renders under either
 *  host's model or none. */
const focusFile = vi.fn();

// The cards are their own tests, and both reach for mutations this file has no
// client for. Recorded rather than rendered: what matters here is which entries
// get the full card and which get an index row.
vi.mock("./ReviewDraftCard", () => ({
  ReviewDraftCard: ({ draft }: { draft: ReviewDraft }) => (
    <div data-testid={`draft-card-${draft.id}`} />
  ),
}));
vi.mock("./PrThreadCard", () => ({
  PrThreadCard: ({ thread }: { thread: PrThread }) => (
    <div data-testid={`thread-card-${thread.path}`} />
  ),
}));

import { PrConversationPane } from "./PrConversationPane";

const pr = {
  id: "PR_node",
  number: 42,
  title: "Fix the thing",
  repo: "acme/web",
  url: "https://github.com/acme/web/pull/42",
  author: "kwaters12",
  authorAvatarUrl: "",
  createdAt: "2026-08-24T10:00:00Z",
  headRef: "feature",
} as ReviewPr;

const loaded = {
  body: "Why this change",
  labels: [],
  comments: [],
  threads: [],
  files: [],
  filesTruncated: false,
  checks: [],
  commits: [],
  commitsTruncated: false,
  baseSha: "abc",
  headSha: "def",
  pendingReviewId: null,
} as unknown as PrDetail;

/** One AI draft, anchored on a file the loaded detail below does list. */
function draft(over: Partial<ReviewDraft> = {}): ReviewDraft {
  return {
    id: "d1",
    agentKind: "Claude",
    prRepo: "acme/web",
    prNumber: 42,
    headSha: "def",
    path: "src/app.ts",
    line: 12,
    startLine: null,
    onRight: true,
    body: "This leaks the handle",
    suggestion: null,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

/** One posted inline thread, on the same file. */
function thread(over: Partial<PrThread> = {}): PrThread {
  return {
    id: "t1",
    replyToId: "c1",
    path: "src/app.ts",
    line: 12,
    startLine: null,
    onRight: true,
    isResolved: false,
    isOutdated: false,
    viewerCanResolve: true,
    viewerCanUnresolve: true,
    comments: [
      {
        author: "grace",
        authorAvatarUrl: "",
        body: "Same here",
        createdAt: "2026-08-25T10:00:00Z",
        isPending: false,
      },
    ],
    ...over,
  } as PrThread;
}

/** The detail, landed, with one file in the diff. */
const withFiles = {
  ...loaded,
  files: [{ path: "src/app.ts", sha: "s1" }],
} as unknown as PrDetail;

beforeEach(() => {
  detail.data = undefined;
  detail.isLoading = true;
  ai.drafts = [];
  focusFile.mockClear();
});

/**
 * Reported: a PR's description and comments read as *absent* for as long as the
 * fetch took. "Nobody wrote anything" and "we haven't looked yet" are different
 * answers, and only one of them is ours to assert — the same rule the sidebar's
 * project sections follow.
 */
describe("PrConversationPane while the detail read is in flight", () => {
  it("never claims the PR has no description", () => {
    render(<PrConversationPane pr={pr} focusFile={focusFile} />);
    expect(screen.queryByText(/No description provided/i)).not.toBeInTheDocument();
  });

  /** The header is *not* a guess: who opened the PR and when came with the inbox
   *  row, so it stays real while only the body waits. */
  it("keeps the author and time it already knows, and skeletons only the body", () => {
    const { container } = render(<PrConversationPane pr={pr} focusFile={focusFile} />);
    expect(screen.getByText("kwaters12")).toBeInTheDocument();
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("renders the real body once the read lands", () => {
    detail.data = loaded;
    detail.isLoading = false;
    const { container } = render(<PrConversationPane pr={pr} focusFile={focusFile} />);
    expect(screen.getByText("Why this change")).toBeInTheDocument();
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);
  });

  /** An empty description after a *successful* read is a real answer, and this
   *  is the one case where saying so is correct. */
  it("does say so when the PR genuinely has no description", () => {
    detail.data = { ...loaded, body: "" };
    detail.isLoading = false;
    render(<PrConversationPane pr={pr} focusFile={focusFile} />);
    expect(screen.getByText(/No description provided/i)).toBeInTheDocument();
  });
});

/**
 * The description is the proposal the comments are *about*. It used to be the
 * timeline's first card — same avatar gutter, same "author commented" header —
 * which read as the author's opening remark rather than as the pull request.
 */
describe("PrConversationPane's description", () => {
  const comment = {
    author: "grace",
    authorAvatarUrl: "",
    body: "looks good",
    createdAt: "2026-08-25T10:00:00Z",
    kind: "Issue",
    path: null,
    isPending: false,
    isBot: false,
  };

  it("is its own labelled block, not one of the conversation's comment cards", () => {
    detail.data = { ...loaded, comments: [comment] } as unknown as PrDetail;
    detail.isLoading = false;
    render(<PrConversationPane pr={pr} focusFile={focusFile} />);

    expect(screen.getByText("Description")).toBeInTheDocument();
    expect(screen.getByText(/opened this/)).toBeInTheDocument();
    // One entry is worded as a comment, and it is the comment.
    expect(screen.getAllByText("commented")).toHaveLength(1);
  });

  /** The rule has not changed, only what stands in for the unknown: nothing may
   *  claim somebody said something. Drawing *nothing at all* was the other way
   *  of getting it wrong — it answered "no one has commented" before we had
   *  looked — so the wait is now comment-shaped placeholders. */
  it("claims no comment while the read that would carry it is in flight", () => {
    const { container } = render(<PrConversationPane pr={pr} focusFile={focusFile} />);
    expect(screen.queryByText("commented")).not.toBeInTheDocument();
    expect(screen.queryByText("reviewed")).not.toBeInTheDocument();
    // A face and a card per placeholder, in the shape a comment arrives in.
    expect(container.querySelectorAll(".animate-pulse.rounded-full").length).toBeGreaterThan(0);
  });

  it("drops the placeholders once the read says there is no conversation", () => {
    detail.data = loaded;
    detail.isLoading = false;
    const { container } = render(<PrConversationPane pr={pr} focusFile={focusFile} />);
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);
    expect(screen.queryByText("Conversation")).not.toBeInTheDocument();
  });
});

/**
 * Reported: "we show them at first, but when real comments load they're not
 * visible anymore." The section listed only the entries the diff had no room for,
 * and while the detail read was in flight *every* entry qualified — so the
 * feedback appeared, then vanished at the exact moment the pane finished loading.
 *
 * The section now lists everything. That the cards also render beside their code
 * is not a duplicate: this is the index, and it answers "what has been said about
 * this pull request" on the page that opens it.
 */
describe("PrConversationPane's anchored feedback", () => {
  it("keeps the AI's drafts on screen once the detail read lands", () => {
    ai.drafts = [draft()];
    detail.isLoading = false;
    const { rerender } = render(<PrConversationPane pr={pr} focusFile={focusFile} />);
    expect(screen.getByText("Review comments")).toBeInTheDocument();

    detail.data = withFiles;
    rerender(<PrConversationPane pr={pr} focusFile={focusFile} />);
    expect(screen.getByText("This leaks the handle")).toBeInTheDocument();
  });

  it("keeps the posted review threads on screen for the same reason", () => {
    detail.data = { ...withFiles, threads: [thread()] } as unknown as PrDetail;
    detail.isLoading = false;
    render(<PrConversationPane pr={pr} focusFile={focusFile} />);
    expect(screen.getByText("Review comments")).toBeInTheDocument();
    expect(screen.getByText("Same here")).toBeInTheDocument();
  });

  /**
   * The AI reviews this pull request like any other reviewer, so its comments
   * belong with everyone else's rather than in a section of their own — and the
   * row says whose it is with santree's mark, which is what replaced the
   * heading that used to carry that fact.
   */
  it("lists the AI's drafts among the posted comments, under santree's mark", () => {
    ai.drafts = [draft()];
    detail.data = { ...withFiles, threads: [thread()] } as unknown as PrDetail;
    detail.isLoading = false;
    render(<PrConversationPane pr={pr} focusFile={focusFile} />);

    expect(screen.queryByText("AI suggested comments")).not.toBeInTheDocument();
    expect(screen.getAllByText("Review comments")).toHaveLength(1);
    // Both in the one list, and the AI's is attributed.
    expect(screen.getByText("Same here")).toBeInTheDocument();
    expect(screen.getByText("This leaks the handle")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "santree's AI review" })).toBeInTheDocument();
  });

  /** The row is an index entry, not a second copy of the card: it names where the
   *  comment is and opens the diff there, where the card with the actions is. */
  it("names the file and line, and jumps to it on click", () => {
    ai.drafts = [draft()];
    detail.data = withFiles;
    detail.isLoading = false;
    render(<PrConversationPane pr={pr} focusFile={focusFile} />);

    const row = screen.getByTitle(/src\/app\.ts · line 12/);
    fireEvent.click(row);
    expect(focusFile).toHaveBeenCalledWith("src/app.ts", 12);
    expect(screen.queryByTestId("draft-card-d1")).not.toBeInTheDocument();
  });

  /** GitHub caps the file list and a push can drop a file. There is no card
   *  beside that code to jump to, so the whole card renders here — this is the
   *  only place the draft exists. */
  it("gives a draft on a file the diff doesn't list its whole card", () => {
    ai.drafts = [draft({ id: "d2", path: "docs/notes.md" })];
    detail.data = withFiles;
    detail.isLoading = false;
    render(<PrConversationPane pr={pr} focusFile={focusFile} />);

    expect(screen.getByTestId("draft-card-d2")).toBeInTheDocument();
    expect(screen.queryByTitle(/docs\/notes\.md/)).not.toBeInTheDocument();
  });

  it("does the same for a thread on a file the diff doesn't list", () => {
    detail.data = {
      ...withFiles,
      threads: [thread({ path: "docs/notes.md" })],
    } as unknown as PrDetail;
    detail.isLoading = false;
    render(<PrConversationPane pr={pr} focusFile={focusFile} />);
    expect(screen.getByTestId("thread-card-docs/notes.md")).toBeInTheDocument();
  });
});

/**
 * A comment card hangs its body off a 26px avatar, so anything drawn at the
 * column's own edge is visibly wider than every comment above it. The composer
 * and the feedback index are not somebody's comment and get no face — but they
 * take the same offset, so the boxes line up. The description keeps the full
 * column: it is the proposal the comments are about, not one of them.
 */
describe("PrConversationPane's left edge", () => {
  it("hangs the composer and the feedback index off the comment column", () => {
    ai.drafts = [draft()];
    detail.data = withFiles;
    detail.isLoading = false;
    const { container } = render(<PrConversationPane pr={pr} focusFile={focusFile} />);

    expect(screen.getByPlaceholderText("Comment on this pull request…").closest(".ml-9")).not.toBe(
      null,
    );
    expect(screen.getByTitle(/src\/app\.ts · line 12/).closest(".ml-9")).not.toBeNull();
    // The description is deliberately not inset.
    expect(container.querySelector("section .ml-9")).toBeNull();
  });
});
