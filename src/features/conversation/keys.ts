/** What each of the Conversation view's actions types, as steps: pure, so the
 *  sequences are one table, read against Claude Code's own key map
 *  (docs/conversation.md), and tested as one.
 *
 *  A step is one write, a pause, or a `check`: the point where the action asks
 *  the session's record again, and gives up the rest when it no longer holds.
 *  Nothing here types; `paneWriter` runs a sequence, one pane's at a time, and
 *  only on the user's own action (COMPLIANCE.md). */
import { withoutControls } from "../terminal/agentProvider";
import type { DigitKey, TerminalKey } from "../terminal/types";
import type { Dialog, QuestionView } from "./dialog";
import { atLeast, type Trust } from "./trust";

export type Step =
  /** One key, one write (`clear` is its keys in one write). */
  | { kind: "key"; key: TerminalKey }
  /** Text the user wrote, as their paste: one write. */
  | { kind: "paste"; text: string }
  /** Nothing is written for this long. */
  | { kind: "wait"; ms: number }
  /** The action's guard runs here: a reason ends the sequence. */
  | { kind: "check" };

/** How long nothing follows an Esc. Within about 20 ms Claude Code reads Esc
 *  and the next byte as one Alt chord: the Esc is dropped and the other key
 *  acts alone (an Esc then `1` approved a command). Measured safe from 50 ms. */
export const ESC_GAP_MS = 100;

/** How long Enter waits behind the paste it submits: a CR that shares the
 *  paste's write, or comes right behind it, can land inside the paste as a new
 *  line instead of submitting it. A long paste takes Claude Code longer to
 *  take in, so the wait grows with it, to a cap. */
export function enterGap(text: string): number {
  return 500 + Math.min(500, Math.floor(text.length / 80));
}

/** Esc, alone, then the quiet that keeps the next byte a key of its own. */
const escAlone = (): Step[] => [
  { kind: "key", key: "escape" },
  { kind: "wait", ms: ESC_GAP_MS },
];

/** Send: what is left in Claude Code's input is emptied (its own write, never
 *  the paste's: in one write the clear arrived as text), then the draft as the
 *  user's paste, then their Enter. The record is read before the first byte
 *  and again right before the Enter, which is not pressed if Claude has opened
 *  a dialog since: an Enter there confirms whatever option is highlighted. */
export function sendSteps(draft: string): Step[] {
  return [
    { kind: "check" },
    { kind: "key", key: "clear" },
    { kind: "paste", text: draft },
    { kind: "wait", ms: enterGap(draft) },
    { kind: "check" },
    { kind: "key", key: "enter" },
  ];
}

/** Stop: one Esc. A second would open Claude Code's rewind menu. */
export function stopSteps(): Step[] {
  return escAlone();
}

// ── Answers ─────────────────────────────────────────────────────────────────
// A dialog's answers, as its own keys, from the sequences probed on Claude
// Code 2.1.312 (the contract's "Safe key sequences"). Each key is a write of
// its own, ANSWER_GAP_MS apart; a lone Esc keeps its own gap.

/** How long each answer key waits behind the one before: the dialogs were
 *  probed with 300-600 ms between keys (150 ms is the floor they were seen to
 *  need). */
export const ANSWER_GAP_MS = 300;

/** What the user picked on a card. Indexes are into the payload's own lists,
 *  from 0. */
export type Answer =
  /** `1`: row 1 is Yes in every permission dialog. */
  | { kind: "yes" }
  /** `2`, only when Claude offered a rule (see `Dialog.option2`). */
  | { kind: "always" }
  /** A lone Esc: rejects, and stops the turn. */
  | { kind: "no" }
  /** Tab on row 1 opens "Yes, and tell Claude what to do next". */
  | { kind: "yesTell"; text: string }
  /** Up wraps to the last row, No, whatever the row count; Tab there opens
   *  "No, and tell Claude what to do differently". */
  | { kind: "noTell"; text: string }
  /** One question, one pick: its digit picks and submits. */
  | { kind: "option"; option: number }
  /** One question: N+1 focuses "Type something.", then the text and Enter. */
  | { kind: "freeText"; text: string }
  /** Several questions: a digit each (each picks and moves on), then `1` on
   *  the Submit tab. */
  | { kind: "picks"; options: readonly number[] }
  /** One multi-select question: a digit per option (each toggles), Tab to
   *  the Submit tab, then `1`. */
  | { kind: "toggles"; options: readonly number[] }
  /** A lone Esc on a question. */
  | { kind: "cancel" }
  /** Up twice is "Yes, manually approve edits" in every variant seen. */
  | { kind: "planManual" }
  /** Up wraps to "Tell Claude what to change" and focuses its field. */
  | { kind: "planChanges"; text: string }
  /** A lone Esc on a plan: rejects it and stops. */
  | { kind: "reject" };

export type AnswerKind = Answer["kind"];

/** The least trust (`trust.ts`) each answer needs. A lone Esc dismisses the
 *  dialog whatever was done to it; a digit picks its own row, and option 2's
 *  also depends on Claude having drawn that row; every other sequence assumes
 *  the dialog is as Claude drew it — row 1 highlighted, the first tab, empty
 *  fields. */
export function trustNeeded(kind: AnswerKind): Trust {
  switch (kind) {
    case "no":
    case "cancel":
    case "reject":
      return "reject";
    case "yes":
    case "option":
      return "basic";
    case "always":
      return "lone";
    default:
      return "full";
  }
}

/** Digits name rows 1 to 9. */
const MAX_DIGIT = 9;

/** Whether `count` options can each be named by a digit. */
const digitable = (count: number) => count >= 1 && count <= MAX_DIGIT;

