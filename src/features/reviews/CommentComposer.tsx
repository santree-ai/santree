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
import { useEffect, useRef, useState } from "react";

import { SuggestionIcon } from "../../components/icons";
import { Button } from "../../components/primitives";

/** One button beside the composer. `body` arrives trimmed and non-empty; call
 *  `done` once the post lands so the box clears (and not before). */
export interface ComposerAction {
  label: string;
  busyLabel: string;
  title?: string;
  onSubmit: (body: string, done: () => void) => void;
}

const FENCE_OPEN = "```suggestion\n";

/** The fenced block GitHub reads as a suggested replacement for the commented
 *  lines. Exported for the composer's test and for callers building a prefill. */
export function suggestionBlock(lines: string[]): string {
  return `${FENCE_OPEN}${lines.join("\n")}\n\`\`\`\n`;
}

export function CommentComposer({
  primary,
  secondary,
  suggestion,
  initialValue = "",
  placeholder = "Leave a comment…",
  autoFocus = false,
  rows = 3,
  pending = false,
  onCancel,
}: {
  /** The default action — what ⌘⏎ fires. */
  primary: ComposerAction;
  /** GitHub's second half of the inline composer ("Comment" beside "Start a
   *  review"). Omitted everywhere there's only one thing to do. */
  secondary?: ComposerAction;
  /** The lines this comment is anchored to. Given them, the composer offers
   *  GitHub's "add a suggestion" button, which drops in a ```suggestion block
   *  prefilled with exactly those lines. Omitted where there's nothing to
   *  suggest against (a reply, the PR conversation box), and by the diff
   *  composer when the patch can't produce every line of the range. */
  suggestion?: string[];
  /** Text the box opens with — editing something that already exists rather than
   *  writing something new. */
  initialValue?: string;
  placeholder?: string;
  autoFocus?: boolean;
  rows?: number;
  /** A post is in flight — both buttons lock so one comment can't be sent twice. */
  pending?: boolean;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState(initialValue);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  // Where to put the caret once React has committed a programmatic edit. Applied
  // from an effect rather than straight after `setBody`, because the textarea
  // still holds the *old* value until that render lands — selecting against it
  // would land at the wrong offset (or out of range).
  const pendingSelection = useRef<[number, number] | null>(null);
  const trimmed = body.trim();

  // `body` isn't read inside the effect — it's the trigger. The selection can only
  // be applied once React has written the new value into the textarea, and
  // depending on it is what waits for that.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the dep is the trigger, not a read
  useEffect(() => {
    const range = pendingSelection.current;
    if (!range || !boxRef.current) return;
    pendingSelection.current = null;
    boxRef.current.focus();
    boxRef.current.setSelectionRange(range[0], range[1]);
  }, [body]);

  const run = (action: ComposerAction) => {
    if (!trimmed || pending) return;
    action.onSubmit(trimmed, () => setBody(""));
  };

  const insertSuggestion = () => {
    if (!suggestion) return;
    const at = boxRef.current?.selectionStart ?? body.length;
    const before = body.slice(0, at);
    const after = body.slice(at);
    // A fence has to open its own line, with a blank line between it and any
    // prose above — otherwise the parser folds it into that paragraph and the
    // suggestion posts as literal backticks.
    const lead =
      before === "" || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    const block = suggestionBlock(suggestion);
    setBody(before + lead + block + after);
    // Leave the suggested lines selected, so the first keystroke replaces them —
    // the prefill is a starting point, not usually the edit.
    const start = `${before}${lead}${FENCE_OPEN}`.length;
    pendingSelection.current = [start, start + suggestion.join("\n").length];
  };

  return (
    <div>
      {suggestion && (
        <div className="mb-1.5 flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={insertSuggestion}
            disabled={pending}
            title="Add a suggestion: a block GitHub shows as a proposed change, and the author can commit in one click"
          >
            <SuggestionIcon size={13} />
            Suggestion
          </Button>
        </div>
      )}
      <textarea
        ref={boxRef}
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
