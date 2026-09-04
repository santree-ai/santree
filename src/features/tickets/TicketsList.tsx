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
import { useCallback, useState } from "react";

import { EmptyState, Skeleton } from "../../components/primitives";
import {
  BAND_LABEL_X,
  INDENT_PX,
  MilestoneHeading,
  PROJECT_LABEL_X,
  ProjectHeading,
  showMilestoneGroups,
} from "../../components/WorkSignals";
import { toggleDisclosureMap } from "../../lib/disclosure";
import { useAppUi } from "../../state/AppContext";
import { useWorkRepoGate } from "../../state/WorkRepoGate";
import { useIssues } from "../issues/model";
import { TicketRow } from "./TicketRow";
import { useStartTicket } from "./useStartTicket";
import type { TicketRow as Row, TicketProjectGroup } from "./useTickets";

/** Where a row's words start under each heading: the heading's own label
 *  column (the constants beside the shared headings in `WorkSignals`), never
 *  its chevron — a key in line with the chevron reads as the heading's sibling.
 *  A milestone heading steps in one indent from its project, and its rows hang
 *  from *its* label. */
const PROJECT_ROW_X = PROJECT_LABEL_X;
const MILESTONE_ROW_X = INDENT_PX + BAND_LABEL_X;

/** Placeholder rows while the per-repo reads are in flight. "We haven't looked
 *  yet" must not render as "there is nothing" — see {@link EmptyState}'s callers. */
function TicketSkeleton() {
  return (
    <div className="px-2 pt-3" aria-hidden>
      {Array.from({ length: 10 }, (_, i) => (
        // Static placeholders in a fixed-length list — no identity to key by.
        <div key={i} className="flex h-8 items-center gap-2" style={{ paddingLeft: PROJECT_ROW_X }}>
          <Skeleton className="h-2.5 w-14" />
          <Skeleton className="h-2.5" style={{ width: `${[38, 52, 44, 60, 34][i % 5]}%` }} />
        </div>
      ))}
    </div>
  );
}

