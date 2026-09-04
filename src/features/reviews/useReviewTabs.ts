/**
 * The Reviews main area's window management: which tab is showing, and what the
 * "+" may open.
 *
 * Reviews used to have a shape of its own — one pull request, an inner strip of
 * its sections, and the AI review sitting in that strip beside them. It is the
 * same window management as everywhere else now: the PR is a *tab*, its agents
 * and terminals are tabs beside it, and the strip that draws them is Trees' own
 * ({@link TabStrip}).
 *
 * Four kinds of tab, and the asymmetry between them is the whole model:
 *
 * - **`pr`** — the pull request itself. Not a `worktree_tabs` row and never
 *   closable; see {@link ReviewTabs.active}.
 * - **`tab:<id>`** — the PR checkout's own rows, exactly the ones Trees shows for
 *   that worktree. They need a checkout, because a terminal needs a directory.
 * - **`issueView`** — the PR's Linear ticket at reading width, opened from the
 *   rail's ticket pane. View state, not a row: it is the same ticket the rail
 *   already shows, so it needs no checkout and nothing survives a restart.
 * - **`ai:<agent>`** — an AI review session. It brings its own detached checkout
 *   (`useReviewWorkspace`), so it works on a PR with no worktree at all.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AgentKind, ReviewPr, TabKind, WorktreeTab } from "../../bindings";
import {
  useAddWorktreeTab,
  useCloseReviewSession,
  useRemoveWorktreeTab,
  useRenameWorktreeTab,
  useSessionProviders,
  useWorktreeTabs,
} from "../../lib/queries";
import { useOptionalAgentRuns } from "../../state/AgentRuns";
import { defaultTabTitle } from "../trees/model";
import { aiReviewTermKey } from "./AiReviewSessionPane";
import { type PrCheckout, usePrCheckout } from "./PrCheckout";
import { ticketIdFor } from "./ticket";
import { useWorktreeGate } from "./WorktreeGate";

/** The providers that can review a pull request, in menu order. */
export const REVIEW_AGENTS: AgentKind[] = ["Codex", "Claude"];

export type ReviewMainTab = "pr" | "issueView" | `ai:${AgentKind}` | `tab:${string}`;

/** The main-tab id for an AI review session, and for a checkout row. */
export const aiTab = (agent: AgentKind): ReviewMainTab => `ai:${agent}`;
export const checkoutTab = (id: string): ReviewMainTab => `tab:${id}`;

/** Which AI review a tab is, or `null` when it isn't one. The rail needs this to
 *  know whether the review it would start is already on screen. */
export function aiTabAgent(tab: ReviewMainTab): AgentKind | null {
  if (!tab.startsWith("ai:")) return null;
  const agent = tab.slice(3) as AgentKind;
  return REVIEW_AGENTS.includes(agent) ? agent : null;
}

export interface ReviewTabs {
  /** The tab on screen. Always resolvable: `pr` is not a row, so it cannot be
   *  closed and there is always something to fall back to. */
  active: ReviewMainTab;
  /** Show a tab. Picking an AI review tab is also what *opens* the session — a
   *  PR the AI has reviewed before gets its tab back from
   *  {@link ReviewTabs.providers} on the next launch, with nothing running in
   *  it. */
  select: (tab: ReviewMainTab) => void;
  /** The PR's local checkout — what a terminal or an ordinary agent tab needs,
   *  and what the "+" offers to create when there is none. */
  checkout: PrCheckout;
  /** The checkout's `worktree_tabs` rows, in strip order. */
  rows: WorktreeTab[];
  /** `tabId` is for a resume, which has already bound a session to it. */
  addTab: (kind: TabKind, agentKind?: AgentKind, tabId?: string) => void;
  closeTab: (id: string) => void;
  renameTab: (id: string, title: string) => void;
  /** AI review providers with a tab: one whose session this PR already has, or
   *  one opened in this session. */
  providers: AgentKind[];
  /** The AI review panes mounted here — they stay mounted once opened, so a tab
   *  switch never throws away a running session and its checkout. */
  mounted: AgentKind[];
  /** Close an AI review tab: end its process, forget the stored conversation.
   *  The transcript stays on disk, so Session history reopens the same review. */
  closeReview: (agent: AgentKind) => void;
  /** Open (and start) an AI review tab. `runSetup` is the worktree dialog's
   *  answer, applied once the session's checkout actually lands — the review
   *  creates it lazily, so the request has to outlive this call. */
  openReview: (agent: AgentKind, runSetup?: boolean) => void;
  /** Whether the PR's ticket is open as a tab. Already gated on the PR naming a
   *  ticket at all, however it was asked for. */
  issueViewOpen: boolean;
  /** Open the ticket as a tab and show it; close drops the tab (the selection
   *  falls back to the pull request). */
  openIssueView: () => void;
  closeIssueView: () => void;
}

