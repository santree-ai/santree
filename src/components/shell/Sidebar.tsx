/**
 * The one permanent left rail: search, the destinations that aren't a worktree,
 * and every project's worktrees with their agents underneath.
 *
 * It is mounted once by {@link AppShell} and never unmounts, which is the point
 * of the layout — the tree is the app's index, so it has to survive navigation
 * rather than being rebuilt per view. Views own only the area to its right.
 *
 * The top strip is the window's drag region: on macOS the traffic lights are
 * drawn over it, so it also reserves their inset.
 */
import { useRef } from "react";

import { useEdgeResize } from "../../lib/useEdgeResize";
import { SIDEBAR, useAppUi } from "../../state/AppContext";
import { ChevronLeftIcon, PlusIcon } from "../icons";
import { EdgeResizeHandle, Spinner } from "../primitives";
import { SidebarFooter } from "../SidebarFooter";
import { ProjectTree } from "./ProjectTree";
import { SidebarNav } from "./SidebarNav";
import { useAddProject } from "./useAddProject";

/** Horizontal space the macOS traffic lights need before anything can be drawn.
 *  Shared with the shell, which reproduces the inset while the rail is hidden. */
export const TRAFFIC_LIGHTS_INSET = 78;

/** Section label + the add-project action, above the tree. */
function ProjectsHeader() {
  const { addProject, isPending, pendingRepo, orgs, chooseOrg, error } = useAddProject();

  return (
    <div className="flex-none">
      <div className="flex h-7 items-center gap-1.5 px-4 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-5">
        Projects
        <button
          type="button"
          onClick={addProject}
          disabled={isPending}
          aria-label="Add project"
          title="Add project"
          className="ml-auto flex h-5 w-5 cursor-pointer items-center justify-center rounded text-muted-4 transition-colors hover:bg-hover hover:text-fg-2 disabled:cursor-default"
        >
          {isPending ? <Spinner size={11} /> : <PlusIcon size={12} />}
        </button>
      </div>
      {error && <p className="px-4 pb-1 text-[11px] text-[var(--color-status-red)]">{error}</p>}
      {/* Asked only when several Linear workspaces are connected and the repo's
          own CLI config didn't already answer it. */}
      {pendingRepo && (
        <div className="mx-2.5 mb-1.5 rounded-md border border-line bg-surface p-2">
          <p className="pb-1 text-[11px] text-muted-4">Linear workspace for {pendingRepo}</p>
          {orgs.map((org) => (
            <button
              key={org.slug}
              type="button"
              onClick={() => chooseOrg(org.slug)}
              className="flex h-6 w-full cursor-pointer items-center rounded px-1.5 text-[12px] text-fg-2 transition-colors hover:bg-hover"
            >
              {org.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const { sidebarWidth, setSidebarWidth, setSidebarCollapsed } = useAppUi();
  const scope = useRef<HTMLDivElement>(null);
  const resize = useEdgeResize({
    cssVar: "--sidebar-width",
    target: scope,
    width: sidebarWidth,
    min: SIDEBAR.min,
    max: SIDEBAR.max,
    edge: "right",
    onCommit: setSidebarWidth,
  });

  return (
    <div
      ref={scope}
      className="relative flex flex-none flex-col border-r border-line bg-panel"
      style={{ width: "var(--sidebar-width)" }}
    >
      <div
        data-tauri-drag-region
        className="flex h-[38px] flex-none items-center justify-end pr-2"
        style={{ paddingLeft: TRAFFIC_LIGHTS_INSET }}
      >
        <button
          type="button"
          onClick={() => setSidebarCollapsed(true)}
          aria-label="Hide sidebar"
          title="Hide sidebar (⌘B)"
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-5 transition-colors hover:bg-hover hover:text-fg-2"
        >
          <ChevronLeftIcon size={13} />
        </button>
      </div>
      <SidebarNav />
      <ProjectsHeader />
      <ProjectTree />
      <SidebarFooter />
      <EdgeResizeHandle edge="right" {...resize} />
    </div>
  );
}
