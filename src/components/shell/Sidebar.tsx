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
import { ChevronLeftIcon } from "../icons";
import { EdgeResizeHandle } from "../primitives";
import { SidebarFooter } from "../SidebarFooter";
import { AddProjectPrompt } from "./AddProjectPrompt";
import { DaedalusSection } from "./DaedalusSection";
import { ProjectTree } from "./ProjectTree";
import { SECTION_HEADER, SectionAddButton } from "./SectionHeader";
import { SidebarNav } from "./SidebarNav";
import { TrackerConnectPrompt } from "./TrackerConnectPrompt";
import { TriageSection } from "./TriageSection";
import { useAddProject } from "./useAddProject";

/** Horizontal space the macOS traffic lights need before anything can be drawn.
 *  Shared with the shell, which reproduces the inset while the rail is hidden. */
export const TRAFFIC_LIGHTS_INSET = 78;

/** Section label + the add-project action, above this machine's projects. */
function ProjectsHeader() {
  const flow = useAddProject();

  return (
    <div className="flex-none">
      <div className={SECTION_HEADER}>
        Projects
        <SectionAddButton
          label="Add project"
          onClick={() => void flow.addProject()}
          pending={flow.isPending}
        />
      </div>
      <AddProjectPrompt flow={flow} className="mx-2.5 mb-1.5" />
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
      {/* Above the scroll area, not in it: without a tracker there are no tickets
          and no triage, so the way to connect stays in view however far the tree
          is scrolled. Nothing once a Linear workspace or Jira site is connected. */}
      <TrackerConnectPrompt />
      {/* One viewport for everything below the destinations. Triage, Projects
          and Daedalus scroll together rather than each inside a box of its own,
          so a long queue is scrolled past — or folded away — like any other
          section of the rail, never scrolled *within*. Triage leads because it is
          *incoming* work, the same reading order a project's Reviews section
          follows inside its own section; it draws nothing while triage is off,
          and a greyed-out heading while Linear isn't connected (see
          `TriageSection`). Daedalus follows this machine's projects: the same
          tree, over the repos that live on the home server, and nothing at all
          until Daedalus is set up (see `DaedalusSection`). The OS's overlay
          scrollbar, not the app's classic one (`scrollbar-native` in
          styles.css): the rail's rows run to its edge, and a scrollbar that
          took a gutter narrowed every one of them the moment the queue ran
          long. */}
      <div className="scrollbar-native flex min-h-0 flex-1 flex-col overflow-y-auto">
        <TriageSection />
        <ProjectsHeader />
        <ProjectTree location="Local" emptyLabel="No projects on this machine" />
        <DaedalusSection />
      </div>
      <SidebarFooter />
      <EdgeResizeHandle edge="right" {...resize} />
    </div>
  );
}
