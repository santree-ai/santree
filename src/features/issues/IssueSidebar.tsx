/** Left rail of the Issues tab: header, grouped ticket list, launch tray, footer. */

import type { CSSProperties } from "react";
import { useMemo, useState } from "react";

import { ChevronDownIcon } from "../../components/icons";
import { Button, Dot, ProjectGlyph } from "../../components/primitives";
import { SidebarFooter } from "../../components/SidebarFooter";
import { ProjectDueDate } from "../../components/WorkSignals";
import { usePrefetchOnHover } from "../../lib/queries";
import { useApp } from "../../state/AppContext";
import {
  accentActiveStyle,
  accentFillVar,
  PROJECT_FALLBACK,
  statusColor,
  successColor,
} from "../../theme/colors";
import { IssueRow, type IssueRowVM } from "./IssueRow";
import { LaunchPanel } from "./LaunchPanel";
import { deriveIssueState, useIssueHover, useIssues } from "./model";

interface Group {
  project: string;
  color: string;
  icon: string | null;
  targetDate: string | null;
  rows: IssueRowVM[];
}

export function IssueSidebar() {
  const {
    tasks,
    projectMeta,
    worktreeIds,
    selected,
    focusId,
    focusProject,
    baseFor,
    isEligible,
    toggle,
    revealInGraph,
    revealProject,
    selectReady,
  } = useIssues();
  const { setHover } = useIssueHover();
  const { activeRepo } = useApp();
  const prefetchOnHover = usePrefetchOnHover(activeRepo);

  // Which project groups are collapsed in the list (sidebar-local).
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggleCollapsed = (project: string) =>
    setCollapsed((c) => ({ ...c, [project]: !c[project] }));
  // ⌘/Ctrl+click a chevron collapses or expands *every* project at once.
  const setAllCollapsed = (value: boolean) =>
    setCollapsed(Object.fromEntries(groups.map((g) => [g.project, value])));

  // Ready (launchable) tickets, and whether they're all already queued — drives
  // the "Select Ready" button's count and its toggled-on styling.
  const readyIds = useMemo(
    () => tasks.filter((t) => t.ready && isEligible(t)).map((t) => t.id),
    [tasks, isEligible],
  );
  const allReadySelected = readyIds.length > 0 && readyIds.every((id) => selected[id]);

  const groups = useMemo<Group[]>(() => {
    // The sidebar is the viewer's own work queue — grayed context blockers live
    // only in the graph, never here.
    const mine = tasks.filter((t) => t.actionable);
    const order: string[] = [];
    for (const t of mine) if (!order.includes(t.project)) order.push(t.project);

    return order
      .map((project) => {
        const rows = mine.filter((t) => t.project === project);

        const mapped = rows.map<IssueRowVM>((t) => {
          const hasWorktree = worktreeIds.has(t.id);
          const st = deriveIssueState(t, {
            selected: !!selected[t.id],
            baseFor,
            hasWorktree,
          });
          const selectable = isEligible(t);
          const isFocused = focusId === t.id;
          const dim = focusProject !== null && t.project !== focusProject;

          const opacity = dim ? 0.4 : 1;
          const rowStyle: CSSProperties = { opacity };
          const boxStyle: CSSProperties = {
            // Non-selectable rows still show a faint (disabled) box so every row
            // keeps the same checkbox column and alignment.
            border: `1.5px solid ${selectable ? (st.selected ? accentFillVar : "var(--color-dot)") : "var(--color-line-2)"}`,
            background: st.selected ? accentFillVar : "transparent",
          };

          return {
            id: t.id,
            title: t.title,
            statusColor: statusColor[t.status],
            priority: t.priority,
            estimate: t.estimate,
            active: isFocused,
            selectable,
            selected: st.selected,
            showRdy: st.ready,
            showChain: st.chainable,
            chainBase: st.chainBase,
            showBlocked: st.blocked,
            showWorking: hasWorktree,
            rowStyle,
            boxStyle,
            onReveal: () => revealInGraph(t.id),
            onToggleSelect: () => toggle(t.id),
            onHover: () => {
              setHover(t.id);
              // Prewarm the detail so clicking shows it instantly (no skeleton flash).
              prefetchOnHover(t.id);
            },
          };
        });

        const meta = projectMeta.get(project);
        return {
          project,
          color: meta?.color ?? PROJECT_FALLBACK,
          icon: meta?.icon ?? null,
          targetDate: meta?.targetDate ?? null,
          rows: mapped,
        };
      })
      .filter((g) => g.rows.length > 0);
  }, [
    tasks,
    projectMeta,
    worktreeIds,
    selected,
    focusId,
    focusProject,
    baseFor,
    isEligible,
    toggle,
    revealInGraph,
    setHover,
    prefetchOnHover,
  ]);

  return (
    <>
      <div className="flex h-10 flex-none items-center gap-2 border-b border-hairline pr-2.5 pl-[15px]">
        <span className="text-[12px] font-semibold tracking-[.01em] text-fg-2">Issues</span>
        <span className="font-mono text-[10.5px] text-muted-4">
          {tasks.filter((t) => t.actionable).length}
        </span>
        <Button
          size="sm"
          onClick={selectReady}
          disabled={readyIds.length === 0}
          title="Add all ready tickets to the launch selection"
          className="ml-auto"
          style={allReadySelected ? accentActiveStyle() : undefined}
        >
          <Dot color={successColor} size={6} />
          Select Ready {readyIds.length}
        </Button>
      </div>

      {/* biome-ignore lint/a11y/noStaticElementInteractions: clears the decorative hover highlight */}
      <div className="flex-1 overflow-y-auto p-2" onMouseLeave={() => setHover(null)}>
        {groups.map((g) => {
          const isCollapsed = !!collapsed[g.project];
          const focused = focusProject === g.project;
          return (
            <div key={g.project}>
              <div className="flex items-center gap-0.5 pt-2.5 pr-1.5 pb-[5px] pl-0.5">
                <button
                  type="button"
                  onClick={(e) =>
                    e.metaKey || e.ctrlKey
                      ? setAllCollapsed(!isCollapsed)
                      : toggleCollapsed(g.project)
                  }
                  className="flex flex-none cursor-pointer items-center justify-center rounded p-1 text-muted-4 hover:text-fg-2"
                  aria-label={isCollapsed ? "Expand project" : "Collapse project"}
                  title={`${isCollapsed ? "Expand" : "Collapse"} (⌘-click for all)`}
                >
                  <ChevronDownIcon
                    size={11}
                    className={
                      isCollapsed ? "-rotate-90 transition-transform" : "transition-transform"
                    }
                  />
                </button>
                <button
                  type="button"
                  onClick={() => revealProject(g.project)}
                  title="Show in graph"
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-[7px] rounded-md px-1 py-0.5 text-left hover:bg-hover"
                >
                  <ProjectGlyph color={g.color} icon={g.icon} size={7} />
                  <span
                    className="overflow-hidden text-[11.5px] font-semibold text-ellipsis whitespace-nowrap"
                    style={{ color: focused ? "var(--accent-text)" : "var(--color-fg-2)" }}
                  >
                    {g.project}
                  </span>
                  <span className="font-mono text-[9.5px] text-muted-4">{g.rows.length}</span>
                  <ProjectDueDate date={g.targetDate} />
                </button>
              </div>
              {!isCollapsed && g.rows.map((vm) => <IssueRow key={vm.id} vm={vm} />)}
            </div>
          );
        })}
      </div>

      <LaunchPanel />
      <SidebarFooter />
    </>
  );
}
