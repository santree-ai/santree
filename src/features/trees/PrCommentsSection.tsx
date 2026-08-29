/**
 * The PR pane's conversation: the PR's top-level comments, filtered by who wrote
 * them, with santree's own AI drafts folded in as a fourth voice.
 *
 * The filter is the feature. A PR that has been open a day is mostly machines —
 * CI summaries, migration dumps, coverage reports — and "Humans 1" is how you find
 * the one question someone actually asked you. The Humans/Bots split comes from
 * GitHub's own actor type (see `commentAudience`), never from reading logins.
 *
 * Inline review threads are **not** rendered here: they belong to lines of code,
 * so they render in the diff where those lines are. What this section carries
 * instead is the list of files carrying them — otherwise they'd exist only inside
 * files you happen to open, which is a list you never finish.
 */
import { useState } from "react";

import type { PrComment, PrThread, ReviewPr } from "../../bindings";
import { Avatar } from "../../components/Avatar";
import { MessageSquareIcon } from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { Pill, Segmented } from "../../components/primitives";
import { RelativeTime } from "../../components/RelativeTime";
import { usePrDetail, useReviewDrafts, useReviewWorkItems } from "../../lib/queries";
import { isoMs } from "../../lib/relativeTime";
import { splitRepoSlug } from "../../lib/repo";
import { palette } from "../../theme/colors";
import {
  audienceCounts,
  audienceLabel,
  COMMENT_AUDIENCES,
  type CommentAudience,
  filterByAudience,
  showsDrafts,
} from "../reviews/commentAudience";
import { QueueAction } from "../reviews/QueueAction";
import { ReviewDraftCard } from "../reviews/ReviewDraftCard";
import { useTrees } from "./model";

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** One entry per commented file, most-discussed first, unresolved counted apart. */
function groupThreadsByFile(threads: PrThread[]) {
  const byPath = new Map<string, { path: string; count: number; open: number }>();
  for (const thread of threads) {
    const entry = byPath.get(thread.path) ?? { path: thread.path, count: 0, open: 0 };
    entry.count += 1;
    if (!thread.isResolved) entry.open += 1;
    byPath.set(thread.path, entry);
  }
  return [...byPath.values()].sort((a, b) => b.open - a.open || b.count - a.count);
}

