/**
 * The "Conversation" tab: the pull request as GitHub shows it first — what the
 * author says it does, and what everyone has said about it since.
 *
 * **The description is not a comment.** It is the proposal the comments are
 * about, so it gets its own block at the top — labelled, without the avatar
 * gutter every reply wears — and the timeline under it is the discussion alone
 * (see `timeline.ts`). Rendering the body as the thread's first card made it look
 * like the author's opening remark, which is the one thing on this page it isn't.
 *
 * This is the Reviews tab's landing surface, and it is where the description
 * finally gets width. It spent its life in the info rail, wrapped to a 400px
 * column beside the diff, which is a fine place to *glance* at a body and a
 * hostile one to read a long one in. The text column is still capped — a
 * description running the whole width of a maximised window is unreadable the
 * other way — but at a reading measure rather than a rail's.
 *
 * After the timeline comes the index of anchored feedback: every inline review
 * thread and every AI-written draft, in one list ordered by where they point
 * (`anchoredFeedback.ts`). The AI had its own section under the posted comments
 * and no longer does — it reviews this pull request like any other reviewer, so
 * its comments sit with theirs and wear santree's mark instead of a heading.
 *
 * **All of it also renders beside its code** in the Files-changed tab, and that
 * is not a duplicate — it is the same feedback answering two different questions.
 * Reading the pull request, "what has been said about this?" is a property of the
 * PR and belongs on the page that opens it; reading the diff, it is a property of
 * a line. Listing only the ones the diff had no room for made the section
 * disappear the moment the detail read landed, which is the one thing it must
 * never do.
 *
 * So each entry here is a *row*, not a second copy of the card: where it is, and
 * the first line of what it says, opening Files changed at that line — where the
 * card with the actions on it lives. The exception is an entry on a file the diff
 * doesn't list at all (GitHub caps the file list, and a push can drop a file):
 * there is nowhere to jump to, so its whole card renders here, because here is
 * the only place it exists.
 */

import type { PrThread, ReviewDraft, ReviewPr } from "../../bindings";
import { Avatar } from "../../components/Avatar";
import { MessageSquareIcon, SantreeMark } from "../../components/icons";
import { Markdown, MarkdownTitle } from "../../components/Markdown";
import { Pill, Skeleton } from "../../components/primitives";
import { RelativeTime } from "../../components/RelativeTime";
import { useAddPrConversationComment, usePrDetail, useReviewDrafts } from "../../lib/queries";
import { isoMs } from "../../lib/relativeTime";
import { splitRepoSlug } from "../../lib/repo";
import { palette } from "../../theme/colors";
import { anchoredFeedback } from "./anchoredFeedback";
import { CommentComposer } from "./CommentComposer";
import { anchorLabel } from "./InlineCommentBox";
import { PrThreadCard } from "./PrThreadCard";
import { COMMENT_GUTTER, PR_COLUMN } from "./prLayout";
import { ReviewDraftCard } from "./ReviewDraftCard";
import { type TimelineEntry, timelineEntries } from "./timeline";

