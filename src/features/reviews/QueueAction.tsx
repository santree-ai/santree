/**
 * The one control that puts something on a PR's AI work queue.
 *
 * A failing check, a reviewer's comment, one of the AI's own drafts, a line you
 * highlighted in the diff and a note you typed all land in the same list, and
 * before this they each hand-rolled the same four things: mint an id, call
 * {@link useAddReviewWorkItem}, disable while pending or already queued, and pick
 * a glyph. Four copies of that drifted — one said "Add to queue", one only had an
 * aria-label, and the icons disagreed.
 *
 * The **spark** is deliberate, and it is a widening of what that glyph means:
 * elsewhere it marks AI-authored work, here it marks the queue an AI drains. The
 * tab (`aiWork`) and every button that fills it now wear the same mark, so the
 * button and its destination read as one concept — which is what the old
 * checklist-icon comments were arguing for, against a checklist tab that no
 * longer exists.
 *
 * It lives in `reviews/` rather than beside the Trees call sites for the reason
 * {@link ./briefStale} documents: the dependency only runs one way — Trees hosts
 * review components, never the reverse.
 *
 * Whether an item is *already* queued stays with the caller: every source
 * recognises its own rows differently (a check by name, a thread by its reply id,
 * a draft by its id, a conversation comment by its text, because GitHub gives it
 * no id at all).
 */
import type { ReactNode } from "react";

import { CheckIcon, SparklesIcon } from "../../components/icons";
import { Button, type ButtonVariant } from "../../components/primitives";
import { type AddReviewWorkItem, useAddReviewWorkItem } from "../../lib/queries";

export function QueueAction({
  prRepo,
  number,
  item,
  queued,
  variant = "button",
  label = "Add to queue",
  queuedLabel = "In queue",
  title = "Queue this for the agent to act on",
  queuedTitle = "Already in the queue",
  buttonVariant = "ghost",
  className,
}: {
  prRepo: string;
  number: number;
  /** Everything but the id, which this owns — a queue row is identified by the
   *  client so the optimistic patch and the persisted row are the same row. */
  item: Omit<AddReviewWorkItem, "id">;
  /** Whether this source is already on the queue. The caller decides: see above. */
  queued: boolean;
  /** `button` is a labelled action in a row of them; `icon` is the bare glyph
   *  that rides in a card header, where there is no room for words — there the
   *  label becomes the accessible name instead of visible text. */
  variant?: "button" | "icon";
  label?: string;
  queuedLabel?: string;
  title?: string;
  queuedTitle?: string;
  /** The `button` variant's {@link Button} style — a card whose queue action is
   *  its primary one passes `primary`. */
  buttonVariant?: ButtonVariant;
  className?: string;
}) {
  const add = useAddReviewWorkItem(prRepo, number);
  const disabled = queued || add.isPending;
  const glyph: ReactNode = queued ? <CheckIcon size={10} /> : <SparklesIcon size={11} />;
  const queue = () => add.mutate({ id: crypto.randomUUID(), ...item });

  if (variant === "icon") {
    return (
      <button
        type="button"
        disabled={disabled}
        aria-label={queued ? queuedLabel : label}
        title={queued ? queuedTitle : title}
        onClick={queue}
        // Fixed size, always in flow: only the opacity changes on hover. A
        // control that mounts on hover occupies nothing at rest, so it resizes
        // its host the instant you point at it and the card jumps under the
        // pointer. Queued is *state*, not an affordance — it stays visible.
        className={`flex size-4 flex-none cursor-pointer items-center justify-center transition-opacity disabled:cursor-default ${
          queued
            ? "text-accent"
            : "text-muted-4 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-fg-2"
        } ${className ?? ""}`}
      >
        {glyph}
      </button>
    );
  }

  return (
    <Button
      size="sm"
      variant={buttonVariant}
      disabled={disabled}
      title={queued ? queuedTitle : title}
      onClick={queue}
      className={className}
    >
      {glyph}
      {queued ? queuedLabel : label}
    </Button>
  );
}
