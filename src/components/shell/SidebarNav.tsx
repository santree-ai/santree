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
 * header summary of its own; they are plain totals.
 *
 * Tickets wears the Linear mark: it is the Linear queue, and the mark is what
 * every ticket row further down the rail already leads with.
 *
 * **Reviews and Triage are deliberately absent.** One global Reviews entry could
 * only ever show one number for every project at once, which is the wrong shape
 * for an inbox that spans a registry: the answer you want is "does *this* project
 * need me", and it lives on each project's own Reviews row in the tree below.
 * Triage is a section of the rail in its own right (`TriageSection`, directly
 * under this block): its queue *is* the list, so a row that only counted it was
 * a click between you and the tickets. The routes still exist — the palette's
 * Reviews entry is the everything view, and a triage ticket opens at
 * `/triage?ticket=`.
 */
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useTicketCount } from "../../lib/queries";
import { useAppUi } from "../../state/AppContext";
import { LinearLogo, SearchIcon } from "../icons";

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
}

export function SidebarNav() {
  const navigate = useNavigate();
  const { toggleCommandPalette } = useAppUi();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const tasks = useTicketCount();

  const items: NavItem[] = [
    { label: "Search", icon: <SearchIcon size={13} />, action: toggleCommandPalette, hint: "⌘K" },
    { label: "Tickets", path: "/issues", icon: <LinearLogo size={12} />, count: tasks },
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
              <span className="ml-auto min-w-4 rounded-full bg-hover-2 px-1.5 text-center text-[10px] leading-4 text-muted-4">
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
