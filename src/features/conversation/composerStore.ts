/** What the Conversation view's composer holds for one tab, outside any
 *  component, keyed by the tab's term key: the draft, the send in flight, the
 *  messages sent that the record doesn't show yet, and a Stop waiting to be
 *  heard. A face switch, a tab switch or a remount of the view finds them
 *  where they were. Memory only: an app restart starts over.
 *
 *  The draft only ever holds what the user typed into the box, or a message
 *  they sent from it, put back (`putBack`): never anything the view drew from
 *  the transcript or the hooks (COMPLIANCE.md; `compliance.test.ts`). */
import { useSyncExternalStore } from "react";

import type { ConversationItem } from "../../bindings";
import { withoutControls } from "../terminal/agentProvider";
import type { Outcome, WriteJob } from "./paneWriter";

/** A message the session took, drawn until the record shows it. */
export interface Echo {
  id: number;
  text: string;
  /** The record's last item when it was sent: a prompt after it can be this. */
  afterSeq: number;
  /** Sent while Claude was working, so it waits in Claude's queue. */
  queued: boolean;
}

/** A Stop the record has not answered yet. */
export interface StopMark {
  at: number;
  /** The message an Esc before Claude's first reply puts back in its input:
   *  the last one sent from here, while it is the turn being stopped. */
  restore: string | null;
  /** That message is back in the box already. */
  restored: boolean;
}

export interface TabComposer {
  draft: string;
  /** One line about the last thing the composer did, under the box. */
  note: string | null;
  /** The send between the user's click and its Enter. */
  sending: WriteJob | null;
  echoes: readonly Echo[];
  /** The last message the session took from here, and the record's prompt
   *  that shows it once one does. */
  lastSent: { text: string; echo: number; shownAs: string | null } | null;
  stop: StopMark | null;
}

const EMPTY: TabComposer = {
  draft: "",
  note: null,
  sending: null,
  echoes: [],
  lastSent: null,
  stop: null,
};

const tabs = new Map<string, TabComposer>();
const listeners = new Map<string, Set<() => void>>();
let echoSeq = 0;

export function composerOf(key: string): TabComposer {
  return tabs.get(key) ?? EMPTY;
}

function update(key: string, change: (prev: TabComposer) => Partial<TabComposer>): void {
  const prev = composerOf(key);
  const next = { ...prev, ...change(prev) };
  tabs.set(key, next);
  for (const listener of listeners.get(key) ?? []) listener();
}

function subscribe(key: string, listener: () => void): () => void {
  const set = listeners.get(key) ?? new Set();
  set.add(listener);
  listeners.set(key, set);
  return () => set.delete(listener);
}

/** One tab's composer, live. */
export function useTabComposer(key: string): TabComposer {
  return useSyncExternalStore(
    (listener) => subscribe(key, listener),
    () => composerOf(key),
    () => composerOf(key),
  );
}

/** The user typed into the box. */
export function typeDraft(key: string, value: string): void {
  update(key, () => ({ draft: value, note: null }));
}

/** Say one line under the box. */
export function noteFor(key: string, note: string | null): void {
  update(key, () => ({ note }));
}

/** `draft` with a message sent from here put back ahead of it. */
const withSent = (held: string, sent: string) => (held.trim() ? `${sent}\n\n${held}` : sent);

/** A message the user sent from here, back in the box ahead of whatever they
 *  have written since. */
export function putBack(key: string, echo: Echo): void {
  update(key, (prev) => ({
    draft: withSent(prev.draft, echo.text),
    note: null,
    echoes: prev.echoes.filter((e) => e.id !== echo.id),
  }));
}

/** A send has started: its job, until it settles. */
export function sendStarted(key: string, job: WriteJob): void {
  update(key, () => ({ sending: job, note: null }));
}

/** Where a send's sequence stopped, in a few words for the user. A paste that
 *  went in without its Enter is still in Claude's input: the next send's clear
 *  takes it out. */
function notSent(outcome: Exclude<Outcome, { kind: "done" }>): string {
  // The clear and the paste are the first two writes: past them, the draft is
  // in Claude's input.
  const pasted = outcome.typed >= 2;
  const left = pasted ? " It's in Claude's input; sending again replaces it." : "";
  switch (outcome.kind) {
    case "refused":
      return `The terminal didn't take it. Not sent.${left}`;
    case "held":
      return `Not sent: ${outcome.reason}${left}`;
    case "cancelled":
      return `Not sent: ${outcome.reason}${left}`;
  }
}

