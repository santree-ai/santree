/**
 * Right pane of the Reviews tab: **the pull request as one tab among the others**.
 *
 * The main area is the same window manager every other view has — a strip of real
 * tabs ({@link ReviewTabBar}) over whatever one of them is showing. The first is
 * the pull request itself — {@link PrPage}, the same page Trees opens a worktree's
 * own PR into — hosted here with what this view decides for it: which section is
 * showing, the rail's jump into the diff, and whether the header offers to check
 * the PR out (not for your own).
 *
 * Beside that tab are the PR checkout's own tabs, the ticket the PR is for (the
 * "Linear" tab the rail's pane expands into) and the AI review sessions — see
 * {@link useReviewTabs} for why one of those needs a worktree and the others
 * don't.
 *
 * The split against the {@link ReviewSidePanel} rail is by *what you do with it*:
 * the main tabs are where you work — the things that need width and that you act
 * on — and the rail is what you consult while reading, the ticket and the AI's
 * work queue. Keeping the ticket beside the diff instead of replacing it is the
 * whole point: reading a PR against its ticket used to mean flipping away from the
 * code.
 *
 */
import { useCallback, useEffect, useState } from "react";

import type { AgentKind, ReviewPr } from "../../bindings";
import { IssuePage } from "../../components/IssuePage";
import { AgentIcon, PrIcon } from "../../components/icons";
import { Button, EmptyState } from "../../components/primitives";
import { REVIEW_AGENT_KEY, useResolvedSetting } from "../../lib/queries";
import { useAgentRuns } from "../../state/AgentRuns";
import { agentProvider } from "../terminal/agentProvider";
import { AgentTabPane } from "../trees/AgentTabPane";
import { WorktreeTerminal } from "../trees/WorktreeTerminal";
import { AiReviewSessionPane } from "./AiReviewSessionPane";
import { MergeQueuePane } from "./MergeQueuePane";
import { useReviewsModel } from "./model";
import { PrPage, type PrTab } from "./PrPage";
import { defaultRailTab, type RailTab, ReviewSidePanel } from "./ReviewSidePanel";
import { ReviewTabBar } from "./ReviewTabBar";
import { ticketIdFor } from "./ticket";
import { useResumeReviewSession } from "./useResumeReviewSession";
import {
  aiTabAgent,
  checkoutTab,
  type ReviewMainTab,
  type ReviewTabs,
  useReviewTabs,
} from "./useReviewTabs";

export function ReviewDetail() {
  const { active, showMergeQueue } = useReviewsModel();

  if (showMergeQueue) return <MergeQueuePane />;

  // The sidebar *is* the inbox. This used to be a landing page — a "Review
  // inbox" hero with a needs-review count, a merge-queue button and a "pick up
  // next" grid — built when the view had a rail of its own to land in. Every one
  // of those is now a row in the sidebar's Reviews section, one click from
  // anywhere, and the page was reachable only by arriving at /reviews with no PR
  // in the url: a second inbox nothing navigated to.
  if (!active) return <NothingPicked />;
  // Keyed remount so per-PR query state, the active tabs, and scroll reset on switch.
  return <Detail key={active.id} pr={active} />;
}

/** What the view shows before a pull request is picked. Deliberately small: the
 *  sidebar next to it is the list, so the only thing missing here is a choice. */
function NothingPicked() {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-center bg-app">
      <EmptyState
        icon={<PrIcon size={16} className="text-muted-4" />}
        title="No pull request open"
        subtitle="Pick one from the Reviews section in the sidebar."
      />
    </div>
  );
}

function Detail({ pr }: { pr: ReviewPr }) {
  const { repo, infoCollapsed, toggleInfo } = useReviewsModel();
  // Keyed by PR id one level up, so this resolves once per pull request rather
  // than carrying the last one's landing pane onto a PR that has no ticket.
  const [panelTab, setPanelTab] = useState<RailTab>(() => defaultRailTab(!!ticketIdFor(pr)));
  const tabs = useReviewTabs(pr, repo);
  // The strip is what a resumed conversation opens into, so the host that owns
  // it is the one that can offer the action (see `useResumeReviewSession`).
  const resumer = useResumeReviewSession(tabs);
  /** Show a rail tab, un-collapsing the rail if it's hidden — the one entry point,
   *  so a caller can't leave the user staring at a tab they can't see. */
  const openPanel = (tab: RailTab) => {
    setPanelTab(tab);
    if (infoCollapsed) toggleInfo();
  };

  return (
    <div className="relative flex min-w-0 flex-1 overflow-hidden">
      <PrWorkspace pr={pr} tabs={tabs} />
      <ReviewSidePanel
        pr={pr}
        tab={panelTab}
        onTabChange={openPanel}
        activeReviewAgent={aiTabAgent(tabs.active)}
        resumer={resumer}
        onOpenIssueView={tabs.openIssueView}
      />
    </div>
  );
}

