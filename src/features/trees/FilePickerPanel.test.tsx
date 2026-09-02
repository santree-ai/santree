/**
 * The right panel's two halves have to agree: the tab strip offers exactly the
 * panes this worktree has, and the body renders exactly the pane the strip's
 * selection names.
 *
 * The body used to be a ternary cascade ending in `<SessionHistory/>`, so a pane
 * that fell through every arm rendered the *wrong* thing rather than nothing —
 * a failure you have to notice, not one you trip over. These walk every arm.
 *
 * The stakes on the strip: a worktree cut from a plain branch has no Linear
 * ticket, and offering it an Issue tab is what fetched a nonexistent issue and
 * put a red error toast on screen.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorktreePr } from "../../bindings";
import type { FileScope, FileTab } from "./model";

const trees = vi.hoisted(() => ({
  repo: "acme/app",
  active: { id: "AK-1", title: "A ticket" } as { id: string; title: string } | null,
  activeId: "AK-1",
  activePr: null as WorktreePr | null,
  fileTab: "issue" as FileTab,
  hasTicket: true,
  prsByWorktree: new Map<string, WorktreePr[]>(),
  openPrDialog: vi.fn(),
  suggestPr: vi.fn(),
  selectFile: vi.fn(),
  selectedFile: null as string | null,
  selectedFileScope: "working" as FileScope,
  setFileTab: vi.fn(),
  rightCollapsed: false,
  rightWidth: 340,
  setRightWidth: vi.fn(),
  toggleRightPanel: vi.fn(),
}));

vi.mock("./model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model")>()),
  useTrees: () => trees,
}));

vi.mock("../../lib/queries", () => ({
  usePrSummary: () => ({ data: undefined }),
  usePrReviewBrief: () => ({ data: undefined }),
  useReviewWorkItems: () => ({ data: [] }),
  useWorktreeStatus: () => ({ data: undefined }),
  useSetWorktreeTitle: () => ({ mutate: vi.fn() }),
}));

// Reach a router and a query client to launch an agent; the panel only needs the
// launchers to exist. Same for resuming a session — its own tests cover it.
vi.mock("../reviews/useStartWork", () => ({
  useStartWorkInWorktree: () => ({ start: vi.fn(), starting: false }),
  useStartAiReviewInWorktree: () => ({ start: vi.fn(), starting: false }),
}));
vi.mock("./useResumeSession", () => ({
  useResumeSessionInWorktree: () => ({ resume: vi.fn(), resumingId: null }),
}));

// Each pane stands in for itself: what matters here is *which* one the body
// picked, not what it renders. Hoisted with the mocks that use it — a `vi.mock`
// factory runs before the module body.
const { stub } = vi.hoisted(() => ({
  stub: (name: string) => () => <div>{name} pane</div>,
}));
vi.mock("../../components/IssuePane", () => ({ IssuePane: stub("Issue") }));
vi.mock("./WorktreePrPane", () => ({ WorktreePrPane: stub("PR") }));
vi.mock("../reviews/AiWorkPane", () => ({ AiWorkPane: stub("AI work"), aiWorkDot: () => null }));
vi.mock("./AllFilesList", () => ({ AllFilesList: stub("Files") }));
vi.mock("./GitPanel", () => ({ GitPanel: stub("Changes") }));
vi.mock("./SessionHistory", () => ({ SessionHistory: stub("History") }));

import { FilePickerPanel } from "./FilePickerPanel";

const pr = { repo: "acme/app", number: 7, issueId: "AK-1" } as WorktreePr;

/** Render with the model dialled to `state`, from the shared fixture each time —
 *  several of these walk a set of states inside one test. */
function mount(state: Partial<typeof trees> = {}) {
  cleanup();
  Object.assign(trees, {
    active: { id: "AK-1", title: "A ticket" },
    activeId: "AK-1",
    activePr: null,
    fileTab: "issue",
    hasTicket: true,
    rightCollapsed: false,
    ...state,
  });
  return render(<FilePickerPanel />);
}