/** A send settled: the draft goes and its echo comes when the session took
 *  both the paste and the Enter; otherwise the draft stays, with why. */
export function sendSettled(
  key: string,
  text: string,
  outcome: Outcome,
  at: { afterSeq: number; queued: boolean },
): void {
  update(key, (prev) => {
    if (outcome.kind !== "done") return { sending: null, note: notSent(outcome) };
    const echo: Echo = { id: ++echoSeq, text, afterSeq: at.afterSeq, queued: at.queued };
    return {
      sending: null,
      // The box was read-only while the send was out: what is in it is what went.
      draft: prev.draft === text ? "" : prev.draft,
      note: null,
      echoes: [...prev.echoes, echo],
      lastSent: { text, echo: echo.id, shownAs: null },
    };
  });
}

/** A message's text as the record keeps it: line breaks as `\n` (Claude's
 *  input turns a pasted CR into one), no control characters, no space around. */
function asRecorded(text: string): string {
  return withoutControls(text.replace(/\r\n?/g, "\n"), "\t\n").trim();
}

/** Which echoes the record shows now, by id, with the item that shows each.
 *  Each item after an echo was sent stands for one echo, the oldest it can:
 *  a queued item (Claude took the message into its queue at the Enter — and
 *  says itself whether it was delivered or taken back) or a prompt with the
 *  echo's own text; failing that, a typed prompt stands for the oldest echo
 *  sent before it, whatever Claude made of its text. Display only. */
export function shownEchoes(
  echoes: readonly Echo[],
  items: readonly ConversationItem[],
): Map<number, string> {
  const shown = new Map<number, string>();
  const waiting = [...echoes];
  for (const item of items) {
    if (waiting.length === 0) break;
    const body = item.body;
    const prompt = body.kind === "user" && (body.origin === "Typed" || body.origin === "Queued");
    if (body.kind !== "queued" && !prompt) continue;
    const text = "text" in body ? asRecorded(body.text) : "";
    let at = waiting.findIndex((e) => e.afterSeq < item.seq && asRecorded(e.text) === text);
    if (at === -1 && body.kind === "user" && body.origin === "Typed") {
      at = waiting.findIndex((e) => e.afterSeq < item.seq);
    }
    if (at === -1) continue;
    shown.set(waiting[at].id, item.id);
    waiting.splice(at, 1);
  }
  return shown;
}

/** Drop the echoes the record shows now. */
export function echoesShown(key: string, items: readonly ConversationItem[]): void {
  const prev = composerOf(key);
  const shown = shownEchoes(prev.echoes, items);
  if (shown.size === 0) return;
  update(key, (s) => ({
    echoes: s.echoes.filter((e) => !shown.has(e.id)),
    lastSent:
      s.lastSent && shown.has(s.lastSent.echo)
        ? { ...s.lastSent, shownAs: shown.get(s.lastSent.echo) ?? null }
        : s.lastSent,
  }));
}

/** The user clicked Stop. `latestPrompt` is the record's latest prompt: the
 *  last message sent from here is the turn being stopped while it is still
 *  waiting to be shown, or is that prompt. */
export function stopClicked(key: string, at: number, latestPrompt: string | null | undefined) {
  update(key, (prev) => {
    const last = prev.lastSent;
    const current =
      last !== null &&
      (prev.echoes.some((e) => e.id === last.echo) || last.shownAs === latestPrompt);
    return { stop: { at, restore: current ? last.text : null, restored: false }, note: null };
  });
}

/** The Stop's Esc went nowhere, or the record has moved on past it. */
export function stopOver(key: string, at: number): void {
  update(key, (prev) => (prev.stop?.at === at ? { stop: null } : {}));
}

/** An Esc before Claude's first reply: Claude put the message back in its
 *  input and recorded nothing. It goes back in the box too, once. */
export function stopUnheard(key: string, at: number): void {
  update(key, (prev) => {
    const stop = prev.stop;
    if (stop?.at !== at || stop.restored) return {};
    if (stop.restore === null) return { stop: { ...stop, restored: true } };
    return {
      stop: { ...stop, restored: true },
      draft: withSent(prev.draft, stop.restore),
      // It never became a turn: Claude took it back.
      echoes: prev.echoes.filter((e) => e.id !== prev.lastSent?.echo),
    };
  });
}

/** Test-only: forget every tab's composer. */
export function resetComposers(): void {
  tabs.clear();
}
