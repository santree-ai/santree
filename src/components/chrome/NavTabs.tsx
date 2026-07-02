/** Top navigation tabs, shown in the content area's header (right of the sidebar). */
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useTerminals } from "../../features/terminal/TerminalsContext";
import { useTriageQueue, useViewCounts } from "../../lib/queries";
import { useApp } from "../../state/AppContext";
import { Tabs } from "../primitives";

interface TabDef {
  label: string;
  path: string;
  count?: number;
}

export function NavTabs() {
  const { accent, triageEnabled, activeRepo } = useApp();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const counts = useViewCounts(activeRepo);
  // Only fetch the triage queue (2 Linear GraphQL calls) when the tab is actually
  // shown — useTriageTickets/useTriageSchedule already no-op on an empty repo.
  const { visible: triageVisible } = useTriageQueue(triageEnabled ? activeRepo : "");
  const { tabs: terminals } = useTerminals();

  const activePath = pathname === "" ? "/" : pathname;
  const defs: TabDef[] = [
    ...(triageEnabled ? [{ label: "Triage", path: "/triage", count: triageVisible.length }] : []),
    { label: "Issues", path: "/", count: counts.tasks },
    { label: "Trees", path: "/trees", count: counts.worktrees },
    { label: "Reviews", path: "/reviews", count: counts.reviews },
    { label: "Terminal", path: "/terminal", count: terminals.length },
  ];

  // The tab value is the route path; navigation happens in onChange. Counts ride
  // along in the shared `badge` slot. The `inset` variant matches the chrome's
  // full-height underline look.
  return (
    <Tabs
      tabs={defs.map((t) => ({
        value: t.path,
        label: t.label,
        badge:
          t.count !== undefined ? (
            <span className="font-mono text-[10px] text-muted-4">{t.count}</span>
          ) : undefined,
      }))}
      value={activePath}
      onChange={(path) => navigate({ to: path })}
      variant="inset"
      accent={accent}
      className="h-full items-stretch gap-0.5"
      tabClassName="h-full"
    />
  );
}
