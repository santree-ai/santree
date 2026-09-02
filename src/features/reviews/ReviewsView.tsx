/** The Reviews view: the pull request you picked, in full.
 *
 * The **sidebar is the inbox** — every project's Reviews section lists what is
 * waiting on you and what you opened (`components/shell/ProjectReviewsSection`),
 * and that is where a PR is chosen. This view is what opens when you choose one:
 * its metadata, conversation, checks and diff. It had a second rail of its own
 * that listed the same pull requests with a second grouping control; two lists of
 * one inbox, a click apart, is one list too many, and the one in the permanent
 * sidebar is the one you can reach from anywhere.
 *
 * With nothing selected it says so and points at the sidebar. It used to show a
 * landing page instead — a second inbox, reachable only by arriving here without
 * a PR in the url. Data comes from `useReviews`, which covers the whole registry, narrowed to the
 * project the route names (`?project=` — see `model.tsx`). The window chrome and
 * the app-wide navigation come from the app shell.
 */
import { ReviewsProvider } from "./model";
import { ReviewDetail } from "./ReviewDetail";
import { WorktreeGateProvider } from "./WorktreeGate";

export function ReviewsView() {
  return (
    <ReviewsProvider>
      {/* Around the whole view, because the surfaces that need a checkout are
          scattered through it — the tab strip's "+", the panes' empty states,
          the brief's start button — and they must all ask the same question. */}
      <WorktreeGateProvider>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <ReviewDetail />
          </div>
        </div>
      </WorktreeGateProvider>
    </ReviewsProvider>
  );
}
