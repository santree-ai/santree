/**
 * The Reviews tab's full-height right rail — what you consult *while* reading a
 * pull request, in five panes: the Linear ticket it belongs to, the branch as it
 * sits on disk (its files, its git state, the agent sessions that have run on
 * it), and the AI work queue (the queue itself plus the AI's reading of the PR
 * that fills it).
 *
 * It is the same {@link SidePanel} the worktree panel is built on, deliberately:
 * both are reference beside the work, and a reviewer moving between the two views
 * should not have to learn a second panel. The three middle panes are literally
 * Trees' own — {@link AllFilesList}, {@link GitPanel}, {@link SessionHistory},
 * taking their worktree as props — because "what is on this branch" is the same
 * question wherever it is asked. What they read is the PR's own worktree when it
 * has one and the AI review's detached checkout when it doesn't; see
 * {@link usePrCheckout} for that rule, {@link PrCheckoutBar} for how the second
 * says which one it is, and {@link NoPrCheckout} for the PR that has neither.
 *
 * **There is no PR pane here, and that is the whole split.** In Trees the rail
 * carries the pull request because the main area is the worktree; in Reviews the
 * main area *is* the pull request — its description, conversation, checks, files
 * and AI review — so a PR pane in the rail would be the same thing twice, in a
 * narrower column. What stays in the rail is what the PR is *about* and what to
 * *do* about it.
 *
 * The rail spans the whole detail area — header, tabs, and body — so whichever of
 * these you're consulting stays *beside* the diff instead of replacing it. That's
 * why the ticket lives here rather than in the main tab bar: a review is the code
 * read against its ticket, and a tab that hides the code to show the ticket makes
 * you flip back and forth to do it.
 *
 * Collapsible + resizable (drag its left edge or ⌘L).
 */
import type { ReactNode } from "react";

import type { AgentKind, ReviewPr } from "../../bindings";
import { IssuePane } from "../../components/IssuePane";
import { BranchIcon, ClockIcon, FilesIcon, LinearLogo, SparklesIcon } from "../../components/icons";
import { SidePanel, type SidePanelTab } from "../../components/SidePanel";
import { usePrReviewBrief, useReviewWorkItems, useWorktreeStatus } from "../../lib/queries";
import { AllFilesList } from "../trees/AllFilesList";
import { changesDot } from "../trees/FilePickerPanel";
import { GitPanel } from "../trees/GitPanel";
import { SessionHistory } from "../trees/SessionHistory";
import type { SessionResumer } from "../trees/useResumeSession";
import { AiWorkPane, aiWorkDot } from "./AiWorkPane";
import { reviewBriefStale } from "./briefStale";
import { useReviewsModel } from "./model";
import { NoPrCheckout, PrCheckoutBar, usePrCheckout } from "./PrCheckout";
import { ticketIdFor } from "./ticket";
import { useStartWorkFromReviews } from "./useStartWork";

export type RailTab = "issue" | "files" | "changes" | "history" | "aiWork";

const DEFAULT_W = 400;
const MIN_W = 300;
const MAX_W = 720;

const TABS: SidePanelTab<RailTab>[] = [
  { tab: "issue", label: "Issue", icon: <LinearLogo size={14} /> },
  { tab: "files", label: "Files", icon: <FilesIcon size={15} /> },
  { tab: "changes", label: "Changes", icon: <BranchIcon size={15} /> },
  { tab: "history", label: "Session history", icon: <ClockIcon size={15} /> },
  { tab: "aiWork", label: "AI work queue", icon: <SparklesIcon size={15} /> },
];

/** The pane the rail lands on for a PR, before the reader picks one.
 *
 *  The ticket leads — a review is the code read against what it was asked to do —
 *  but a PR whose title and branch name no ticket has nothing to lead with, and
 *  landing on an empty state teaches nothing. Same rule `resolveFileTab` follows
 *  in Trees: never open on a pane that isn't there. The Issue tab itself stays on
 *  offer, because "this PR has no linked ticket" is worth being able to check. */
export function defaultRailTab(hasTicket: boolean): RailTab {
  return hasTicket ? "issue" : "aiWork";
}

