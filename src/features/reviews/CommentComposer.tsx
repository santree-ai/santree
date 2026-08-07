/**
 * The one text box every review comment is written in: the diff-line composer,
 * the reply box under a thread, and the PR conversation box at the foot of the
 * info rail. Mirrors `IssueDiscussion`'s Linear composer (⌘⏎ sends, Esc cancels)
 * so writing a comment feels the same wherever you are in the app.
 *
 * The draft is *not* cleared optimistically. A rejected inline comment is
 * routine — GitHub refuses any line that isn't part of the diff — and losing what
 * you typed to a 422 is far worse than watching a button say "Posting…". The
 * parent signals success by calling the `done` callback it's handed.
 */
import { useState } from "react";

import { Button } from "../../components/primitives";

/** One button beside the composer. `body` arrives trimmed and non-empty; call
 *  `done` once the post lands so the box clears (and not before). */
export interface ComposerAction {
  label: string;
  busyLabel: string;
  title?: string;
  onSubmit: (body: string, done: () => void) => void;
}

export function CommentComposer({
  primary,
  secondary,
  placeholder = "Leave a comment…",
  autoFocus = false,
  rows = 3,
  pending = false,
  onCancel,
}: {
  /** The default action — what ⌘⏎ fires. */
  primary: ComposerAction;
  /** GitHub's second half of the inline composer ("Add single comment" beside
   *  "Start a review"). Omitted everywhere there's only one thing to do. */
  secondary?: ComposerAction;
  placeholder?: string;
  autoFocus?: boolean;
  rows?: number;
  /** A post is in flight — both buttons lock so one comment can't be sent twice. */
  pending?: boolean;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState("");
  const trimmed = body.trim();

  const run = (action: ComposerAction) => {
    if (!trimmed || pending) return;
    action.onSubmit(trimmed, () => setBody(""));
  };

  return (
    <div>
      <textarea
        // biome-ignore lint/a11y/noAutofocus: these composers only open on an explicit click; focusing them is the intent
        autoFocus={autoFocus}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            run(primary);
          } else if (e.key === "Escape" && onCancel) {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder={placeholder}
        rows={rows}
        className="w-full resize-y rounded-lg border border-line-2 bg-input px-3 py-2 text-[12px] leading-[1.55] text-fg-2 placeholder:text-muted-4 focus:border-line-strong focus:outline-none"
      />
      <div className="mt-1.5 flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto font-mono text-[9px] text-muted-4">⌘⏎ to send</span>
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        )}
        {secondary && (
          <Button
            size="sm"
            title={secondary.title}
            onClick={() => run(secondary)}
            disabled={!trimmed || pending}
            className="min-w-0"
          >
            <span className="truncate">{pending ? secondary.busyLabel : secondary.label}</span>
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          title={primary.title}
          onClick={() => run(primary)}
          disabled={!trimmed || pending}
          className="min-w-0"
        >
          <span className="truncate">{pending ? primary.busyLabel : primary.label}</span>
        </Button>
      </div>
    </div>
  );
}
