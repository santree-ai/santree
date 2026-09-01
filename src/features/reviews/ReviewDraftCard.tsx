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
  useReviewWorkItems,
  useUpdateReviewDraft,
} from "../../lib/queries";
import { palette } from "../../theme/colors";
import { CommentComposer } from "./CommentComposer";
import type { CommentTarget } from "./commentTarget";
import { composeDraftBody, splitDraftBody } from "./draftBody";
import { anchorLabel } from "./InlineCommentBox";
import { patchLineRange } from "./patchLines";
import { QueueAction } from "./QueueAction";

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Both header badges, so they are the same shape: same radius, same padding,
 *  same height. They differ only in what they say and in their tint. */
const BADGE = "gap-1 px-1.5 py-px text-[9.5px] font-medium";

export function ReviewDraftCard({
  draft,
  target,
  patch,
  stale = false,
  mode = "publish",
}: {
  draft: ReviewDraft;
  target: CommentTarget;
  /** The file's patch, when the card sits with its file. The only source for the
   *  lines a suggestion would replace, as in {@link PrThreadCard}. */
  patch?: string;
  /** Written against a head the PR has moved past: its line numbers describe code
   *  that isn't there any more, so publishing is refused. */
  stale?: boolean;
  /**
   * What the card's primary action does with the draft.
   *
   * `publish` is reviewing someone else's PR: the draft's destination is their
   * conversation, so it goes into your pending review. `queue` is your own PR,
   * where posting a comment at yourself achieves nothing — the useful destination
   * is the work queue, and the draft becomes something to fix. Editing and
   * deleting are the same either way.
   */
  mode?: "publish" | "queue";
}) {
  const [editing, setEditing] = useState(false);
  const update = useUpdateReviewDraft(target.prRepo, target.number);
  const remove = useDeleteReviewDraft(target.prRepo, target.number);
  const publish = usePublishReviewDrafts(target.prRepo, target.number);
  const { data: workItems } = useReviewWorkItems(target.prRepo, target.number);
  const inQueue = workItems?.some(
    (item) => item.source === "aiDraft" && item.sourceId === draft.id,
  );

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
      {/* One line-box height (`leading-4`) across three type sizes, so the path,
          the badges and the time sit on one line instead of three near-misses. */}
      <div className="flex items-center gap-2 px-3 py-1.5 leading-4">
        <span className="flex min-w-0 items-center text-[10.5px] text-muted-3">
          {/* Only the path is code — the anchor is prose, so it stays in the UI
              face. The title carries the *whole* path because this card also
              renders in Trees' PR pane, away from its file, where `a/util.py`
              and `b/util.py` are the same basename. */}
          <span className="truncate font-mono" title={draft.path}>
            {basename(draft.path)}
          </span>
          <span className="flex-none whitespace-pre"> · {anchor}</span>
        </span>
        {/* The agent's mark rides *inside* the badge rather than leading the row:
            as a separate 11px logomark in the dimmest token it read as a smudge,
            and it said "AI" twice over. Here it inherits the pill's purple, and
            one badge answers both what this is and who wrote it. */}
        <Pill
          color={palette.purple}
          className={BADGE}
          title={`Written by the ${draft.agentKind} review. Only you can see it until you add it to your review`}
        >
          <AgentIcon kind={draft.agentKind} size={10} />
          AI draft
        </Pill>
        {/* Amber, not the dimmest token in the palette: this is the row's warning
            — publishing is refused while it stands. */}
        {stale && (
          <Pill
            color={palette.amber}
            className={BADGE}
            title="Written against an earlier commit. The PR has moved since, so these line numbers may point at different code."
          >
            Older commit
          </Pill>
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
              {/* The AI work queue's own spark — see {@link QueueAction}. */}
              <QueueAction
                prRepo={target.prRepo}
                number={target.number}
                queued={!!inQueue}
                buttonVariant={mode === "queue" ? "primary" : "ghost"}
                className={mode === "queue" ? "ml-auto" : undefined}
                item={{
                  body: composeDraftBody(draft),
                  source: "aiDraft",
                  sourceId: draft.id,
                  path: draft.path,
                  line: draft.line,
                  startLine: draft.startLine,
                  onRight: draft.onRight,
                }}
              />
              {mode === "publish" && (
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
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