/** The main column: the tab strips of its split groups, and whichever tab each
 *  is showing. */
function PrWorkspace({ pr, tabs }: { pr: ReviewPr; tabs: ReviewTabs }) {
  const { repo, fileFocus, focusFile, aiReviewRequest, inbox } = useReviewsModel();
  const [prTab, setPrTab] = useState<PrTab>("conversation");
  // Your own PR is worked on in Trees, beside its worktree; the header's offer
  // to check it out from here is for other people's. Said by withholding the
  // checkout — see `ReviewHeader`.
  const isMine = inbox?.mine.some((candidate) => candidate.id === pr.id) ?? false;
  const ticketId = ticketIdFor(pr);
  const { data: configuredAgent } = useResolvedSetting(repo, REVIEW_AGENT_KEY);
  const defaultAgent = (configuredAgent as AgentKind | null) ?? "Claude";
  const { select, openReview } = tabs;
  const worktree = tabs.checkout.worktree;

  const showFiles = useCallback(() => {
    setPrTab("files");
    select("pr");
  }, [select]);

  // The rail is visible from every tab, so a jump from it has to bring the diff
  // back with it — otherwise clicking a reading-order entry from the AI's brief
  // looks like nothing happened.
  useEffect(() => {
    if (fileFocus) showFiles();
  }, [fileFocus, showFiles]);

  // "Start AI review" comes from the rail, which is beside this column rather than
  // in it. A nonce, so asking again on an already-open tab still brings it forward.
  useEffect(() => {
    if (!aiReviewRequest) return;
    openReview(defaultAgent);
  }, [aiReviewRequest, defaultAgent, openReview]);

  // A checkout tab hosts that worktree's session right here, so the off-screen
  // launcher has to skip it — two hosts for one session would both seed it.
  // Only the rows on screen (one per split group): with the pull request or
  // another tab showing there is no host here, and a queued launch should still
  // run.
  const { setVisibleWorktree } = useAgentRuns();
  const hostedTabs = tabs.split.visible
    .filter((t) => t.startsWith("tab:"))
    .map((t) => t.slice("tab:".length))
    .join(",");
  const hosted = hostedTabs ? tabs.checkout.worktreeId : "";
  useEffect(() => {
    setVisibleWorktree(hosted ? { repo, id: hosted, tabs: hostedTabs.split(",") } : null);
    return () => setVisibleWorktree(null);
  }, [hosted, hostedTabs, repo, setVisibleWorktree]);

  // A tab's content, wherever its split group puts it. Only the checkout's
  // terminals mount and unmount with their tab — the live PTY lives in the global
  // TerminalLayer, so unmounting the host just detaches the overlay. The pull
  // request, the ticket and the AI reviews stay mounted and hidden: the first two
  // so a long diff's (or thread's) scroll position and expansions survive a tab
  // switch, the last because unmounting it would throw away a running session
  // and its checkout.
  const renderTab = (tab: ReviewMainTab, visible: boolean) => {
    if (tab === "pr") {
      return (
        <PrPage
          pr={pr}
          tab={prTab}
          onTab={setPrTab}
          fileFocus={fileFocus}
          focusFile={focusFile}
          checkout={isMine ? undefined : tabs.checkout}
        />
      );
    }
    // The rail's ticket pane at reading width. It opens from that pane and only
    // with a ticket to open — the strip's half of the same gate is in
    // `useReviewTabs`.
    if (tab === "issueView") {
      return ticketId && tabs.issueViewOpen ? <IssuePage repo={repo} ticketId={ticketId} /> : null;
    }
    const agent = aiTabAgent(tab);
    if (agent) {
      if (tabs.mounted.includes(agent)) {
        return (
          <AiReviewSessionPane
            pr={pr}
            agentKind={agent}
            visible={visible}
            onShowDrafts={showFiles}
          />
        );
      }
      // A review from an earlier launch, restored on screen by the layout but
      // not running: starting it is the tab's own act (`select`), never a side
      // effect of a layout coming back.
      return visible ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <EmptyState
            className="flex-none"
            icon={<AgentIcon kind={agent} size={16} className="text-muted-4" />}
            title={`${agentProvider(agent).label} review`}
            subtitle="Not running. Open it to pick the review back up."
          />
          <Button size="sm" variant="tinted" onClick={() => tabs.select(tab)}>
            Open review
          </Button>
        </div>
      ) : null;
    }
    const row = tabs.rows.find((t) => checkoutTab(t.id) === tab);
    if (!row || !worktree || !visible) return null;
    return row.kind !== "terminal" ? (
      <AgentTabPane repo={tabs.checkout.repo} worktree={worktree} tab={row} tabs={tabs.rows} />
    ) : (
      <WorktreeTerminal
        id={`${worktree.id}:tab:${row.id}`}
        branch={row.title}
        cwd={worktree.path}
      />
    );
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-app">
      <ReviewTabBar pr={pr} tabs={tabs} renderTab={renderTab} />
    </div>
  );
}
