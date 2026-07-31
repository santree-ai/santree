/** Top navigation tabs, shown in the content area's header (right of the sidebar). */
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useAttentionCount } from "../../features/agents/useAgents";
import { useTriageQueue, useViewCounts } from "../../lib/queries";
import { useApp } from "../../state/AppContext";
import { sessionStateMeta } from "../../theme/colors";
import { Tabs } from "../primitives";

interface TabDef {
  label: string;
  path: string;
  count?: number;
  badge?: ReactNode;
}

export function NavTabs() {
  const { accent, triageEnabled, devEnabled, activeRepo } = useApp();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const counts = useViewCounts(activeRepo);
  // Only fetch the triage queue (2 Linear GraphQL calls) when the tab is actually
  // shown — useTriageTickets/useTriageSchedule already no-op on an empty repo.
  const { visible: triageVisible } = useTriageQueue(triageEnabled ? activeRepo : "");
  const needsYou = useAttentionCount();

  const activePath = pathname === "" ? "/" : pathname;
  const defs: TabDef[] = [
    {
      label: "Agents",
      path: "/",
      // Not a count of agents — a count of agents *blocked on you*. The nav bar
      // is the only chrome visible from every view, so it carries the alert.
      badge:
        needsYou > 0 ? (
          <span
            className="font-mono text-[10px] font-semibold"
            style={{ color: sessionStateMeta.waiting.color }}
          >
            {needsYou}
          </span>
        ) : undefined,
    },
    // Dev sits beside Agents: both span every repo rather than being scoped to
    // the active one, which is what the divider below separates.
    ...(devEnabled ? [{ label: "Dev", path: "/dev" }] : []),
    ...(triageEnabled ? [{ label: "Triage", path: "/triage", count: triageVisible.length }] : []),
    { label: "Issues", path: "/issues", count: counts.tasks },
    { label: "Trees", path: "/trees", count: counts.worktrees },
    { label: "Reviews", path: "/reviews", count: counts.reviews },
  ];

  // The rule drawn after the last repo-independent tab, splitting "spans
  // everything" from "scoped to the active repo".
  const dividerAfter = devEnabled ? "/dev" : "/";

  // The tab value is the route path; navigation happens in onChange. Counts ride
  // along in the shared `badge` slot. The `inset` variant matches the chrome's
  // full-height underline look.
  return (
    <Tabs
      tabs={defs.map((t) => ({
        value: t.path,
        label: t.label,
        separatorAfter: t.path === dividerAfter,
        badge:
          t.badge ??
          (t.count !== undefined ? (
            <span className="font-mono text-[10px] text-muted-4">{t.count}</span>
          ) : undefined),
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
