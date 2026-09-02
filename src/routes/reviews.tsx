import { createFileRoute } from "@tanstack/react-router";

import { ReviewsView } from "../features/reviews/ReviewsView";

export const Route = createFileRoute("/reviews")({
  // `?project=` is the registered project the inbox is scoped to — the sidebar's
  // per-project Reviews row is how you get here, and the scope has to survive a
  // reload or the row lands you somewhere else than it did a moment ago. Absent
  // means every project, which is what a PR that belongs to none of them needs.
  // `?pr=` is the open pull request's url. It lives in the route rather than in
  // view state because two surfaces need it: the detail pane, and the sidebar's
  // Reviews section, which has to light up the row you are looking at. Selection
  // held inside the view left the sidebar highlighting whatever worktree was
  // picked last — two selections on screen, neither of them the truth. A reload
  // lands back on the same PR as a consequence, not as a second mechanism.
  // `?queue=` is the merge queue, in the route for exactly the same reason: the
  // sidebar's merge-queue row is outside the view and cannot reach view state.
  // It and `?pr=` are two states of one pane, so each writer clears the other
  // (see `features/reviews/model.tsx`).
  validateSearch: (
    search: Record<string, unknown>,
  ): { project?: string; pr?: string; queue?: true } => ({
    project: typeof search.project === "string" && search.project ? search.project : undefined,
    pr: typeof search.pr === "string" && search.pr ? search.pr : undefined,
    // A hand-edited or reloaded url carries it as a string; a navigation carries
    // the boolean. Anything else is not the queue, and absent is not `false` —
    // the key simply leaves the url.
    queue: search.queue === true || search.queue === "true" ? true : undefined,
  }),
  component: ReviewsView,
});
