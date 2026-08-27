/**
 * The window: one permanent sidebar, one swapping content area, one status bar.
 *
 * Everything that must outlive a navigation — the terminal layer, background
 * agent runs, the palette — is mounted by the route root *outside* this
 * component's content slot. That separation is load-bearing: a live PTY or a
 * queued agent launch parented to a view would die the moment the user looked
 * somewhere else.
 *
 * The sidebar's committed width lives in app state; the live value during a drag
 * is a CSS variable owned here, so dragging repaints the layout without
 * re-rendering the tree.
 *
 * Collapsing hides the rail entirely rather than shrinking it to icons — the tree
 * is text, and a tree with the text taken out is decoration. The traffic-light
 * inset and the drag region move into the content column while it is away, since
 * the window still has to be draggable and macOS still draws its buttons there.
 */
import type { CSSProperties, ReactNode } from "react";

import { useAppUi } from "../../state/AppContext";
import { ChevronRightIcon } from "../icons";
import { Sidebar, TRAFFIC_LIGHTS_INSET } from "./Sidebar";
import { StatusBar } from "./status/StatusBar";

/** Stands in for the sidebar's title strip while the rail is collapsed. */
function CollapsedRail({ onExpand }: { onExpand: () => void }) {
  return (
    <div
      data-tauri-drag-region
      className="flex h-[38px] flex-none items-center border-b border-hairline"
      style={{ paddingLeft: TRAFFIC_LIGHTS_INSET }}
    >
      <button
        type="button"
        onClick={onExpand}
        aria-label="Show sidebar"
        title="Show sidebar (⌘B)"
        className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-4 transition-colors hover:bg-hover hover:text-fg-2"
      >
        <ChevronRightIcon size={13} />
      </button>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { sidebarWidth, sidebarCollapsed, setSidebarCollapsed } = useAppUi();

  return (
    <div
      className="flex h-full flex-col bg-app"
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <div className="flex min-h-0 flex-1">
        {!sidebarCollapsed && <Sidebar />}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {sidebarCollapsed && <CollapsedRail onExpand={() => setSidebarCollapsed(false)} />}
          {children}
        </main>
      </div>
      <StatusBar />
    </div>
  );
}
