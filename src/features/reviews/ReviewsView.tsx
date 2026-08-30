/** The Reviews view: an org-scoped GitHub pull-request dashboard. Its own left
 *  column splits PRs into collapsible "My PRs" (by repo), individual review
 *  requests, and one block per team; the pane to its right shows the selected
 *  PR's metadata, conversation, and diff. Data is scoped to the org of the
 *  active repo (`useReviews`). The window chrome and the app-wide navigation
 *  come from the app shell — this view renders only its own two columns. */
import { ReviewsProvider } from "./model";
import { ReviewDetail } from "./ReviewDetail";
import { ReviewsSidebar } from "./ReviewsSidebar";

/** Width of the inbox column. Fixed: the shell owns the resizable app sidebar,
 *  and this column is a list of uniform rows rather than a variable-depth tree. */
const INBOX_WIDTH = 300;

export function ReviewsView() {
  return (
    <ReviewsProvider>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          <div
            className="flex flex-none flex-col border-r border-line bg-panel"
            style={{ width: INBOX_WIDTH }}
          >
            <ReviewsSidebar />
          </div>
          <ReviewDetail />
        </div>
      </div>
    </ReviewsProvider>
  );
}
