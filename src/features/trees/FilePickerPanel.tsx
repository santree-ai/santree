/** The worktree's right panel: up to six panes behind an icon strip — the ticket
 *  the worktree exists for, the file browser, the git panel (what has changed, what
 *  is committed, and the commit box), the history of agent sessions that ran here,
 *  and, once the branch has a pull request, that PR and the AI work queue (the
 *  queue itself plus the AI's reading of the PR that fills it). Every one of them
 *  is *reference beside the work*, which is what separates them from the main
 *  area's tabs: those are places you type, this is what you consult while typing.
 *  The ticket leads because it is what the branch was started from.
 *
 *  Each pane only *picks*: clicking a file swaps the main area to its
 *  diff/contents (see FileViewer). Resizable (drag the left edge) and collapsible
 *  (drag past the threshold, the tab bar's toggle, or ⌘L — it hides entirely when
 *  collapsed, and the main tab bar grows the control that brings it back).
 *
 *  This file is only Trees' *wiring*: the chrome, the geometry and the keyboard
 *  model come from the shared {@link SidePanel}, and the content from
 *  {@link IssuePane}, {@link AllFilesList}, {@link GitPanel},
 *  {@link SessionHistory}, {@link WorktreePrPane} and {@link AiWorkPane}. All but
 *  the PR pane are hosted by the Reviews rail too — they take their worktree, and
 *  where a click lands, as props. What only Trees can answer is bound here: the
 *  main area a file opens in, the create-PR dialog, the tab a resumed session
 *  lands in, and the main-area tabs the ticket and PR panes expand into. */
import { type ReactNode, useCallback, useRef } from "react";

import type { ChangedFile } from "../../bindings";
import { IssuePane } from "../../components/IssuePane";
import {
  BranchIcon,
  ClockIcon,
  FilesIcon,
  GitHubLogo,
  LinearLogo,
  SparklesIcon,
} from "../../components/icons";
import { SidePanel, type SidePanelTab } from "../../components/SidePanel";
import {
  usePrReviewBrief,
  usePrSummary,
  useReviewWorkItems,
  useSetWorktreeTitle,
  useWorktreeStatus,
} from "../../lib/queries";
import { checkRollupMeta } from "../../theme/colors";
import { AiWorkPane, aiWorkDot } from "../reviews/AiWorkPane";
import { reviewBriefStale } from "../reviews/briefStale";
import { useStartAiReviewInWorktree, useStartWorkInWorktree } from "../reviews/useStartWork";
import { AllFilesList } from "./AllFilesList";
import { GitPanel } from "./GitPanel";
import { availableFileTabs, BASE_ID, type FileTab, useTrees } from "./model";
import { SessionHistory } from "./SessionHistory";
import { useResumeSessionInWorktree } from "./useResumeSession";
import { WorktreePrPane } from "./WorktreePrPane";

/** The Changes tab's dot: the worktree has something uncommitted. Exported
 *  because the Reviews rail hosts the same pane and must say it the same way —
 *  a second rule for the same dot is how two strips start disagreeing about one
 *  worktree. `undefined` is "not loaded yet", which is not a claim either way. */
export function changesDot(status: ChangedFile[] | undefined): string | null {
  return (status?.length ?? 0) > 0 ? "var(--accent)" : null;
}

/** Six 32px tabs (192px), the five 4px gaps between them (20px), the 28px collapse
 *  control and the strip's own 8px of padding each side come to 256px exactly;
 *  below that the strip overflows before the panel ever reaches its collapse
 *  threshold. Adding a pane means raising this. */
const MIN_W = 256;
/** Wide enough for the ticket pane to be readable — an issue description at 320px
 *  is a column of five-word lines. */
const MAX_W = 680;
const DEFAULT_W = 340;

const TABS: SidePanelTab<FileTab>[] = [
  { tab: "issue", label: "Issue", icon: <LinearLogo size={14} /> },
  { tab: "files", label: "Files", icon: <FilesIcon size={15} /> },
  { tab: "changes", label: "Changes", icon: <BranchIcon size={15} /> },
  { tab: "history", label: "Session history", icon: <ClockIcon size={15} /> },
  { tab: "pr", label: "Pull request", icon: <GitHubLogo size={14} /> },
  // A generic spark, not a provider's mark: the queue is drained (and the review
  // written) by whichever agent the repo is configured for — Claude or Codex —
  // and a tab that claims one of them is wrong half the time. The same spark
  // rides on every control that puts something *in* the queue (see
  // {@link QueueAction}), so the buttons and their destination read as one thing.
  { tab: "aiWork", label: "AI work queue", icon: <SparklesIcon size={15} /> },
];

