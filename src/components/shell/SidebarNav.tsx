/**
 * The sidebar's navigation block: a search affordance over the three destinations
 * that aren't a worktree.
 *
 * Search is rendered as a row rather than hidden behind ⌘K alone — the palette is
 * the app's only cross-entity search, and a keyboard-only entry point is
 * invisible to anyone who hasn't been told about it.
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
  path: string;
  icon: ReactNode;
  count?: number;
  /** Render the count as "act on this", not as a total. */
  urgent?: boolean;
}

/** The ⌘K palette, surfaced as a clickable row so it can also be found by mouse. */
function SearchRow() {
  const { toggleCommandPalette } = useAppUi();
  return (
    <button
      type="button"
      onClick={toggleCommandPalette}
      className="mx-2.5 mb-2 flex h-7 cursor-pointer items-center gap-2 rounded-md border border-line bg-surface px-2 text-[12px] text-muted-4 transition-colors hover:border-line-strong hover:text-fg-2"
    >
      <SearchIcon size={13} />
      Search
      <kbd className="ml-auto rounded border border-line px-1 py-px font-sans text-[10px] text-muted-5">
        ⌘K
      </kbd>
    </button>
  );
}

export function SidebarNav() {
  const navigate = useNavigate();
  const { activeRepo, triageEnabled, devEnabled } = useApp();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const counts = useViewCounts(activeRepo);
  // Two Linear calls, so only asked for when the destination is actually reachable.
  const { visible: triageVisible } = useTriageQueue(triageEnabled ? activeRepo : "");

  const items: NavItem[] = [
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
    ...(devEnabled ? [{ label: "Dev", path: "/dev", icon: <ListIcon size={12} /> }] : []),
  ];

  return (
    <>
      <SearchRow />
      <nav className="flex flex-none flex-col gap-px px-2.5 pb-1.5">
        {items.map((item) => {
          const active = pathname.startsWith(item.path);
          return (
            <button
              key={item.path}
              type="button"
              onClick={() => navigate({ to: item.path })}
              className={`flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] font-medium transition-colors ${
                active ? "bg-hover-2 text-fg" : "text-muted-4 hover:bg-hover hover:text-fg-2"
              }`}
            >
              {item.icon}
              {item.label}
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
    </>
  );
}
