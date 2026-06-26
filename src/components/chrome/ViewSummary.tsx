/** The right-aligned status summary in the content header, derived per tab. */
import { useRouterState } from "@tanstack/react-router";

import { Badge } from "../../components/primitives";
import { useLinearStatus, useTasks, useTriageTickets, useWorktrees } from "../../lib/queries";
import { useApp } from "../../state/AppContext";

export function ViewSummary() {
  const { accent, activeRepo } = useApp();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: tasks = [] } = useTasks(activeRepo);
  const { data: worktrees = [] } = useWorktrees();
  const { data: triage = [] } = useTriageTickets(activeRepo);
  const { data: linear } = useLinearStatus(activeRepo);

  const path = pathname === "" ? "/" : pathname;
  // Issues and triage are live when a Linear org is connected; only the
  // unauthenticated fallback is the built-in sample data.
  const sample = (path === "/" || path.startsWith("/triage")) && !linear?.authenticated;
  let lead = "";
  let value = "";
  let color = "#3fb950";

  if (path === "/") {
    lead = `${tasks.length} tasks · `;
    value = `${tasks.filter((t) => t.ready).length} ready`;
  } else if (path.startsWith("/trees")) {
    lead = `${worktrees.length} worktrees · `;
    value = `${worktrees.filter((w) => w.activity === "Running").length} running`;
    color = accent;
  } else if (path.startsWith("/triage")) {
    value = `${triage.length} to triage`;
    color = "#f85149";
  } else if (path.startsWith("/reviews")) {
    value = `${worktrees.filter((w) => w.pr).length} awaiting review`;
    color = accent;
  }

  return (
    <div className="flex items-center gap-2.5">
      {sample && (path === "/" || path.startsWith("/triage")) && (
        <Badge color="var(--color-muted-2)">SAMPLE DATA</Badge>
      )}
      <div className="font-mono text-[11px] text-muted-4">
        {lead}
        <span style={{ color }}>{value}</span>
      </div>
    </div>
  );
}
