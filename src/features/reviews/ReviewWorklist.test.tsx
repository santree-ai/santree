/**
 * The queue holds four kinds of row and only one of them is the user's own
 * words. These cover what that distinction has to mean on screen: a reference
 * carries no pencil (its body is re-resolved from the source, so an edit here
 * would diverge in silence), each source is named by a glyph the app already
 * uses for it, and the metadata line is read live — a check that has gone green
 * since it was queued says "passed", whatever its frozen sentence claims.
 */

import { openUrl } from "@tauri-apps/plugin-opener";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PrCheck,
  PrComment,
  PrDetail,
  PrThread,
  ReviewDraft,
  ReviewPr,
  ReviewWorkItem,
} from "../../bindings";
import { ReviewWorklist } from "./ReviewWorklist";

const spies = vi.hoisted(() => ({ add: vi.fn(), update: vi.fn(), remove: vi.fn() }));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

vi.mock("../../lib/queries", () => ({
  useReviewWorkItems: () => ({ data: items }),
  useAddReviewWorkItem: () => ({ mutate: spies.add, isPending: false }),
  useUpdateReviewWorkItem: () => ({ mutate: spies.update, isPending: false }),
  useDeleteReviewWorkItem: () => ({ mutate: spies.remove, isPending: false }),
}));

let items: ReviewWorkItem[] = [];

function workItem(over: Partial<ReviewWorkItem> & { id: string }): ReviewWorkItem {
  return {
    prRepo: "acme/api",
    prNumber: 7,
    body: "",
    done: false,
    source: "manual",
    sourceId: null,
    path: null,
    line: null,
    startLine: null,
    onRight: null,
    createdAtMs: null,
    updatedAtMs: null,
    ...over,
  };
}

function check(over: Partial<PrCheck> & { name: string }): PrCheck {
  return {
    status: "Failure",
    description: null,
    url: null,
    steps: [],
    annotations: [],
    jobId: null,
    runId: null,
    startedAt: null,
    completedAt: null,
    ...over,
  };
}

function comment(over: Partial<PrComment> & { author: string }): PrComment {
  return {
    authorAvatarUrl: "",
    body: "",
    createdAt: "2026-06-28T12:00:00Z",
    kind: "ReviewThread",
    path: null,
    isPending: false,
    isBot: false,
    ...over,
  };
}

function thread(over: Partial<PrThread> & { replyToId: string }): PrThread {
  return {
    id: `T_${over.replyToId}`,
    path: "src/retry.ts",
    line: 42,
    startLine: null,
    onRight: true,
    isResolved: false,
    isOutdated: false,
    viewerCanResolve: true,
    viewerCanUnresolve: true,
    comments: [],
    ...over,
  };
}

function draft(over: Partial<ReviewDraft> & { id: string }): ReviewDraft {
  return {
    agentKind: "Claude",
    prRepo: "acme/api",
    prNumber: 7,
    headSha: "head",
    path: "src/retry.ts",
    line: 42,
    startLine: null,
    onRight: true,
    body: "",
    suggestion: null,
    createdAtMs: null,
    updatedAtMs: null,
    ...over,
  };
}

function detail(over: Partial<PrDetail> = {}): PrDetail {
  return {
    body: "",
    attachments: [],
    labels: [],
    comments: [],
    threads: [],
    files: [],
    filesTruncated: false,
    commits: [],
    commitsTruncated: false,
    checks: [],
    baseSha: "base",
    headSha: "head",
    pendingReviewId: null,
    ...over,
  };
}

const PR: ReviewPr = {
  id: "m1",
  number: 7,
  title: "Booking webhook retries",
  url: "https://github.com/acme/api/pull/7",
  repo: "acme/api",
  project: null,
  headRef: "you/pr-7",
  headRefId: null,
  baseRef: "main",
  baseRefId: null,
  headSha: "head",
  author: "you",
  authorAvatarUrl: "",
  state: "Open",
  isDraft: false,
  reviewDecision: "ReviewRequired",
  checks: "Failure",
  isInMergeQueue: false,
  additions: 10,
  deletions: 2,
  changedFiles: 2,
  commentCount: 0,
  aiDraftCount: 0,
  reviewers: [],
  updatedAt: "2026-06-29T12:00:00Z",
  createdAt: "2026-06-28T12:00:00Z",
  waitingSince: "2026-06-28T12:00:00Z",
  headCommittedAt: "2026-06-28T12:00:00Z",
  viewerReview: null,
};

const focus = vi.fn();

const startWork = vi.fn();

function list(
  rows: ReviewWorkItem[],
  over?: Partial<PrDetail>,
  drafts: ReviewDraft[] = [],
  startingWork = false,
) {
  items = rows;
  return render(
    <ReviewWorklist
      pr={PR}
      detail={detail(over)}
      drafts={drafts}
      onFocusFile={focus}
      onStartWork={startWork}
      startingWork={startingWork}
    />,
  );
}

beforeEach(() => {
  items = [];
  focus.mockClear();
  startWork.mockClear();
  vi.mocked(openUrl).mockClear();
});

/** The launch behind this button renders the prompt from the live PR, which is
 *  seconds long. It used to run with no sign at all — the tab it opens only
 *  appeared at the end — so the button is the one place a click is guaranteed to
 *  register, and it has to keep registering until the launch is done. */