export function PrCommentsSection({ pr }: { pr: ReviewPr }) {
  const { selectFile } = useTrees();
  const [owner, name] = splitRepoSlug(pr.repo);
  const { data: detail } = usePrDetail(owner, name, pr.number);
  const { data: drafts = [] } = useReviewDrafts(pr.repo, pr.number);
  const [audience, setAudience] = useState<CommentAudience>("all");

  const comments = detail?.comments ?? [];
  const counts = audienceCounts(comments, drafts);
  const shown = filterByAudience(comments, audience);
  const shownDrafts = showsDrafts(audience) ? drafts : [];
  const threads = detail?.threads ?? [];
  const unresolved = threads.filter((t) => !t.isResolved).length;
  // Inline threads grouped by file. They belong to lines of code, so they render
  // in the diff — but a list that only exists inside files you happen to open is
  // a list you never finish, so the files carrying them are named here.
  const byFile = groupThreadsByFile(threads);

  return (
    <section className="border-b border-hairline px-3 py-2.5">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-[10px] tracking-[.06em] text-muted-4 uppercase">
          Comments
        </span>
      </div>

      <Segmented
        className="mb-2.5"
        value={audience}
        onChange={setAudience}
        options={COMMENT_AUDIENCES.map((value) => ({
          value,
          label: audienceLabel[value],
          count: counts[value],
        }))}
      />

      {byFile.length > 0 && (
        <div className="mb-2.5 overflow-hidden rounded-md border border-line-2">
          <div className="border-b border-line-2 bg-raised px-2.5 py-1 text-[10px] text-muted-4">
            On the code
            {unresolved > 0 && <span className="text-accent"> · {unresolved} unresolved</span>}
          </div>
          {byFile.map(({ path, count, open }) => (
            <button
              key={path}
              type="button"
              onClick={() => selectFile(path, "branch")}
              title={`Open ${path}`}
              className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1 text-left transition-colors hover:bg-hover"
            >
              {/* Basename only: at this width a full path truncates to its
                  leading directories, which is the half that doesn't identify it. */}
              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-fg-3">
                {basename(path)}
              </span>
              <span className="flex flex-none items-center gap-1 font-mono text-[9.5px] text-muted-4">
                <MessageSquareIcon size={9} />
                {count}
              </span>
              {open > 0 && (
                <span
                  className="h-1.5 w-1.5 flex-none rounded-full bg-[var(--accent)]"
                  aria-hidden
                />
              )}
            </button>
          ))}
        </div>
      )}

      {shown.length === 0 && shownDrafts.length === 0 ? (
        <p className="py-1 text-[11px] text-muted-4">
          {comments.length === 0
            ? "No conversation on this pull request yet."
            : `Nothing from ${audienceLabel[audience].toLowerCase()} here.`}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {shown.map((comment, i) => (
            <CommentCard
              key={`${comment.author}-${comment.createdAt}-${i}`}
              comment={comment}
              pr={pr}
            />
          ))}
          {shownDrafts.map((draft) => (
            <ReviewDraftCard
              key={draft.id}
              draft={draft}
              target={{
                prRepo: pr.repo,
                number: pr.number,
                prId: pr.id,
                headSha: detail?.headSha ?? "",
                pendingReviewId: detail?.pendingReviewId ?? null,
              }}
              // On your own PR a draft is work to do, not a comment to post at
              // yourself — so the card offers the queue instead of "Add to review".
              mode="queue"
              stale={!!detail?.headSha && draft.headSha !== detail.headSha}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** One conversation comment, with the one action this pane offers on it: queue it.
 *
 *  No reply box. Replying to the conversation on your own PR is a rarer thing than
 *  acting on what it says, and `PrComment` carries no per-comment id to anchor a
 *  reply to — the header's "Open on GitHub" is the honest route for it. Inline
 *  threads *can* be replied to, in the diff, where `PrThreadCard` has the thread. */
function CommentCard({ comment, pr }: { comment: PrComment; pr: ReviewPr }) {
  const { data: items } = useReviewWorkItems(pr.repo, pr.number);
  const body = comment.body.trim();
  // Matched on the text because a conversation comment has no id in `PrComment`
  // to match on. It fails in the safe direction: an edited comment reads as
  // un-queued and can be queued again, rather than a real one being suppressed.
  const queued = items?.some((item) => item.source === "manual" && item.body === body);

  return (
    <div className="group rounded-md border border-line-2 bg-raised px-2.5 py-2">
      <div className="mb-1 flex items-center gap-1.5">
        <Avatar name={comment.author} src={comment.authorAvatarUrl} size={16} />
        <span className="min-w-0 truncate text-[11px] font-medium text-fg-2">{comment.author}</span>
        {comment.isBot && (
          <Pill color={palette.slate} className="px-1 py-px text-[8.5px] font-medium uppercase">
            bot
          </Pill>
        )}
        {comment.kind === "Review" && <span className="text-[10px] text-muted-4">reviewed</span>}
        {/* In the header, not under the body: a button on its own row leaves a
            band of dead space at the foot of every card, and these cards are
            stacked.

            The action sits *beside* the timestamp and is always in flow — only
            its opacity changes. A control that mounts on hover occupies nothing
            at rest, so it resizes the header the instant you point at it and the
            card jumps under the pointer. The slot keeps its 16px even when there
            is nothing to queue (a review with no body), so the timestamps line
            up down the stack too. */}
        <span className="ml-auto flex flex-none items-center gap-1.5">
          <RelativeTime
            ms={isoMs(comment.createdAt)}
            className="font-mono text-[9.5px] text-muted-4"
          />
          <span className="flex h-4 w-4 flex-none items-center justify-center">
            {/* The AI work queue's own spark: the button and the place it sends
                things read as one concept. */}
            {body && (
              <QueueAction
                variant="icon"
                prRepo={pr.repo}
                number={pr.number}
                queued={!!queued}
                label="Queue this comment"
                queuedLabel="Already in the queue"
                queuedTitle="Already in the queue"
                item={{
                  body,
                  source: "manual",
                  sourceId: null,
                  path: null,
                  line: null,
                  startLine: null,
                  onRight: null,
                }}
              />
            )}
          </span>
        </span>
      </div>
      <div className="text-[11.5px]">
        <Markdown>{comment.body}</Markdown>
      </div>
    </div>
  );
}
