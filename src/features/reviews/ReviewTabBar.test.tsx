/**
 * The Reviews strip's own rules: the pull request is a tab like any other except
 * that it can't be closed, the checkout's tabs sit beside it, and the "+" honours
 * the asymmetry between the two kinds of session it can open — an AI review
 * brings its own checkout, a terminal or an agent needs the PR's.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewDraft, ReviewPr, TabKind, WorktreeTab } from "../../bindings";
import { worktree as fxWorktree } from "../../test/fixtures";
import type { TerminalTabs } from "../terminal/orchestrator";
import { TerminalsProvider, useTerminals } from "../terminal/TerminalsContext";
import { WorktreeGateProvider } from "./WorktreeGate";

vi.mock("./model", () => ({
  useReviewsModel: () => ({ infoCollapsed: false, toggleInfo: vi.fn() }),
}));
vi.mock("../../lib/queries", () => ({
  useReviewDrafts: () => ({ data: drafts }),
  useAgentAuth: () => ({ data: { connected: true } }),
  useCodexAccount: () => ({ data: { connected: true } }),
  useCodexHealth: () => ({ data: { available: true } }),
}));

import { ReviewTabBar } from "./ReviewTabBar";
import type { ReviewMainTab, ReviewTabs } from "./useReviewTabs";

const pr = { repo: "acme/app", number: 42 } as ReviewPr;
const WORKTREE_ID = "review-4-acme-3-app-42";
let drafts: ReviewDraft[] = [];

const row = (id: string, kind: TabKind, title: string): WorktreeTab => ({
  id,
  worktreeId: WORKTREE_ID,
  kind,
  agentKind: kind === "terminal" ? null : "Codex",
  title,
  pr: null,
});

/** The model the bar draws, dialled per test. */
function tabsModel(over: Partial<ReviewTabs> = {}): ReviewTabs {
  return {
    active: "pr" as ReviewMainTab,
    select: vi.fn(),
    checkout: {
      repo: "acme/app",
      worktree: null,
      worktreeId: "",
      source: { worktree: null, worktreeId: "", repo: "acme/app", isReview: false },
      openAsTree: vi.fn(),
      opening: false,
      canOpen: true,
    },
    rows: [],
    addTab: vi.fn(),
    closeTab: vi.fn(),
    renameTab: vi.fn(),
    providers: [],
    mounted: [],
    openReview: vi.fn(),
    closeReview: vi.fn(),
    issueViewOpen: false,
    openIssueView: vi.fn(),
    closeIssueView: vi.fn(),
    ...over,
  };
}

/** A checkout, and the rows that can only exist once there is one. */
function checkedOut(over: Partial<ReviewTabs> = {}): ReviewTabs {
  const base = tabsModel(over);
  return {
    ...base,
    checkout: {
      ...base.checkout,
      worktree: fxWorktree(WORKTREE_ID, { branch: "feature" }),
      worktreeId: WORKTREE_ID,
      source: {
        worktree: fxWorktree(WORKTREE_ID, { branch: "feature" }),
        worktreeId: WORKTREE_ID,
        repo: base.checkout.repo,
        isReview: false,
      },
    },
  };
}

/** Leaks the terminal registry so a test can spawn the PTY sessions the bar
 *  watches (the real orchestrator — sessions are plain state). */
let registry: TerminalTabs;
function Probe() {
  registry = useTerminals();
  return null;
}

function mount(tabs: ReviewTabs) {
  return render(
    <TerminalsProvider>
      {/* The real host mounts this around the whole view: without a checkout, an
          AI review has to cut one, and that is asked for rather than assumed. */}
      <WorktreeGateProvider>
        <ReviewTabBar pr={pr} tabs={tabs} />
      </WorktreeGateProvider>
      <Probe />
    </TerminalsProvider>,
  );
}

const openMenu = () => fireEvent.click(screen.getByRole("button", { name: /New tab/ }));
const tabNames = () => screen.getAllByRole("tab").map((t) => t.textContent);

beforeEach(() => {
  drafts = [];
});

