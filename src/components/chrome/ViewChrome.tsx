/**
 * Per-view window layout (Conductor-style chrome).
 *
 * Top bar: the left cell (over the sidebar) holds the macOS traffic-light inset
 * plus the collapse toggle (left) and back/forward (right); the right cell holds
 * the nav tabs and status summary. The repo switcher lives at the **top of the
 * sidebar** when it's open, and moves **into the top bar** when the sidebar is
 * collapsed (or the view has no sidebar). Views provide sidebar *content*;
 * ViewChrome owns the column chrome (shared width, border, repo header, resize).
 *
 * The left cell takes the sidebar's width whenever the column is shown, so the
 * vertical divider runs unbroken from the title bar down through the content.
 * That's the reason a view with a left column should pass it as `sidebar` rather
 * than rendering its own aside: a hand-rolled column is a different width from
 * the cell above it, and the divider visibly steps.
 */
import { type CSSProperties, type ReactNode, type RefObject, useRef } from "react";

import { useEdgeResize } from "../../lib/useEdgeResize";
import { CHROME, SIDEBAR, useAppUi } from "../../state/AppContext";
import { EdgeResizeHandle } from "../primitives";
import { ChromeControls } from "./ChromeControls";
import { KeepAwakeButton } from "./KeepAwakeButton";
import { NavTabs } from "./NavTabs";
import { RefreshButton } from "./RefreshButton";
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
  /**
   * Keep the repo switcher in the top bar even while the sidebar column is open,
   * instead of moving it into the column's header. For a view whose column is a
   * panel rather than a navigable tree (Dev's bug list), a repo header would be
   * a row of chrome above content that doesn't belong to a repo.
   */
  repoInTopBar?: boolean;
}

/**
 * Drag handle on the sidebar's right edge. Dragging in past the collapse
 * threshold collapses the sidebar (resetting the stored width so re-expanding
 * restores a sensible size). See {@link useEdgeResize} for the resize mechanics.
 */
function SidebarResizer({ target }: { target: RefObject<HTMLDivElement | null> }) {
  const { sidebarWidth, setSidebarWidth, setSidebarCollapsed } = useAppUi();
  const resize = useEdgeResize({
    cssVar: "--sidebar-width",
    target,
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

  return <EdgeResizeHandle edge="right" {...resize} />;
}

export function ViewChrome({
  sidebar,
  children,
  leftCell,
  rightCell,
  showRepoSelector = true,
  repoInTopBar: keepRepoInTopBar = false,
}: ViewChromeProps) {
  const { sidebarCollapsed, sidebarWidth, toggleSidebar } = useAppUi();
  const resizeScope = useRef<HTMLDivElement>(null);

  const hasSidebar = sidebar !== undefined;
  // Views with a custom leftCell (Settings) aren't collapsible — their left cell
  // is their own control.
  const collapsible = hasSidebar && leftCell === undefined;
  const showColumn = hasSidebar && !(collapsible && sidebarCollapsed);
  // The repo switcher rides in the top bar whenever the sidebar column isn't
  // shown — or whenever the view asked to keep it there.
  const repoInTopBar = showRepoSelector && (!showColumn || keepRepoInTopBar);
  // The cell's right border is a divider between two things, so it's drawn only
  // when there is a second thing: a column continuing below it, or the repo
  // switcher grouped inside it. A view with neither (Agents, which scopes itself
  // with its own multi-repo picker) would otherwise show a stub rule hanging off
  // the traffic lights with nothing beneath it.
  const dividedCell = showColumn || repoInTopBar || leftCell !== undefined;

  return (
    <div
      ref={resizeScope}
      className="flex h-full flex-col"
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <div
        data-tauri-drag-region
        className="flex h-[46px] flex-none border-b border-line bg-surface"
      >
        <div
          data-tauri-drag-region
          className={`flex min-w-0 flex-none items-center gap-2 pr-2.5 ${
            dividedCell ? "border-r border-line" : ""
          }`}
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
                // Filling pushes back/forward to the cell's right edge, which
                // only works when nothing follows them — with the switcher here,
                // the controls group tight and it takes the remaining width.
                fill={showColumn && !repoInTopBar}
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
              <div className="flex items-center gap-2.5">
                <ViewSummary />
                <KeepAwakeButton />
                <RefreshButton />
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
            {showRepoSelector && !repoInTopBar && (
              <div
                className={`flex ${CHROME.subBar} flex-none items-center border-b border-hairline px-3`}
              >
                <RepoSelector />
              </div>
            )}
            <div className="flex min-h-0 flex-1 flex-col">{sidebar}</div>
            <SidebarResizer target={resizeScope} />
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
