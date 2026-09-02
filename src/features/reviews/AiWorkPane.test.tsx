import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewBrief, ReviewPr } from "../../bindings";

const spies = vi.hoisted(() => ({
  selectFile: vi.fn(),
  addItem: vi.fn(),
  startReview: vi.fn(),
  startWork: vi.fn(),
  starting: false,
  brief: null as ReviewBrief | null,
}));

vi.mock("../../lib/queries", () => ({
  REVIEW_AGENT_KEY: "review_agent",
  usePrSummary: () => ({ data: pr }),
  usePrDetail: () => ({ data: undefined }),
  usePrReviewBrief: () => ({ data: spies.brief, isLoading: false }),
  useResolvedSetting: () => ({ data: "Codex" }),
  useReviewDrafts: () => ({ data: [] }),
  useReviewWorkItems: () => ({ data: [] }),
  useAddReviewWorkItem: () => ({ mutate: spies.addItem, isPending: false }),
  useUpdateReviewWorkItem: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteReviewWorkItem: () => ({ mutate: vi.fn(), isPending: false }),
  useAgentAuth: () => ({ data: { connected: true } }),
  useCodexHealth: () => ({ data: { available: true } }),
  useCodexAccount: () => ({ data: { connected: true } }),
}));

vi.mock("../terminal/TerminalsContext", () => ({ useTerminals: () => ({ tabs: [] }) }));

import { AiWorkPane } from "./AiWorkPane";

/** The pane with a host's wiring attached — every difference between Trees and
 *  Reviews is one of these props, which is the point of the merge. This stands in
 *  for the Trees host: a jump opens the file elsewhere and leaves the pane alone,
 *  and both launches are asynchronous. */
function mountPane(pr: { repo: string; number: number } | null) {
  return render(
    <AiWorkPane
      pr={pr}
      santreeRepo="acme/app"
      activeReviewAgent={null}
      onJump={spies.selectFile}
      startWork={{ start: spies.startWork, starting: spies.starting }}
      onStartReview={spies.startReview}
      startingReview={spies.starting}
      canPickAgent
    />,
  );
}

const pr = {
  id: "pr-7",
  repo: "acme/app",
  number: 7,
  headSha: "head-2",
} as ReviewPr;

function brief(over: Partial<ReviewBrief> = {}): ReviewBrief {
  return {
    agentKind: "Codex",
    summary: "Adds the AI work pane.",
    readingOrder: [
      { path: "src/features/trees/FilePickerPanel.tsx", role: "entryPoint", why: "Start" },
    ],
    watchOuts: [],
    questions: [],
    truncated: false,
    headSha: "head-2",
    generatedAtMs: 1_756_000_000_000,
    ...over,
  };
}

describe("AiWorkPane", () => {
  beforeEach(() => {
    spies.starting = false;
  });

  /** The merge is the whole point: reading the brief is where you decide what to
   *  fix, and the queue is where a fix goes. Two tabs meant a switch per item. */
  it("renders the queue and the brief in one pane, queue first", () => {
    spies.brief = brief();

    mountPane({ repo: "acme/app", number: 7 });

    const queue = screen.getByLabelText("New review improvement");
    const summary = screen.getByText("Adds the AI work pane.");
    // Queue first: it is what you come back to, the brief is what you read once.
    expect(queue.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /** The reason the reading order lives beside the work: you open the files one
   *  after another, from here. The jump is the host's — Reviews scrolls its diff
   *  column, Trees opens the file in the main area — but neither may take the
   *  pane away with it, or the reader loses their place in the list every time. */
  it("hands a reading-order file to its host and stays where it is", () => {
    spies.brief = brief();
    spies.selectFile.mockClear();

    mountPane({ repo: "acme/app", number: 7 });

    fireEvent.click(screen.getByTitle("Jump to src/features/trees/FilePickerPanel.tsx"));

    expect(spies.selectFile).toHaveBeenCalledWith("src/features/trees/FilePickerPanel.tsx");
    expect(screen.getByLabelText("New review improvement")).toBeInTheDocument();
  });

  it("queues a note from the pane's own composer", () => {
    spies.brief = brief();
    spies.addItem.mockClear();

    mountPane({ repo: "acme/app", number: 7 });

    fireEvent.change(screen.getByLabelText("New review improvement"), {
      target: { value: "Split the dot logic out" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add/ }));

    expect(spies.addItem).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Split the dot logic out", source: "manual" }),
    );
  });

  it("offers to start the review when the PR has no brief yet", () => {
    spies.brief = null;

    mountPane({ repo: "acme/app", number: 7 });

    expect(screen.getByRole("button", { name: /Start Codex review/ })).toBeInTheDocument();
  });

  /** The launch is seconds of backend work (fetch the PR, build the diff index,
   *  render the prompt) before its tab can run anything. For as long as the guard
   *  was a bare ref that ran without a render, the button that started it said
   *  "Start" throughout — so the only feedback a click had was more clicking. */
  it("shows the review launch running, and refuses a second click", () => {
    spies.brief = null;
    spies.starting = true;
    spies.startReview.mockClear();

    mountPane({ repo: "acme/app", number: 7 });

    const button = screen.getByRole("button", { name: /Starting/ });
    expect(button).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Start Codex review/ })).toBeNull();

    fireEvent.click(button);
    expect(spies.startReview).not.toHaveBeenCalled();
  });

  /** The queue rows are keyed `(pr_repo, pr_number)` in SQLite, so there is
   *  nowhere to put a PR-less item until a migration lifts that. The pane takes
   *  the null anyway, so the day it does this is one branch, not a rewrite. */
  it("says so when the branch has no pull request yet", () => {
    spies.brief = brief();

    mountPane(null);

    expect(screen.getByText("No pull request yet")).toBeInTheDocument();
    expect(screen.queryByLabelText("New review improvement")).toBeNull();
  });
});
