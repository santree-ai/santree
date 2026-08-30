/**
 * The sidebar's navigation block: Search, then the destinations that aren't a
 * worktree.
 *
 * Search leads the list as a row like the others rather than as a field — the
 * palette is the app's only cross-entity search, and a keyboard-only entry point
 * is invisible to anyone who hasn't been told about it. It reads as a destination
 * because that is what it does: it takes you to something.
 *
 * Counts are the standing "how much is waiting" signal now that no view carries a
 * header summary of its own. Triage's count is the untriaged queue, so it reads
 * as work to pick up; the others are plain totals.
 */
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useTriageQueue, useViewCounts } from "../../lib/queries";
import { useApp, useAppUi } from "../../state/AppContext";
import { ListIcon, PrIcon, SearchIcon, TelescopeIcon } from "../icons";

interface NavItem {
  label: string;
  icon: ReactNode;
  /** A routed destination — the row is active while the router is under it. */
  path?: string;
  /** An action instead of a route (Search opens the palette). */
  action?: () => void;
  /** Shown at the row's trailing edge for an action row, where a count would be. */
  hint?: string;
  count?: number;
  /** Render the count as "act on this", not as a total. */
  urgent?: boolean;
}

export function SidebarNav() {
  const navigate = useNavigate();
  const { activeRepo, triageEnabled } = useApp();
  const { toggleCommandPalette } = useAppUi();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const counts = useViewCounts(activeRepo);
  // Two Linear calls, so only asked for when the destination is actually reachable.
  const { visible: triageVisible } = useTriageQueue(triageEnabled ? activeRepo : "");

  const items: NavItem[] = [
    { label: "Search", icon: <SearchIcon size={13} />, action: toggleCommandPalette, hint: "⌘K" },
    ...(triageEnabled
      ? [
          {
            label: "Triage",
            path: "/triage",
            icon: <TelescopeIcon size={13} />,
            count: triageVisible.length,
            urgent: true,
          },
        ]
      : []),
    { label: "Tickets", path: "/issues", icon: <ListIcon size={12} />, count: counts.tasks },
    { label: "Reviews", path: "/reviews", icon: <PrIcon size={12} />, count: counts.reviews },
  ];

  return (
    <nav className="flex flex-none flex-col gap-0.5 px-2.5 pb-2">
      {items.map((item) => {
        const active = item.path !== undefined && pathname.startsWith(item.path);
        const onClick = item.action ?? (() => navigate({ to: item.path }));
        return (
          <button
            key={item.label}
            type="button"
            onClick={onClick}
            aria-current={active ? "page" : undefined}
            className={`flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] font-medium transition-colors ${
              active ? "bg-hover-2 text-fg" : "text-muted-4 hover:bg-hover hover:text-fg-2"
            }`}
          >
            {item.icon}
            {item.label}
            {item.hint && (
              <kbd className="ml-auto rounded border border-line px-1 py-px font-sans text-[10px] text-muted-5">
                {item.hint}
              </kbd>
            )}
            {item.count !== undefined && item.count > 0 && (
              <span
                className={`ml-auto min-w-4 rounded-full px-1.5 text-center text-[10px] leading-4 ${
                  item.urgent
                    ? "bg-[var(--color-status-amber)] font-semibold text-black"
                    : "bg-hover-2 text-muted-4"
                }`}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
