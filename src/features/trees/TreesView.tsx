/** The Trees tab: worktrees grouped by project (sidebar) · a main area that holds
 *  the always-on terminal (or a picked file's diff/contents) with a bottom status
 *  bar · a collapsible file-picker right panel · the all-agents overview. */
import type { ReactNode } from "react";

import type { Worktree, WorktreeTab } from "../../bindings";
import { ViewChrome } from "../../components/chrome/ViewChrome";
import { AgentIcon, BranchIcon, CloseIcon, PrIcon, TreeIcon } from "../../components/icons";
import { MarkdownTitle } from "../../components/Markdown";
import { Button, EmptyState, TerminalActivity } from "../../components/primitives";
import { SessionEndedPane } from "../../components/SessionEndedPane";
import { CLAUDE_STATUS_LINE_KEY, useBoolSetting } from "../../lib/queries";
import { useAgentRuns } from "../../state/AgentRuns";
import { alpha } from "../../theme/colors";
import { agentProvider } from "../terminal/agentProvider";
import { BottomBar } from "./BottomBar";
import { CreatePrDialog } from "./CreatePrDialog";
import { FilePickerPanel } from "./FilePickerPanel";
import { FileViewer } from "./FileViewer";
import { MainTabBar } from "./MainTabBar";
import { BASE_ID, extraTab, TreesProvider, useTrees } from "./model";
import { SessionStatusLine } from "./SessionStatusLine";
import { SetupLogsView } from "./SetupLogsView";
import { StartTaskButton } from "./StartTaskButton";
import { sessionIdOf, useAgentTab } from "./useAgentTab";
import { useWorktreeAgent } from "./useWorktreeAgent";
import { WorktreeIssuePane } from "./WorktreeIssuePane";
import { WorktreeSidebar } from "./WorktreeSidebar";
import { WorktreeTerminal } from "./WorktreeTerminal";

function TreesContent() {
  const { worktrees, active, loading } = useTrees();

  // Nothing selected and no worktrees yet: show a loading state while the first
  // fetch is in flight (otherwise the empty state flashes as if nothing exists),
  // then the real empty state. The base entry, if any, is still selectable from
  // the sidebar; selecting it makes `active` truthy below.
  if (!active && worktrees.length === 0) {
    return (
      <div className="flex min-w-0 flex-1 flex-col bg-app">
        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <TerminalActivity label="Loading worktrees…" />
          </div>
        ) : (
          <WorkspaceLaunchSurface />
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-app">
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
        <WorkspaceLaunchSurface />
      )}
    </div>
  );
}

/** Useful home for Trees when no worktree is selected. It teaches the surface
 * while keeping recent work one click away instead of spending the largest pane
 * in the app on a generic empty message. */
