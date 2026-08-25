/**
 * The "Issue" tab: the Linear ticket linked to the PR — the same shared discussion
 * view the Trees "Issue" tab uses. `ticketId` is null when neither the PR title nor
 * its branch carries one (see `ticket.ts`).
 */
import { openUrl } from "@tauri-apps/plugin-opener";

import { Avatar } from "../../components/Avatar";
import { DiscussionPane, DiscussionSkeleton } from "../../components/IssueDiscussion";
import { LinearLogo } from "../../components/icons";
import { MarkdownTitle } from "../../components/Markdown";
import { Button, Dot, EmptyState } from "../../components/primitives";
import { RelativeTime } from "../../components/RelativeTime";
import { useTriageDetail } from "../../lib/queries";
import { priorityColor } from "../../theme/colors";

export function ReviewIssuePane({ repo, ticketId }: { repo: string; ticketId: string | null }) {
  const { data: detail } = useTriageDetail(repo, ticketId);
  // Guard against flashing the previous ticket's body while a new one loads.
  const ready = ticketId && detail?.id === ticketId ? detail : undefined;

  if (!ticketId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-app">
        <EmptyState
          title="No linked ticket"
          subtitle="This PR's title has no ticket id (e.g. [AK-123])."
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-app">
      <div className="flex-none border-b border-hairline px-5 pt-4 pb-3.5">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="font-mono text-[11px] text-muted-2">{ticketId}</span>
          {ready && (
            <span className="flex items-center gap-1.5 text-[11px] text-muted-2">
              <Dot color={priorityColor[ready.priority]} size={7} />
              {ready.state}
            </span>
          )}
          {ready && (
            <Button
              size="sm"
              onClick={() => openUrl(ready.url)}
              title="Open in Linear"
              className="ml-auto"
            >
              <LinearLogo size={11} className="text-[color:var(--linear-brand)]" />
              Open
            </Button>
          )}
        </div>
        <MarkdownTitle className="block text-[15px] leading-[1.3] font-semibold text-fg-bright">
          {ready?.title ?? ticketId}
        </MarkdownTitle>
        {ready && (
          <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[10.5px] text-muted-3">
            <span className="flex items-center gap-1.5">
              <Avatar name={ready.author} src={ready.authorAvatarUrl} size={15} />
              {ready.author}
            </span>
            <span className="text-muted-5">·</span>
            <RelativeTime ms={ready.createdAtMs} />
            {ready.labels.map((l) => (
              <span
                key={l}
                className="rounded border border-line-2 bg-input px-1.5 py-px font-mono text-[9.5px] text-muted-2"
              >
                {l}
              </span>
            ))}
          </div>
        )}
      </div>
      {ready ? <DiscussionPane detail={ready} repo={repo} /> : <DiscussionSkeleton />}
    </div>
  );
}
