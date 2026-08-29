/** The Trees view: the selected worktree's workspace. The tab strip · the
 *  always-on terminal (or a picked file's diff/contents) with the session status
 *  line and bottom status bar under it · a collapsible right panel (the ticket,
 *  files, changes, session history).
 *
 *  There is deliberately no header naming the worktree: the sidebar row that
 *  selected it already names it and is always on screen, and the actions a header
 *  would carry act on the checkout as a place on disk — they live on that row's
 *  right-click menu. Which worktree is selected comes from the app shell's project
 *  tree; with nothing selected the view shows its launch surface. */
import type { ReactNode } from "react";

import type { Worktree, WorktreeTab } from "../../bindings";
import { CloseIcon, PrIcon } from "../../components/icons";
import { MarkdownTitle } from "../../components/Markdown";
import { Button, EmptyState, TerminalActivity } from "../../components/primitives";
import { SessionEndedPane } from "../../components/SessionEndedPane";
import { useWorktreeTabLaunch } from "../../lib/queries";
import { useAgentRuns } from "../../state/AgentRuns";
import { alpha } from "../../theme/colors";
import { agentProvider } from "../terminal/agentProvider";
import { CheckLogView } from "./CheckLogView";
import { CreatePrDialog } from "./CreatePrDialog";
import { FilePickerPanel } from "./FilePickerPanel";
import { FileViewer } from "./FileViewer";
import { MainTabBar } from "./MainTabBar";
import { BASE_ID, extraTab, TreesProvider, useTrees } from "./model";
import { SetupLogsView } from "./SetupLogsView";
import { useAgentTab } from "./useAgentTab";
import { useWorktreeAgent } from "./useWorktreeAgent";
import { WelcomeSurface } from "./WelcomeSurface";
import { WorktreeTerminal } from "./WorktreeTerminal";

