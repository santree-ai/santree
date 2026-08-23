/**
 * The composer that opens on a diff line — GitHub's `+` button, and the two
 * things it can do with what you write:
 *
 *  - **Comment** posts immediately, notifying the author.
 *  - **Start a review** / **Add to review** stacks it into your pending review,
 *    invisible to everyone until you submit it. That's the primary action: a
 *    batched review is one notification instead of five, which is the difference
 *    between a reviewer who is easy to work with and one who isn't.
 *
 * Laid out like github.com's box (avatar + "Add a comment on line R4" header,
 * then the composer, then Cancel / Comment / Start a review) minus the parts we
 * deliberately don't carry: no Preview tab, no formatting toolbar, no file
 * attachments. The one tool kept is **Suggestion**, which needs the commented
 * lines — recovered from the file's patch by {@link patchLineRange}.
 *
 * Rendered by `@git-diff-view`'s `renderWidgetLine`, which owns the open/closed
 * state per line and hands us `onClose`, plus the selected range when the gutter
 * was dragged across several lines.
 */
import { Avatar } from "../../components/Avatar";
import { useAddPrInlineComment, useGithubViewerLogin } from "../../lib/queries";
import { CommentComposer } from "./CommentComposer";
import type { CommentTarget } from "./commentTarget";
import { patchLineRange } from "./patchLines";

/** GitHub's own shorthand for a diff anchor: side letter + line number, as in
 *  "line R4" (new side) or "lines L10 to L14" (old side). */
export function anchorLabel(startLine: number | null, line: number, onRight: boolean): string {
  const side = onRight ? "R" : "L";
  return startLine === null || startLine >= line
    ? `line ${side}${line}`
    : `lines ${side}${startLine} to ${side}${line}`;
}

export function InlineCommentBox({
  target,
  path,
  patch,
  line,
  startLine,
  onRight,
  onClose,
}: {
  target: CommentTarget;
  path: string;
  /** The file's patch — the source for the Suggestion prefill. */
  patch: string;
  /** Last line of the comment, within the side named by `onRight` (each side is
   *  numbered independently — see `isRightSide`). */
  line: number;
  /** First line, when the gutter was dragged across a range; equal to `line` for
   *  the ordinary single-line case. */
  startLine: number;
  onRight: boolean;
  onClose: () => void;
}) {
  const { mutate, isPending } = useAddPrInlineComment(target.prRepo, target.number);
  const { data: viewer } = useGithubViewerLogin();
  const inReview = !!target.pendingReviewId;
  // A one-line "range" is just a comment on that line; sending a start GitHub
  // would reject helps nobody, so it only travels when it spans something.
  const from = startLine < line ? startLine : null;
  // No prefill unless the patch carries every line of the range — a suggestion
  // silently missing one of them would delete it.
  const suggestion = patchLineRange(patch, onRight, from ?? line, line) ?? undefined;

  const post = (pending: boolean) => (body: string, done: () => void) =>
    mutate(
      {
        prRepo: target.prRepo,
        number: target.number,
        prId: target.prId,
        headSha: target.headSha,
        path,
        line,
        startLine: from,
        onRight,
        body,
        pending,
        reviewId: target.pendingReviewId,
      },
      {
        onSuccess: () => {
          done();
          onClose();
        },
      },
    );

  return (
    <div className="border-y border-hairline bg-app px-3 py-2.5">
      <div className="overflow-hidden rounded-lg border border-line-2">
        <div className="flex items-center gap-2 border-b border-line-2 bg-input px-3 py-2">
          <Avatar
            name={viewer ?? "?"}
            src={viewer ? `https://github.com/${viewer}.png` : null}
            size={20}
          />
          <span className="text-[12px] font-semibold text-fg-2">
            Add a comment on {anchorLabel(from, line, onRight)}
          </span>
          <span className="ml-auto truncate font-mono text-[9.5px] text-muted-4" title={path}>
            {path}
          </span>
        </div>
        <div className="px-3 py-2.5">
          <CommentComposer
            autoFocus
            rows={3}
            pending={isPending}
            placeholder="Leave a comment"
            suggestion={suggestion}
            onCancel={onClose}
            primary={{
              label: inReview ? "Add to review" : "Start a review",
              busyLabel: "Saving…",
              title: inReview
                ? "Add this to your pending review. Nobody sees it until you submit"
                : "Begin a batched review; nothing is posted until you submit it",
              onSubmit: post(true),
            }}
            secondary={{
              label: "Comment",
              busyLabel: "Posting…",
              title: "Post this comment now, on its own",
              onSubmit: post(false),
            }}
          />
        </div>
      </div>
    </div>
  );
}
