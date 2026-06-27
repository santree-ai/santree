/** The right-aligned status summary in the content header, derived per tab. */
import { useRouterState } from "@tanstack/react-router";

import { Badge } from "../../components/primitives";
import { useLinearStatus, useViewCounts } from "../../lib/queries";
import { useApp } from "../../state/AppContext";

export function ViewSummary() {
  const { accent, activeRepo } = useApp();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const counts = useViewCounts(activeRepo);
  const { data: linear } = useLinearStatus(activeRepo);

  const path = pathname === "" ? "/" : pathname;
  // Issues and triage are live when a Linear org is connected; the
  // unauthenticated fallback is sample data. Trees and Reviews have no live
  // backend yet, so they're always sample — flag both honestly.
  const sample =
    ((path === "/" || path.startsWith("/triage")) && !linear?.authenticated) ||
    path.startsWith("/trees") ||
    path.startsWith("/reviews");
  let lead = "";
  let value = "";
  let color = "var(--color-status-green)";

  if (path === "/") {
    lead = `${counts.tasks} tasks · `;
    value = `${counts.tasksReady} ready`;
  } else if (path.startsWith("/trees")) {
    lead = `${counts.worktrees} worktrees · `;
    value = `${counts.worktreesRunning} running`;
    color = accent;
    // Triage has no header summary — the tab badge already shows the count.
  } else if (path.startsWith("/reviews")) {
    value = `${counts.reviews} awaiting review`;
    color = accent;
  }

  return (
    <div className="flex items-center gap-2.5">
      {sample && <Badge color="var(--color-muted-2)">SAMPLE DATA</Badge>}
      <div className="font-mono text-[11px] text-muted-4">
        {lead}
        <span style={{ color }}>{value}</span>
      </div>
    </div>
  );
}