export function TicketsList({
  groups,
  loading,
}: {
  groups: TicketProjectGroup[];
  loading: boolean;
}) {
  const { requestTreeFocus } = useAppUi();
  const navigate = useNavigate();
  const {
    focusId,
    setFocus,
    rightCollapsed,
    toggleRightPanel,
    selected,
    toggle: toggleQueued,
    enqueueIn,
    isEligible,
    setRailTab,
  } = useIssues();
  const startTicket = useStartTicket();
  const askRepo = useWorkRepoGate();

  // Folded groups, keyed by the group key (and `${key}:${milestone}` below).
  // `scope` is what a ⌘-click reaches — a project's milestones — per the one
  // disclosure rule every folding heading in the app follows.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = useCallback(
    (key: string, scope: readonly string[], bulk: boolean) =>
      setCollapsed((c) => toggleDisclosureMap(c, key, scope, bulk)),
    [],
  );

  // A click opens the ticket in the inspector beside the list. It used to be a
  // three-part hop — switch the app's project, hand the id over as a focus
  // request, wait for that project's tasks to land — because the inspector was
  // scoped to whichever project was active and a ticket is not scoped at all.
  // The inspector reads through its own stable scope now, and a ticket read
  // there is the same ticket, so a click just focuses it. The panel is expanded
  // if it was collapsed, and turned to the ticket pane — a click that selects
  // something the user can't see would read as a click that did nothing.
  const onOpen = useCallback(
    (row: Row) => {
      setFocus(row.task.id);
      setRailTab("issue");
      if (rightCollapsed) toggleRightPanel();
    },
    [setFocus, setRailTab, rightCollapsed, toggleRightPanel],
  );

  // Which project a ticket starts in is the gate's answer — the one project
  // that carries it, the Work default, or the question — and the queue takes the
  // same answer, so a ticket can't be queued somewhere it wouldn't have been
  // run. Taking one back out asks nothing.
  const onToggleQueue = useCallback(
    (row: Row) => {
      if (selected[row.task.id]) {
        toggleQueued(row.task.id);
        return;
      }
      void askRepo(row.repos, `Queueing ${row.task.id}`).then((repo: string | null) => {
        if (repo) enqueueIn(repo, row.task.id);
      });
    },
    [selected, toggleQueued, askRepo, enqueueIn],
  );

  const onStart = useCallback(
    (row: Row, opts: { background: boolean; pick?: boolean }) => {
      void askRepo(row.repos, `Starting ${row.task.id}`, { always: opts.pick }).then(
        (repo: string | null) => {
          if (!repo) return;
          startTicket(
            { repo, id: row.task.id, title: row.task.title, project: row.task.project },
            { background: opts.background },
          );
        },
      );
    },
    [askRepo, startTicket],
  );

  // The worktree already on a started ticket, in Trees — the row's chip names
  // it but can't open it, so the menu does. It lives in the row's home repo,
  // which every other view is scoped to, so the app switches there first (the
  // sidebar's own three-part handoff).
  const onOpenWorktree = useCallback(
    (row: Row) => {
      if (!row.worktree) return;
      navigate({ to: "/trees", search: { project: row.repo, tree: row.worktree.id } });
      requestTreeFocus(row.repo, row.worktree.id);
    },
    [requestTreeFocus, navigate],
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

  /** What a group's tickets add up to, for its heading. */
  const points = (items: Row[]) => items.reduce((sum, row) => sum + (row.task.estimate ?? 0), 0);

  // Every row can be queued now: the queue remembers which project each ticket
  // goes to (answered by the gate on the way in), so it is no longer "the active
  // project's" and a ticket no project of the app's was pointed at is no longer
  // silently unqueueable.
  const rows = (items: Row[], indent: number) =>
    items.map((row) => {
      const home = row.repos.length > 0;
      return (
        <TicketRow
          key={row.task.id}
          row={row}
          indent={indent}
          active={home && row.task.id === focusId}
          queued={home && !!selected[row.task.id]}
          onOpen={onOpen}
          onStart={onStart}
          onToggleQueue={home && isEligible(row.task) ? onToggleQueue : undefined}
          onOpenWorktree={onOpenWorktree}
        />
      );
    });

  return (
    // `px-2`: every row's fill is a rounded object inset from the panel's
    // edges, not a band that runs into the borders on either side. The headings
    // bring their own `px-2` and so start one step in from the fills.
    <div className="flex-1 overflow-y-auto px-2 pb-6">
      {groups.map((group) => {
        const open = !collapsed[group.key];
        const milestoneKeys = group.milestones.map((m) => `${group.key}:${m.key}`);
        return (
          <div key={group.key}>
            <ProjectHeading
              label={group.project}
              count={group.count}
              color={group.color}
              icon={group.icon}
              targetDate={group.targetDate}
              points={points(group.milestones.flatMap((m) => m.items))}
              open={open}
              onToggle={(bulk) => toggle(group.key, milestoneKeys, bulk)}
            />
            {open &&
              (showMilestoneGroups(group.milestones)
                ? group.milestones.map((milestone) => {
                    const key = `${group.key}:${milestone.key}`;
                    const milestoneOpen = !collapsed[key];
                    return (
                      <div key={milestone.key}>
                        {/* Only the heading steps in; its rows stay full width
                            so every row's fill starts at the same edge. */}
                        <div style={{ paddingLeft: INDENT_PX }}>
                          <MilestoneHeading
                            label={milestone.label}
                            count={milestone.items.length}
                            targetDate={milestone.targetDate}
                            points={points(milestone.items)}
                            open={milestoneOpen}
                            onToggle={(bulk) => toggle(key, [], bulk)}
                          />
                        </div>
                        {milestoneOpen && rows(milestone.items, MILESTONE_ROW_X)}
                      </div>
                    );
                  })
                : rows(group.milestones[0]?.items ?? [], PROJECT_ROW_X))}
          </div>
        );
      })}
    </div>
  );
}
