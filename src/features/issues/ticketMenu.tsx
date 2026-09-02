/**
 * A ticket's right-click menu on the graph.
 *
 * The canvas has no row to wrap — a node is React Flow's, and the right-click
 * arrives as a canvas event with coordinates — so the rows are built here from
 * the model and the canvas opens them through `PositionedMenu`. They are the
 * inspector's own actions (run, run in the background, the queue, the worktree
 * already on a started ticket) followed by the Linear rows every ticket menu
 * shares, so a node and a list row offer the same things in the same words.
 */
import { useMemo } from "react";

import { BranchIcon, PlayIcon, QueueIcon } from "../../components/icons";
import { linearTicketItems } from "../../components/menuRows";
import type { ContextMenuItem } from "../../components/primitives";
import { useLinearIssueUrl } from "../../lib/queries";
import { useApp } from "../../state/AppContext";
import { useIssues } from "./model";

export function useTicketMenuItems(id: string | null): ContextMenuItem[] {
  const { byId, isEligible, selected, worktreeIds, run, runBackground, toggle, goToWorktree } =
    useIssues();
  const { activeRepo } = useApp();
  const linkFor = useLinearIssueUrl(activeRepo);

  return useMemo(() => {
    const task = id ? byId.get(id) : undefined;
    if (!task) return [];
    const items: ContextMenuItem[] = [];
    if (isEligible(task)) {
      items.push(
        {
          kind: "action",
          key: "run",
          label: "Run",
          icon: <PlayIcon size={12} />,
          run: () => run(task.id),
        },
        {
          kind: "action",
          key: "run-bg",
          label: "Run in the background",
          icon: <PlayIcon size={12} />,
          run: () => runBackground(task.id),
        },
        {
          kind: "action",
          key: "queue",
          label: selected[task.id] ? "Remove from queue" : "Add to queue",
          icon: <QueueIcon size={13} />,
          run: () => toggle(task.id),
        },
      );
    }
    if (worktreeIds.has(task.id)) {
      items.push({
        kind: "action",
        key: "worktree",
        label: "Open worktree",
        icon: <BranchIcon size={12} />,
        run: () => goToWorktree(task.id),
      });
    }
    if (items.length > 0) items.push({ kind: "rule", key: "rule-linear" });
    items.push(...linearTicketItems(task.id, linkFor(task.id)));
    return items;
  }, [
    id,
    byId,
    isEligible,
    selected,
    worktreeIds,
    run,
    runBackground,
    toggle,
    goToWorktree,
    linkFor,
  ]);
}
