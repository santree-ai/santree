/** The Trees tab: worktrees grouped by project (sidebar) · a main area that holds
 *  the always-on terminal (or a picked file's diff/contents) with a bottom status
 *  bar · a collapsible file-picker right panel · the all-agents overview. */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import type { Worktree, WorktreeTab } from "../../bindings";
import { ViewChrome } from "../../components/chrome/ViewChrome";
import { CloseIcon, PrIcon } from "../../components/icons";
import { Button, EmptyState, Spinner } from "../../components/primitives";
import { SessionEndedPane } from "../../components/SessionEndedPane";
import {
  CLAUDE_START_WITH_CHROME_KEY,
  CLAUDE_STATUS_LINE_KEY,
  useAgentSession,
  useBoolSetting,
  useClaudeHookSettings,
  useResolvedSetting,
  WORK_EFFORT_KEY,
  WORK_MODEL_KEY,
  WORK_PERMISSION_MODE_KEY,
} from "../../lib/queries";
import { useApp, useAppUi } from "../../state/AppContext";
import { alpha } from "../../theme/colors";
import { agentSessionSeed, shellQuote } from "../terminal/agentSeed";
import { useTerminals } from "../terminal/TerminalsContext";
import { AllAgentsView } from "./AllAgentsView";
import { BottomBar } from "./BottomBar";
import { CreatePrDialog } from "./CreatePrDialog";
import { FilePickerPanel } from "./FilePickerPanel";
import { FileViewer } from "./FileViewer";
import { MainTabBar } from "./MainTabBar";
import { BASE_ID, extraTab, TreesProvider, useTrees } from "./model";
import { SessionStatusLine } from "./SessionStatusLine";
import { SetupLogsView } from "./SetupLogsView";
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
          <EmptyState icon={<Spinner size={18} />} title="Loading worktrees…" />
        ) : (
          <EmptyState
            title="No worktrees yet"
            subtitle="Start a task from the sidebar to create a worktree and an agent terminal."
          />
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
        <AllAgentsView />
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
      <Spinner size={20} />
      <div>
        <div className="text-[13px] font-medium text-fg-2">Creating workspace…</div>
        <div className="mt-1 text-[11.5px] text-muted-3">
          {worktree.id} · {worktree.title}
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
        Pushed to origin — open a pull request for{" "}
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
    clearAgentLaunch,
    requestAgentLaunch,
    selectedFile,
    setupLines,
    activeTab,
    extraTabs,
  } = useTrees();
  // Display-only gate for the inline usage bar; usage is captured regardless, so
  // this reflects instantly on already-running tabs (no relaunch needed).
  const showUsageBar = useBoolSetting("app", CLAUDE_STATUS_LINE_KEY).value;
  const qc = useQueryClient();

  // The whole main-session seed pipeline — resume/fresh/shell resolution, the
  // one-shot seed, and the terminal-hold gates — lives in a shared hook so the
  // off-screen background launcher (`BackgroundLaunch`) runs the exact same logic.
  // `liveSeen` latches so quitting the agent (the session dies under us) doesn't
  // immediately re-resume it into a restart loop: the Terminal tab shows a resume
  // placeholder (the main work tab can't be closed) and the Resume button resets
  // the latch. A real reopen also remounts this pane (it's keyed by id).
  const {
    isBase,
    launching,
    settingUp,
    initialSetup,
    refId,
    setLiveSeen,
    ended,
    session,
    seed,
    preparing,
  } = useWorktreeAgent(worktree);

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
            ) : preparing ? (
              <EmptyState
                className="h-full"
                title={launching ? "Preparing the agent…" : "Resuming…"}
                subtitle="The terminal opens in a moment."
              />
            ) : ended ? (
              <SessionEndedPane
                title="Work session ended"
                subtitle={
                  <>
                    This is the main work terminal for{" "}
                    <span className="font-mono text-fg-3">{worktree.id}</span>. The agent exited —
                    resume it whenever you're ready.
                  </>
                }
                onResume={() => {
                  // Resuming is an explicit launch: drop the cached session
                  // resolution (it may predate this exit — e.g. the process died
                  // while the terminal host was unmounted and onExited never
                  // fired) and set the launch flag so the resolve is allowed to
                  // start fresh. Without the flag, a pruned/never-written
                  // transcript resolves to a plain shell and Resume dead-ends in
                  // a shell ↔ "session ended" loop with no way to get the agent.
                  qc.removeQueries({ queryKey: ["agent-session", repo, refId] });
                  requestAgentLaunch(worktree.id);
                  setLiveSeen(false);
                }}
              />
            ) : (
              <WorktreeTerminal
                id={worktree.id}
                branch={worktree.branch}
                cwd={worktree.path}
                seed={seed}
                onLaunched={() => clearAgentLaunch(worktree.id)}
                // Drop the cached session resolution so the next launch re-asks the
                // backend instead of replaying a stale "fresh" decision whose
                // transcript now exists on disk (which `session::resolve` would
                // correctly resolve to Resume).
                onExited={() => qc.removeQueries({ queryKey: ["agent-session", repo, refId] })}
              />
            ))}
          {/* Extra tabs (opened via the "+" tab): each its own PTY, mounted only
              while showing — the session persists in the global TerminalLayer.
              Terminal tabs are plain login shells; Claude tabs carry their own
              resumable agent session. */}
          {extraTabs.map((t) =>
            activeTab === extraTab(t.id) ? (
              t.kind === "claude" ? (
                <ClaudeTabPane key={t.id} repo={repo} worktree={worktree} tab={t} />
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
          {settingUp && (
            <div className={`absolute inset-0 z-40 ${activeTab === "setup" ? "" : "hidden"}`}>
              <SetupLogsView lines={setupLines} />
            </div>
          )}
        </div>
        {/* santree-native statusline for this worktree's main session, from the
            live usage the injected statusLine captures — the exact numbers the
            in-terminal bar shows. Gated on the display setting only (capture is
            always on), so toggling it updates running tabs instantly. */}
        {!isBase && showUsageBar && (
          <SessionStatusLine
            sessionId={
              session.data && session.data.type !== "shell" ? session.data.sessionId : null
            }
          />
        )}
        <PrSuggestionBar worktree={worktree} />
        <BottomBar worktree={worktree} />
      </div>
      <FilePickerPanel />
    </div>
  );
}

/** An extra Claude tab: a persisted agent session rooted in the worktree.
 *
 *  Its conversation is keyed by `tree:<worktree>:tab:<tab id>` in the session
 *  registry, so opening the tab — first ever, after quitting claude, or after an
 *  app restart — resolves to a fresh `--session-id` launch or a `--resume` of
 *  the same conversation. Unlike the main work tab there's no opening prompt
 *  (the user starts the conversation), and unlike extra terminal tabs, quitting
 *  claude doesn't close the tab — it shows the resume state instead (`liveSeen`
 *  latches so the dead session isn't instantly re-resumed into a restart loop). */
function ClaudeTabPane({
  repo,
  worktree,
  tab,
}: {
  repo: string;
  worktree: Worktree;
  tab: WorktreeTab;
}) {
  const { settings } = useApp();
  const refId = `tree:${worktree.id}:tab:${tab.id}`;
  const qc = useQueryClient();
  const { tabs } = useTerminals();
  const liveSession = tabs.some((t) => t.source === "issue" && t.refId === refId);
  const [liveSeen, setLiveSeen] = useState(false);
  useEffect(() => {
    if (liveSession) setLiveSeen(true);
  }, [liveSession]);
  const ended = liveSeen && !liveSession;

  // A Claude tab exists to run claude, so any (re)open is an explicit launch
  // (`allowFresh`) — resolve only when there's no live PTY to attach to.
  const needsSeed = !liveSession && !liveSeen;
  const session = useAgentSession(repo, refId, worktree.path, true, needsSeed);
  const exec = settings?.agents?.find((a) => a.key === "Claude")?.exec?.trim() || "claude";
  // The configured Work model/effort apply to a fresh start only — a resume
  // keeps the session's own model.
  const model = useResolvedSetting(repo, WORK_MODEL_KEY).data;
  const effort = useResolvedSetting(repo, WORK_EFFORT_KEY).data;
  const hookSettings = useClaudeHookSettings().data;
  const startWithChrome = useBoolSetting("app", CLAUDE_START_WITH_CHROME_KEY).value;
  const permissionMode = useResolvedSetting(repo, WORK_PERMISSION_MODE_KEY).data;
  const seed = agentSessionSeed(session.data, exec, {
    modelFlag: model ? `--model ${shellQuote(model)}` : undefined,
    effortFlag: effort ? `--effort ${shellQuote(effort)}` : undefined,
    // This pane is Claude-only by construction (exec pinned to "Claude").
    settingsFlag: hookSettings ? `--settings ${shellQuote(hookSettings)}` : undefined,
    chrome: startWithChrome,
    permissionMode: permissionMode ?? undefined,
  });

  if (ended) {
    return (
      <SessionEndedPane
        title="Claude session ended"
        subtitle={
          <>
            <span className="font-mono text-fg-3">{tab.title}</span> keeps its conversation — resume
            it whenever you're ready, or close the tab to discard it.
          </>
        }
        onResume={() => {
          // Drop the cached resolution first — it may predate this exit (the
          // process can die while this pane is unmounted, so onExited never
          // fired) and would replay a stale `--session-id` for a session whose
          // transcript now exists.
          qc.removeQueries({ queryKey: ["agent-session", repo, refId] });
          setLiveSeen(false);
        }}
      />
    );
  }
  if (needsSeed && session.isFetching) {
    return (
      <EmptyState
        className="h-full"
        title="Starting Claude…"
        subtitle="The terminal opens in a moment."
      />
    );
  }
  return (
    <WorktreeTerminal
      id={`${worktree.id}:tab:${tab.id}`}
      branch={tab.title}
      cwd={worktree.path}
      seed={seed}
      // Drop the cached session resolution so the next open re-asks the backend
      // instead of replaying a stale "fresh" decision whose transcript now
      // exists on disk (which `session::resolve` would correctly resolve to
      // Resume).
      onExited={() => qc.removeQueries({ queryKey: ["agent-session", repo, refId] })}
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
      <BackgroundLaunches />
    </TreesProvider>
  );
}

/** Hosts the off-screen agent terminals for "Run in background" launches. Each
 *  runs the same seed pipeline as the visible pane but is rendered off-screen (at
 *  a real size — a display:none host gives xterm a 0-row grid) so its PTY spawns
 *  and the agent seeds without stealing focus. The active worktree is excluded —
 *  its own visible `WorktreePane` owns that session. Once an agent has launched it
 *  drops out of `bgLaunches`, unmounting here; the live session persists in the
 *  TerminalLayer and re-attaches when the worktree is next opened. */
function BackgroundLaunches() {
  const { bgLaunches } = useAppUi();
  const { worktrees, activeId } = useTrees();
  return (
    <>
      {bgLaunches
        .filter((id) => id !== activeId)
        .map((id) => {
          const wt = worktrees.find((w) => w.id === id);
          // Wait for the real worktree — a pending placeholder has no path/branch
          // to root a terminal in yet.
          return wt && !wt.pending ? <BackgroundLaunch key={id} worktree={wt} /> : null;
        })}
    </>
  );
}

/** One off-screen agent terminal for a background launch (see {@link BackgroundLaunches}). */
function BackgroundLaunch({ worktree }: { worktree: Worktree }) {
  const { repo, clearAgentLaunch } = useTrees();
  const { clearBackgroundLaunch } = useAppUi();
  const qc = useQueryClient();
  const { launching, initialSetup, preparing, seed, refId } = useWorktreeAgent(worktree);

  // Same gate as the visible pane: don't spawn the PTY until we're actually
  // launching and the seed inputs are fresh (past initial setup + prompt fetch) —
  // mounting early would spawn a bare shell and silently drop the agent launch.
  if (!launching || initialSetup || preparing) return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed top-0 left-0 -z-50 h-[600px] w-[900px] overflow-hidden opacity-0"
      style={{ transform: "translateX(-100000px)" }}
    >
      <WorktreeTerminal
        id={worktree.id}
        branch={worktree.branch}
        cwd={worktree.path}
        seed={seed}
        onLaunched={() => {
          clearAgentLaunch(worktree.id);
          // Agent seeded + running in the persistent TerminalLayer — stop hosting
          // it off-screen; a later open re-attaches to the same session.
          clearBackgroundLaunch(worktree.id);
        }}
        onExited={() => qc.removeQueries({ queryKey: ["agent-session", repo, refId] })}
      />
    </div>
  );
}

/** Mounts the create-PR dialog only while it's open (so its initial draft fetch
 *  fires on open), positioned as a fixed overlay regardless of tree placement. */
function PrDialogHost() {
  const { prDialogFor } = useTrees();
  return prDialogFor ? <CreatePrDialog /> : null;
}
