/**
 * List mode: every ticket, every repo, one scroll.
 *
 * The page is a flat scroll of grouped rows rather than a rail beside a canvas —
 * the question it answers is "what is there to pick up", which is a reading
 * question, not a navigation one. Grouping is project → milestone, the same
 * shape (and the same helpers) the graph's bands and the Trees rail use, so a
 * project reads the same wherever it appears.
 */
import { useCallback, useState } from "react";

import { ChevronDownIcon } from "../../components/icons";
import { EmptyState, ProjectGlyph, Skeleton } from "../../components/primitives";
import {
  MilestoneHeading,
  ProjectDueDate,
  showMilestoneGroups,
} from "../../components/WorkSignals";
import { useApp, useAppUi } from "../../state/AppContext";
import { useIssues } from "../issues/model";
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
  open,
  onToggle,
}: {
  group: TicketProjectGroup;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      // `tree-band`, the same container register the sidebar's bands use: this
      // folds its rows, it doesn't open anything, so it must not paint the fill
      // that means "selected" on the ticket rows below. The chevron carries the
      // hover feedback instead, since the label is already at full strength.
      className="tree-band group flex w-full cursor-pointer items-center gap-2 px-2 pt-3 pb-1 text-left"
    >
      <ChevronDownIcon
        size={11}
        className={`flex-none text-muted-4 transition-[transform,color] group-hover:text-muted-3 ${open ? "" : "-rotate-90"}`}
      />
      <ProjectGlyph color={group.color} icon={group.icon} size={7} />
      <span className="truncate text-[12px] font-semibold text-fg-2">{group.project}</span>
      <span className="font-mono text-[10px] text-muted-4">{group.count}</span>
      <ProjectDueDate date={group.targetDate} />
    </button>
  );
}

export function TicketsList({
  groups,
  loading,
}: {
  groups: TicketProjectGroup[];
  loading: boolean;
}) {
  const { activeRepo, setActiveRepo } = useApp();
  const { requestIssueFocus } = useAppUi();
  const { focusId, setFocus, rightCollapsed, toggleRightPanel } = useIssues();
  const startTicket = useStartTicket();

  // Folded groups, keyed by the group key (and `${key}:${milestone}` below).
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggleCollapsed = useCallback(
    (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] })),
    [],
  );

  // A click opens the ticket in the inspector beside the list. The inspector's
  // model is scoped to the active repo, and a ticket isn't — so the repo it is
  // read under is its home when it has one (its worktree lives there), else the
  // active repo when that carries it, else the first that does. A different repo
  // switches the app and hands the id over as a focus request, which the model
  // commits once that repo's tasks have landed; the same repo focuses at once.
  // The panel is expanded if it was collapsed — a click that selects something
  // the user can't see would read as a click that did nothing.
  const onOpen = useCallback(
    (row: Row) => {
      const repo = row.worktree || !row.repos.includes(activeRepo) ? row.repo : activeRepo;
      if (repo === activeRepo) {
        setFocus(row.task.id);
      } else {
        setActiveRepo(repo);
        requestIssueFocus(row.task.id);
      }
      if (rightCollapsed) toggleRightPanel();
    },
    [activeRepo, setActiveRepo, setFocus, requestIssueFocus, rightCollapsed, toggleRightPanel],
  );

  const onStart = useCallback(
    (row: Row, background: boolean, repo: string) =>
      startTicket(
        { repo, id: row.task.id, title: row.task.title, project: row.task.project },
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
            <ProjectHeading group={group} open={open} onToggle={() => toggleCollapsed(group.key)} />
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
                              active={row.repos.includes(activeRepo) && row.task.id === focusId}
                              onOpen={onOpen}
                              onStart={onStart}
                            />
                          ))}
                      </div>
                    );
                  })
                : group.milestones[0]?.items.map((row) => (
                    <TicketRow
                      key={row.task.id}
                      row={row}
                      active={row.repos.includes(activeRepo) && row.task.id === focusId}
                      onOpen={onOpen}
                      onStart={onStart}
                    />
                  )))}
          </div>
        );
      })}
    </div>
  );
}
