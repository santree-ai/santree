/**
 * One AI-written draft review comment, anchored in the diff where it would land.
 *
 * It reads as a third kind of thing beside a posted thread (accent) and a GitHub
 * pending comment (amber): purple, labelled, and never mistakable for something
 * already said. That distinction is the feature — an agent that reviews on your
 * behalf is worse than no agent, because its output goes out under your name, so
 * the whole flow is built around reading each one before it does.
 *
 * Three things you do with it: **edit** (it's your comment now), **delete** (most
 * of them, most of the time), and **add to review**, which is the only step here
 * that reaches GitHub. Editing and deleting are optimistic — they're local rows,
 * and waiting on disk would make them feel like posting.
 */
import { useState } from "react";

import type { ReviewDraft } from "../../bindings";
import { AgentIcon, PencilIcon, TrashIcon } from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { Button, Pill } from "../../components/primitives";
import { RelativeTime } from "../../components/RelativeTime";
import { SuggestionOriginal } from "../../components/Suggestion";
import {
  useDeleteReviewDraft,
  usePublishReviewDrafts,
  useUpdateReviewDraft,
} from "../../lib/queries";
import { palette } from "../../theme/colors";
import { CommentComposer } from "./CommentComposer";
import type { CommentTarget } from "./commentTarget";
import { composeDraftBody, splitDraftBody } from "./draftBody";
import { anchorLabel } from "./InlineCommentBox";
import { patchLineRange } from "./patchLines";

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function ReviewDraftCard({
  draft,
  target,
  patch,
  stale = false,
}: {
  draft: ReviewDraft;
  target: CommentTarget;
  /** The file's patch, when the card sits with its file. The only source for the
   *  lines a suggestion would replace, as in {@link PrThreadCard}. */
  patch?: string;
  /** Written against a head the PR has moved past: its line numbers describe code
   *  that isn't there any more, so publishing is refused. */
  stale?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const update = useUpdateReviewDraft(target.prRepo, target.number);
  const remove = useDeleteReviewDraft(target.prRepo, target.number);
  const publish = usePublishReviewDrafts(target.prRepo, target.number);

  const original =
    patch != null
      ? patchLineRange(patch, draft.onRight, draft.startLine ?? draft.line, draft.line)
      : null;
  // The same label the composer uses, so a draft and a comment you wrote yourself
  // name their anchor identically.
  const anchor = anchorLabel(draft.startLine, draft.line, draft.onRight);
  // A single draft still goes into the pending review, never out on its own — so
  // it says what the diff's own composer says.
  const addLabel = target.pendingReviewId ? "Add to review" : "Start a review";

  return (
    <div className="border-l-2 bg-app" style={{ borderColor: palette.purple }}>
      <div className="flex items-center gap-2 px-3 py-1.5">
        <AgentIcon kind={draft.agentKind} size={11} className="flex-none text-muted-3" />
        <span className="font-mono text-[10.5px] text-muted-3">
          {basename(draft.path)} · {anchor.toLowerCase()}
        </span>
        <Pill
          color={palette.purple}
          className="px-1 py-px text-[9.5px] font-medium"
          title="Written by the AI review. Only you can see it until you add it to your review"
        >
          AI draft
        </Pill>
        {stale && (
          <span
            className="rounded bg-input px-1 py-px text-[9.5px] text-muted-4"
            title="Written against an earlier commit. The PR has moved since, so these line numbers may point at different code."
          >
            Older commit
          </span>
        )}
        <RelativeTime
          ms={draft.updatedAtMs}
          className="ml-auto flex-none font-mono text-[9.5px] text-muted-4"
        />
      </div>

      <div className="px-3 pt-0.5 pb-2.5">
        {editing ? (
          <CommentComposer
            initialValue={composeDraftBody(draft)}
            autoFocus
            rows={4}
            suggestion={original ?? undefined}
            pending={update.isPending}
            onCancel={() => setEditing(false)}
            primary={{
              label: "Save",
              busyLabel: "Saving…",
              onSubmit: (text, done) => {
                const { body, suggestion } = splitDraftBody(text);
                update.mutate({ id: draft.id, body, suggestion });
                done();
                setEditing(false);
              },
            }}
          />
        ) : (
          <>
            <div className="text-[12px]">
              <SuggestionOriginal value={original}>
                <Markdown>{composeDraftBody(draft)}</Markdown>
              </SuggestionOriginal>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                <PencilIcon size={10} />
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => remove.mutate(draft.id)}
                title="Delete this draft. It was never sent anywhere."
              >
                <TrashIcon size={10} />
                Delete
              </Button>
              <Button
                size="sm"
                variant="primary"
                className="ml-auto"
                disabled={publish.isPending || stale || !target.headSha}
                title={
                  stale
                    ? "This draft was written against an earlier commit, so its lines may not match the code any more. Ask the AI review to look again, or delete it."
                    : "Add this comment to your pending review. Nobody else sees it until you finish the review."
                }
                onClick={() => publish.mutate([draft.id])}
              >
                {publish.isPending ? "Adding…" : addLabel}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
