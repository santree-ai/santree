/**
 * The pending-review tray: a footer strip that appears under the diff the moment
 * you have an unsubmitted review, and the dialog that finishes it.
 *
 * It matters that this is *visible*. Draft comments are invisible to the PR's
 * author until the review is submitted, so a batched review that's easy to start
 * and easy to forget is worse than no batching at all — the strip is the standing
 * reminder that N comments are sitting unsent.
 *
 * Submitting is the user's call, in every sense: the verdict is picked explicitly
 * (there's no default that could be pressed through), and nothing in santree's AI
 * review surfaces can reach this path — reviews go out under the user's name, so
 * the user writes and sends them.
 */
import { useState } from "react";

import type { PrDetail, ReviewEvent } from "../../bindings";
import { CheckIcon, WarningIcon } from "../../components/icons";
import { Button, ConfirmDialog, Segmented } from "../../components/primitives";
import { useDiscardPrReview, useSubmitPrReview } from "../../lib/queries";
import { alpha, palette } from "../../theme/colors";
import { useReviewsModel } from "./model";

/** How many draft comments the viewer is holding — a thread can hold a draft
 *  reply under posted comments, so this counts comments, not threads. */
export function draftCount(detail: PrDetail | undefined): number {
  return (detail?.threads ?? []).reduce(
    (n, t) => n + t.comments.filter((c) => c.isPending).length,
    0,
  );
}

/** "3 draft comments" — or, when the count is zero, no count at all.
 *
 *  A pending review with nothing to count is a real state: the review may have
 *  been started on github.com, or its threads may not have come back with the
 *  conversation. "0 draft comments will be posted" would be nonsense, so the
 *  copy drops to the thing we do know — that a draft review is open. */
function drafted(n: number): string {
  return n > 0 ? `${n} draft comment${n === 1 ? "" : "s"}` : "";
}

const EVENTS: { value: ReviewEvent; label: string }[] = [
  { value: "Comment", label: "Comment" },
  { value: "Approve", label: "Approve" },
  { value: "RequestChanges", label: "Request changes" },
];

export function ReviewSubmitBar({
  prRepo,
  number,
  reviewId,
  drafts,
}: {
  prRepo: string;
  number: number;
  /** The viewer's pending review — the bar only renders when there is one. */
  reviewId: string;
  drafts: number;
}) {
  const { repo } = useReviewsModel();
  const [submitting, setSubmitting] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [event, setEvent] = useState<ReviewEvent>("Comment");
  const [summary, setSummary] = useState("");
  const submit = useSubmitPrReview(repo, prRepo, number);
  const discard = useDiscardPrReview(prRepo, number);

  // GitHub's rule, enforced here so it's a disabled button rather than a 422:
  // only an approval may go out without a summary.
  const needsSummary = event !== "Approve" && !summary.trim();

  return (
    <div
      className="flex flex-none items-center gap-2.5 border-t px-3 py-2 text-[11.5px]"
      style={{ borderColor: alpha(34, palette.amber), background: alpha(10, palette.amber) }}
    >
      <WarningIcon size={12} className="flex-none" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{drafted(drafts) || "Draft review in progress"}</span>
        <span className="text-muted-3">
          {drafts > 0 ? ". Nobody can see them until you submit." : ". Nothing is posted yet."}
        </span>
      </span>
      <Button size="sm" variant="ghost" onClick={() => setDiscarding(true)}>
        Discard
      </Button>
      <Button size="sm" variant="primary" onClick={() => setSubmitting(true)}>
        <CheckIcon size={11} />
        Finish review
      </Button>

      <ConfirmDialog
        open={submitting}
        title="Submit your review"
        message={
          <>
            {drafted(drafts) || "Your draft review"} will be posted on{" "}
            <span className="font-mono text-fg-3">
              {prRepo}#{number}
            </span>
            .
          </>
        }
        confirmLabel={
          event === "Approve"
            ? "Approve"
            : event === "RequestChanges"
              ? "Request changes"
              : "Submit comments"
        }
        busyLabel="Submitting…"
        extra={
          <div className="flex flex-col gap-2">
            <Segmented options={EVENTS} value={event} onChange={setEvent} />
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={4}
              placeholder={
                event === "Approve" ? "Summary (optional)…" : "Summary — required by GitHub…"
              }
              className="w-full resize-y rounded-lg border border-line-2 bg-input px-3 py-2 text-[12px] leading-[1.55] text-fg-2 placeholder:text-muted-4 focus:border-line-strong focus:outline-none"
            />
            {needsSummary && (
              <span className="text-[10.5px] text-muted-3">
                GitHub needs a summary for anything but an approval.
              </span>
            )}
          </div>
        }
        onConfirm={async () => {
          // The dialog's own guard: `onConfirm` is what the button runs, so
          // refusing here is what keeps an empty-summary submit from leaving.
          if (needsSummary) throw new Error("GitHub needs a summary for this kind of review.");
          await submit.mutateAsync({ reviewId, event, body: summary });
          setSummary("");
        }}
        onClose={() => setSubmitting(false)}
      />

      <ConfirmDialog
        open={discarding}
        danger
        title="Discard draft review"
        message={`${drafted(drafts) || "Your draft review"} will be deleted. This can't be undone.`}
        confirmLabel="Discard"
        busyLabel="Discarding…"
        onConfirm={() => discard.mutateAsync(reviewId)}
        onClose={() => setDiscarding(false)}
      />
    </div>
  );
}
