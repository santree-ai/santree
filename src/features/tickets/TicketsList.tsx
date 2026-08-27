/**
 * List mode: every ticket, every repo, one scroll.
 *
 * The page is a flat scroll of grouped rows rather than a rail beside a canvas —
 * the question it answers is "what is there to pick up", which is a reading
 * question, not a navigation one. Grouping is project → milestone, the same
 * shape (and the same helpers) the graph's bands and the Trees rail use, so a
 * project reads the same wherever it appears.
 */
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";

import { ChevronDownIcon } from "../../components/icons";
import { EmptyState, ProjectGlyph, Skeleton } from "../../components/primitives";
import {
  MilestoneHeading,
  ProjectDueDate,
  showMilestoneGroups,
} from "../../components/WorkSignals";
import { useApp, useAppUi } from "../../state/AppContext";
import { TicketRow } from "./TicketRow";
import { useStartTicket } from "./useStartTicket";
import type { TicketRow as Row, TicketProjectGroup } from "./useTickets";

/** Placeholder rows while the per-repo reads are in flight. "We haven't looked
 *  yet" must not render as "there is nothing" — see {@link EmptyState}'s callers. */
function TicketSkeleton() {
  return (
    <div className="px-2 pt-3" aria-hidden>
      {Array.from({ length: 10 }, (_, i) => (
        // Static placeholders in a fixed-length list — no identity to key by.
        <div key={i} className="flex h-8 items-center gap-2 px-2">
          <Skeleton className="h-2.5 w-[52px]" />
          <Skeleton className="h-2.5" style={{ width: `${[38, 52, 44, 60, 34][i % 5]}%` }} />
        </div>
      ))}
    </div>
  );
}

function ProjectHeading({
  group,
  showRepo,
  open,
  onToggle,
}: {
  group: TicketProjectGroup;
  /** Repos are only worth naming once more than one contributes tickets. */
  showRepo: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 pt-3 pb-1 text-left hover:bg-hover"
    >
      <ChevronDownIcon
        size={11}
        className={`flex-none text-muted-4 ${open ? "transition-transform" : "-rotate-90 transition-transform"}`}
      />
      <ProjectGlyph color={group.color} icon={group.icon} size={7} />
      <span className="truncate text-[12px] font-semibold text-fg-2">{group.project}</span>
      <span className="font-mono text-[10px] text-muted-4">{group.count}</span>
      {showRepo && (
        <span className="truncate font-mono text-[10px] text-muted-5">{group.repo}</span>
      )}
      <ProjectDueDate date={group.targetDate} />
    </button>
  );
}

export function TicketsList({
  groups,
  loading,
  /** Flip the page to Graph mode — where a ticket with no worktree opens. */
  onShowGraph,
}: {
  groups: TicketProjectGroup[];
  loading: boolean;
  onShowGraph: () => void;
}) {
  const { setActiveRepo } = useApp();
  const { requestTreeFocus, requestIssueFocus } = useAppUi();
  const navigate = useNavigate();
  const startTicket = useStartTicket();

  // Folded groups, keyed by the group key (and `${key}:${milestone}` below).
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggleCollapsed = useCallback(
    (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] })),
    [],
  );

  const showRepo = useMemo(() => new Set(groups.map((g) => g.repo)).size > 1, [groups]);

  // Opening is repo-scoped on the other side: Trees and the graph both show one
  // repo, so a ticket from elsewhere makes its repo active on the way over.
  const onOpen = useCallback(
    (row: Row) => {
      setActiveRepo(row.repo);
      if (row.worktree) {
        requestTreeFocus(row.task.id);
        navigate({ to: "/trees" });
        return;
      }
      requestIssueFocus(row.task.id);
      onShowGraph();
    },
    [setActiveRepo, requestTreeFocus, requestIssueFocus, navigate, onShowGraph],
  );

  const onStart = useCallback(
    (row: Row, background: boolean) =>
      startTicket(
        { repo: row.repo, id: row.task.id, title: row.task.title, project: row.task.project },
        { background },
      ),
    [startTicket],
  );

  if (loading && groups.length === 0) return <TicketSkeleton />;

  if (groups.length === 0) {
    return (
      <EmptyState
        title="No tickets"
        subtitle="Connect a repo to Linear, or turn off the actionable-only filter to see the tickets you're not assigned."
      />
    );
  }

  return (
    <div className="flex-1 overflow-y-auto pb-6">
      {groups.map((group) => {
        const open = !collapsed[group.key];
        return (
          <div key={group.key}>
            <ProjectHeading
              group={group}
              showRepo={showRepo}
              open={open}
              onToggle={() => toggleCollapsed(group.key)}
            />
            {open &&
              (showMilestoneGroups(group.milestones)
                ? group.milestones.map((milestone) => {
                    const key = `${group.key}:${milestone.key}`;
                    const milestoneOpen = !collapsed[key];
                    return (
                      <div key={milestone.key} className="pl-4">
                        <MilestoneHeading
                          label={milestone.label}
                          count={milestone.items.length}
                          targetDate={milestone.targetDate}
                          open={milestoneOpen}
                          onToggle={() => toggleCollapsed(key)}
                        />
                        {milestoneOpen &&
                          milestone.items.map((row) => (
                            <TicketRow
                              key={row.task.id}
                              row={row}
                              onOpen={onOpen}
                              onStart={onStart}
                            />
                          ))}
                      </div>
                    );
                  })
                : group.milestones[0]?.items.map((row) => (
                    <TicketRow key={row.task.id} row={row} onOpen={onOpen} onStart={onStart} />
                  )))}
          </div>
        );
      })}
    </div>
  );
}