describe("ReviewTabBar", () => {
  /** It is not a `worktree_tabs` row — it is what the view *is*, so there is
   *  nothing for a ✕ to close it to. */
  it("leads with the pull request, and offers no way to close it", () => {
    mount(tabsModel());

    expect(tabNames()).toEqual(["Pull Request"]);
    expect(screen.queryByRole("button", { name: "Close Pull Request" })).not.toBeInTheDocument();
  });

  it("puts the checkout's own tabs after it, each closable", () => {
    mount(checkedOut({ rows: [row("t1", "agent", "Codex"), row("t2", "terminal", "Terminal 2")] }));

    expect(tabNames()).toEqual(["Pull Request", "Codex", "Terminal 2"]);
    expect(screen.getByRole("button", { name: "Close Codex" })).toBeVisible();
  });

  // The same rule Trees follows: the row goes and the process goes with it, or a
  // shell keeps running under a name nothing shows any more.
  /** The ticket is view state rather than a row, but on the strip it is a tab
   *  like the rest: named, marked, and closable. */
  it("lists the expanded ticket as a closable Linear tab", () => {
    const tabs = tabsModel({ issueViewOpen: true });
    mount(tabs);

    expect(screen.getByRole("tab", { name: "Linear" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close Linear" }));
    expect(tabs.closeIssueView).toHaveBeenCalledTimes(1);
  });

  it("tears down a checkout tab's PTY session when the tab is closed", () => {
    const tabs = checkedOut({ rows: [row("t1", "terminal", "Terminal 2")] });
    mount(tabs);
    act(() => {
      registry.open({
        title: "t1",
        source: "issue",
        refId: `tree:${WORKTREE_ID}:tab:t1`,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Close Terminal 2" }));

    expect(registry.tabs).toHaveLength(0);
    expect(tabs.closeTab).toHaveBeenCalledWith("t1");
  });

  it("carries each provider's own draft count beside its review tab", () => {
    drafts = [
      { id: "d1", agentKind: "Codex" },
      { id: "d2", agentKind: "Claude" },
      { id: "d3", agentKind: "Claude" },
    ] as ReviewDraft[];
    mount(tabsModel({ providers: ["Codex", "Claude"] }));

    // Ordering is asserted where no counts are in play; here the point is that
    // each provider's badge is its own. The count rides *inside* the tab, after
    // the label — the trailing slot is the close ✕ on every closable tab, and a
    // review tab is one of those.
    expect(screen.getByRole("tab", { name: /Codex review/ })).toHaveTextContent("1");
    expect(screen.getByRole("tab", { name: /Claude Code review/ })).toHaveTextContent("2");
  });

  /** An AI review is an agent with a review prompt, so its tab ends the way every
   *  other agent tab does. It used to be the one tab on the strip with no ✕ —
   *  which left a finished review parked there with nothing running in it. */
  it("closes a review tab like any other agent tab", () => {
    const tabs = tabsModel({ providers: ["Codex", "Claude"] });
    mount(tabs);

    fireEvent.click(screen.getByRole("button", { name: "Close Codex review" }));
    expect(tabs.closeReview).toHaveBeenCalledWith("Codex");
    // Its neighbour is untouched: one surface holds one conversation per
    // provider, and closing one must not end the other's.
    expect(tabs.closeReview).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Close Claude Code review" })).toBeTruthy();
  });

  describe("the new-tab menu without a checkout", () => {
    /** The review brings its own checkout — which is exactly why it asks first:
     *  a working tree on disk is a consequence, and it used to appear without a
     *  word. The setup script is the dialog's one option, off unless asked for. */
    it("asks before the AI review cuts the checkout it needs", async () => {
      const tabs = tabsModel();
      mount(tabs);
      openMenu();

      fireEvent.click(screen.getByRole("button", { name: "Codex review" }));
      expect(tabs.openReview).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toHaveTextContent(/Reviewing with Codex needs/);

      fireEvent.click(screen.getByRole("button", { name: "Create worktree" }));
      await waitFor(() => expect(tabs.openReview).toHaveBeenCalledWith("Codex", false));
    });

    it("starts nothing when the worktree is declined", async () => {
      const tabs = tabsModel();
      mount(tabs);
      openMenu();

      fireEvent.click(screen.getByRole("button", { name: "Codex review" }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(tabs.openReview).not.toHaveBeenCalled();
    });

    it("offers no terminal, since there would be nowhere to run it", () => {
      mount(tabsModel());
      openMenu();

      expect(screen.queryByRole("button", { name: /Terminal/ })).not.toBeInTheDocument();
    });

    it("offers to cut the checkout instead — the header's own flow", () => {
      const tabs = tabsModel();
      mount(tabs);
      openMenu();

      fireEvent.click(screen.getByRole("button", { name: /Open as tree/ }));
      expect(tabs.checkout.openAsTree).toHaveBeenCalled();
      expect(tabs.addTab).not.toHaveBeenCalled();
    });

    /** A PR whose repository isn't a registered project has nowhere to cut one,
     *  and no waiting will change that. */
    it("disables that when the PR's repository isn't a local project", () => {
      const tabs = tabsModel();
      mount({ ...tabs, checkout: { ...tabs.checkout, canOpen: false } });
      openMenu();

      expect(screen.getByRole("button", { name: /Open as tree/ })).toBeDisabled();
    });
  });

  describe("the new-tab menu with a checkout", () => {
    it("opens terminals and agents in it", () => {
      const tabs = checkedOut();
      mount(tabs);
      openMenu();

      fireEvent.click(screen.getByRole("button", { name: /Terminal/ }));
      expect(tabs.addTab).toHaveBeenCalledWith("terminal");
    });

    it("keeps the AI review a separate choice from an agent working in the tree", () => {
      const tabs = checkedOut();
      mount(tabs);
      openMenu();

      // Two Codex rows: the review, and an agent in the tree. Same provider,
      // different jobs — and named apart, since the headings that separate them
      // are not read out.
      expect(screen.getAllByRole("button", { name: /Codex/ })).toHaveLength(2);

      fireEvent.click(screen.getByRole("button", { name: "Codex in the checkout" }));
      expect(tabs.addTab).toHaveBeenCalledWith("agent", "Codex");
      expect(tabs.openReview).not.toHaveBeenCalled();
    });
  });
});