function WorkspaceLaunchSurface() {
  const { worktrees, baseWorktree, setActive } = useTrees();
  const recent = worktrees.filter((worktree) => !worktree.pending).slice(0, 4);
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-8 py-10">
      <div className="w-full max-w-[720px]">
        <div className="mb-7 flex items-start gap-4">
          <span className="flex h-11 w-11 flex-none items-center justify-center rounded-[var(--radius-lg)] border border-line-2 bg-raised text-accent">
            <TreeIcon size={19} />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-[18px] font-semibold tracking-[-.01em] text-fg-bright">
              Choose a workspace
            </h1>
            <p className="mt-1 max-w-[560px] text-[12.5px] leading-5 text-muted-3">
              Return to recent work, open the repository base, or create a focused workspace from an
              issue.
            </p>
          </div>
          <StartTaskButton />
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {baseWorktree && (
            <button
              type="button"
              onClick={() => setActive(BASE_ID)}
              className="entity-card flex cursor-pointer items-center gap-3 p-3 text-left"
            >
              <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[var(--radius-sm)] border border-line-2 bg-input text-muted-2">
                <BranchIcon />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] font-medium text-fg-2">Base workspace</span>
                <span className="mt-0.5 block truncate font-mono text-[9.5px] text-muted-4">
                  {baseWorktree.branch}
                </span>
              </span>
            </button>
          )}
          {recent.map((worktree) => (
            <button
              key={worktree.id}
              type="button"
              onClick={() => setActive(worktree.id)}
              className="entity-card flex cursor-pointer items-center gap-3 p-3 text-left"
            >
              <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[var(--radius-sm)] border border-line-2 bg-input text-muted-2">
                {worktree.agent ? (
                  <AgentIcon kind={worktree.agent} size={13} />
                ) : (
                  <TreeIcon size={13} />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[10.5px] text-fg-2">
                  {worktree.id}
                </span>
                <MarkdownTitle className="mt-0.5 block line-clamp-2 text-[11px] text-muted-3">
                  {worktree.title}
                </MarkdownTitle>
              </span>
            </button>
          ))}
        </div>

        <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-4 font-mono text-[10px] text-muted-4">
          <span>
            <kbd className="mr-1.5 rounded border border-line-2 bg-input px-1.5 py-0.5">⌘K</kbd>{" "}
            find anything
          </span>
          <span>
            <kbd className="mr-1.5 rounded border border-line-2 bg-input px-1.5 py-0.5">⌘B</kbd>{" "}
            sidebar
          </span>
          <span>
            <kbd className="mr-1.5 rounded border border-line-2 bg-input px-1.5 py-0.5">⌘L</kbd>{" "}
            files
          </span>
          <span className="ml-auto">workspaces stay isolated · sessions restore automatically</span>
        </div>
      </div>
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
 *  PR opens the dialog, Dismiss hides it — instead of relying on the bottom-bar
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
  const { repo, selectedFile, activeTab, extraTabs, setupFor } = useTrees();
  const { requestAgentLaunch, clearAgentLaunch } = useAgentRuns();
  // Display-only gate for the inline usage bar; usage is captured regardless, so
  // this reflects instantly on already-running tabs (no relaunch needed).
  const showUsageBar = useBoolSetting("app", CLAUDE_STATUS_LINE_KEY).value;

  const { isBase, launching, initialSetup, ended, session, seed, preparing, resume, onExited } =
    useWorktreeAgent(worktree);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <MainTabBar />
        {/* The terminal host is mounted ONLY while the Terminal tab is active (like
            the triage Investigate pane). The live xterm + PTY live in the global
            TerminalLayer (keyed `tree:<id>`), so unmounting the host just detaches
            the overlay; the session + scrollback persist and re-attach on return.
            The Issue / File / Setup views stay mounted (hidden when inactive). */}
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
              Terminal tabs are plain login shells; Claude and Fix-CI tabs carry
              their own resumable agent session. */}
          {extraTabs.map((t) =>
            activeTab === extraTab(t.id) ? (
              t.kind === "agent" || t.kind === "fixCi" ? (
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
          {!isBase && (
            <div className={`absolute inset-0 z-30 ${activeTab === "issue" ? "" : "hidden"}`}>
              <WorktreeIssuePane key={worktree.id} repo={repo} worktree={worktree} />
            </div>
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
        </div>
        {/* santree-native statusline for this worktree's main session, from the
            live usage the injected statusLine captures — the exact numbers the
            in-terminal bar shows. Gated on the display setting only (capture is
            always on), so toggling it updates running tabs instantly. */}
        {!isBase && showUsageBar && <SessionStatusLine sessionId={sessionIdOf(session.data)} />}
        <PrSuggestionBar worktree={worktree} />
        <BottomBar worktree={worktree} />
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

/** An extra agent tab: a persisted provider session rooted in the worktree, or the
 *  "Fix CI with AI" variant of one.
 *
 *  Its conversation is keyed by `tree:<worktree>:tab:<tab id>` in the session
 *  registry, so opening the tab — first ever, after quitting claude, or after an
 *  app restart — resolves to a fresh `--session-id` launch or a `--resume` of the
 *  same conversation. Unlike the main work tab, quitting claude doesn't close the
 *  tab; it shows the resume state instead.
 *
 *  A Fix-CI tab differs in exactly two ways: it launches with the commit/push-
 *  denying settings file (so the agent fixes and validates but leaves committing to
 *  the user), and it opens by reading the CI-fix prompt written when the Reviews
 *  button kicked it off. Both are seeded on the first (fresh) launch only — a resume
 *  after restart just continues the conversation, with the settings still applied. */
function AgentTabPane({
  repo,
  worktree,
  tab,
}: {
  repo: string;
  worktree: Worktree;
  tab: WorktreeTab;
}) {
  const { fixCiPromptFor } = useTrees();
  const fixCi = tab.kind === "fixCi";
  const promptPath = fixCiPromptFor(tab.id);

  const { ended, preparing, seed, resume, onExited } = useAgentTab({
    repo,
    refId: `tree:${worktree.id}:tab:${tab.id}`,
    cwd: worktree.path,
    agent: tab.agentKind ?? "Claude",
    // An agent tab exists to run the agent, so any (re)open is an explicit launch.
    allowFresh: true,
    noGit: fixCi,
    // A plain agent tab has no opening prompt (the user starts the conversation).
    // Fix-CI seeds the short "read the file" line — the CI log is far too large to
    // type into the PTY (same reason the work prompt seeds a path).
    prompt: !fixCi
      ? undefined
      : promptPath
        ? `Read ${promptPath} and follow the instructions inside.`
        : "Fix the failing CI for this branch. Do not commit or push.",
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
        fixCi
          ? "Reading the CI failure. The terminal opens in a moment."
          : "The terminal opens in a moment."
      }
      ended={ended}
      endedTitle={fixCi ? "Fix-CI session ended" : "Agent session ended"}
      endedSubtitle={
        fixCi ? (
          <>
            <span className="font-mono text-fg-3">{tab.title}</span> keeps its conversation. Resume
            it to keep working, or close the tab. Commit &amp; push your fix from the bottom bar.
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
      <ViewChrome sidebar={<WorktreeSidebar />}>
        <TreesContent />
      </ViewChrome>
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
