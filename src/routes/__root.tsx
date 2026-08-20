import { createRootRoute, Outlet } from "@tanstack/react-router";

import { ShortcutsOverlay } from "../components/ShortcutsOverlay";
import { WelcomeScreen } from "../components/WelcomeScreen";
import { TerminalLayer } from "../features/terminal/TerminalLayer";
import { AgentRunHost } from "../features/trees/AgentRunHost";
import { useRepos, useUpdateWatcher } from "../lib/queries";
import { useKeyboardShortcuts } from "../lib/useKeyboardShortcuts";
import { AgentRunsProvider } from "../state/AgentRuns";
import { LegacyMigrationProvider } from "../state/LegacyMigration";

export const Route = createRootRoute({
  component: AppShell,
});

/**
 * The application frame. Each route renders its own window chrome via
 * `ViewChrome` (split top bar: repo switcher beside the native traffic lights on
 * the left, navigation tabs on the right). The shell just provides the
 * full-height container; the help popover is anchored in each sidebar's
 * `SidebarFooter` instead (see `HelpMenu`).
 *
 * First run (no repositories registered) swaps the routed views for the
 * `WelcomeScreen`. Gated on the list having *loaded* — rendering nothing for
 * the first frames — so neither the welcome screen nor the normal chrome
 * flashes for the wrong state on startup.
 */
function AppShell() {
  useKeyboardShortcuts();
  useUpdateWatcher();
  const { data: repos } = useRepos();
  return (
    <AgentRunsProvider>
      <LegacyMigrationProvider>
        <div className="relative flex h-screen flex-col overflow-hidden bg-surface text-fg">
          <div className="min-h-0 flex-1">
            {repos === undefined ? null : repos.length === 0 ? <WelcomeScreen /> : <Outlet />}
          </div>
          {/* Always mounted so terminal sessions persist across tab switches. */}
          <TerminalLayer />
          {/* Always mounted so an agent launch — a "Run in background" from Issues, or
              one queued behind a setup run the user navigated away from — actually
              runs. It used to live under the Trees route, which meant it only ran if
              you happened to be looking at it. */}
          <AgentRunHost />
          <ShortcutsOverlay />
        </div>
      </LegacyMigrationProvider>
    </AgentRunsProvider>
  );
}
