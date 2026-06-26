import { createRootRoute, Outlet } from "@tanstack/react-router";

import { HelpMenu } from "../components/HelpMenu";
import { ShortcutsOverlay } from "../components/ShortcutsOverlay";
import { TerminalLayer } from "../features/terminal/TerminalLayer";
import { useKeyboardShortcuts } from "../lib/useKeyboardShortcuts";

export const Route = createRootRoute({
  component: AppShell,
});

/**
 * The application frame. Each route renders its own window chrome via
 * `ViewChrome` (split top bar: repo switcher beside the native traffic lights on
 * the left, navigation tabs on the right). The shell just provides the
 * full-height container and the floating help popover.
 */
function AppShell() {
  useKeyboardShortcuts();
  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-surface text-fg">
      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
      {/* Always mounted so terminal sessions persist across tab switches. */}
      <TerminalLayer />
      <HelpMenu />
      <ShortcutsOverlay />
    </div>
  );
}
