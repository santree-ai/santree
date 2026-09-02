/** The Trees view: the selected worktree's workspace. The tab strip · whatever
 *  tab is showing (a terminal, an agent, a picked file's diff/contents) · a
 *  collapsible right panel (the ticket, files, changes, session history).
 *
 *  Every tab closes, so "whatever is showing" can be nothing: with none open the
 *  pane falls through to the welcome surface, and the bar above it is how you
 *  open the next one.
 *
 *  There is deliberately no header naming the worktree: the sidebar row that
 *  selected it already names it and is always on screen, and the actions a header
 *  would carry act on the checkout as a place on disk — they live on that row's
 *  right-click menu. Which worktree is selected comes from the app shell's project
 *  tree; with nothing selected the view shows its launch surface. */
import { useCallback, useEffect, useState } from "react";

import type { Worktree, WorktreePr } from "../../bindings";
import { IssuePage } from "../../components/IssuePage";
import { CloseIcon, PrIcon } from "../../components/icons";
import { MarkdownTitle } from "../../components/Markdown";
import { Button, TerminalActivity } from "../../components/primitives";
import { usePrSummary, useWorktreeTabs } from "../../lib/queries";
import { useAppUi } from "../../state/AppContext";
import { alpha } from "../../theme/colors";
import type { FileFocus } from "../reviews/model";
import { PrPage, PrPageSkeleton, type PrTab } from "../reviews/PrPage";
import { AgentTabPane } from "./AgentTabPane";
import { CheckLogView } from "./CheckLogView";
import { CreatePrDialog } from "./CreatePrDialog";
import { FilePickerPanel } from "./FilePickerPanel";
import { FileViewer } from "./FileViewer";
import { MainTabBar } from "./MainTabBar";
import { BASE_ID, extraTab, TreesProvider, useTrees } from "./model";
import { SetupLogsView } from "./SetupLogsView";
import { useReopenClosedTab } from "./useReopenClosedTab";
import { WelcomeSurface } from "./WelcomeSurface";
import { WorktreeTerminal } from "./WorktreeTerminal";

function TreesContent() {
  const { worktrees, active, loading } = useTrees();
  useAbandonedLaunchTabs();
  // Clicking an exited agent in the rail asks for a tab its process took with
  // it; this resumes the conversation into a new one. Above the early return so
  // it keeps running whatever the view is showing.
  useReopenClosedTab();

  // Nothing selected and no worktrees yet: show a loading state while the first
  // fetch is in flight (otherwise the empty state flashes as if nothing exists),
  // then the real empty state. The base entry, if any, is still selectable from
  // the shell's project tree; selecting it makes `active` truthy below.
  if (!active && worktrees.length === 0) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-app">
        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <TerminalActivity label="Loading worktrees…" />
          </div>
        ) : (
          <WelcomeSurface />
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-app">
      {active ? (
        active.pending ? (
          <CreatingPane worktree={active} />
        ) : (
          // Keyed by id so per-worktree terminal state (e.g. the live-session
          // latch) resets when switching worktrees.
          <WorktreePane key={active.id} worktree={active} />
        )
      ) : (
        // The cross-surface overview moved out of Trees into the Agents section —
        // it was never a worktree view, and half of what it should show (triage
        // investigations, Dev) never had a worktree to hang off.
        <WelcomeSurface />
      )}
    </div>
  );
}

/** Close the tab a failed launch left behind.
 *
 *  A review launch opens its tab at the click, before the command that renders its
 *  prompt has even been sent — which is the whole point, but it means a failure
 *  has to un-open it. Left alone the row is an agent tab holding a session on paths
 *  that will never arrive: permanently "Reading pull request…", and only closable
 *  by hand. Trees does it rather than the launcher because tab rows are Trees'
 *  state, and the launcher runs from Reviews too. */
