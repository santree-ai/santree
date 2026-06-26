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
import type { ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { useRef } from "react";

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
 * Drag handle on the sidebar's right edge. To stay buttery, the drag updates the
 * `--sidebar-width` CSS variable *directly* (no React state, so no re-render of
 * the whole app on every pointer move) and only commits the final width to state
 * on pointer-up. Dragging in past the collapse threshold collapses the sidebar.
 */
function SidebarResizer() {
  const { sidebarWidth, setSidebarWidth, setSidebarCollapsed } = useApp();
  const startX = useRef(0);
  const startW = useRef(0);
  const latest = useRef(sidebarWidth);
  const dragging = useRef(false);

  const setVar = (w: number) =>
    document.documentElement.style.setProperty("--sidebar-width", `${w}px`);

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    startX.current = e.clientX;
    startW.current = sidebarWidth;
    latest.current = sidebarWidth;
    dragging.current = true;
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !(e.buttons & 1)) return;
    const next = startW.current + (e.clientX - startX.current);
    if (next < SIDEBAR.collapseAt) {
      dragging.current = false;
      e.currentTarget.releasePointerCapture(e.pointerId);
      latest.current = SIDEBAR.default;
      setVar(SIDEBAR.default);
      setSidebarCollapsed(true);
      setSidebarWidth(SIDEBAR.default);
      return;
    }
    const clamped = Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, next));
    latest.current = clamped;
    // Visual-only update — the column + top cell read this variable.
    setVar(clamped);
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    // Commit the dragged width to state exactly once.
    setSidebarWidth(latest.current);
  };

  return (
    <div
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
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
