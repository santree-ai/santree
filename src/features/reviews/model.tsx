/**
 * Reviews tab view-model: the org-scoped PR inbox plus the current selection.
 *
 * Mirrors `features/trees/model.tsx` — server data comes from the `useReviews`
 * query; this context only holds the ephemeral selection and exposes the inbox to
 * the sidebar and detail panel. A PR pill elsewhere in the app can deep-link here
 * by setting `reviewFocus` (the PR url) on AppContext, which we resolve to a
 * selection once the inbox is loaded.
 */
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

import type { ReviewInbox, ReviewPr } from "../../bindings";
import { useReviews } from "../../lib/queries";
import { useApp, useAppUi } from "../../state/AppContext";

interface ReviewsModel {
  repo: string;
  inbox: ReviewInbox | undefined;
  loading: boolean;
  /** Every PR across all categories, for selection lookup. */
  allPrs: ReviewPr[];
  activeId: string | null;
  setActive: (id: string | null) => void;
  /** The currently selected PR, or null. */
  active: ReviewPr | null;
}

const ReviewsContext = createContext<ReviewsModel | null>(null);

export function ReviewsProvider({ children }: { children: ReactNode }) {
  const { activeRepo: repo } = useApp();
  const { reviewFocus, consumeReviewFocus } = useAppUi();
  const { data: inbox, isLoading } = useReviews(repo);
  const [activeId, setActiveId] = useState<string | null>(null);

  const allPrs = useMemo(
    () => (inbox ? [...inbox.mine, ...inbox.requested, ...inbox.teams.flatMap((t) => t.prs)] : []),
    [inbox],
  );

  // Select the first PR once the inbox loads, and re-select when the current
  // selection falls out of the list — e.g. after switching the active repo (and
  // thus the org), where the old activeId no longer exists and the detail pane
  // would otherwise go blank.
  useEffect(() => {
    if (allPrs.length > 0 && !allPrs.some((p) => p.id === activeId)) {
      setActiveId(allPrs[0].id);
    }
  }, [activeId, allPrs]);

  // Resolve a cross-view deep-link (PR pill → Reviews) to a selection.
  useEffect(() => {
    if (!reviewFocus) return;
    const match = allPrs.find((p) => p.url === reviewFocus);
    if (match) {
      setActiveId(match.id);
      consumeReviewFocus();
    }
  }, [reviewFocus, allPrs, consumeReviewFocus]);

  const value = useMemo<ReviewsModel>(
    () => ({
      repo,
      inbox,
      loading: isLoading,
      allPrs,
      activeId,
      setActive: setActiveId,
      active: allPrs.find((p) => p.id === activeId) ?? null,
    }),
    [repo, inbox, isLoading, allPrs, activeId],
  );

  return <ReviewsContext.Provider value={value}>{children}</ReviewsContext.Provider>;
}

export function useReviewsModel(): ReviewsModel {
  const ctx = useContext(ReviewsContext);
  if (!ctx) throw new Error("useReviewsModel must be used within <ReviewsProvider>");
  return ctx;
}
