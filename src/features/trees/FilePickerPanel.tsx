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
 *  collapsed, and the main tab bar grows the control that brings it back). This
 *  is the thin shell: {@link WorktreeIssuePane}, {@link AllFilesList},
 *  {@link GitPanel}, {@link SessionHistory}, {@link WorktreePrPane} and
 *  {@link WorktreeAiWorkPane} own their content. */
import { type CSSProperties, type ReactNode, useRef } from "react";

import {
  BranchIcon,
  ClockIcon,
  FilesIcon,
  GitHubLogo,
  LinearLogo,
  PanelIcon,
  SparklesIcon,
} from "../../components/icons";
import { EdgeResizeHandle, onTabStripKeyDown } from "../../components/primitives";
import {
  usePrReviewBrief,
  usePrSummary,
  useReviewWorkItems,
  useWorktreeStatus,
} from "../../lib/queries";
import { useEdgeResize } from "../../lib/useEdgeResize";
import { checkRollupMeta, palette } from "../../theme/colors";
import { reviewBriefStale } from "../reviews/briefStale";
import { AllFilesList } from "./AllFilesList";
import { GitPanel } from "./GitPanel";
import { availableFileTabs, BASE_ID, type FileTab, useTrees } from "./model";
import { SessionHistory } from "./SessionHistory";
import { WorktreeAiWorkPane } from "./WorktreeAiWorkPane";
import { WorktreeIssuePane } from "./WorktreeIssuePane";
import { WorktreePrPane } from "./WorktreePrPane";

/** Six 32px tabs (192px), the five 4px gaps between them (20px), the 28px collapse
 *  control and the strip's own 8px of padding each side come to 256px exactly;
 *  below that the strip overflows before the panel ever reaches its collapse
 *  threshold. Adding a pane means raising this. */
const MIN_W = 256;
/** Wide enough for the ticket pane to be readable — an issue description at 320px
 *  is a column of five-word lines. */
const MAX_W = 680;
const DEFAULT_W = 340;

/** The AI work tab's dot. Two signals, one dot, and **status beats count**: a
 *  stale brief is a claim about whether what you are reading is still true, and
 *  "there are 3 open items" doesn't cancel it. Pure so it can be tested without
 *  rendering the strip — see model.test.ts. */
export function aiWorkDot(staleReview: boolean, openWork: number): string | null {
  if (staleReview) return palette.amber;
  return openWork > 0 ? "var(--accent)" : null;
}

