/** Each dialog's answer, by occurrence: the session and the moment its hook
 *  recorded the dialog (`PendingPrompt.recordedAtMs`). One answer per
 *  occurrence — a doubled key answers the next dialog, which Claude draws about
 *  90 ms after the first is answered — so it is held here, outside the card: a
 *  remount, a face switch or a tab switch finds it where it was and can't
 *  answer twice. Memory only. */
import { useSyncExternalStore } from "react";

import type { Outcome, WriteJob } from "./paneWriter";

export interface Occurrence {
  sessionId: string;
  recordedAtMs: number;
}

export type AnswerState =
  /** Its keys are going out. */
  | { status: "typing"; label: string; job: WriteJob }
  /** Every key went. */
  | { status: "sent"; label: string }
  /** Some keys went and the rest didn't: the dialog is in a state nothing
   *  here can know, so nothing more is offered for it. */
  | { status: "partial"; label: string; reason: string }
  /** Nothing was typed (the record had moved, say): it may be answered again. */
  | { status: "held"; reason: string };

/** How many occurrences are remembered; older ones are long gone. */
const KEPT = 64;

const states = new Map<string, AnswerState>();
const listeners = new Set<() => void>();
/** When each session's last answer was started, by session. */
const answeredAt = new Map<string, number>();

const keyOf = (o: Occurrence) => `${o.sessionId}\u0000${o.recordedAtMs}`;

function set(o: Occurrence, state: AnswerState): void {
  const key = keyOf(o);
  states.delete(key);
  states.set(key, state);
  if (states.size > KEPT) states.delete(states.keys().next().value as string);
  for (const listener of listeners) listener();
}

export function answerOf(o: Occurrence): AnswerState | null {
  return states.get(keyOf(o)) ?? null;
}

/** Whether `o` can still be answered: nothing out for it, sent, or stopped
 *  part-way. */
export function mayAnswer(o: Occurrence): boolean {
  const now = answerOf(o);
  return !now || now.status === "held";
}

/** An answer's keys were queued for `o`. */
export function answerStarted(o: Occurrence, label: string, job: WriteJob): void {
  answeredAt.set(o.sessionId, Date.now());
  set(o, { status: "typing", label, job });
}

/** When `sessionId`'s last answer from a card was started, if any. */
export function lastAnsweredAt(sessionId: string): number | null {
  return answeredAt.get(sessionId) ?? null;
}

/** How an answer's sequence ended. */
export function answerSettled(o: Occurrence, label: string, outcome: Outcome): void {
  if (outcome.kind === "done") {
    set(o, { status: "sent", label });
  } else if (outcome.typed === 0) {
    set(o, {
      status: "held",
      reason: outcome.kind === "refused" ? "the terminal didn't take it." : outcome.reason,
    });
  } else {
    set(o, {
      status: "partial",
      label,
      reason: outcome.kind === "refused" ? "the terminal stopped taking keys." : outcome.reason,
    });
  }
}

/** Give up the rest of an answer still typing for `o`. */
export function cancelAnswer(o: Occurrence, reason: string): void {
  const now = answerOf(o);
  if (now?.status === "typing") now.job.cancel(reason);
}

/** One occurrence's answer, live; null for none (or no occurrence). */
export function useAnswer(o: Occurrence | null): AnswerState | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => (o ? answerOf(o) : null),
    () => (o ? answerOf(o) : null),
  );
}

/** Test-only: forget every answer. */
export function resetAnswers(): void {
  states.clear();
  answeredAt.clear();
}
