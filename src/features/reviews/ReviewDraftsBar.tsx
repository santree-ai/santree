/**
 * The AI review's tray: a footer strip that appears while santree is holding draft
 * comments for this PR, and the dialog that sends them.
 *
 * It sits directly above {@link ReviewSubmitBar}, and the two read as one flow:
 * drafts land here, "Add all to review" turns them into pending comments, then the
 * bar below sends the review. That ordering is the point — an agent's findings have
 * to pass through a human twice before anyone else sees them, once when they're
 * read and once when the review is submitted.
 *
 * Same reason the submit bar is loud: a draft nobody looks at is worse than no
 * draft, so a standing strip beats a badge somewhere.
 */
import { useState } from "react";

import type { ReviewDraft } from "../../bindings";
import { AgentIcon } from "../../components/icons";
import { Button, ConfirmDialog } from "../../components/primitives";
import { usePublishReviewDrafts } from "../../lib/queries";
import { alpha, palette } from "../../theme/colors";
import type { CommentTarget } from "./commentTarget";

/** The first line of a comment, for the confirm dialog's list. */
function firstLine(body: string): string {
  return (
    body
      .trim()
      .split("\n")
      .find((l) => l.trim().length > 0) ?? ""
  );
}

export function ReviewDraftsBar({
  target,
  drafts,
}: {
  target: CommentTarget;
  drafts: ReviewDraft[];
}) {
  const [confirming, setConfirming] = useState(false);
  // Its own failure UI: a partial publish is reported inside the dialog, with how
  // many landed, so a toast would either duplicate it or replace a count with
  // "something went wrong".
  const publish = usePublishReviewDrafts(target.prRepo, target.number, { silent: true });

  // A draft written against an earlier head has line numbers that no longer
  // describe the code. Publishing refuses them, so they're left out here rather
  // than sent and bounced.
  const sendable = drafts.filter((d) => d.headSha === target.headSha);
  const skipped = drafts.length - sendable.length;
  const n = sendable.length;
  const label = target.pendingReviewId ? "Add all to review" : "Start a review with all";

  return (
    <div
      className="flex flex-none items-center gap-2.5 border-t px-3 py-2 text-[11.5px]"
      style={{ borderColor: alpha(34, palette.purple), background: alpha(10, palette.purple) }}
    >
      <span className="flex flex-none items-center -space-x-1">
        {[...new Set(drafts.map((draft) => draft.agentKind))].map((agent) => (
          <AgentIcon key={agent} kind={agent} size={12} />
        ))}
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">
          {drafts.length} AI draft{drafts.length === 1 ? "" : "s"}
        </span>
        <span className="text-muted-3">
          . Only you can see them. Nothing reaches GitHub until you add them to your review.
        </span>
      </span>
      <Button
        size="sm"
        variant="primary"
        disabled={n === 0 || !target.headSha}
        title={
          n === 0
            ? "Every draft was written against an earlier commit. Ask the AI review to look again."
            : "Add these comments to your pending review"
        }
        onClick={() => setConfirming(true)}
      >
        {label}
      </Button>

      <ConfirmDialog
        open={confirming}
        title="Add AI drafts to your review"
        message={
          <>
            {n} comment{n === 1 ? "" : "s"} will be added to your pending review on{" "}
            <span className="font-mono text-fg-3">
              {target.prRepo}#{target.number}
            </span>
            . Nobody else can see them until you finish the review.
            {skipped > 0 && (
              <>
                {" "}
                {skipped} written against an earlier commit {skipped === 1 ? "is" : "are"} skipped.
              </>
            )}
          </>
        }
        confirmLabel={`Add ${n} to review`}
        busyLabel="Adding…"
        extra={
          <div className="max-h-48 overflow-y-auto rounded-lg border border-line-2 bg-input">
            {sendable.map((d) => (
              <div
                key={d.id}
                className="flex gap-2 border-b border-line-2 px-2.5 py-1.5 last:border-b-0"
              >
                <span className="flex-none font-mono text-[10px] text-muted-4">
                  {d.path}:{d.line}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-fg-3">
                  {firstLine(d.body)}
                </span>
              </div>
            ))}
          </div>
        }
        onConfirm={async () => {
          const outcome = await publish.mutateAsync(sendable.map((d) => d.id));
          if (outcome.failed) {
            // The count is the honest part: whatever didn't go is still a draft,
            // so say how far it got rather than "failed".
            throw new Error(
              `Added ${outcome.published} of ${n}. ${outcome.failed.error} The rest are still here.`,
            );
          }
        }}
        onClose={() => setConfirming(false)}
      />
    </div>
  );
}