export function ReviewSidePanel({
  pr,
  tab,
  onTabChange,
  activeReviewAgent,
  resumer,
  onOpenIssueView,
}: {
  pr: ReviewPr;
  tab: RailTab;
  onTabChange: (tab: RailTab) => void;
  activeReviewAgent: AgentKind | null;
  /** Opens a past conversation as a tab on the main strip. Supplied by the host
   *  that owns that strip; absent in a rail rendered without one. */
  resumer?: SessionResumer;
  /** Opens the ticket pane's ticket as a tab on the main strip, at reading
   *  width. Same provenance as `resumer`: the strip's owner supplies it. */
  onOpenIssueView?: () => void;
}) {
  const {
    infoCollapsed,
    toggleInfo,
    infoWidth,
    setInfoWidth,
    repo: santreeRepo,
    focusFile,
    openAiReview,
  } = useReviewsModel();
  const ticketId = ticketIdFor(pr);
  const { data: workItems } = useReviewWorkItems(pr.repo, pr.number);
  const openWork = (workItems ?? []).filter((item) => !item.done).length;
  // The same row the pane reads, so the strip can't claim a review is current
  // while the brief inside it says it isn't.
  const { data: brief } = usePrReviewBrief(pr.repo, pr.number);
  const staleReview = reviewBriefStale(brief, pr.headSha);
  const checkout = usePrCheckout(pr);
  // What the three branch panes read — the PR's worktree, or the review checkout.
  const source = checkout.source;
  // No `?? []` default: `undefined` is "not read yet" and the panes below render
  // it as a skeleton. It is also what a PR with no checkout gets, since the query
  // stays disabled without a worktree id.
  const { data: status } = useWorktreeStatus(source.repo, source.worktreeId);
  // From here the PR has no worktree yet, so starting work creates one and
  // navigates to it — the Trees host skips both (see useStartWork). The checkout
  // it cuts belongs to the PR's OWN project: the inbox spans the registry, so the
  // project the app is pointed at is routinely a different repo entirely. The
  // fallback only covers a PR no registered project owns, which has no worktree
  // to be created in anyway and fails closed in the backend.
  const startWork = useStartWorkFromReviews(pr, pr.project ?? santreeRepo, checkout);

  const tabs = TABS.map((t) => ({
    ...t,
    dot:
      t.tab === "aiWork"
        ? aiWorkDot(staleReview, openWork)
        : t.tab === "changes"
          ? changesDot(status)
          : null,
  }));

  // Every tab is on offer whether or not the PR has been checked out, so the
  // three that need one say so instead of vanishing.
  const checkedOut = source.worktree !== null;

  /** A branch pane and the line that says which checkout it is reading. Written
   *  once: the notice is about the source, not about any one pane, and three
   *  copies would be three chances for one of them to stop saying it. */
  const onCheckout = (pane: ReactNode) => (
    <div className="flex min-h-0 flex-1 flex-col">
      <PrCheckoutBar pr={pr} source={source} />
      <div className="flex min-h-0 flex-1 flex-col">{pane}</div>
    </div>
  );

  const panes: Record<RailTab, ReactNode> = {
    issue: <IssuePane repo={santreeRepo} ticketId={ticketId} onExpand={onOpenIssueView} />,
    // No `onOpen` on either browser, in either list: this view's main area is the
    // pull request (conversation, commits, checks, files changed, the agent), and
    // it has no general file viewer to land a click in. Jumping to the PR's diff
    // instead would only work for the files the PR touches, and these panes list
    // the whole checkout — so most clicks would do nothing at all. Read-only rows
    // say that up front; a dead button says it once per click.
    files: checkedOut ? (
      onCheckout(
        <AllFilesList repo={source.repo} worktreeId={source.worktreeId} selectedPath={null} />,
      )
    ) : (
      <NoPrCheckout what="Browsing the branch's files" repo={pr.repo} checkout={checkout} />
    ),
    // Staging, discarding and committing stay live — they act on the checkout,
    // not on this view. Rare on someone else's PR, but not impossible, and a
    // pane that shows the change without offering to keep it is half a pane.
    changes: checkedOut ? (
      onCheckout(
        <GitPanel
          repo={source.repo}
          worktreeId={source.worktreeId}
          worktree={source.worktree}
          status={status}
          selectedPath={null}
          selectedScope="working"
        />,
      )
    ) : (
      <NoPrCheckout what="Reading the branch's git state" repo={pr.repo} checkout={checkout} />
    ),
    // Resumable here now. It wasn't when this rail was written — a resume opens a
    // tab and Reviews had no strip to put one in. It has one, and that round trip
    // is what makes closing an AI review safe: the ✕ forgets the session so the
    // tab stays gone, and this is the way back to the conversation.
    history: checkedOut ? (
      onCheckout(
        <SessionHistory
          repo={source.repo}
          worktreeId={source.worktreeId}
          branch={source.isReview ? null : (source.worktree?.branch ?? null)}
          onResume={resumer?.resume}
          resumingId={resumer?.resumingId ?? null}
        />,
      )
    ) : (
      <NoPrCheckout
        what="Listing the sessions that ran on this branch"
        repo={pr.repo}
        checkout={checkout}
      />
    ),
    aiWork: (
      <AiWorkPane
        pr={pr}
        santreeRepo={santreeRepo}
        activeReviewAgent={activeReviewAgent}
        // A jump scrolls this view's own diff column — the Files-changed tab
        // beside the rail, which `PrPane` brings forward for the click.
        onJump={focusFile}
        startWork={startWork}
        onStartReview={openAiReview}
      />
    ),
  };

  return (
    <SidePanel
      tabs={tabs}
      active={tab}
      onSelect={onTabChange}
      collapsed={infoCollapsed}
      onToggle={toggleInfo}
      width={infoWidth}
      onWidth={setInfoWidth}
      cssVar="--rev-right"
      min={MIN_W}
      max={MAX_W}
      resetTo={DEFAULT_W}
      ariaLabel="Pull request panel"
    >
      {/* A total map rather than a ternary cascade, for the reason Trees gives:
          a new `RailTab` is a compile error here instead of quietly landing in
          whichever arm happened to be last. */}
      {panes[tab]}
    </SidePanel>
  );
}