export function FilePickerPanel() {
  const {
    repo,
    active,
    activeId,
    activePr,
    fileTab,
    hasTicket,
    prsByWorktree,
    openPrDialog,
    suggestPr,
    selectFile,
    selectedFile,
    selectedFileScope,
    setFileTab,
    rightCollapsed,
    rightWidth,
    setRightWidth,
    toggleRightPanel,
    openPrView,
    openIssueView,
  } = useTrees();
  const { data: prSummary } = usePrSummary(activePr?.repo ?? null, activePr?.number ?? 0);
  const { data: workItems } = useReviewWorkItems(activePr?.repo ?? "", activePr?.number ?? 0);
  const openWork = (workItems ?? []).filter((item) => !item.done).length;
  // One row read, already cached by the pane itself — the dot and the brief's own
  // "new commits have landed" banner ask `reviewBriefStale` the same question, so
  // the strip can't claim a review is current while the pane says it isn't.
  const { data: brief } = usePrReviewBrief(activePr?.repo ?? "", activePr?.number ?? 0);
  const staleReview = reviewBriefStale(brief, prSummary?.headSha);
  // No `?? []` default on purpose: `undefined` means the status hasn't loaded,
  // which the git panel renders as a skeleton. Defaulting here would collapse
  // that into "no changes" and assert something we don't know yet.
  const { data: status } = useWorktreeStatus(repo, activeId);
  // Both launchers are built here rather than in the pane because the pane is
  // shared with Reviews, whose "Start work" has to create the worktree first.
  // This is the whole of Trees' half of that difference.
  const summary = prSummary ?? undefined;
  const startWork = useStartWorkInWorktree(summary, activeId, repo);
  const startReview = useStartAiReviewInWorktree(summary, activeId, repo);
  const resumeSession = useResumeSessionInWorktree();

  // Self-heal the stored title: when the live Linear title differs from what's
  // cached on the worktree (imported/renamed tickets), persist it so the sidebar
  // card stays accurate. Once per worktree — the ref remembers which one it has
  // already written, so switching trees arms it again and a refetch doesn't.
  const { mutate: refreshTitle } = useSetWorktreeTitle(repo);
  const healed = useRef<string | null>(null);
  const onResolvedTitle = useCallback(
    (live: string) => {
      if (!active || healed.current === active.id || live === active.title) return;
      healed.current = active.id;
      refreshTitle({ id: active.id, title: live });
    },
    [active, refreshTitle],
  );

  // Which panes this worktree has — the base checkout and a worktree cut from a
  // plain branch have no ticket, and the PR panes need a pull request.
  // `availableFileTabs` is the single answer, shared with `resolveFileTab`, so the
  // strip can't hide a pane the model resolves to.
  const available = availableFileTabs({
    isBase: activeId === BASE_ID,
    hasPr: activePr !== null,
    hasTicket,
  });

  /** A tab's dot: see {@link SidePanel}'s strip comment for what each one means.
   *  Null is "nothing to say", which is most tabs most of the time. */
  function dotFor(tab: FileTab): string | null {
    if (tab === "changes") return changesDot(status);
    if (tab === "pr")
      return prSummary && prSummary.checks !== "None"
        ? checkRollupMeta[prSummary.checks].color
        : null;
    if (tab === "aiWork") return aiWorkDot(staleReview, openWork);
    return null;
  }

  const tabs = TABS.filter((t) => available.includes(t.tab)).map((t) => ({
    ...t,
    dot: dotFor(t.tab),
  }));

  const panes: Record<FileTab, ReactNode> = {
    // Both expand into a main-area tab. The controls are drawn only where the
    // panes are, and the panes only exist with a ticket / a PR to show — so the
    // tabs can only ever be opened for something that is there.
    issue: active && (
      <IssuePane
        key={active.id}
        repo={repo}
        ticketId={active.id}
        fallbackTitle={active.title}
        onResolvedTitle={onResolvedTitle}
        onExpand={openIssueView}
      />
    ),
    // Keyed by PR so switching worktrees resets the sections' open state rather
    // than carrying one PR's expansions onto another's.
    pr: activePr && (
      <WorktreePrPane
        key={`${activePr.repo}#${activePr.number}`}
        pr={activePr}
        onExpand={openPrView}
      />
    ),
    aiWork: (
      <AiWorkPane
        key={`${activePr?.repo}#${activePr?.number}`}
        pr={activePr}
        santreeRepo={repo}
        // Trees has no AI-review tab of its own to be "on": the session runs as an
        // ordinary agent tab in the main area, like any other.
        activeReviewAgent={null}
        // A file opens in the **main** area and the panel stays put — see
        // {@link AiWorkPane}.
        onJump={(path) => selectFile(path, "branch")}
        startWork={startWork}
        onStartReview={startReview.start}
        startingReview={startReview.starting}
        // The launcher takes a per-launch agent override, so the picker beside
        // the run button is live here (it is not in Reviews — see the prop).
        canPickAgent
      />
    ),
    files: (
      <AllFilesList
        repo={repo}
        worktreeId={activeId}
        selectedPath={selectedFile}
        onOpen={selectFile}
      />
    ),
    changes: (
      <GitPanel
        repo={repo}
        worktreeId={activeId}
        worktree={active}
        status={status}
        selectedPath={selectedFile}
        selectedScope={selectedFileScope}
        onOpen={selectFile}
        createPr={{
          hasPr: (prsByWorktree.get(activeId) ?? []).length > 0,
          open: () => openPrDialog(activeId),
          suggestAfterPush: () => suggestPr(activeId),
        }}
      />
    ),
    history: (
      <SessionHistory
        repo={repo}
        worktreeId={activeId}
        branch={active?.branch ?? null}
        onResume={resumeSession.resume}
        resumingId={resumeSession.resumingId}
      />
    ),
  };

  return (
    <SidePanel
      tabs={tabs}
      active={fileTab}
      onSelect={setFileTab}
      collapsed={rightCollapsed}
      onToggle={toggleRightPanel}
      width={rightWidth}
      onWidth={setRightWidth}
      cssVar="--tree-right"
      min={MIN_W}
      max={MAX_W}
      resetTo={DEFAULT_W}
      ariaLabel="Worktree panel"
    >
      {/* A total map rather than a ternary cascade: every pane is named by its own
          tab, so a new `FileTab` is a compile error here instead of silently
          landing in whichever arm happened to be last. Only `panes[fileTab]`
          mounts — the others are element descriptions nothing renders. */}
      {panes[fileTab]}
    </SidePanel>
  );
}
