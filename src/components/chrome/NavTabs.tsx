/** Top navigation tabs, shown in the content area's header (right of the sidebar). */
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useAttentionCount } from "../../features/agents/useAgents";
import { useTriageQueue, useViewCounts } from "../../lib/queries";
import { useApp } from "../../state/AppContext";
import { sessionStateMeta } from "../../theme/colors";
import { AgentsIcon, ListIcon, PrIcon, TelescopeIcon, TerminalIcon, TreeIcon } from "../icons";
import { Badge, Tabs } from "../primitives";

interface TabDef {
  label: string;
  path: string;
  icon: ReactNode;
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
      icon: <AgentsIcon size={13} />,
      // Not a count of agents — a count of agents *blocked on you*. The nav bar
      // is the only chrome visible from every view, so it carries the alert.
      badge: (
        <span className="flex items-center gap-1">
          <Badge color="var(--color-status-amber)">WIP</Badge>
          {needsYou > 0 && (
            <span
              className="font-mono text-[10px] font-semibold"
              style={{ color: sessionStateMeta.waiting.color }}
            >
              {needsYou}
            </span>
          )}
        </span>
      ),
    },
    // Dev sits beside Agents: both span every repo rather than being scoped to
    // the active one, which is what the divider below separates.
    ...(devEnabled ? [{ label: "Dev", path: "/dev", icon: <TerminalIcon size={12} /> }] : []),
    ...(triageEnabled
      ? [
          {
            label: "Triage",
            path: "/triage",
            icon: <TelescopeIcon size={13} />,
            count: triageVisible.length,
          },
        ]
      : []),
    { label: "Issues", path: "/issues", icon: <ListIcon size={12} />, count: counts.tasks },
    { label: "Trees", path: "/trees", icon: <TreeIcon size={12} />, count: counts.worktrees },
    { label: "Reviews", path: "/reviews", icon: <PrIcon size={12} />, count: counts.reviews },
  ];

  // The rule drawn after the last repo-independent tab, splitting "spans
  // everything" from "scoped to the active repo".
  const dividerAfter = devEnabled ? "/dev" : "/";

  // The tab value is the route path; navigation happens in onChange. Counts ride
  // along in the shared `badge` slot. The `inset` variant matches the chrome's
  // full-height underline look.
  return (
    <Tabs
      tabs={defs.map((t, index) => ({
        value: t.path,
        label: t.label,
        title: `${t.label} (⌘${index + 1})`,
        icon: t.icon,
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
