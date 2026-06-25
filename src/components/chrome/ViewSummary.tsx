/** The right-aligned status summary in the content header, derived per tab. */
import { useRouterState } from "@tanstack/react-router";

import { useTasks, useTriageTickets, useWorktrees } from "../../lib/queries";
import { useApp } from "../../state/AppContext";

export function ViewSummary() {
  const { accent, activeRepo } = useApp();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: tasks = [] } = useTasks(activeRepo);
  const { data: worktrees = [] } = useWorktrees();
  const { data: triage = [] } = useTriageTickets();

  const path = pathname === "" ? "/" : pathname;
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
    <div className="font-mono text-[11px] text-muted-4">
      {lead}
      <span style={{ color }}>{value}</span>
    </div>
  );
}
