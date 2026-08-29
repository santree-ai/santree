/**
 * Shared issue "discussion" rendering: the markdown description plus the
 * threaded comment list, with inline images. Used by the Triage view's main
 * pane and the Issues view's Description tab so both render Linear issues
 * identically. Memoized on `detail` so toggling visibility never re-parses the
 * markdown — only genuinely new detail data does.
 */
import { memo, useState } from "react";

import type { TriageComment, TriageDetail } from "../bindings";
import { LINEAR_READ_ONLY_HINT, useAddComment, useLinearReadOnly } from "../lib/queries";
import { Avatar } from "./Avatar";
import { Markdown } from "./Markdown";
import { Button, Skeleton } from "./primitives";
import { RelativeTime } from "./RelativeTime";

export function countComments(comments: TriageComment[]): number {
  return comments.reduce((n, c) => n + 1 + countComments(c.children), 0);
}

/** Optimistically-added comments carry a temp id until the refetch replaces
 *  them; dim those so a slow post reads as in-flight, not committed. */
const isPending = (c: TriageComment) => c.id.startsWith("pending-");

/**
 * Inline comment editor. Posts a top-level comment when `parentId` is null, or a
 * reply to that comment otherwise. ⌘/Ctrl+Enter sends; Esc cancels a reply.
 */
function CommentComposer({
  repo,
  ticketId,
  parentId = null,
  autoFocus = false,
  onClose,
  placeholder = "Leave a comment…",
}: {
  repo: string;
  ticketId: string;
  parentId?: string | null;
  autoFocus?: boolean;
  onClose?: () => void;
  placeholder?: string;
}) {
  const [body, setBody] = useState("");
  const add = useAddComment(repo);
  const readOnly = useLinearReadOnly(repo);
  const trimmed = body.trim();

  const submit = () => {
    // Guarded here rather than only on the button: ⌘⏎ reaches this directly, and
    // a disabled button would still leave the keyboard path open.
    if (!trimmed || add.isPending || readOnly) return;
    // `useAddComment` appends the comment to the thread optimistically, so the
    // field has to empty at once too — clearing only on success shows the text
    // twice for the length of the round-trip. A failed post rolls the comment
    // back (and toasts), so put the draft back rather than losing what was typed.
    setBody("");
    add.mutate(
      { ticketId, parentId, body: trimmed },
      {
        onSuccess: () => onClose?.(),
        onError: () => setBody(trimmed),
      },
    );
  };

  return (
    <div>
      <textarea
        // biome-ignore lint/a11y/noAutofocus: a reply composer opens on explicit click; focusing it is the intent
        autoFocus={autoFocus}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape" && onClose) {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder={readOnly ? "Linear is connected read-only" : placeholder}
        disabled={readOnly}
        rows={parentId ? 2 : 3}
        className="w-full resize-y rounded-lg border border-line-2 bg-input px-3 py-2 text-[12px] leading-[1.55] text-fg-2 placeholder:text-muted-4 focus:border-line-strong focus:outline-none"
      />
      <div className="mt-1.5 flex items-center justify-end gap-2">
        <span className="mr-auto text-[9.5px] text-muted-4">
          {readOnly ? LINEAR_READ_ONLY_HINT : <span className="font-mono">⌘⏎ to send</span>}
        </span>
        {onClose && (
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          onClick={submit}
          disabled={!trimmed || add.isPending || readOnly}
        >
          {add.isPending ? "Posting…" : parentId ? "Reply" : "Comment"}
        </Button>
      </div>
    </div>
  );
}

function CommentHead({ comment, size }: { comment: TriageComment; size: number }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <Avatar name={comment.author} src={comment.avatarUrl} size={size} />
      <span className="text-[11.5px] font-medium text-fg-2">{comment.author}</span>
      <RelativeTime ms={comment.createdAtMs} className="font-mono text-[10px] text-muted-4" />
    </div>
  );
}

function CommentItem({
  comment,
  repo,
  ticketId,
}: {
  comment: TriageComment;
  repo: string;
  ticketId: string;
}) {
  const [replying, setReplying] = useState(false);
  const readOnly = useLinearReadOnly(repo);
  return (
    <div
      className="rounded-[10px] border border-hairline bg-panel px-3.5 py-3"
      style={isPending(comment) ? { opacity: 0.55 } : undefined}
    >
      <CommentHead comment={comment} size={22} />
      <Markdown>{comment.body}</Markdown>

      {comment.children.length > 0 && (
        // Threaded replies — indented under a connector rail, no separate card.
        <div className="mt-3.5 space-y-3.5 border-l-2 border-line-2 pl-3.5">
          {comment.children.map((child, i) => (
            <div key={`${child.id}-${i}`} style={isPending(child) ? { opacity: 0.55 } : undefined}>
              <CommentHead comment={child} size={18} />
              <Markdown>{child.body}</Markdown>
            </div>
          ))}
        </div>
      )}

      {/* Reply targets this thread's root (Linear threads are one level deep).
          Hidden for optimistic comments — there's no real id to reply to yet. */}
      {!isPending(comment) &&
        (replying ? (
          <div className="mt-3 border-l-2 border-line-2 pl-3.5">
            <CommentComposer
              repo={repo}
              ticketId={ticketId}
              parentId={comment.id}
              autoFocus
              placeholder="Write a reply…"
              onClose={() => setReplying(false)}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setReplying(true)}
            disabled={readOnly}
            title={readOnly ? LINEAR_READ_ONLY_HINT : undefined}
            className="mt-2.5 cursor-pointer text-[11px] font-medium text-muted-3 hover:text-fg-2 disabled:cursor-default disabled:opacity-50 disabled:hover:text-muted-3"
          >
            Reply
          </button>
        ))}
    </div>
  );
}

