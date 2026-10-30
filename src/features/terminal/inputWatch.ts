/**
 * When input last reached each pane through this page's own writer, for a view
 * that has to know whether anything but itself can have touched a dialog in a
 * pane it isn't showing: the Conversation view's answer cards. Every key
 * sequence but a lone digit or a lone Esc assumes the dialog is as Claude drew
 * it — row 1 highlighted, the first tab, empty fields — and a key the user
 * pressed in the terminal can make the same sequence give another answer.
 *
 * Every byte a pane takes from this page leaves through its view's one writer
 * (`TerminalView`: the renderer's input, and the seed), so watching there sees
 * all of it, the view's own sends and Stops included. What is kept is when,
 * never what. The bytes are looked at only to leave out the focus reports the
 * terminal sends on its own when its focus moves (a face switch makes one):
 * they carry no key, and Claude's dialogs ignore them. The answer card's own
 * keys are left out too ({@link untracked}).
 *
 * A pane is watched from the moment its view wired that writer — opened or
 * attached in this page load — so a window that starts earlier can't be
 * vouched for (an app restart, a reload, a re-attach, a pane newer than the
 * dialog): {@link quietSince} answers no.
 */
import type { SessionId } from "./types";

interface Watch {
  /** When this page started watching the pane. */
  since: number;
  /** When input last reached it; null for none since `since`. */
  last: number | null;
}

/** The focus-in and focus-out reports (DEC mode 1004) xterm sends by itself. */
const FOCUS_REPORTS = new Set(["\x1b[I", "\x1b[O"]);

const watches = new Map<SessionId, Watch>();
const listeners = new Set<() => void>();
/** An {@link untracked} call is typing. */
let untracking = false;

function notify(): void {
  for (const listener of listeners) listener();
}

/** Start watching a pane's input; the returned function stops. */
export function watchInput(id: SessionId): () => void {
  const watch: Watch = { since: Date.now(), last: null };
  watches.set(id, watch);
  notify();
  return () => {
    if (watches.get(id) !== watch) return;
    watches.delete(id);
    notify();
  };
}

/** Input is reaching the pane now. */
export function inputReached(id: SessionId, data: string): void {
  const watch = watches.get(id);
  if (!watch || untracking || FOCUS_REPORTS.has(data)) return;
  watch.last = Date.now();
  notify();
}

/**
 * Run `type`, one paste or key press into a pane's renderer, with the input it
 * causes left out of the watch: the answer card's keys, and nothing else
 * (`paneWriter`). They go only once the answer's checks (before its first key
 * and its last) found its dialog the one on record, open, alone and
 * untouched, and an answer ends with the key that closes it; the dialog that
 * follows (drawn 33-54 ms later, probed) must not read them as input that may
 * have answered it, or every second dialog of a batch would offer nothing.
 *
 * xterm emits a paste's or a key's bytes through `onData`, to the pane's
 * writer, before `paste` or `input` returns (`XtermRenderer.typed`), so the
 * writes made while `type` runs are exactly the ones it causes: none of them
 * is missed, and no other write is taken for one.
 */
export function untracked<T>(type: () => T): T {
  untracking = true;
  try {
    return type();
  } finally {
    untracking = false;
  }
}

/** Whether nothing has reached the pane since `from`, as this page has seen
 *  all along: watched from `from` or earlier, with no input after it. */
export function quietSince(id: SessionId | null, from: number): boolean {
  if (id === null) return false;
  const watch = watches.get(id);
  return watch !== undefined && watch.since <= from && (watch.last === null || watch.last < from);
}

/** Whether this page has seen input reach the pane at `from` or later. A pane
 *  it doesn't watch has none it saw: {@link quietSince} is the cautious read. */
export function inputSince(id: SessionId | null, from: number): boolean {
  if (id === null) return false;
  const last = watches.get(id)?.last ?? null;
  return last !== null && last >= from;
}

/** Be told whenever any pane's watch changes. */
export function subscribeInput(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
