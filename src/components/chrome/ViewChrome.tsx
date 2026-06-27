/**
 * Per-view window layout (Conductor-style chrome).
 *
 * Top bar: the left cell (over the sidebar) holds the macOS traffic-light inset
 * plus the collapse toggle (left) and back/forward (right); the right cell holds
 * the nav tabs and status summary. The repo switcher lives at the **top of the
 * sidebar** when it's open, and moves **into the top bar** when the sidebar is
 * collapsed (or the view has no sidebar). Views provide sidebar *content*;
 * ViewChrome owns the column chrome (shared width, border, repo header, resize).
 */
import type { ReactNode } from "react";

import { useEdgeResize } from "../../lib/useEdgeResize";
import { SIDEBAR, useApp } from "../../state/AppContext";
import { ChromeControls } from "./ChromeControls";
import { NavTabs } from "./NavTabs";
import { RepoSelector } from "./RepoSelector";
import { ViewSummary } from "./ViewSummary";

/** Horizontal space reserved on the left for the macOS traffic lights. */
const TRAFFIC_LIGHTS_INSET = 78;

interface ViewChromeProps {
  /** Optional sidebar *content* (ViewChrome wraps it in the column + repo header). */
  sidebar?: ReactNode;
  /** Main content, filling the area right of the sidebar. */
  children: ReactNode;
  /** Override the left header cell (e.g. Settings' Back button). */
  leftCell?: ReactNode;
  /** Override the right header area (default: nav tabs + status summary). */
  rightCell?: ReactNode;
  /** Show the repo switcher (default true; off for Settings, which has scope tabs). */
  showRepoSelector?: boolean;
}

/**
 * Drag handle on the sidebar's right edge. Dragging in past the collapse
 * threshold collapses the sidebar (resetting the stored width so re-expanding
 * restores a sensible size). See {@link useEdgeResize} for the resize mechanics.
 */
function SidebarResizer() {
  const { sidebarWidth, setSidebarWidth, setSidebarCollapsed } = useApp();
  const resize = useEdgeResize({
    cssVar: "--sidebar-width",
    width: sidebarWidth,
    min: SIDEBAR.min,
    max: SIDEBAR.max,
    edge: "right",
    onCommit: setSidebarWidth,
    collapse: {
      at: SIDEBAR.collapseAt,
      resetTo: SIDEBAR.default,
      onCollapse: () => setSidebarCollapsed(true),
    },
  });

  return (
    <div
      {...resize}
      className="absolute top-0 right-[-3px] z-20 h-full w-1.5 cursor-col-resize hover:bg-[color-mix(in_srgb,var(--accent)_45%,transparent)]"
      aria-hidden
    />
  );
}

export function ViewChrome({
  sidebar,
  children,
  leftCell,
  rightCell,
  showRepoSelector = true,
}: ViewChromeProps) {
  const { sidebarCollapsed, toggleSidebar } = useApp();

  const hasSidebar = sidebar !== undefined;
  // Views with a custom leftCell (Settings) aren't collapsible — their left cell
  // is their own control.
  const collapsible = hasSidebar && leftCell === undefined;
  const showColumn = hasSidebar && !(collapsible && sidebarCollapsed);
  // The repo switcher rides in the top bar whenever the sidebar column isn't shown.
  const repoInTopBar = showRepoSelector && !showColumn;

  return (
    <div className="flex h-full flex-col">
      <div
        data-tauri-drag-region
        className="flex h-[46px] flex-none border-b border-line bg-surface"
      >
        <div
          data-tauri-drag-region
          className="flex min-w-0 flex-none items-center gap-2 border-r border-line pr-2.5"
          style={{
            width: showColumn ? "var(--sidebar-width)" : undefined,
            paddingLeft: TRAFFIC_LIGHTS_INSET,
          }}
        >
          {leftCell ?? (
            <>
              <ChromeControls
                canCollapse={collapsible}
                collapsed={sidebarCollapsed}
                onToggle={toggleSidebar}
                fill={showColumn}
              />
              {repoInTopBar && <RepoSelector />}
            </>
          )}
        </div>
        <div className="flex flex-1 items-stretch pr-3">
          {rightCell ?? (
            <>
              <NavTabs />
              <div data-tauri-drag-region className="h-full flex-1" />
              <div className="flex items-center">
                <ViewSummary />
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {showColumn && (
          <div
            className="relative flex flex-none flex-col border-r border-line bg-panel"
            style={{ width: "var(--sidebar-width)" }}
          >
            {showRepoSelector && (
              <div className="flex h-11 flex-none items-center border-b border-hairline px-3">
                <RepoSelector />
              </div>
            )}
            <div className="flex min-h-0 flex-1 flex-col">{sidebar}</div>
            <SidebarResizer />
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
