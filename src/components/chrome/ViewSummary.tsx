/** The right-aligned status summary in the content header, derived per tab. */
import { useRouterState } from "@tanstack/react-router";

import { useViewCounts } from "../../lib/queries";
import { useApp } from "../../state/AppContext";

export function ViewSummary() {
  const { accent, activeRepo } = useApp();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const counts = useViewCounts(activeRepo);

  const path = pathname === "" ? "/" : pathname;
  let lead = "";
  let value = "";
  let color = "var(--color-status-green)";

  if (path.startsWith("/issues")) {
    lead = `${counts.tasks} tasks · `;
    value = `${counts.tasksReady} ready`;
    // Agents has no header summary — its own sub-bar already carries the totals,
    // and the nav badge carries the "needs you" count.
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
    <div className="font-mono text-[11px] text-muted-4">
      {lead}
      <span style={{ color }}>{value}</span>
    </div>
  );
}