describe("ReviewWorklist launch state", () => {
  it("hands the open items over on a click", () => {
    list([workItem({ id: "1", body: "tidy the retry loop" })]);

    fireEvent.click(screen.getByRole("button", { name: "Start work" }));

    expect(startWork).toHaveBeenCalledTimes(1);
  });

  it("reports the launch running and takes no further clicks", () => {
    list([workItem({ id: "1", body: "tidy the retry loop" })], undefined, [], true);

    const button = screen.getByRole("button", { name: /Starting/ });
    expect(button).toBeDisabled();
    fireEvent.click(button);

    expect(startWork).not.toHaveBeenCalled();
  });
});

describe("ReviewWorklist rows", () => {
  it("offers the pencil on your own note and on nothing else", () => {
    // A reference's body is authored by the backend from its source and resolved
    // again when the agent starts — an edit here would be overwritten, unseen.
    list(
      [
        workItem({ id: "1", source: "manual", body: "tidy the retry loop" }),
        workItem({ id: "2", source: "githubThread", sourceId: "9001", body: "nit" }),
        workItem({ id: "3", source: "aiDraft", sourceId: "d1", body: "leaks a handle" }),
        workItem({ id: "4", source: "check", sourceId: "build", body: "build is red" }),
      ],
      { checks: [check({ name: "build" })] },
    );

    expect(screen.getAllByLabelText("Edit improvement")).toHaveLength(1);
    // Deleting stays available on every row: a reference you don't want to fix
    // still comes off the queue.
    expect(screen.getAllByLabelText("Delete improvement")).toHaveLength(4);

    fireEvent.click(screen.getByLabelText("Edit improvement"));
    expect(screen.getByLabelText("Edit review improvement")).toHaveValue("tidy the retry loop");
  });

  it("names each row's source in its glyph slot", () => {
    list(
      [
        workItem({ id: "1", source: "manual", body: "note" }),
        workItem({ id: "2", source: "githubThread", sourceId: "9001", body: "nit" }),
        workItem({ id: "3", source: "aiDraft", sourceId: "d1", body: "leak" }),
        workItem({ id: "4", source: "check", sourceId: "build", body: "red" }),
      ],
      { checks: [check({ name: "build" })] },
      [draft({ id: "d1" })],
    );

    expect(screen.getByLabelText("Note")).toBeInTheDocument();
    expect(screen.getByLabelText("Review comment")).toBeInTheDocument();
    expect(screen.getByLabelText("AI draft")).toBeInTheDocument();
    expect(screen.getByLabelText("Check, failed")).toBeInTheDocument();
  });

  it("reads a check's status live, not off the sentence it was queued with", () => {
    list([workItem({ id: "1", source: "check", sourceId: "build", body: "build is failing" })], {
      checks: [
        check({
          name: "build",
          status: "Success",
          description: "GitHub Actions",
          url: "https://x",
        }),
      ],
    });

    expect(screen.getByText("passed")).toBeInTheDocument();
    expect(screen.getByText("GitHub Actions")).toBeInTheDocument();
    fireEvent.click(screen.getByText("build"));
    expect(openUrl).toHaveBeenCalledWith("https://x");
  });

  it("says so when the queued check is no longer on the PR", () => {
    // Renamed or dropped since queueing. Silence here would leave the frozen
    // sentence reading as if it were still live.
    list([workItem({ id: "1", source: "check", sourceId: "lint", body: "lint is failing" })]);
    expect(screen.getByText("not on this PR any more")).toBeInTheDocument();
  });

  it("shows a thread's author, anchor and resolved state", () => {
    list(
      [
        workItem({
          id: "1",
          source: "githubThread",
          sourceId: "9001",
          body: "nit",
          path: "src/retry.ts",
          line: 42,
        }),
      ],
      {
        threads: [
          thread({
            replyToId: "9001",
            isResolved: true,
            isOutdated: true,
            comments: [comment({ author: "sam", body: "nit" })],
          }),
        ],
      },
    );

    expect(screen.getByText("@sam")).toBeInTheDocument();
    expect(screen.getByText("Resolved")).toBeInTheDocument();
    expect(screen.getByText("Outdated")).toBeInTheDocument();
    fireEvent.click(screen.getByText("src/retry.ts:42"));
    expect(focus).toHaveBeenCalledWith("src/retry.ts", 42);
  });

  it("names the agent behind a draft, and flags one written against an older head", () => {
    const queued = workItem({ id: "1", source: "aiDraft", sourceId: "d1", body: "leaks a handle" });
    const { unmount } = list([queued], { headSha: "new" }, [draft({ id: "d1", headSha: "old" })]);
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Older commit")).toBeInTheDocument();
    unmount();

    list([queued], { headSha: "head" }, [draft({ id: "d1", headSha: "head" })]);
    expect(screen.queryByText("Older commit")).toBeNull();
  });

  it("keeps showing what the source says now when it has moved on", () => {
    list([workItem({ id: "1", source: "githubThread", sourceId: "9001", body: "nit" })], {
      threads: [
        thread({
          replyToId: "9001",
          comments: [comment({ author: "sam", body: "on reflection, no" })],
        }),
      ],
    });
    expect(screen.getByText(/Latest:/)).toHaveAttribute("title", "on reflection, no");
  });
});