/** Every answer a dialog has, by its tool (or its questions' shape). */
function everyAnswer(dialog: Dialog): AnswerKind[] {
  switch (dialog.kind) {
    case "permission": {
      const always: AnswerKind[] = dialog.option2 ? ["always"] : [];
      if (dialog.family === "other") return ["yes", "no"];
      if (dialog.family === "webFetch") return ["yes", ...always, "no"];
      return ["yes", ...always, "no", "yesTell", "noTell"];
    }
    case "questions": {
      const qs = dialog.questions;
      // The preview layout was probed as one single-select question only.
      const plain = (q: QuestionView) => q.options.every((o) => o.preview === null);
      if (qs.length === 1 && !qs[0].multiSelect && digitable(qs[0].options.length)) {
        // "Type something." is row N+1 — except in the preview layout, which
        // has no such row (N+1 there is "Chat about this").
        const typed = plain(qs[0]) && qs[0].options.length + 1 <= MAX_DIGIT;
        return ["option", ...(typed ? (["freeText"] as const) : []), "cancel"];
      }
      if (qs.length === 1 && qs[0].multiSelect && digitable(qs[0].options.length) && plain(qs[0])) {
        return ["toggles", "cancel"];
      }
      if (
        qs.length >= 2 &&
        qs.every((q) => !q.multiSelect && digitable(q.options.length) && plain(q))
      ) {
        return ["picks", "cancel"];
      }
      return ["cancel"];
    }
    case "plan":
      return ["planManual", "planChanges", "reject"];
    case "elicitation":
      return [];
  }
}

/** The answers a card offers for `dialog` at the trust it has in it. */
export function answersFor(dialog: Dialog, trust: Trust): AnswerKind[] {
  return everyAnswer(dialog).filter((kind) => atLeast(trust, trustNeeded(kind)));
}

const key = (k: TerminalKey): Step => ({ kind: "key", key: k });

/** The digit that names row `n` (from 1), or null past what a digit names. */
function digit(n: number): Step | null {
  if (!Number.isInteger(n) || n < 1 || n > MAX_DIGIT) return null;
  return key(String(n) as DigitKey);
}

/** The user's text as their paste, or null when nothing would be left of it:
 *  the paste drops control characters as Send's does. */
function pasteOf(text: string): Step | null {
  const kept = withoutControls(text.replace(/\r\n?/g, "\n"), "\t\n");
  return kept.trim() ? { kind: "paste", text } : null;
}

/** Writes in order, each its own, ANSWER_GAP_MS apart (an Enter behind a
 *  paste waits as Send's does), with the record read before the first and
 *  again before the last. Null when any write is. */
function typed(writes: readonly (Step | null)[]): Step[] | null {
  if (writes.some((w) => w === null)) return null;
  const steps: Step[] = [{ kind: "check" }];
  writes.forEach((write, i) => {
    const step = write as Step;
    if (i > 0) {
      const before = writes[i - 1] as Step;
      steps.push({
        kind: "wait",
        ms:
          before.kind === "paste" ? Math.max(ANSWER_GAP_MS, enterGap(before.text)) : ANSWER_GAP_MS,
      });
      if (i === writes.length - 1) steps.push({ kind: "check" });
    }
    steps.push(step);
  });
  return steps;
}

/** Options picked by index: every one named by a digit, none twice. */
function picked(options: readonly number[], count: number): boolean {
  return (
    new Set(options).size === options.length &&
    options.every((o) => Number.isInteger(o) && o >= 0 && o < Math.min(count, MAX_DIGIT))
  );
}

/**
 * The keys that give `answer` to `dialog`, or null when the card must not
 * offer it: an answer this dialog doesn't have (or not at the card's `trust`),
 * an option that isn't there, or text with nothing in it. The one place a
 * payload chooses bytes is here: an option's digit comes from its position in
 * the payload, bounded to the options that exist and to 1-9.
 */
export function answerSteps(dialog: Dialog, answer: Answer, trust: Trust): Step[] | null {
  if (!answersFor(dialog, trust).includes(answer.kind)) return null;
  const questions = dialog.kind === "questions" ? dialog.questions : [];
  switch (answer.kind) {
    case "yes":
      return typed([digit(1)]);
    case "always":
      return typed([digit(2)]);
    case "no":
    case "cancel":
    case "reject":
      return [{ kind: "check" }, ...escAlone()];
    case "yesTell":
      return typed([key("tab"), pasteOf(answer.text), key("enter")]);
    case "noTell":
      return typed([key("up"), key("tab"), pasteOf(answer.text), key("enter")]);
    case "option": {
      const count = questions[0]?.options.length ?? 0;
      return picked([answer.option], count) ? typed([digit(answer.option + 1)]) : null;
    }
    case "freeText": {
      const count = questions[0]?.options.length ?? 0;
      return typed([digit(count + 1), pasteOf(answer.text), key("enter")]);
    }
    case "picks": {
      const fits =
        answer.options.length === questions.length &&
        answer.options.every((o, i) => picked([o], questions[i].options.length));
      return fits ? typed([...answer.options.map((o) => digit(o + 1)), digit(1)]) : null;
    }
    case "toggles": {
      const count = questions[0]?.options.length ?? 0;
      return answer.options.length > 0 && picked(answer.options, count)
        ? typed([...answer.options.map((o) => digit(o + 1)), key("tab"), digit(1)])
        : null;
    }
    case "planManual":
      return typed([key("up"), key("up"), key("enter")]);
    case "planChanges":
      return typed([key("up"), pasteOf(answer.text), key("enter")]);
  }
}
