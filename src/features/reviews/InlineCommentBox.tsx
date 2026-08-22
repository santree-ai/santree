/**
 * The composer that opens on a diff line — GitHub's `+` button, and the two
 * things it can do with what you write:
 *
 *  - **Add single comment** posts immediately, notifying the author.
 *  - **Start a review** / **Add to review** stacks it into your pending review,
 *    invisible to everyone until you submit it. That's the primary action: a
 *    batched review is one notification instead of five, which is the difference
 *    between a reviewer who is easy to work with and one who isn't.
 *
 * Rendered by `@git-diff-view`'s `renderWidgetLine`, which owns the open/closed
 * state per line and hands us `onClose`.
 */
import { useAddPrInlineComment } from "../../lib/queries";
import { CommentComposer } from "./CommentComposer";
import type { CommentTarget } from "./commentTarget";

export function InlineCommentBox({
  target,
  path,
  line,
  onRight,
  onClose,
}: {
  target: CommentTarget;
  path: string;
  /** Line number within the side named by `onRight` (each side is numbered
   *  independently — see `isRightSide`). */
  line: number;
  onRight: boolean;
  onClose: () => void;
}) {
  const { mutate, isPending } = useAddPrInlineComment(target.prRepo, target.number);
  const inReview = !!target.pendingReviewId;

  const post = (pending: boolean) => (body: string, done: () => void) =>
    mutate(
      {
        prRepo: target.prRepo,
        number: target.number,
        prId: target.prId,
        headSha: target.headSha,
        path,
        line,
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
      <div className="mb-1.5 font-mono text-[9.5px] tracking-[.05em] text-muted-4 uppercase">
        {path}:{line} · {onRight ? "new" : "old"}
      </div>
      <CommentComposer
        autoFocus
        rows={3}
        pending={isPending}
        placeholder="Leave a comment on this line…"
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
          label: "Add single comment",
          busyLabel: "Posting…",
          title: "Post this comment now, on its own",
          onSubmit: post(false),
        }}
      />
    </div>
  );
}