export function useReviewTabs(pr: ReviewPr, santreeRepo: string): ReviewTabs {
  const checkout = usePrCheckout(pr);
  const { data: allTabs = [] } = useWorktreeTabs(checkout.repo);
  const { mutate: addTabRow } = useAddWorktreeTab(checkout.repo);
  const { mutate: renameTabRow } = useRenameWorktreeTab(checkout.repo);
  const { mutate: removeTabRow } = useRemoveWorktreeTab(checkout.repo);
  // A session this PR has reviewed with before survives a restart, so its tab is
  // back on the strip without anyone re-opening it.
  const { data: storedProviders = [] } = useSessionProviders(santreeRepo, aiReviewTermKey(pr));
  const { mutate: closeSession } = useCloseReviewSession(santreeRepo);
  const askForWorktree = useWorktreeGate();
  const [mounted, setMounted] = useState<AgentKind[]>([]);
  const [remembered, setRemembered] = useState<ReviewMainTab | null>(null);
  // Plain state, like the two above: the host keys this hook by PR, so a new
  // pull request starts with the ticket closed.
  const [issueViewAsked, setIssueViewAsked] = useState(false);
  // The rail only offers to open a ticket it has, so this is belt and braces —
  // but a tab for a PR whose title and branch name no ticket would open on an
  // empty page, and the strip must not list one.
  const issueViewOpen = issueViewAsked && ticketIdFor(pr) !== null;

  const worktreeId = checkout.worktreeId;
  const agentRuns = useOptionalAgentRuns();
  const pendingSetup = useRef(false);
  const rows = useMemo(
    () => (worktreeId ? allTabs.filter((t) => t.worktreeId === worktreeId) : []),
    [allTabs, worktreeId],
  );
  const providers = useMemo(
    () => REVIEW_AGENTS.filter((a) => storedProviders.includes(a) || mounted.includes(a)),
    [storedProviders, mounted],
  );

  // The remembered tab resolved against what is actually open — one rule for
  // "what am I looking at", so closing a tab needs no fallback of its own. The
  // pull request is always open, which is what makes that fallback total.
  const open: ReviewMainTab[] = [
    "pr",
    ...rows.map((t) => checkoutTab(t.id)),
    ...(issueViewOpen ? (["issueView"] as const) : []),
    ...providers.map(aiTab),
  ];
  const active = remembered && open.includes(remembered) ? remembered : "pr";

  const openIssueView = useCallback(() => {
    setIssueViewAsked(true);
    setRemembered("issueView");
  }, []);
  const closeIssueView = useCallback(() => {
    setIssueViewAsked(false);
    setRemembered((current) => (current === "issueView" ? null : current));
  }, []);

  const closeReview = useCallback(
    (agent: AgentKind) => {
      setMounted((current) => current.filter((a) => a !== agent));
      setRemembered((current) => (current === aiTab(agent) ? null : current));
      // The stored session goes too, or the strip puts the tab straight back on
      // the next launch from a conversation nothing is running. Tearing the PTY
      // down is the strip's half — `ReviewTabBar` does it for these tabs exactly
      // as `useTabSessions` does for the checkout's.
      closeSession({ prRepo: pr.repo, number: pr.number, agent });
    },
    [closeSession, pr.repo, pr.number],
  );

  const openReview = useCallback((agent: AgentKind, runSetup = false) => {
    if (runSetup) pendingSetup.current = true;
    setMounted((current) => (current.includes(agent) ? current : [...current, agent]));
    setRemembered(aiTab(agent));
  }, []);

  // The dialog said yes to the setup script, and the checkout it applies to only
  // exists once the review session has created it — so the request waits here for
  // the id to appear. Cleared before the call, and `startSetup` refuses a second
  // run for a worktree already setting up, so this can't stack.
  useEffect(() => {
    if (!pendingSetup.current || !worktreeId) return;
    pendingSetup.current = false;
    agentRuns?.runSetup(checkout.repo, worktreeId);
  }, [checkout.repo, worktreeId, agentRuns]);

  // Showing an AI review tab and starting its session are the same act: the tab
  // can exist (a stored session from a previous launch) with nothing mounted
  // behind it, and selecting it would otherwise land on a blank pane.
  //
  // Which means selecting one can *create the checkout* — the session cuts it on
  // the way in. Usually it is already there, from when the review first ran; but
  // the checkout can be removed since (see `PrCheckoutBar`), and then a click on
  // a leftover tab would put a worktree back on disk without a word. So the same
  // question is asked here as at the "+" menu, and only in the case that would
  // actually write something.
  const select = useCallback(
    (tab: ReviewMainTab) => {
      const agent = aiTabAgent(tab);
      if (!agent) {
        setRemembered(tab);
        return;
      }
      if (worktreeId) {
        openReview(agent);
        return;
      }
      void askForWorktree(`Reopening the ${agent} review`).then((choice) => {
        if (choice.ok) openReview(agent, choice.runSetup);
      });
    },
    [openReview, worktreeId, askForWorktree],
  );

  const addTab = useCallback(
    (kind: TabKind, agentKind?: AgentKind, tabId?: string) => {
      // Without a checkout there is no directory to run in — the menu offers to
      // cut one instead of opening a tab that would have nowhere to live.
      if (!worktreeId) return;
      // The id is minted here (not by the backend) so the optimistic cache patch
      // is the exact row the DB will hold and the tab can be focused immediately.
      // A resume passes its own: it has already bound the stored session to that
      // id, and a tab under a different one would resume nothing.
      const id = tabId ?? crypto.randomUUID();
      const resolvedAgent = kind === "terminal" ? null : (agentKind ?? "Codex");
      addTabRow({
        id,
        worktreeId,
        kind,
        agentKind: resolvedAgent,
        title: defaultTabTitle(kind, resolvedAgent, rows),
        pr: null,
      });
      setRemembered(checkoutTab(id));
    },
    [worktreeId, rows, addTabRow],
  );

  return {
    active,
    select,
    checkout,
    rows,
    addTab,
    closeTab: removeTabRow,
    renameTab: (id, title) => {
      const trimmed = title.trim();
      if (trimmed) renameTabRow({ id, title: trimmed });
    },
    providers,
    mounted,
    openReview,
    closeReview,
    issueViewOpen,
    openIssueView,
    closeIssueView,
  };
}
