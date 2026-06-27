/**
 * A collapsible "Notes" section at the bottom of the issue panel: free-text
 * context the user stores locally for a task (never synced to Linear; later used
 * as agent prompt context).
 *
 * Collapsed by default so tasks that need no extra context stay out of the way —
 * the header is a single slim row. When a note exists, the header shows an accent
 * dot + a one-line preview so you can tell at a glance without expanding. Edits
 * autosave (debounced + on blur); clearing the text deletes the note.
 *
 * Mount with `key={taskId}` so each task gets a fresh draft.
 */
import { useEffect, useRef, useState } from "react";

import { ChevronDownIcon } from "../../components/icons";
import { useSetTaskNote, useTaskNote } from "../../lib/queries";

const SAVE_DEBOUNCE_MS = 500;

export function TaskNotes({ repo, taskId }: { repo: string; taskId: string }) {
  const { data: note } = useTaskNote(repo, taskId);
  const { mutate: saveNote } = useSetTaskNote(repo);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  // The note loads asynchronously; adopt it into the draft exactly once so later
  // cache updates (our own optimistic save) never clobber what the user is typing.
  const seeded = useRef(false);

  useEffect(() => {
    if (!seeded.current && note !== undefined) {
      setDraft(note ?? "");
      seeded.current = true;
    }
  }, [note]);

  const saved = note ?? "";

  // Autosave the draft a beat after typing stops (no-op once it matches what's
  // stored — our optimistic write makes `saved` equal `draft` after a save).
  useEffect(() => {
    if (!seeded.current || draft === saved) return;
    const timer = setTimeout(() => saveNote({ taskId, body: draft }), SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, saved, taskId, saveNote]);

  const hasContent = saved.trim().length > 0;

  return (
    <div className="flex-none border-t border-hairline bg-panel px-5 pt-1.5 pb-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1 py-1.5 text-left text-muted-3 transition-colors hover:text-fg-2"
        aria-expanded={open}
      >
        <ChevronDownIcon size={11} className={open ? "" : "-rotate-90"} />
        <span className="flex-none text-[11px] font-semibold tracking-[.01em]">Notes</span>
        {hasContent && (
          <span
            className="h-1.5 w-1.5 flex-none rounded-full"
            style={{ background: "var(--accent)" }}
            aria-hidden
          />
        )}
        {!open && (
          <span className="min-w-0 flex-1 overflow-hidden text-[11px] text-ellipsis whitespace-nowrap text-muted-4">
            {hasContent ? saved : "Add context for this task…"}
          </span>
        )}
      </button>

      {open && (
        <textarea
          // biome-ignore lint/a11y/noAutofocus: focusing on expand is the intent
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== saved) saveNote({ taskId, body: draft });
          }}
          placeholder="Context for this task — stored locally, never synced to Linear. Sent to agents as prompt context later."
          className="mt-1.5 max-h-[40vh] min-h-[88px] w-full resize-y rounded-lg border border-line-2 bg-input px-3 py-2 text-[12px] leading-[1.55] text-fg-2 placeholder:text-muted-4 focus:border-line-strong focus:outline-none"
        />
      )}
    </div>
  );
}
