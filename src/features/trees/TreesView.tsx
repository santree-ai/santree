/** The Trees tab: worktrees grouped by project (sidebar) · a main area that holds
 *  the always-on terminal (or a picked file's diff/contents) with a bottom status
 *  bar · a collapsible file-picker right panel · the all-agents overview. */
import type { Settings, Worktree } from "../../bindings";
import { ViewChrome } from "../../components/chrome/ViewChrome";
import { EmptyState, Spinner } from "../../components/primitives";
import { useWorkPrompt } from "../../lib/queries";
import { useApp } from "../../state/AppContext";
import { AllAgentsView } from "./AllAgentsView";
import { BottomBar } from "./BottomBar";
import { CreatePrDialog } from "./CreatePrDialog";
import { FilePickerPanel } from "./FilePickerPanel";
import { FileViewer } from "./FileViewer";
import { MainTabBar } from "./MainTabBar";
import { BASE_ID, TreesProvider, termTab, useTrees } from "./model";
import { SetupLogsView } from "./SetupLogsView";
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
          <WorktreePane worktree={active} />
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

/** Single-quote a string for a POSIX shell command line. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The command a freshly-started worktree's terminal runs: `exec claude '<prompt>'`.
 *  Setup (if any) ran earlier on the setup-logs page, so this is just the agent.
 *  `exec` replaces the shell so quitting the agent ends the session. `promptText`
 *  is the backend-rendered `work` prompt; falls back to a one-liner if it's not
 *  available (e.g. the render failed). */
function agentSeed(w: Worktree, settings: Settings | null, promptText?: string): string {
  const exec = settings?.agents.find((a) => a.key === w.agent)?.exec?.trim() || "claude";
  const prompt = promptText ?? `Work on ${w.id}: ${w.title}`;
  return `exec ${shellQuote(exec)} ${shellQuote(prompt)}`;
}

function WorktreePane({ worktree }: { worktree: Worktree }) {
  const {
    repo,
    launchAgents,
    clearAgentLaunch,
    selectedFile,
    setupFor,
    setupThenLaunch,
    activeTab,
    completeSetup,
    extraTerminals,
  } = useTrees();
  const { settings } = useApp();
  // The base-branch entry has no ticket — no Issue tab, no agent launch/setup.
  const isBase = worktree.id === BASE_ID;

  // Only freshly-started tasks launch the agent (see the launch-flag in the model).
  const launching = launchAgents.has(worktree.id);
  const settingUp = setupFor === worktree.id;
  // Withhold the terminal ONLY during the very first setup (part of starting the
  // task) — the PTY doesn't exist yet, so it must wait for the env. A manual
  // "Re-run setup" later must NOT yank/restart the already-running terminal.
  const initialSetup = settingUp && setupThenLaunch;

  // The agent's opening prompt is rendered by the backend (`work` template). Fetch
  // it once we're launching (and past any initial setup); the terminal waits for
  // it so the agent starts with the full prompt, not the fallback one-liner.
  const workPrompt = useWorkPrompt(repo, worktree.id, launching && !initialSetup);
  const awaitingPrompt = launching && !initialSetup && !workPrompt.isFetched;
  const seed = launching ? agentSeed(worktree, settings, workPrompt.data) : undefined;

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
            ) : awaitingPrompt ? (
              <EmptyState
                className="h-full"
                title="Preparing the agent…"
                subtitle="The terminal opens once the prompt is ready."
              />
            ) : (
              <WorktreeTerminal
                id={worktree.id}
                branch={worktree.branch}
                cwd={worktree.path}
                seed={seed}
                onLaunched={() => clearAgentLaunch(worktree.id)}
              />
            ))}
          {/* Extra terminals (opened via the "+" tab): each its own PTY, mounted
              only while showing — the session persists in the global TerminalLayer.
              Plain login shells (no agent seed). */}
          {extraTerminals.map((n) =>
            activeTab === termTab(n) ? (
              <WorktreeTerminal
                key={n}
                id={`${worktree.id}:t${n}`}
                branch={worktree.branch}
                cwd={worktree.path}
              />
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
              <SetupLogsView repo={repo} worktreeId={worktree.id} onComplete={completeSetup} />
            </div>
          )}
        </div>
        <BottomBar worktree={worktree} />
      </div>
      <FilePickerPanel />
    </div>
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