export function PrConversationPane({
  pr,
  focusFile,
}: {
  pr: ReviewPr;
  /** Bring the Files-changed tab forward at a file (and line). The host's: in
   *  Reviews the rail's brief writes the same jump from outside this page, so
   *  it lives in that view's model; in Trees it is the page's own state. */
  focusFile: (path: string, line?: number | null) => void;
}) {
  const [owner, name] = splitRepoSlug(pr.repo);
  const { data: detail, isLoading } = usePrDetail(owner, name, pr.number);
  const { data: drafts } = useReviewDrafts(pr.repo, pr.number);
  const { mutate, isPending } = useAddPrConversationComment(pr.repo, pr.number);
  // `focusFile` is the jump the rows below make: it scrolls the Files-changed
  // tab to the file and brings that tab forward, so a click from here lands on
  // the code rather than on a tab the reader then has to find.

  // Which entries have a card beside their code to jump to. Empty while the read
  // is in flight, which is why it decides the *shape* of a row and never whether
  // one renders: gating the list on it made every entry vanish the moment the
  // detail landed.
  const files = new Set((detail?.files ?? []).map((f) => f.path));
  // One list, posted and proposed together, ordered by where each one points.
  const feedback = anchoredFeedback(detail?.threads ?? [], drafts ?? []);
  // Until the read lands, the only thing we can honestly draw is the description's
  // *header* — its author and time came with the inbox row. Its body, and whether
  // anyone has replied at all, are both unknown; drawing an empty page anyway
  // would state "no description, no comments", which is a different answer to the
  // question than "we haven't looked yet" (see the same rule on the sidebar's
  // project sections).
  const entries = timelineEntries(detail?.comments ?? []);

  return (
    <div className="selectable min-h-0 flex-1 overflow-y-auto px-5 py-5">
      <div className={PR_COLUMN}>
        <PrDescription pr={pr} body={detail?.body} loading={isLoading} />
        {isLoading && <TimelineSkeleton />}
        {entries.length > 0 && (
          <div className="mt-6">
            <SectionLabel>Conversation</SectionLabel>
            <div className="flex flex-col gap-3">
              {entries.map((entry) => (
                <TimelineCard key={entry.key} entry={entry} />
              ))}
            </div>
          </div>
        )}
        {/* The composer renders even on a PR nobody has commented on: "no
            conversation yet" is exactly when you want to start one. It hangs
            under the avatar gutter rather than at the column's edge: what you
            are writing is a comment, and it should be the width of one. */}
        <div className={`mt-4 ${COMMENT_GUTTER}`}>
          <CommentComposer
            rows={3}
            pending={isPending}
            placeholder="Comment on this pull request…"
            primary={{
              label: "Comment",
              busyLabel: "Posting…",
              onSubmit: (body, done) => mutate(body, { onSuccess: done }),
            }}
          />
        </div>
        {feedback.length > 0 && (
          <div className="mt-6 border-t border-hairline pt-4">
            {/* The label keeps the column's edge, as "Conversation" does above a
                row of cards whose *avatars* start there. Only the box moves in,
                so the section headings read as one margin down the page. */}
            <SectionLabel>Review comments</SectionLabel>
            <div className={`overflow-hidden rounded-lg border border-line-2 ${COMMENT_GUTTER}`}>
              {feedback.map((entry) => {
                // Whether the diff has a card beside this code to jump to.
                const inDiff = files.has(entry.path);
                if (entry.kind === "thread") {
                  return inDiff ? (
                    <AnchorRow
                      key={entry.key}
                      icon={<MessageSquareIcon size={11} />}
                      path={entry.path}
                      anchor={threadAnchor(entry.thread)}
                      body={entry.thread.comments[0]?.body ?? ""}
                      trailing={`${entry.thread.comments.length}`}
                      onJump={() => focusFile(entry.path, entry.line)}
                    />
                  ) : (
                    <PrThreadCard
                      key={entry.key}
                      thread={entry.thread}
                      prRepo={pr.repo}
                      number={pr.number}
                    />
                  );
                }
                return inDiff ? (
                  <AnchorRow
                    key={entry.key}
                    // santree's own mark, not the agent's: the reviewer here is
                    // the app's AI review, and it stays that whether Claude or
                    // Codex ran it. Purple still says "not sent yet".
                    icon={<SantreeMark size={11} />}
                    by="santree's AI review"
                    tint={palette.purple}
                    path={entry.path}
                    anchor={draftAnchor(entry.draft)}
                    body={entry.draft.body}
                    onJump={() => focusFile(entry.path, entry.line)}
                  />
                ) : (
                  <ReviewDraftCard
                    key={entry.key}
                    draft={entry.draft}
                    target={{
                      prRepo: pr.repo,
                      number: pr.number,
                      prId: pr.id,
                      headSha: detail?.headSha ?? "",
                      pendingReviewId: detail?.pendingReviewId ?? null,
                    }}
                    stale={!!detail?.headSha && entry.draft.headSha !== detail.headSha}
                  />
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Where a thread sits, in the same words the composer and the AI drafts use for
 *  the same fact. A thread GitHub could not place has no line to name — it is
 *  about the file, and saying "line null" would be worse than saying nothing. */
function threadAnchor(thread: PrThread): string {
  return thread.line == null
    ? "on the file"
    : anchorLabel(thread.startLine, thread.line, thread.onRight);
}

function draftAnchor(draft: ReviewDraft): string {
  return anchorLabel(draft.startLine, draft.line, draft.onRight);
}

/**
 * One entry in the conversation's index of anchored feedback: where it is, and
 * the first line of what it says.
 *
 * A row rather than the card, because the card is already rendering beside its
 * code one tab away and this is the index, not a second copy — clicking opens
 * that tab at that line, which is where the actions are. The body is inline
 * markdown (`MarkdownTitle`): a preview that rendered a fenced diff or a heading
 * would be taller than the row it summarises.
 */
function AnchorRow({
  icon,
  by,
  tint,
  path,
  anchor,
  body,
  trailing,
  onJump,
}: {
  icon: React.ReactNode;
  /** Who wrote it, where the glyph is standing in for a reviewer rather than
   *  decorating the row. Given it, the mark gets that accessible name and the
   *  title says whose comment this is — without it the icon is chrome, which is
   *  what a posted comment's speech bubble is. */
  by?: string;
  /** The glyph's colour, where the kind of entry has one — the AI's purple, as
   *  everywhere else it is named. Posted comments take the muted default. */
  tint?: string;
  path: string;
  anchor: string;
  body: string;
  /** One extra fact at the trailing edge, when the entry has one worth a column
   *  (a thread's comment count). */
  trailing?: string;
  onJump: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onJump}
      title={`${path} · ${anchor}${by ? `\n${by} — only you can see it yet` : ""}\nShow it in Files changed`}
      className="flex w-full cursor-pointer items-start gap-2 border-b border-line-2 px-3 py-2 text-left last:border-b-0 hover:bg-hover"
    >
      {/* Muted unless the kind of entry owns a colour, which the inline style then
          wins with — a posted comment's glyph is chrome, the AI's is a label. */}
      <span
        className="mt-px flex flex-none items-center text-muted-4"
        style={{ color: tint ?? undefined }}
        // Named only when the glyph stands in for a reviewer. A speech bubble on
        // a posted comment is chrome, and `role="img"` on it would announce a
        // decoration between the row's file and its text.
        {...(by ? { role: "img", "aria-label": by } : {})}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 text-[10.5px] text-muted-3">
          {/* The whole path is one hover away: two directories can hold the same
              basename, and the row only has width for one of them. */}
          <span className="truncate font-mono">{basename(path)}</span>
          <span className="flex-none whitespace-pre"> · {anchor}</span>
        </span>
        <MarkdownTitle className="mt-0.5 block line-clamp-2 text-[12px] leading-[1.35] text-muted-2">
          {body}
        </MarkdownTitle>
      </span>
      {trailing && (
        <span className="mt-px flex-none font-mono text-[10px] text-muted-4">{trailing}</span>
      )}
    </button>
  );
}

/** Shown when the author opened the PR without writing anything. Italic markdown
 *  rather than a bare string, so it renders as the aside it is. */
const NO_DESCRIPTION = "_No description provided._";

/** The pull request's own body: what the author proposes, and when they proposed
 *  it.
 *
 *  Deliberately not shaped like a {@link TimelineCard} — no avatar gutter, a
 *  label instead of a verb — because the one thing a reader must not have to
 *  work out is which of these blocks is the PR and which are replies to it. */
function PrDescription({
  pr,
  body,
  loading,
}: {
  pr: ReviewPr;
  body: string | null | undefined;
  loading: boolean;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2 text-[11px]">
        <SectionLabel className="mb-0">Description</SectionLabel>
        <span className="min-w-0 truncate text-muted-3">
          <span className="font-medium text-fg-2">{pr.author}</span> opened this
        </span>
        <RelativeTime
          ms={isoMs(pr.createdAt)}
          className="ml-auto flex-none font-mono text-[9.5px] text-muted-4"
        />
      </div>
      <div className="rounded-lg border border-line-2 bg-raised px-4 py-3">
        {loading ? <BodySkeleton /> : <Markdown>{body?.trim() || NO_DESCRIPTION}</Markdown>}
      </div>
    </section>
  );
}

/** Two comment-shaped rows while the read that would carry them is in flight.
 *
 *  The same 26px face and the same card as {@link TimelineCard}, because the
 *  shape is the whole claim: "people have said things here, and they are on
 *  their way". Nothing at all was drawn before, which read as a pull request
 *  nobody had commented on — the answer, given before we had looked. A PR that
 *  genuinely has no conversation simply loses the block when the read lands,
 *  and that is the right trade: a moment of "maybe something" beats a
 *  confidently wrong "nothing". */
const TIMELINE_ROWS = [["w-11/12", "w-3/5"], ["w-4/5"]];

function TimelineSkeleton() {
  return (
    <div className="mt-6" aria-hidden>
      <SectionLabel>Conversation</SectionLabel>
      <div className="flex flex-col gap-3">
        {TIMELINE_ROWS.map((lines) => (
          <div key={lines.join()} className="flex gap-2.5">
            <Skeleton className="h-[26px] w-[26px] flex-none rounded-full" />
            <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-line-2 bg-raised">
              {/* The header strip: who, the verb, and the time at the far edge. */}
              <div className="flex items-center gap-2 border-b border-line-2 px-3 py-2">
                <Skeleton className="h-2.5 w-20" />
                <Skeleton className="h-2.5 w-14" />
                <Skeleton className="ml-auto h-2.5 w-9" />
              </div>
              <div className="flex flex-col gap-1.5 px-3 py-2.5">
                {lines.map((w) => (
                  <Skeleton key={w} className={`h-3 ${w}`} />
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Stand-in for a body still being fetched. Ragged widths on purpose — a block
 *  of equal bars reads as a table, not as prose. */
function BodySkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-3 w-11/12" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-4/5" />
    </div>
  );
}

function SectionLabel({
  children,
  className = "mb-2.5",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`font-mono text-[10px] tracking-[.06em] text-muted-4 uppercase ${className}`}>
      {children}
    </div>
  );
}

/** One comment: avatar in the gutter, a header strip saying who wrote it and
 *  when, and the body under it. */
function TimelineCard({ entry }: { entry: TimelineEntry }) {
  return (
    <div className="flex gap-2.5">
      <Avatar name={entry.author} src={entry.authorAvatarUrl} size={26} />
      <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-line-2 bg-raised">
        <div className="flex items-center gap-2 border-b border-line-2 px-3 py-1.5 text-[11px]">
          <span className="min-w-0 truncate font-medium text-fg-2">{entry.author}</span>
          <span className="flex-none text-muted-4">{entry.verb}</span>
          {entry.isBot && (
            <Pill color={palette.slate} className="px-1 py-px text-[8.5px] font-medium uppercase">
              bot
            </Pill>
          )}
          <RelativeTime
            ms={isoMs(entry.createdAt)}
            className="ml-auto flex-none font-mono text-[9.5px] text-muted-4"
          />
        </div>
        <div className="px-3 py-2.5">
          <Markdown>{entry.body}</Markdown>
        </div>
      </div>
    </div>
  );
}
