/** Left rail of the Issues tab: header, grouped ticket list, launch tray, footer. */

import type { CSSProperties } from "react";
import { useMemo } from "react";

import { Dot } from "../../components/primitives";
import { SidebarFooter } from "../../components/SidebarFooter";
import { colorForProject, statusColor } from "../../theme/colors";
import { IssueRow, type IssueRowVM } from "./IssueRow";
import { LaunchPanel } from "./LaunchPanel";
import { useIssues } from "./model";

const accent = "var(--accent)";
const alpha = (pct: number) => `color-mix(in srgb, var(--accent) ${pct}%, transparent)`;

interface Group {
  project: string;
  color: string;
  rows: IssueRowVM[];
}

export function IssueSidebar() {
  const {
    tasks,
    sessionByTask,
    selected,
    focusId,
    focusProject,
    readyFilter,
    baseFor,
    isEligible,
    toggle,
    toggleReadyFilter,
  } = useIssues();

  const readyCount = useMemo(
    () => tasks.filter((t) => t.ready && !sessionByTask.has(t.id)).length,
    [tasks, sessionByTask],
  );

  const groups = useMemo<Group[]>(() => {
    const order: string[] = [];
    for (const t of tasks) if (!order.includes(t.project)) order.push(t.project);

    return order
      .map((project) => {
        let rows = tasks.filter((t) => t.project === project);
        if (readyFilter) rows = rows.filter((t) => isEligible(t));

        const mapped = rows.map<IssueRowVM>((t) => {
          const session = sessionByTask.get(t.id);
          const running = !!session && session.stage < 4;
          const done = !!session && session.stage >= 4;
          const chainBase = t.ready ? null : baseFor(t);
          const chainable = chainBase !== null && !session;
          const selectable = isEligible(t);
          const isSelected = !!selected[t.id] && !session;
          const focused = focusId === t.id;
          const dim = focusProject !== null && t.project !== focusProject;

          const rowStyle: CSSProperties = {
            background: isSelected ? alpha(12) : focused ? "var(--color-hover)" : "transparent",
            border: `1px solid ${isSelected ? alpha(40) : "transparent"}`,
            opacity: dim ? 0.4 : 1,
          };
          const boxStyle: CSSProperties = {
            border: `1.5px solid ${selectable ? (isSelected ? accent : "var(--color-dot)") : "transparent"}`,
            background: isSelected ? accent : "transparent",
          };

          return {
            id: t.id,
            title: t.title,
            statusColor: statusColor[t.status],
            selectable,
            selected: isSelected,
            showRdy: t.ready && !session,
            showChain: chainable,
            chainBase,
            showBlocked: !t.ready && !chainable && !session,
            showRun: running,
            runColor: done ? "#3fb950" : accent,
            showDone: done,
            prMini: done && session ? `#${session.pr}` : "",
            rowStyle,
            boxStyle,
            onClick: () => toggle(t.id),
          };
        });

        return { project, color: colorForProject(project), rows: mapped };
      })
      .filter((g) => g.rows.length > 0);
  }, [
    tasks,
    sessionByTask,
    selected,
    focusId,
    focusProject,
    readyFilter,
    baseFor,
    isEligible,
    toggle,
  ]);

  const readyFilterStyle: CSSProperties = readyFilter
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
        <span className="font-mono text-[10.5px] text-muted-4">{tasks.length}</span>
        <button
          type="button"
          onClick={toggleReadyFilter}
          className="ml-auto flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] transition-all hover:border-line-strong"
          style={readyFilterStyle}
        >
          <Dot color="#3fb950" size={6} />
          Ready {readyCount}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {groups.map((g) => (
          <div key={g.project}>
            <div className="flex items-center gap-[7px] px-1.5 pt-2.5 pb-[5px]">
              <Dot color={g.color} size={7} />
              <span className="overflow-hidden text-[11.5px] font-semibold text-ellipsis whitespace-nowrap text-fg-2">
                {g.project}
              </span>
              <span className="font-mono text-[9.5px] text-muted-4">{g.rows.length}</span>
            </div>
            {g.rows.map((vm) => (
              <IssueRow key={vm.id} vm={vm} />
            ))}
          </div>
        ))}
      </div>

      <LaunchPanel />
      <SidebarFooter />
    </>
  );
}
