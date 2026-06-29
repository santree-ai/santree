/**
 * Shared issue "discussion" rendering: the markdown description plus the
 * threaded comment list, with inline images. Used by the Triage view's main
 * pane and the Issues view's Description tab so both render Linear issues
 * identically. Memoized on `detail` so toggling visibility never re-parses the
 * markdown — only genuinely new detail data does.
 */
import { memo } from "react";

import type { TriageComment, TriageDetail } from "../bindings";
import { Avatar } from "./Avatar";
import { Markdown } from "./Markdown";
import { Skeleton } from "./primitives";

export function countComments(comments: TriageComment[]): number {
  return comments.reduce((n, c) => n + 1 + countComments(c.children), 0);
}

function CommentHead({ comment, size }: { comment: TriageComment; size: number }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <Avatar name={comment.author} src={comment.avatarUrl} size={size} />
      <span className="text-[11.5px] font-medium text-fg-2">{comment.author}</span>
      <span className="font-mono text-[10px] text-muted-4">{comment.created}</span>
    </div>
  );
}

function CommentItem({ comment }: { comment: TriageComment }) {
  return (
    <div className="rounded-[10px] border border-hairline bg-panel px-3.5 py-3">
      <CommentHead comment={comment} size={22} />
      <Markdown>{comment.body}</Markdown>

      {comment.children.length > 0 && (
        // Threaded replies — indented under a connector rail, no separate card.
        <div className="mt-3.5 space-y-3.5 border-l-2 border-line-2 pl-3.5">
          {comment.children.map((child, i) => (
            <div key={`${child.author}-${i}`}>
              <CommentHead comment={child} size={18} />
              <Markdown>{child.body}</Markdown>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The issue body + comment thread, no scroll wrapper — for embedding in a pane
 *  that scrolls other sections (e.g. dependencies) alongside it. */
export const DiscussionContent = memo(function DiscussionContent({
  detail,
}: {
  detail: TriageDetail;
}) {
  const total = countComments(detail.comments);
  return (
    <>
      {detail.description.trim() ? (
        <Markdown>{detail.description}</Markdown>
      ) : (
        // Be explicit about an empty body — a blank space reads as "failed to load".
        <p className="text-[12.5px] text-muted-4 italic">No description.</p>
      )}

      {total > 0 && (
        <div className="mt-6">
          <div className="mb-3 font-mono text-[9px] tracking-[.07em] text-muted-4 uppercase">
            {total} {total === 1 ? "comment" : "comments"}
          </div>
          <div className="space-y-3.5">
            {detail.comments.map((c, i) => (
              <CommentItem key={`${c.author}-${i}`} comment={c} />
            ))}
          </div>
        </div>
      )}
    </>
  );
});

/** The issue body + comment thread. Scrolls within its own pane. */
export const DiscussionPane = memo(function DiscussionPane({ detail }: { detail: TriageDetail }) {
  return (
    <div className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-5 py-[18px]">
      <DiscussionContent detail={detail} />
    </div>
  );
});

/** Placeholder shown while a freshly-selected issue's detail loads. */
export function DiscussionSkeleton() {
  return (
    <div className="flex-1 overflow-y-auto px-5 py-[18px]">
      <div className="space-y-2.5">
        <Skeleton className="h-3.5 w-1/3" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-11/12" />
        <Skeleton className="h-3 w-4/5" />
        <Skeleton className="mt-4 h-28 w-full rounded-lg" />
        <Skeleton className="h-3 w-3/4" />
      </div>
      <div className="mt-7 space-y-3.5">
        {[0, 1].map((i) => (
          <div key={i} className="rounded-[10px] border border-hairline bg-panel px-3.5 py-3">
            <div className="mb-2 flex items-center gap-2">
              <Skeleton className="h-5 w-5 rounded-full" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-3 w-full" />
            <Skeleton className="mt-1.5 h-3 w-5/6" />
          </div>
        ))}
      </div>
    </div>
  );
}