/** The issue body + comment thread, no scroll wrapper — for embedding in a pane
 *  that scrolls other sections (e.g. dependencies) alongside it. */
export const DiscussionContent = memo(function DiscussionContent({
  detail,
  repo,
}: {
  detail: TriageDetail;
  repo: string;
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

      <div className="mt-6">
        {total > 0 && (
          <>
            <div className="mb-3 font-mono text-[9px] tracking-[.07em] text-muted-4 uppercase">
              {total} {total === 1 ? "comment" : "comments"}
            </div>
            <div className="mb-4 space-y-3.5">
              {detail.comments.map((c, i) => (
                <CommentItem key={`${c.id}-${i}`} comment={c} repo={repo} ticketId={detail.id} />
              ))}
            </div>
          </>
        )}
        <CommentComposer repo={repo} ticketId={detail.id} />
      </div>
    </>
  );
});

/** The pane's own gutter. `dense` is for the workspace's right panel, which can be
 *  as narrow as 240px — a reading gutter sized for Triage's wide column eats a
 *  seventh of the line there. */
const DISCUSSION_GUTTER = { normal: "px-5 py-[18px]", dense: "px-3 py-3.5" } as const;

/** The issue body + comment thread. Scrolls within its own pane. */
export const DiscussionPane = memo(function DiscussionPane({
  detail,
  repo,
  dense = false,
}: {
  detail: TriageDetail;
  repo: string;
  dense?: boolean;
}) {
  return (
    <div
      className={`min-w-0 flex-1 overflow-x-hidden overflow-y-auto ${DISCUSSION_GUTTER[dense ? "dense" : "normal"]}`}
    >
      <DiscussionContent detail={detail} repo={repo} />
    </div>
  );
});

/** Placeholder shown while a freshly-selected issue's detail loads. */
export function DiscussionSkeleton({ dense = false }: { dense?: boolean }) {
  return (
    <div className={`flex-1 overflow-y-auto ${DISCUSSION_GUTTER[dense ? "dense" : "normal"]}`}>
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
