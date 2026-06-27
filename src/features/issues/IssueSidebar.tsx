/** Left rail of the Issues tab: header, grouped ticket list, launch tray, footer. */

import type { CSSProperties } from "react";
import { useMemo, useState } from "react";

import { ChevronDownIcon } from "../../components/icons";
import { Dot, ProjectGlyph } from "../../components/primitives";
import { SidebarFooter } from "../../components/SidebarFooter";
import { usePrefetchOnHover } from "../../lib/queries";
import { useApp } from "../../state/AppContext";
import {
  accentVar as accent,
  alpha,
  colorForProject,
  statusColor,
  successColor,
} from "../../theme/colors";
import { IssueRow, type IssueRowVM } from "./IssueRow";
import { LaunchPanel } from "./LaunchPanel";
import { deriveIssueState, useIssues } from "./model";

interface Group {
  project: string;
  color: string;
  icon: string | null;
  rows: IssueRowVM[];
}

export function IssueSidebar() {
  const {
    tasks,
    projectMeta,
    sessionByTask,
    selected,
    focusId,
    hoverId,
    focusProject,
    baseFor,
    isEligible,
    toggle,
    revealInGraph,
    revealProject,
    setHover,
    selectReady,
  } = useIssues();
  const { activeRepo } = useApp();
  const prefetchOnHover = usePrefetchOnHover(activeRepo);

  // Which project groups are collapsed in the list (sidebar-local).
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggleCollapsed = (project: string) =>
    setCollapsed((c) => ({ ...c, [project]: !c[project] }));

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
          const session = sessionByTask.get(t.id);
          const st = deriveIssueState(t, session, { selected: !!selected[t.id], baseFor });
          const selectable = isEligible(t);
          const focused = focusId === t.id || hoverId === t.id;
          const dim = focusProject !== null && t.project !== focusProject;

          const rowStyle: CSSProperties = {
            background: st.selected ? alpha(12) : focused ? "var(--color-hover)" : "transparent",
            border: `1px solid ${st.selected ? alpha(40) : "transparent"}`,
            opacity: dim ? 0.4 : 1,
          };
          const boxStyle: CSSProperties = {
            // Non-selectable rows still show a faint (disabled) box so every row
            // keeps the same checkbox column and alignment.
            border: `1.5px solid ${selectable ? (st.selected ? accent : "var(--color-dot)") : "var(--color-line-2)"}`,
            background: st.selected ? accent : "transparent",
          };

          return {
            id: t.id,
            title: t.title,
            statusColor: statusColor[t.status],
            selectable,
            selected: st.selected,
            showRdy: st.ready,
            showChain: st.chainable,
            chainBase: st.chainBase,
            showBlocked: st.blocked,
            showRun: st.running,
            runColor: st.runColor,
            showDone: st.done,
            prMini: st.done && session ? `#${session.pr}` : "",
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
          color: meta?.color ?? colorForProject(project),
          icon: meta?.icon ?? null,
          rows: mapped,
        };
      })
      .filter((g) => g.rows.length > 0);
  }, [
    tasks,
    projectMeta,
    sessionByTask,
    selected,
    focusId,
    hoverId,
    focusProject,
    baseFor,
    isEligible,
    toggle,
    revealInGraph,
    setHover,
    prefetchOnHover,
  ]);

  const selectReadyStyle: CSSProperties = allReadySelected
    ? { background: alpha(12), border: `1px solid ${alpha(40)}`, color: accent }
    : {
        background: "var(--color-input-alt)",
        border: "1px solid var(--color-line-3)",
        color: "var(--color-muted)",
      };

  return (
    <>
      <div className="flex h-10 flex-none items-center gap-2 border-b border-hairline pr-2.5 pl-[15px]">
        <span className="text-[12px] font-semibold tracking-[.01em] text-fg-2">Issues</span>
        <span className="font-mono text-[10.5px] text-muted-4">
          {tasks.filter((t) => t.actionable).length}
        </span>
        <button
          type="button"
          onClick={selectReady}
          disabled={readyIds.length === 0}
          title="Add all ready tickets to the launch selection"
          className="ml-auto flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] transition-all hover:border-line-strong disabled:cursor-default disabled:opacity-50"
          style={selectReadyStyle}
        >
          <Dot color={successColor} size={6} />
          Select Ready {readyIds.length}
        </button>
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
                  onClick={() => toggleCollapsed(g.project)}
                  className="flex flex-none cursor-pointer items-center justify-center rounded p-1 text-muted-4 hover:text-fg-2"
                  aria-label={isCollapsed ? "Expand project" : "Collapse project"}
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