function TreesContent() {
  const { worktrees, active, loading } = useTrees();

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
  const { repo, selectedFile, activeTab, extraTabs, setupFor, openCheckLog } = useTrees();
  const { requestAgentLaunch, clearAgentLaunch } = useAgentRuns();

  const { launching, initialSetup, ended, seed, preparing, resume, onExited } =
    useWorktreeAgent(worktree);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <MainTabBar />
        {/* The terminal host is mounted ONLY while the Terminal tab is active (like
            the triage Investigate pane). The live xterm + PTY live in the global
            TerminalLayer (keyed `tree:<id>`), so unmounting the host just detaches
            the overlay; the session + scrollback persist and re-attach on return.
            The File / Setup views stay mounted (hidden when inactive). */}
        <div className="relative min-h-0 flex-1">
          {/* Don't spawn the terminal during the FIRST setup — the PTY's shell
              would capture pre-setup env, and the agent seed only applies on
              session creation (setup writes .env / configures direnv first). A
              later manual re-run keeps the existing terminal. */}
          {activeTab === "terminal" &&
            (initialSetup ? (
              <EmptyState
                className="h-full"
                title="Setting up the workspace…"
                subtitle="The terminal opens once setup finishes."
              />
            ) : (
              <AgentSurface
                worktree={worktree}
                termId={worktree.id}
                branch={worktree.branch}
                preparing={preparing}
                preparingTitle={launching ? "Preparing the agent…" : "Resuming…"}
                preparingSubtitle="The terminal opens in a moment."
                ended={ended}
                endedTitle="Work session ended"
                endedSubtitle={
                  <>
                    This is the main work terminal for{" "}
                    <span className="font-mono text-fg-3">{worktree.id}</span>. The agent exited.
                    Resume it whenever you're ready.
                  </>
                }
                seed={seed}
                onExited={onExited}
                onResume={() => {
                  // Resuming is an explicit launch: the launch flag lets the
                  // resolve mint a fresh session. Without it, a pruned or
                  // never-written transcript resolves to a plain shell and Resume
                  // dead-ends in a shell ↔ "session ended" loop with no way back
                  // to the agent.
                  requestAgentLaunch(worktree.id);
                  resume();
                }}
                onLaunched={() => clearAgentLaunch(worktree.id)}
              />
            ))}
          {/* Extra tabs (opened via the "+" tab): each its own PTY, mounted only
              while showing — the session persists in the global TerminalLayer.
              Terminal tabs are plain login shells; agent and review tabs carry
              their own resumable agent session. */}
          {extraTabs.map((t) =>
            activeTab === extraTab(t.id) ? (
              t.kind !== "terminal" ? (
                <AgentTabPane key={t.id} repo={repo} worktree={worktree} tab={t} />
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
        </div>
        <PrSuggestionBar worktree={worktree} />
      </div>
      <FilePickerPanel />
    </div>
  );
}

/** The three states an agent terminal can be in — still resolving its seed, exited
 *  (resumable), or live. Shared by the main work terminal and every extra agent tab
 *  so they behave identically; they differ only in their copy. */
function AgentSurface({
  worktree,
  termId,
  branch,
  preparing,
  preparingTitle,
  preparingSubtitle,
  ended,
  endedTitle,
  endedSubtitle,
  seed,
  onResume,
  onExited,
  onLaunched,
}: {
  worktree: Worktree;
  termId: string;
  branch: string;
  preparing: boolean;
  preparingTitle: string;
  preparingSubtitle: string;
  ended: boolean;
  endedTitle: string;
  endedSubtitle: ReactNode;
  seed: string | undefined;
  onResume: () => void;
  onExited: () => void;
  onLaunched?: () => void;
}) {
  if (ended) {
    return <SessionEndedPane title={endedTitle} subtitle={endedSubtitle} onResume={onResume} />;
  }
  if (preparing) {
    return <EmptyState className="h-full" title={preparingTitle} subtitle={preparingSubtitle} />;
  }
  return (
    <WorktreeTerminal
      id={termId}
      branch={branch}
      cwd={worktree.path}
      seed={seed}
      onLaunched={onLaunched}
      onExited={onExited}
    />
  );
}

/** An extra agent tab: a persisted provider session rooted in the worktree, or one
 *  of the two PR-scoped review sessions.
 *
 *  Its conversation is keyed by `tree:<worktree>:tab:<tab id>` in the session
 *  registry, so opening the tab — first ever, after quitting claude, or after an
 *  app restart — resolves to a fresh `--session-id` launch or a `--resume` of the
 *  same conversation. Unlike the main work tab, quitting claude doesn't close the
 *  tab; it shows the resume state instead.
 *
 *  A review tab differs in exactly two ways: it launches with the review deny list
 *  and santree's review MCP server, and it opens by reading the prompt written when
 *  the Reviews button kicked it off. The prompt is seeded on the first (fresh)
 *  launch only; the capability paths apply to every launch, resume included — which
 *  is why they come from the persisted row (`useWorktreeTabLaunch`) once the
 *  in-memory hand-off is gone, and never from the plain no-git fallback. */
function AgentTabPane({
  repo,
  worktree,
  tab,
}: {
  repo: string;
  worktree: Worktree;
  tab: WorktreeTab;
}) {
  const { fixCiLaunchFor } = useTrees();
  const review = tab.kind === "fixCi" || tab.kind === "aiReview";
  const handoff = fixCiLaunchFor(tab.id);
  const promptPath = handoff?.promptPath;
  // Only after a restart (or a reload) is the hand-off missing; re-derive from the
  // row then, and hold the launch until it lands.
  const persisted = useWorktreeTabLaunch(repo, tab.id, review && !handoff);
  const launch = handoff ?? persisted.data ?? undefined;

  const { ended, preparing, seed, resume, onExited } = useAgentTab({
    repo,
    refId: `tree:${worktree.id}:tab:${tab.id}`,
    cwd: worktree.path,
    agent: tab.agentKind ?? "Claude",
    // An agent tab exists to run the agent, so any (re)open is an explicit launch.
    allowFresh: true,
    // A review session without its own settings would run with the *standard* ones —
    // no deny list at all — so it waits instead. Resolving them is local work: a
    // settings write and a path derivation, no network.
    hold: review && !launch,
    settingsPath: launch?.settingsPath,
    mcpConfigPath: launch?.mcpConfigPath ?? undefined,
    // A plain agent tab has no opening prompt (the user starts the conversation).
    // A review tab seeds the short "read the file" line — the rendered prompt carries
    // a whole PR diff, far past what can be typed into a shell.
    prompt: !review
      ? undefined
      : promptPath
        ? `Read ${promptPath} and follow the instructions inside.`
        : "Continue the review of this branch. Do not commit or push.",
    // No `--remote-control`: it would collide with the worktree's main work session
    // (same worktree id), which already claims that Remote Control name.
  });

  return (
    <AgentSurface
      worktree={worktree}
      termId={`${worktree.id}:tab:${tab.id}`}
      branch={tab.title}
      preparing={preparing}
      preparingTitle={`Starting ${agentProvider(tab.agentKind ?? "Claude").label}…`}
      preparingSubtitle={
        review
          ? "Reading the pull request. The terminal opens in a moment."
          : "The terminal opens in a moment."
      }
      ended={ended}
      endedTitle={review ? "Review session ended" : "Agent session ended"}
      endedSubtitle={
        review ? (
          <>
            <span className="font-mono text-fg-3">{tab.title}</span> keeps its conversation. Resume
            it to keep working, or close the tab. Commit &amp; push from the Changes pane.
          </>
        ) : (
          <>
            <span className="font-mono text-fg-3">{tab.title}</span> keeps its conversation. Resume
            it whenever you're ready, or close the tab to discard it.
          </>
        )
      }
      seed={seed}
      onResume={resume}
      onExited={onExited}
    />
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
