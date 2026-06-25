/**
 * Per-view window layout. The top bar is split so its divider lines up with the
 * view's sidebar: the left cell (sidebar width) holds the repo switcher beside
 * the native macOS traffic lights; the right cell holds the navigation tabs and
 * the status summary. Below, the sidebar and the main content fill the window.
 *
 * The whole bar is a drag region; interactive children opt out by being their
 * own elements.
 */
import type { ReactNode } from "react";

import { NavTabs } from "./NavTabs";
import { RepoSelector } from "./RepoSelector";
import { ViewSummary } from "./ViewSummary";

/** Horizontal space reserved on the left for the macOS traffic lights. */
const TRAFFIC_LIGHTS_INSET = 78;

interface ViewChromeProps {
  /** Width (px) of the sidebar / header left cell, so the divider aligns. */
  sidebarWidth: number;
  /** Optional sidebar rendered below the left header cell. */
  sidebar?: ReactNode;
  /** Main content, filling the area right of the sidebar. */
  children: ReactNode;
  /** Override the left header cell (default: the repo switcher). */
  leftCell?: ReactNode;
  /** Override the right header area (default: nav tabs + status summary). */
  rightCell?: ReactNode;
}

export function ViewChrome({
  sidebarWidth,
  sidebar,
  children,
  leftCell,
  rightCell,
}: ViewChromeProps) {
  return (
    <div className="flex h-full flex-col">
      <div
        data-tauri-drag-region
        className="flex h-[46px] flex-none border-b border-line bg-surface"
      >
        <div
          data-tauri-drag-region
          className="flex flex-none items-center border-r border-line"
          style={{ width: sidebarWidth, paddingLeft: TRAFFIC_LIGHTS_INSET }}
        >
          {leftCell ?? <RepoSelector />}
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
        {sidebar}
        {children}
      </div>
    </div>
  );
}
