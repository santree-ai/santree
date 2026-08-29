/**
 * Deleting a worktree, from wherever the user reaches for it.
 *
 * Two surfaces ask for this now — the Trees model's bulk "delete merged" and the
 * sidebar row's right-click menu — and the flow is not just the mutation. The
 * card has to vanish immediately (`pendingDeletes`, held as state rather than a
 * cache patch so the filesystem watcher's mid-delete refetch can't re-add a
 * half-deleted worktree with garbage stats), and every terminal rooted in the
 * worktree has to be torn down *after* the removal succeeds — leave one running
 * and its shell keeps working inside a directory that no longer exists, under a
 * dead name in the global Terminal tab.
 *
 * Ordering is deliberate: closing terminals first would destroy the agent session
 * and its context before we know the delete worked, and the optimistic rollback
 * can only bring the card back, not the conversation.
 */
import { useCallback, useRef } from "react";

import { BulkDeleteError, useRemoveWorktree, useRemoveWorktrees } from "../../lib/queries";
import { useAppUi } from "../../state/AppContext";
import type { TerminalTab } from "../terminal/orchestrator";
import { useTerminals } from "../terminal/TerminalsContext";

/** Terminal tabs belonging to a worktree: its main session (`tree:<id>`) and any
 *  extra terminals opened via the "+" tab (`tree:<id>:t<n>`). Exported for
 *  testing — see model.test.ts. */
export function tabsToCloseForWorktree(tabs: TerminalTab[], id: string): TerminalTab[] {
  const prefix = `tree:${id}`;
  return tabs.filter((t) => t.refId === prefix || t.refId?.startsWith(`${prefix}:`));
}

export interface WorktreeDeletion {
  /** Delete one worktree and its branch, in the background. */
  deleteWorktree: (id: string) => void;
  /** Delete several at once, in parallel. Survivors of a partial failure
   *  reappear; the ones that did delete stay hidden. */
  deleteWorktrees: (ids: string[]) => void;
}

export function useWorktreeDeletion(repo: string): WorktreeDeletion {
  const { addPendingDeletes, removePendingDelete } = useAppUi();
  const { mutate: removeOne } = useRemoveWorktree(repo);
  const { mutate: removeMany } = useRemoveWorktrees(repo);

  // The tab list changes on every terminal event. Read it through a ref so the
  // returned callbacks stay stable — the Trees model captures them into its
  // context-value memo, which would otherwise rebuild (re-rendering every
  // `useTrees()` consumer) whenever a terminal somewhere emitted output.
  const { tabs, close: closeTerminalTab } = useTerminals();
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const closeTerminals = useCallback(
    (ids: string[]) => {
      for (const id of ids) {
        for (const t of tabsToCloseForWorktree(tabsRef.current, id)) closeTerminalTab(t.key);
      }
    },
    [closeTerminalTab],
  );

  const deleteWorktree = useCallback(
    (id: string) => {
      addPendingDeletes([id]);
      removeOne(id, {
        onSuccess: () => closeTerminals([id]),
        onError: () => removePendingDelete(id),
      });
    },
    [addPendingDeletes, removePendingDelete, removeOne, closeTerminals],
  );

  const deleteWorktrees = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      addPendingDeletes(ids);
      removeMany(ids, {
        onSuccess: () => closeTerminals(ids),
        onError: (err) => {
          const failed = err instanceof BulkDeleteError ? err.failed : ids;
          closeTerminals(ids.filter((id) => !failed.includes(id)));
          for (const id of failed) removePendingDelete(id);
        },
      });
    },
    [addPendingDeletes, removePendingDelete, removeMany, closeTerminals],
  );

  return { deleteWorktree, deleteWorktrees };
}
