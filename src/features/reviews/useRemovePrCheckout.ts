/**
 * Deleting a pull request's checkout, from wherever the user reaches for it: the
 * sidebar row's menu, the rail's bar, the AI review's footer.
 *
 * The removal itself is optimistic (`useRemoveReviewWorkspace`). What this adds is
 * the half that belongs to the *sessions* the checkout hosted: an AI review runs
 * in that directory, so once it is gone the process is working in a path that no
 * longer exists, and its stored conversation would resume a review of code that
 * isn't on disk. Both go too — after the removal succeeds, never before, for the
 * reason `useWorktreeDeletion` gives: a failed delete must leave the conversation
 * to come back to. The transcript stays on disk, so Session history still opens
 * the same review.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";

import type { ReviewPr } from "../../bindings";
import { queryKeys, useCloseReviewSession, useRemoveReviewWorkspace } from "../../lib/queries";
import { useTerminals } from "../terminal/TerminalsContext";
import { aiReviewTermKey, REVIEW_AGENTS } from "./checkoutSource";

/** What follows a PR's checkout being gone, whichever way it went: its AI
 *  review sessions end — the live panes, and the stored conversations that would
 *  put the tabs (and the sidebar's agent rows) back — and the cached read of the
 *  checkout is looked at again, since it can name the very worktree just deleted. */
export function useCheckoutRemoved(repo: string): (pr: ReviewPr) => void {
  const qc = useQueryClient();
  // Through a ref, like `useWorktreeDeletion`: the tab list changes on every
  // terminal event, and the callback must stay stable and still see the latest.
  const { tabs, close } = useTerminals();
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const { mutateAsync: forget } = useCloseReviewSession(repo);

  return useCallback(
    (pr: ReviewPr) => {
      const termKey = aiReviewTermKey(pr);
      void qc.invalidateQueries({ queryKey: queryKeys.reviewCheckout(repo, pr.repo, pr.number) });
      for (const tab of tabsRef.current) if (tab.refId === termKey) close(tab.key);
      // The rows the sidebar's agent summary is built from. A closed pane
      // re-reads them by itself; a conversation with no pane open does not.
      void Promise.allSettled(
        REVIEW_AGENTS.map((agent) => forget({ prRepo: pr.repo, number: pr.number, agent })),
      ).then(() => qc.invalidateQueries({ queryKey: queryKeys.sessionStates }));
    },
    [close, forget, qc, repo],
  );
}

/** Remove a PR's review checkout, optimistically, and end its AI reviews once it
 *  is gone. `pending` is this site's own in-flight flag; the rest of the app
 *  reads `usePrCheckoutRemovals`. */
export function useRemoveReviewCheckout(repo: string): {
  remove: (pr: ReviewPr) => void;
  pending: boolean;
} {
  const { mutateAsync, isPending } = useRemoveReviewWorkspace(repo);
  const checkoutRemoved = useCheckoutRemoved(repo);

  const remove = useCallback(
    (pr: ReviewPr) => {
      // A promise continuation, not `mutate`'s callbacks: those are dropped when
      // the observer unmounts, and a PR row or a rail scrolls away mid-delete.
      // The failure is toasted (and the cache rolled back) by the mutation itself.
      void mutateAsync({ prRepo: pr.repo, number: pr.number, headSha: pr.headSha }).then(
        () => checkoutRemoved(pr),
        () => {},
      );
    },
    [mutateAsync, checkoutRemoved],
  );

  return { remove, pending: isPending };
}
