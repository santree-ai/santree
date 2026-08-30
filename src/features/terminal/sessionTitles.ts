/**
 * The live terminal title of every open PTY pane, keyed exactly as the pane is.
 *
 * A module-scope store rather than context state, for the same reason the
 * terminal layer is mounted once at the root: titles arrive from a renderer
 * callback, not from a render, and they have to survive every navigation the
 * pane behind them survives. The key is the pane's `label` — `refId ?? key`,
 * which is also the backend's session label and the DB's `term_key` — so the
 * agent registry can join a stored session to the title of the terminal running
 * it without inventing a second identity (see `buildAgentEntries`).
 *
 * **A title lives exactly as long as its PTY.** `TerminalView` clears its entry
 * on teardown, so a session whose process ended has no title here at all —
 * which is the live-PTY gate, made structural rather than remembered. A title
 * from a dead PTY is a ghost: it says "working" forever, because nothing is
 * left to say otherwise.
 *
 * ## Why the snapshot only moves when the *classification* does
 *
 * Codex rewrites its title about ten times a second while it runs (a braille
 * spinner frame per tick), and Claude about twice. Publishing every frame would
 * re-render the whole sidebar tree at 10Hz to change nothing anyone can see —
 * the only consumer is the status dot, and every one of those frames means the
 * same thing. So `setSessionTitle` always records the latest title but only
 * publishes a new snapshot when {@link classifyAgentTitle} disagrees with what
 * the snapshot already holds. A reader therefore gets *a* title that produced
 * the current classification, not necessarily the newest one — which is all the
 * arbiter asks of it, and the only thing anything here reads.
 */
import { useSyncExternalStore } from "react";

import { classifyAgentTitle, type TitleActivity } from "./agentTitle";

/** Titles by pane label. Replaced (never mutated) so `useSyncExternalStore` can
 *  compare snapshots by identity. */
let snapshot: ReadonlyMap<string, string> = new Map();

/** The newest title per pane, published or not — what a new title is compared
 *  against to decide whether the snapshot has to move. */
const latest = new Map<string, { title: string; activity: TitleActivity | null }>();

const listeners = new Set<() => void>();

function publish(next: Map<string, string>) {
  snapshot = next;
  for (const listener of listeners) listener();
}

/** Record the title a pane's terminal just set. */
export function setSessionTitle(label: string, title: string): void {
  const activity = classifyAgentTitle(title);
  const previous = latest.get(label);
  latest.set(label, { title, activity });
  // Same meaning as what is already published: keep the newer text for the next
  // comparison, but don't wake the tree for a spinner frame.
  if (previous && previous.activity === activity && snapshot.has(label)) return;
  publish(new Map(snapshot).set(label, title));
}

/** Forget a pane's title. Called when its PTY goes away — see the file header. */
export function clearSessionTitle(label: string): void {
  latest.delete(label);
  if (!snapshot.has(label)) return;
  const next = new Map(snapshot);
  next.delete(label);
  publish(next);
}

/** Be told when the published snapshot is replaced. */
export function subscribeSessionTitles(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The published snapshot. Stable by identity between publishes, which is what
 *  lets `useSyncExternalStore` — and every memo downstream — skip the work. */
export function sessionTitles(): ReadonlyMap<string, string> {
  return snapshot;
}

/** Every live pane's terminal title, by pane label. */
export function useSessionTitles(): ReadonlyMap<string, string> {
  return useSyncExternalStore(subscribeSessionTitles, sessionTitles, sessionTitles);
}

/** Drop everything. Tests only — the app's entries are owned by live panes. */
export function resetSessionTitles(): void {
  latest.clear();
  publish(new Map());
}