const tabNames = () => screen.getAllByRole("tab").map((t) => t.getAttribute("aria-label"));

describe("the pane the body renders", () => {
  const arms: [FileTab, string][] = [
    ["issue", "Issue pane"],
    ["pr", "PR pane"],
    ["aiWork", "AI work pane"],
    ["files", "Files pane"],
    ["changes", "Changes pane"],
    ["history", "History pane"],
  ];

  // One case per `FileTab`. A tab that stops matching its own arm shows up as the
  // wrong pane here rather than as a quietly-correct-looking History.
  it.each(arms)("renders the %s pane, and only that one", (tab, pane) => {
    mount({ fileTab: tab, activePr: pr });
    expect(screen.getByText(pane)).toBeInTheDocument();
    for (const [, other] of arms) {
      if (other !== pane) expect(screen.queryByText(other)).not.toBeInTheDocument();
    }
  });

  // The two panes that depend on data the worktree may not have. Neither may fall
  // through to another pane's content — an empty body is the honest answer.
  it("renders nothing rather than the wrong pane when a pane's subject is missing", () => {
    mount({ fileTab: "issue", active: null });
    expect(screen.queryByText("Issue pane")).not.toBeInTheDocument();
    expect(screen.queryByText("History pane")).not.toBeInTheDocument();

    mount({ fileTab: "pr", activePr: null });
    expect(screen.queryByText("PR pane")).not.toBeInTheDocument();
    expect(screen.queryByText("History pane")).not.toBeInTheDocument();
  });
});

describe("the tab strip", () => {
  it("offers the Issue tab for a ticket-tracked worktree", () => {
    mount();
    expect(tabNames()).toEqual(["Issue", "Files", "Changes", "Session history"]);
  });

  // The bug this exists to hold: no ticket, no tab onto one.
  it("drops the Issue tab on a worktree with no Linear ticket", () => {
    mount({ hasTicket: false, fileTab: "changes" });
    expect(tabNames()).toEqual(["Files", "Changes", "Session history"]);
    expect(screen.getByText("Changes pane")).toBeInTheDocument();
  });

  it("keeps the PR tabs on a ticket-less worktree that has a pull request", () => {
    mount({ hasTicket: false, fileTab: "changes", activePr: pr });
    expect(tabNames()).toEqual([
      "Files",
      "Changes",
      "Session history",
      "Pull request",
      "AI work queue",
    ]);
  });

  // The strip and the body read the same `availableFileTabs`, and this is what
  // keeps them reading it alike: every tab on offer must lead to its own pane,
  // never to whichever one the body falls back on.
  it("leads to a distinct pane for every tab it offers", () => {
    for (const hasTicket of [true, false]) {
      mount({ hasTicket, activePr: pr, fileTab: "changes" });
      const offered = tabNames();
      const seen = new Set<string>();
      for (const label of offered) {
        const tab = PANE_BY_TAB_LABEL[label ?? ""];
        expect(tab, `no pane known for the "${label}" tab`).toBeDefined();
        mount({ hasTicket, activePr: pr, fileTab: tab });
        expect(screen.getByText(`${PANE_TEXT[tab]} pane`)).toBeInTheDocument();
        seen.add(tab);
      }
      expect(seen.size).toBe(offered.length);
    }
  });
});

/** The strip's accessible label → the pane it selects. */
const PANE_BY_TAB_LABEL: Record<string, FileTab> = {
  Issue: "issue",
  Files: "files",
  Changes: "changes",
  "Session history": "history",
  "Pull request": "pr",
  "AI work queue": "aiWork",
};

/** …and that pane's stand-in text (see the pane mocks above). */
const PANE_TEXT: Record<FileTab, string> = {
  issue: "Issue",
  files: "Files",
  changes: "Changes",
  history: "History",
  pr: "PR",
  aiWork: "AI work",
};
