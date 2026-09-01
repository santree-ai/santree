import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewBrief, ReviewPr } from "../../bindings";

const spies = vi.hoisted(() => ({
  selectFile: vi.fn(),
  setFileTab: vi.fn(),
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

vi.mock("./model", () => ({
  useTrees: () => ({
    repo: "acme/app",
    activeId: "AK-1",
    selectFile: spies.selectFile,
    setFileTab: spies.setFileTab,
  }),
}));

// Both launchers report whether their (multi-second) launch is still running, so
// the pane's buttons can show it — see `StartWorkLauncher`.
vi.mock("../reviews/useStartWork", () => ({
  useStartAiReviewInWorktree: () => ({ start: spies.startReview, starting: spies.starting }),
  useStartWorkInWorktree: () => ({ start: spies.startWork, starting: spies.starting }),
}));

import { WorktreeAiWorkPane } from "./WorktreeAiWorkPane";

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

describe("WorktreeAiWorkPane", () => {
  beforeEach(() => {
    spies.starting = false;
  });

  /** The merge is the whole point: reading the brief is where you decide what to
   *  fix, and the queue is where a fix goes. Two tabs meant a switch per item. */
  it("renders the queue and the brief in one pane, queue first", () => {
    spies.brief = brief();

    render(<WorktreeAiWorkPane pr={{ repo: "acme/app", number: 7 } as never} />);

    const queue = screen.getByLabelText("New review improvement");
    const summary = screen.getByText("Adds the AI work pane.");
    // Queue first: it is what you come back to, the brief is what you read once.
    expect(queue.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /** The reason the reading order lives beside the work: you open the files one
   *  after another, from here. A click that also moved the panel would cost the
   *  reader their place in that list every single time. */
  it("opens a reading-order file in the main area without leaving the pane", () => {
    spies.brief = brief();
    spies.selectFile.mockClear();
    spies.setFileTab.mockClear();

    render(<WorktreeAiWorkPane pr={{ repo: "acme/app", number: 7 } as never} />);

    fireEvent.click(screen.getByTitle("Jump to src/features/trees/FilePickerPanel.tsx"));

    expect(spies.selectFile).toHaveBeenCalledWith(
      "src/features/trees/FilePickerPanel.tsx",
      "branch",
    );
    expect(spies.setFileTab).not.toHaveBeenCalled();
  });

  it("queues a note from the pane's own composer", () => {
    spies.brief = brief();
    spies.addItem.mockClear();

    render(<WorktreeAiWorkPane pr={{ repo: "acme/app", number: 7 } as never} />);

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

    render(<WorktreeAiWorkPane pr={{ repo: "acme/app", number: 7 } as never} />);

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

    render(<WorktreeAiWorkPane pr={{ repo: "acme/app", number: 7 } as never} />);

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

    render(<WorktreeAiWorkPane pr={null} />);

    expect(screen.getByText("No pull request yet")).toBeInTheDocument();
    expect(screen.queryByLabelText("New review improvement")).toBeNull();
  });
});
