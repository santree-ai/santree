/**
 * The Linear ticket a piece of work is about, rendered like the Triage detail —
 * id · priority · state · title · the meta row (author, labels, points, cycle,
 * due date), then the description and comment thread. Reference for the work
 * happening beside it.
 *
 * One pane, two hosts: the worktree's Issue tab (the ticket the branch was cut
 * for) and the pull request's (the ticket its title or branch names). They were
 * two files rendering the same {@link DiscussionPane} over the same
 * `useTriageDetail`, differing only in where the id came from and how much
 * padding they used — a split that cost a second copy of every fix.
 *
 * Laid out for a side panel, not a full pane: the shared discussion runs at its
 * `dense` gutter, and the header trades Triage's breathing room for line length.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect } from "react";

import { useTriageDetail } from "../lib/queries";
import { priorityColor } from "../theme/colors";
import { DiscussionPane, DiscussionSkeleton } from "./IssueDiscussion";
import { IssueMeta } from "./IssueMeta";
import { ExpandIcon, LinearLogo } from "./icons";
import { MarkdownTitle } from "./Markdown";
import { Button, Dot, EmptyState } from "./primitives";

export function IssuePane({
  repo,
  ticketId,
  onResolvedTitle,
  fallbackTitle,
  onExpand,
}: {
  repo: string;
  ticketId: string | null;
  /** Fired with the live Linear title once it resolves. The caller decides
   *  whether it differs from what it holds and what to do about it — a worktree
   *  self-heals its cached title from this, which is a worktree concern and not
   *  something a ticket-rendering pane should know about. */
  onResolvedTitle?: (title: string) => void;
  /** What to show until Linear answers. A worktree already holds the ticket's
   *  title, and falling back to the bare id would blank a name the caller could
   *  have shown all along — the id is true, but it is not what was there a
   *  moment ago. Absent for a PR, whose ticket the app has never fetched. */
  fallbackTitle?: string;
  /** Open the same ticket as a main-area tab, at reading width (the host's
   *  `IssuePage`). The control is drawn only when a host offers it. */
  onExpand?: () => void;
}) {
  const { data: detail } = useTriageDetail(repo, ticketId);
  // Only treat the fetched detail as this ticket's once its id matches (avoids
  // flashing the previous one's body while a new one loads).
  const ready = ticketId && detail?.id === ticketId ? detail : undefined;

  const liveTitle = ready?.title;
  useEffect(() => {
    if (liveTitle) onResolvedTitle?.(liveTitle);
  }, [liveTitle, onResolvedTitle]);

  // Two ways to have no ticket, one thing to say: nothing carried an id, or it
  // carried one Linear has no issue for (`detail === null`) — a branch named like
  // a ticket, a ticket since deleted. Neither is a failure to report.
  if (!ticketId || detail === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-app">
        <EmptyState
          title="No linked ticket"
          subtitle={
            ticketId
              ? `Linear has no issue ${ticketId}.`
              : "This PR's title has no ticket id (e.g. [AK-123])."
          }
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-app">
      <div className="flex-none border-b border-hairline px-3 pt-3 pb-3">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="font-mono text-[11px] text-muted-2">{ticketId}</span>
          {/* Both signals, because they answer different questions and the union
              is cheap: the dot's colour is the ticket's *priority* (how much it
              matters) and the label beside it is its workflow *state* (how far it
              has got). Each pane used to show one and read as complete — "Urgent"
              says nothing about whether it is already in review, and "In Review"
              nothing about whether it should have shipped last week. */}
          {ready && (
            <span className="flex items-center gap-1.5 text-[11px] text-muted-2">
              <Dot color={priorityColor[ready.priority]} size={7} />
              {ready.state}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {ready && (
              <Button size="sm" onClick={() => openUrl(ready.url)} title="Open in Linear">
                <LinearLogo size={11} className="text-[color:var(--linear-brand)]" />
                Open
              </Button>
            )}
            {onExpand && (
              // A square the height of the chip beside it, so the two read as one
              // cluster whether or not "Open" has loaded in yet.
              <button
                type="button"
                onClick={onExpand}
                title="Open in a tab"
                aria-label="Open in a tab"
                className="flex h-[27px] w-[27px] flex-none cursor-pointer items-center justify-center rounded-md border border-line-2 bg-input text-muted-2 transition-colors hover:border-line-strong hover:text-fg-2"
              >
                <ExpandIcon size={12} />
              </button>
            )}
          </div>
        </div>
        <MarkdownTitle className="block text-[13.5px] leading-[1.35] font-semibold text-fg-bright">
          {ready?.title ?? fallbackTitle ?? ticketId}
        </MarkdownTitle>
        {ready && <IssueMeta detail={ready} dense className="mt-2" />}
      </div>
      {ready ? <DiscussionPane detail={ready} repo={repo} dense /> : <DiscussionSkeleton dense />}
    </div>
  );
}
