/** Top navigation tabs, shown in the content area's header (right of the sidebar). */
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { useTerminals } from "../../features/terminal/TerminalsContext";
import { useTasks, useTriageTickets, useWorktrees } from "../../lib/queries";
import { useApp } from "../../state/AppContext";

interface TabDef {
  key: string;
  label: string;
  path: string;
  count?: number;
}

export function NavTabs() {
  const { accent, triageEnabled, activeRepo } = useApp();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: worktrees = [] } = useWorktrees();
  const { data: triage = [] } = useTriageTickets(activeRepo);
  const { data: tasks = [] } = useTasks(activeRepo);
  const { tabs: terminals } = useTerminals();

  const activePath = pathname === "" ? "/" : pathname;
  const tabs: TabDef[] = [
    ...(triageEnabled
      ? [{ key: "triage", label: "Triage", path: "/triage", count: triage.length }]
      : []),
    { key: "issues", label: "Issues", path: "/", count: tasks.length },
    { key: "trees", label: "Trees", path: "/trees", count: worktrees.length },
    {
      key: "reviews",
      label: "Reviews",
      path: "/reviews",
      count: worktrees.filter((w) => w.pr).length,
    },
    { key: "terminal", label: "Terminal", path: "/terminal", count: terminals.length },
  ];

  return (
    <div className="flex h-full items-stretch gap-0.5">
      {tabs.map((tab) => {
        const active = tab.path === activePath;
        const style: CSSProperties = active
          ? {
              color: "var(--color-fg-bright)",
              fontWeight: 500,
              boxShadow: `inset 0 -2px 0 ${accent}`,
            }
          : { color: "#7c7c85" };
        return (
          <button
            type="button"
            key={tab.key}
            onClick={() => navigate({ to: tab.path })}
            className="flex cursor-pointer items-center gap-1.5 px-3 text-[13px]"
            style={style}
          >
            <span>{tab.label}</span>
            {tab.count !== undefined && (
              <span className="font-mono text-[10px] text-muted-4">{tab.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