function useAbandonedLaunchTabs() {
  const { repo, closeTab } = useTrees();
  // The repo's tabs, not the selected worktree's: a launch takes seconds, and the
  // user is free to walk to another worktree inside them.
  const { data: tabs = [] } = useWorktreeTabs(repo);
  const { abandonedLaunchTabs, consumeAbandonedLaunchTab } = useAppUi();
  useEffect(() => {
    for (const id of abandonedLaunchTabs) {
      // Not every abandoned launch got as far as a row (the Reviews path can fail
      // in `createWorktree`, before there is a worktree to open a tab on), so the
      // id is consumed either way.
      if (tabs.some((tab) => tab.id === id)) closeTab(id);
      consumeAbandonedLaunchTab(id);
    }
  }, [abandonedLaunchTabs, tabs, closeTab, consumeAbandonedLaunchTab]);
}

/** Shown while a freshly-launched worktree is still being created (no path/branch
 *  yet, so the terminal can't mount) — gives immediate feedback instead of a blank
 *  pane until the git round-trip lands and the real worktree replaces it. */
function CreatingPane({ worktree }: { worktree: Worktree }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-center">
      <TerminalActivity label="Creating workspace…" />
      <div>
        <div className="flex items-baseline gap-1 text-[11.5px] text-muted-3">
          <span className="font-mono">{worktree.id}</span>
          <span>·</span>
          <MarkdownTitle>{worktree.title}</MarkdownTitle>
        </div>
      </div>
    </div>
  );
}

/** The "create a PR?" suggestion strip, shown above the bottom bar after a
 *  commit+push when the branch has commits and no PR yet. A gentle nudge — Create
 *  PR opens the dialog, Dismiss hides it — instead of relying on the header's
 *  button. Hidden once a PR exists, the dialog is open, or it's been dismissed. */
function PrSuggestionBar({ worktree }: { worktree: Worktree }) {
  const { prSuggestFor, prDialogFor, prsByWorktree, openPrDialog, dismissPrSuggestion } =
    useTrees();
  const hasPr = (prsByWorktree.get(worktree.id) ?? []).length > 0;
  const show =
    prSuggestFor === worktree.id &&
    prDialogFor !== worktree.id &&
    worktree.ahead > 0 &&
    !hasPr &&
    worktree.id !== BASE_ID;
  if (!show) return null;
  return (
    <div
      className="flex flex-none items-center gap-2 border-t border-line px-3 py-2 text-[11.5px]"
      style={{ background: alpha(10) }}
    >
      <span className="flex-none text-accent">
        <PrIcon size={13} />
      </span>
      {/* Take the row's free width but stay one line — a long branch name
          truncates with an ellipsis instead of wrapping the strip taller. */}
      <span className="min-w-0 flex-1 truncate text-fg-2">
        Pushed to origin. Open a pull request for{" "}
        <span className="font-mono text-fg-3">{worktree.branch}</span>?
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="flex-none whitespace-nowrap"
        onClick={dismissPrSuggestion}
      >
        <CloseIcon size={10} />
        Dismiss
      </Button>
      <Button
        variant="primary"
        size="sm"
        className="flex-none whitespace-nowrap"
        onClick={() => openPrDialog(worktree.id)}
      >
        <PrIcon size={12} />
        Create PR
      </Button>
    </div>
  );
}

