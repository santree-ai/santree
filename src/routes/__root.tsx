import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { CommandPalette } from "../components/CommandPalette";
import { ShortcutsOverlay } from "../components/ShortcutsOverlay";
import { AppShell } from "../components/shell/AppShell";
import { WelcomeScreen } from "../components/WelcomeScreen";
import { TerminalLayer } from "../features/terminal/TerminalLayer";
import { AgentRunHost } from "../features/trees/AgentRunHost";
import { useRepos, useUpdateWatcher, useWorktreeWatcher } from "../lib/queries";
import { useKeyboardShortcuts } from "../lib/useKeyboardShortcuts";
import { useNativeContextMenu } from "../lib/useNativeContextMenu";
import { AgentRunsProvider } from "../state/AgentRuns";
import { LegacyMigrationProvider } from "../state/LegacyMigration";
import { WorkRepoGateProvider } from "../state/WorkRepoGate";

export const Route = createRootRoute({
  component: RootLayout,
});

/**
 * The application frame. One {@link AppShell} owns the whole window — the
 * sidebar (search, destinations, every project's worktrees and their agents) and
 * the status bar — and the routed view fills only the area between them. Views
 * therefore render content, never window chrome.
 *
 * The residents below sit *outside* the shell's content slot on purpose: a live
 * terminal or a queued background launch parented to a view would be torn down
 * the moment the user navigated away.
 *
 * First run (no repositories registered) swaps the shell for the
 * `WelcomeScreen`. Gated on the list having *loaded* — rendering nothing for
 * the first frames — so neither the welcome screen nor the normal chrome
 * flashes for the wrong state on startup.
 */
function RootLayout() {
  useKeyboardShortcuts();
  useNativeContextMenu();
  useUpdateWatcher();
  const { data: repos } = useRepos();
  // The filesystem watcher follows the open workspace's project. It is a single
  // watcher by construction (`watch_worktrees` re-points rather than adding, and
  // `WorktreeChanged` names no repo), so it can only ever cover one — and the one
  // worth covering is the project whose files are on screen. Read from the route
  // for the same reason everything else here is: there is no ambient "current
  // project" left to read it from.
  const watched = useRouterState({
    select: (s) =>
      s.location.pathname.startsWith("/trees")
        ? ((s.location.search as { project?: string }).project ?? "")
        : "",
  });
  useWorktreeWatcher(watched);
  // Settings is a page, not a view: it takes the whole window and brings its
  // own way back, so the shell (sidebar, status bar) steps aside for it.
  const fullPage = useRouterState({ select: (s) => s.location.pathname.startsWith("/settings") });
  return (
    <AgentRunsProvider>
      {/* App-level on purpose: "which project does this ticket start in" is asked
          by the Tickets list, the Tickets rail, the graph, the launch queue and
          the workspace's own "Start a task" alike. A gate mounted under one of
          them is a gate the others answer for themselves — which is exactly how
          a start came to mean "wherever I happen to be looking". */}
      <WorkRepoGateProvider>
        <LegacyMigrationProvider>
          <div className="relative flex h-screen flex-col overflow-hidden bg-surface text-fg">
            <div className="min-h-0 flex-1">
              {repos === undefined ? null : repos.length === 0 ? (
                <WelcomeScreen />
              ) : fullPage ? (
                <Outlet />
              ) : (
                <AppShell>
                  <Outlet />
                </AppShell>
              )}
            </div>
            {/* Always mounted so terminal sessions persist across view switches. */}
            <TerminalLayer />
            {/* Always mounted so an agent launch — a "Run in background" from the
              ticket list, or one queued behind a setup run the user navigated away
              from — actually runs. It used to live under the Trees route, which
              meant it only ran if you happened to be looking at it. */}
            <AgentRunHost />
            <CommandPalette />
            <ShortcutsOverlay />
          </div>
        </LegacyMigrationProvider>
      </WorkRepoGateProvider>
    </AgentRunsProvider>
  );
}
