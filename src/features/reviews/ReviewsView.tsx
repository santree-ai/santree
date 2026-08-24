/** The Reviews tab: an org-scoped GitHub pull-request dashboard. The sidebar
 *  splits PRs into collapsible "My PRs" (by repo), individual review requests,
 *  and one block per team; the main pane shows the selected PR's metadata,
 *  conversation, and diff. Data is scoped to the org of the active repo
 *  (`useReviews`). */
import { ViewChrome } from "../../components/chrome/ViewChrome";
import { ReviewsProvider } from "./model";
import { ReviewDetail } from "./ReviewDetail";
import { ReviewsSidebar } from "./ReviewsSidebar";

export function ReviewsView() {
  return (
    <ReviewsProvider>
      <ViewChrome sidebar={<ReviewsSidebar />}>
        <ReviewDetail />
      </ViewChrome>
    </ReviewsProvider>
  );
}
