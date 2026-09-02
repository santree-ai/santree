/**
 * The full-width ticket page: the Linear issue a piece of work is about, at
 * reading width — {@link IssueHeader} over the description and comment thread.
 *
 * One page, three hosts: Triage's detail column, the worktree's "Linear" tab and
 * the pull request's. The rail's {@link IssuePane} is the same ticket at
 * side-panel density, and this is what its "Open in a tab" expands into. It owns
 * its own reads and writes, so it renders with no view provider around it — a
 * main-area tab has none to offer it.
 *
 * Linear's images need no attachment map: the bodies carry `data:` URIs or public
 * links, unlike a GitHub body's signed uploads (see `MarkdownAttachments`).
 */
import type { ReactNode } from "react";

import {
  useLinearReadOnly,
  useRefreshTriage,
  useTriageDetail,
  useTriageSetState,
} from "../lib/queries";
import { DiscussionPane, DiscussionSkeleton } from "./IssueDiscussion";
import { IssueHeader, type IssueSummary } from "./IssueHeader";
import { EmptyState } from "./primitives";

export function IssuePage({
  repo,
  ticketId,
  summary,
  actions,
}: {
  repo: string;
  ticketId: string;
  /** The ticket's row, when the host already holds one — draws the header's
   *  frame before the detail lands. See {@link IssueSummary}. */
  summary?: IssueSummary;
  /** Host actions for the header, after "Open Issue". */
  actions?: ReactNode;
}) {
  const { data } = useTriageDetail(repo, ticketId);
  // Only this ticket's detail counts: a read still carrying the previous id must
  // not render its body under this one's header.
  const detail = data?.id === ticketId ? data : undefined;
  const { refresh, fetching } = useRefreshTriage(repo, ticketId);
  const setState = useTriageSetState(repo);
  const linearReadOnly = useLinearReadOnly(repo);

  // Linear's definitive "no such issue" — a branch named like a ticket, a ticket
  // since deleted. Not a failure to report, and the same words the rail's pane
  // uses for it.
  if (data === null) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-app">
        <EmptyState title="No linked ticket" subtitle={`Linear has no issue ${ticketId}.`} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-app">
      <IssueHeader
        id={ticketId}
        detail={detail}
        summary={summary}
        onSetState={(stateId) => setState.mutate({ ticketId, stateId })}
        linearReadOnly={linearReadOnly}
        onRefresh={refresh}
        refreshing={fetching}
        actions={actions}
      />
      {detail ? <DiscussionPane detail={detail} repo={repo} /> : <DiscussionSkeleton />}
    </div>
  );
}
