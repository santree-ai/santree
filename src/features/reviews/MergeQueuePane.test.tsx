/**
 * The merge-queue panel's three empty answers — different facts (GitHub was
 * never asked, this repo has no queue, the queue is empty), each about one
 * `owner/name`, which the panel has to say; unnamed, "This repository doesn't
 * have a merge queue" sat beside an org-wide inbox listing another repo's PRs.
 * And, with a queue, the numbers it leads with and what each row says.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MergeQueue, MergeQueueEntry, MergeQueueView } from "../../bindings";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("./model", () => ({ useReviewsModel: () => ({ repo: "santree" }) }));

const state = vi.hoisted(() => ({ data: undefined as MergeQueueView | undefined }));
vi.mock("../../lib/queries", () => ({
  useMergeQueue: () => ({ data: state.data, isLoading: false, isError: false }),
}));

import { MergeQueuePane } from "./MergeQueuePane";

function show(data: MergeQueueView) {
  state.data = data;
  render(<MergeQueuePane />);
}

function queue(over: Partial<MergeQueue> = {}): MergeQueue {
  return {
    repo: "acme/web",
    branch: "main",
    url: "https://github.com/acme/web/queue/main",
    nextEstimatedSecs: null,
    mergedLast30Days: null,
    entries: [],
    ...over,
  };
}

function entry(over: Partial<MergeQueueEntry> = {}): MergeQueueEntry {
  return {
    position: 1,
    state: "AwaitingChecks",
    prNumber: 55082,
    prTitle: "Rename is_eligible_for_auto_checkout",
    prUrl: "https://github.com/acme/web/pull/55082",
    author: "gustavo",
    authorAvatarUrl: "",
    isMine: false,
    enqueuedAt: new Date(Date.now() - 19 * 60_000).toISOString(),
    estimatedSecs: 318,
    ...over,
  };
}

describe("MergeQueuePane", () => {
  it("names the repository that has no merge queue", () => {
    show({ repo: "acme/web", githubConnected: true, queue: null });
    expect(screen.getByText(/^acme\/web doesn't have a merge queue/)).toBeInTheDocument();
  });

  it("names the repository whose queue is empty", () => {
    show({ repo: "acme/web", githubConnected: true, queue: queue() });
    expect(screen.getByText(/waiting to merge into acme\/web/)).toBeInTheDocument();
  });

  /** The three numbers GitHub's own page leads with, and a dash — not a zero —
   *  for an estimate it didn't give. */
  it("leads with the queue's numbers", () => {
    show({
      repo: "acme/web",
      githubConnected: true,
      queue: queue({ nextEstimatedSecs: 604, mergedLast30Days: 2213, entries: [entry()] }),
    });
    expect(screen.getByText("In queue").nextElementSibling).toHaveTextContent("1");
    expect(screen.getByText("Next merge").nextElementSibling).toHaveTextContent("~10m 4s");
    expect(screen.getByText("Merged · 30 days").nextElementSibling).toHaveTextContent("2.2k");

    show({ repo: "acme/web", githubConnected: true, queue: queue({ entries: [entry()] }) });
    expect(screen.getAllByText("Next merge")[1].nextElementSibling).toHaveTextContent("—");
  });

  it("says who queued each entry, when, and how long GitHub gives it", () => {
    show({
      repo: "acme/web",
      githubConnected: true,
      queue: queue({ entries: [entry(), entry({ position: 2, prNumber: 53572, isMine: true })] }),
    });
    expect(screen.getByText("2 queued")).toBeInTheDocument();
    expect(screen.getByText("#55082")).toBeInTheDocument();
    expect(screen.getAllByText("enqueued")[0]).toHaveTextContent("enqueued 19m ago");
    expect(screen.getAllByText("~5m 18s to merge")).toHaveLength(2);
    expect(screen.getByText("yours")).toBeInTheDocument();
    expect(screen.getAllByText("checks running")).toHaveLength(2);
  });

  it("reports a disconnected GitHub rather than an absent queue", () => {
    show({ repo: "acme/web", githubConnected: false, queue: null });
    expect(screen.queryByText("No merge queue")).not.toBeInTheDocument();
    expect(screen.getByText("GitHub isn't connected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));
    expect(navigate).toHaveBeenCalledWith({ to: "/settings", search: { section: "github" } });
  });
});
