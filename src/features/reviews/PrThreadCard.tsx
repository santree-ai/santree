/**
 * One inline review-comment thread, rendered GitHub-style: a header row that
 * shows the anchor (file:line), a resolved/outdated badge, and the comment count,
 * with the comments below — and, at the foot, the two things you actually do with
 * someone else's comment: **reply** to it and **resolve** it. **Resolved threads
 * start collapsed** to just the header (click to expand); unresolved threads start
 * open. Used both anchored in the diff (via {@link PrFileDiff}'s
 * `renderExtendLine`) and in the sidebar's "other files" list.
 *
 * A thread whose comments are all `isPending` is the viewer's own draft — it
 * exists only in their unsubmitted review, so it's labelled as such: a draft that
 * looked posted would let someone think they'd said something they hadn't.
 */
import { useState } from "react";

import type { PrThread } from "../../bindings";
import { Avatar } from "../../components/Avatar";
import { CheckIcon, ChevronDownIcon } from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { Button, Pill } from "../../components/primitives";
import { RelativeTime } from "../../components/RelativeTime";
import { useReplyToPrThread, useSetPrThreadResolved } from "../../lib/queries";
import { isoMs } from "../../lib/relativeTime";
import { palette, successColor } from "../../theme/colors";
import { CommentComposer } from "./CommentComposer";

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function PrThreadCard({
  thread,
  prRepo,
  number,
}: {
  thread: PrThread;
  /** "owner/name" of the PR this thread belongs to — the reply/resolve target. */
  prRepo: string;
  number: number;
}) {
  // Resolved conversations collapse to their header by default (GitHub's UI);
  // everything else opens so unresolved feedback is visible without a click.
  const [open, setOpen] = useState(!thread.isResolved);
  const [replying, setReplying] = useState(false);
  const reply = useReplyToPrThread(prRepo, number);
  const { mutate: setResolved } = useSetPrThreadResolved(prRepo, number);

  const anchor = `${basename(thread.path)}${thread.line != null ? `:${thread.line}` : ""}`;
  const count = thread.comments.length;
  // A draft thread has nothing posted in it yet, so there's nothing to reply to
  // and nothing to resolve — it's still just text in the viewer's own review.
  const isDraft = thread.comments.every((c) => c.isPending);
  const canResolve = thread.isResolved ? thread.viewerCanUnresolve : thread.viewerCanResolve;

  return (
    <div
      className="border-l-2 bg-app"
      style={{
        borderColor: isDraft ? palette.amber : thread.isResolved ? successColor : "var(--accent)",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={open ? "Collapse conversation" : "Expand conversation"}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left hover:bg-hover"
      >
        <ChevronDownIcon
          size={11}
          className={`flex-none text-muted-4 transition-transform ${open ? "" : "-rotate-90"}`}
        />
        {thread.isResolved && <CheckIcon size={12} className="flex-none text-status-green" />}
        <span className="font-mono text-[10.5px] text-muted-3">{anchor}</span>
        {isDraft && (
          <Pill
            color={palette.amber}
            className="px-1 py-px text-[9.5px] font-medium"
            title="In your unsubmitted review — nobody else can see this yet"
          >
            Draft
          </Pill>
        )}
        {thread.isResolved && <span className="text-[10px] text-status-green">Resolved</span>}
        {thread.isOutdated && (
          <span className="rounded bg-input px-1 py-px text-[9.5px] text-muted-4">Outdated</span>
        )}
        <span className="ml-auto flex-none text-[10.5px] text-muted-4">
          {count} comment{count === 1 ? "" : "s"}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-2.5 px-3 pt-0.5 pb-2.5">
          {thread.comments.map((c, i) => (
            <div key={`${c.author}-${c.createdAt}-${i}`} className="flex gap-2">
              <Avatar name={c.author} src={c.authorAvatarUrl} size={18} />
              <div className="min-w-0 flex-1">
                <div className="mb-0.5 flex items-center gap-1.5">
                  <span className="text-[11px] font-medium text-fg-2">{c.author}</span>
                  <RelativeTime
                    ms={isoMs(c.createdAt)}
                    className="font-mono text-[9.5px] text-muted-4"
                  />
                </div>
                <div className="text-[12px]">
                  <Markdown>{c.body}</Markdown>
                </div>
              </div>
            </div>
          ))}

          {!isDraft &&
            (replying ? (
              <div className="border-l-2 border-line-2 pl-3">
                <CommentComposer
                  autoFocus
                  rows={2}
                  pending={reply.isPending}
                  placeholder="Write a reply…"
                  onCancel={() => setReplying(false)}
                  primary={{
                    label: "Reply",
                    busyLabel: "Posting…",
                    onSubmit: (body, done) =>
                      reply.mutate(
                        { replyToId: thread.replyToId, body },
                        {
                          onSuccess: () => {
                            done();
                            setReplying(false);
                          },
                        },
                      ),
                  }}
                />
              </div>
            ) : (
              <div className="flex items-center gap-2">
                {/* No root comment id means GitHub gave us nothing to reply under
                    — offering the button would only produce an error on click. */}
                {!!thread.replyToId && (
                  <Button size="sm" variant="ghost" onClick={() => setReplying(true)}>
                    Reply
                  </Button>
                )}
                {canResolve && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setResolved({ threadId: thread.id, resolved: !thread.isResolved })
                    }
                    title={
                      thread.isResolved
                        ? "Reopen this conversation"
                        : "Mark this conversation resolved"
                    }
                  >
                    {thread.isResolved ? "Unresolve" : "Resolve"}
                  </Button>
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