function WorktreePane({ worktree }: { worktree: Worktree }) {
  const {
    repo,
    selectedFile,
    activeTab,
    tabs,
    setupFor,
    openCheckLog,
    addTab,
    fixCiLaunchFor,
    activePr,
    prViewOpen,
    issueViewOpen,
  } = useTrees();

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <MainTabBar />
        {/* A tab's host is mounted ONLY while that tab is showing (like the triage
            Investigate pane). The live xterm + PTY live in the global TerminalLayer
            (keyed `tree:<id>:tab:<tab id>`), so unmounting the host just detaches
            the overlay; the session + scrollback persist and re-attach on return.
            The File / Setup / PR / ticket views stay mounted (hidden when
            inactive). */}
        <div className="relative min-h-0 flex-1">
          {/* Nothing open — every tab was closed, or this workspace has never had
              one. The bar above still carries "+", and this offers the plainest
              thing it can open; Session history resumes any past agent. */}
          {activeTab === null && (
            <div className="absolute inset-0 flex flex-col">
              <WelcomeSurface workspace={{ onOpenTerminal: () => addTab("terminal") }} />
            </div>
          )}
          {/* One pane per open tab, mounted only while showing — the session
              persists in the global TerminalLayer. Terminal tabs are plain login
              shells; agent tabs (a started task's included) and review tabs carry
              their own resumable agent session. */}
          {tabs.map((t) =>
            activeTab === extraTab(t.id) ? (
              t.kind !== "terminal" ? (
                <AgentTabPane
                  key={t.id}
                  repo={repo}
                  worktree={worktree}
                  tab={t}
                  tabs={tabs}
                  handoff={fixCiLaunchFor(t.id)}
                />
              ) : (
                <WorktreeTerminal
                  key={t.id}
                  id={`${worktree.id}:tab:${t.id}`}
                  branch={t.title}
                  cwd={worktree.path}
                />
              )
            ) : null,
          )}
          {selectedFile !== null && (
            <div className={`absolute inset-0 z-40 ${activeTab === "file" ? "" : "hidden"}`}>
              <FileViewer />
            </div>
          )}
          {setupFor !== null && (
            <div className={`absolute inset-0 z-40 ${activeTab === "setup" ? "" : "hidden"}`}>
              <SetupLogsView repo={repo} worktreeId={worktree.id} />
            </div>
          )}
          {/* Mounted-and-hidden like its neighbours. The log fetch is idempotent
              so `cond && <C/>` would be safe here, but a long log's scroll
              position surviving a tab switch is the whole reason it's a tab. */}
          {openCheckLog !== null && (
            <div className={`absolute inset-0 z-40 ${activeTab === "checkLog" ? "" : "hidden"}`}>
              <CheckLogView log={openCheckLog} />
            </div>
          )}
          {/* The right panel's PR and Issue panes at reading width. Same rule as
              the log above — mounted while open, hidden while another tab shows —
              so a long diff's expansions and a thread's scroll survive a switch.
              One display class rather than `flex … hidden`: which of the two wins
              is a question about stylesheet order, and the answer must not be. */}
          {prViewOpen && activePr && (
            <div
              className={activeTab === "prView" ? "absolute inset-0 z-40 flex flex-col" : "hidden"}
            >
              <PrView key={`${activePr.repo}#${activePr.number}`} pr={activePr} />
            </div>
          )}
          {issueViewOpen && (
            <div
              className={
                activeTab === "issueView" ? "absolute inset-0 z-40 flex flex-col" : "hidden"
              }
            >
              <IssuePage repo={repo} ticketId={worktree.id} />
            </div>
          )}
        </div>
        <PrSuggestionBar worktree={worktree} />
      </div>
      <FilePickerPanel />
    </div>
  );
}

/** The worktree's own pull request as a page ({@link PrPage}), with what the page
 *  leaves to its host kept here, per PR: which section is showing, and the jump
 *  into the diff. Reviews keeps that jump in its view model because the rail
 *  writes it from outside the page; here nothing outside the page does — a jump
 *  only ever comes from the page's own conversation rows — so it lives beside
 *  the page, and a jump brings Files changed forward itself.
 *
 *  No checkout is passed: this PR is your own, and its worktree is the view. */
function PrView({ pr }: { pr: WorktreePr }) {
  // The same read the right panel's PR pane made, already cached.
  const { data: summary } = usePrSummary(pr.repo, pr.number);
  const [tab, setTab] = useState<PrTab>("conversation");
  const [fileFocus, setFileFocus] = useState<FileFocus | null>(null);
  const focusFile = useCallback((path: string, line: number | null = null) => {
    setFileFocus((prev) => ({ path, line, nonce: (prev?.nonce ?? 0) + 1 }));
    setTab("files");
  }, []);

  // A skeleton, never an empty state: the worktree says it has this PR, so
  // "nothing here" would be a claim the pending read has not earned.
  if (!summary) return <PrPageSkeleton />;
  return (
    <PrPage pr={summary} tab={tab} onTab={setTab} fileFocus={fileFocus} focusFile={focusFile} />
  );
}

export function TreesView() {
  return (
    <TreesProvider>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TreesContent />
      </div>
      <PrDialogHost />
    </TreesProvider>
  );
}

/** Mounts the create-PR dialog only while it's open (so its initial draft fetch
 *  fires on open), positioned as a fixed overlay regardless of tree placement. */
function PrDialogHost() {
  const { prDialogFor } = useTrees();
  return prDialogFor ? <CreatePrDialog /> : null;
}