const TABS: { tab: FileTab; label: string; icon: ReactNode }[] = [
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

/**
 * The right panel's show/hide control.
 *
 * One component with one geometry, because it changes *host*: the panel's own
 * header owns it while the panel is open, and the main tab bar's trailing edge
 * takes it over once the panel is gone. Both hosts end their content 8px from
 * the same right edge, so the button stays put across the toggle instead of
 * stepping sideways — a control that moves when you press it reads as two
 * different controls.
 */
export function PanelToggle() {
  const { rightCollapsed, toggleRightPanel } = useTrees();
  return (
    <button
      type="button"
      onClick={toggleRightPanel}
      aria-label={rightCollapsed ? "Show panel" : "Hide panel"}
      title={rightCollapsed ? "Show panel (⌘L)" : "Hide panel (⌘L)"}
      className="flex h-[22px] w-7 flex-none cursor-pointer items-center justify-center self-center rounded text-muted-4 transition-colors hover:bg-hover hover:text-fg-2"
    >
      <PanelIcon size={14} />
    </button>
  );
}

export function FilePickerPanel() {
  const resizeTarget = useRef<HTMLDivElement>(null);
  const {
    repo,
    active,
    activeId,
    activePr,
    fileTab,
    hasTicket,
    setFileTab,
    rightCollapsed,
    rightWidth,
    setRightWidth,
    toggleRightPanel,
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

  // Which panes this worktree has — the base checkout and a worktree cut from a
  // plain branch have no ticket, and the PR panes need a pull request.
  // `availableFileTabs` is the single answer, shared with `resolveFileTab`, so the
  // strip can't hide a pane the model resolves to.
  const available = availableFileTabs({
    isBase: activeId === BASE_ID,
    hasPr: activePr !== null,
    hasTicket,
  });
  const tabs = TABS.filter((t) => available.includes(t.tab));

  // A width persisted before the strip grew a pane sits below the new minimum,
  // and nothing re-clamps a stored number — the drag clamps, but only once the
  // user drags. Clamp on the way out so the strip can't open overflowing, and
  // leave what's stored alone in case the minimum ever comes back down.
  const width = Math.min(MAX_W, Math.max(MIN_W, rightWidth));

  /** A tab's dot: see the strip's comment below for what each one means. Null is
   *  "nothing to say", which is most tabs most of the time. */
  function dotFor(tab: FileTab): string | null {
    if (tab === "changes") return (status?.length ?? 0) > 0 ? "var(--accent)" : null;
    if (tab === "pr")
      return prSummary && prSummary.checks !== "None"
        ? checkRollupMeta[prSummary.checks].color
        : null;
    if (tab === "aiWork") return aiWorkDot(staleReview, openWork);
    return null;
  }

  const resize = useEdgeResize({
    cssVar: "--tree-right",
    target: resizeTarget,
    width,
    min: MIN_W,
    max: MAX_W,
    edge: "left",
    onCommit: setRightWidth,
    collapse: { at: 190, resetTo: DEFAULT_W, onCollapse: toggleRightPanel },
  });

  // Fully hidden when collapsed — the control that brings it back moves to the
  // main tab bar's trailing edge, where the panel's own toggle was, so there is
  // no need for a leftover strip here.
  if (rightCollapsed) return null;

  const panes: Record<FileTab, ReactNode> = {
    issue: active && <WorktreeIssuePane key={active.id} repo={repo} worktree={active} />,
    // Keyed by PR so switching worktrees resets the sections' open state rather
    // than carrying one PR's expansions onto another's.
    pr: activePr && <WorktreePrPane key={`${activePr.repo}#${activePr.number}`} pr={activePr} />,
    aiWork: <WorktreeAiWorkPane key={`${activePr?.repo}#${activePr?.number}`} pr={activePr} />,
    files: <AllFilesList />,
    changes: <GitPanel status={status} />,
    history: <SessionHistory />,
  };

  return (
    <div
      ref={resizeTarget}
      className="relative flex flex-none flex-col border-l border-line bg-deep"
      style={
        {
          "--tree-right": `${width}px`,
          width: `var(--tree-right, ${DEFAULT_W}px)`,
        } as CSSProperties
      }
    >
      <EdgeResizeHandle edge="left" {...resize} />
      {/* Icons only: the strip has to fit a narrow panel and the panes are
          recognisable by glyph (the Linear mark, the GitHub mark, a generic AI
          spark, a checklist, files, branch, clock); the name rides in the tooltip
          and the accessible label. The selected pane is marked by an underline at the strip's edge,
          not a filled tile, so the strip reads as tabs rather than as a row of
          buttons; the panel's own collapse control sits at the far end, where it
          can't be mistaken for another pane.

          A tab's dot means "there is something here": pending changes and open
          queue items take the accent, because they are counts. A *status* carries
          its own colour instead — the PR's is the CI rollup, and the AI work
          queue's is amber when its brief was written against a head the PR has
          since moved past (advice about code that has changed reads as current,
          which is worse than none). See {@link aiWorkDot} for why that beats the
          count. */}
      <div
        data-tauri-drag-region
        className="flex h-9 flex-none items-stretch justify-between border-b border-line px-2"
      >
        <div
          role="tablist"
          aria-label="Worktree panel"
          onKeyDown={onTabStripKeyDown}
          className="flex items-stretch gap-1"
        >
          {tabs.map(({ tab, label, icon }) => {
            const on = fileTab === tab;
            const dot = dotFor(tab);
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={on}
                aria-label={label}
                title={label}
                tabIndex={on ? 0 : -1}
                onClick={() => setFileTab(tab)}
                className={`relative flex w-8 cursor-pointer items-center justify-center transition-colors ${
                  on ? "text-fg" : "text-muted-4 hover:text-fg-2"
                }`}
              >
                {icon}
                {dot && (
                  <span
                    aria-hidden
                    className="absolute top-2 right-1 h-1.5 w-1.5 rounded-full"
                    style={{ background: dot }}
                  />
                )}
                {on && (
                  <span
                    aria-hidden
                    className="absolute bottom-0 left-1/2 h-0.5 w-4 -translate-x-1/2 rounded-full bg-fg"
                  />
                )}
              </button>
            );
          })}
        </div>
        <PanelToggle />
      </div>

      {/* A total map rather than a ternary cascade: every pane is named by its own
          tab, so a new `FileTab` is a compile error here instead of silently
          landing in whichever arm happened to be last. Only `panes[fileTab]`
          mounts — the others are element descriptions nothing renders. */}
      {panes[fileTab]}
    </div>
  );
}
