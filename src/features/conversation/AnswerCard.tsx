/** A dialog Claude is showing, drawn from its own hook payload, with the
 *  answers its keys can give: what replaces the composer while Claude asks.
 *
 *  COMPLIANCE.md bounds it as it bounds Send:
 *
 *  - **Only on the user's click or key.** An answer is typed by `answer`, an
 *    action reached only from this card's buttons and its digit keys (and a
 *    text answer's Enter), never from an effect, a timer or the record — and
 *    not in a card's first moments (`ARM_MS`), when a second click meant for
 *    the card just answered can land on the one that replaced it.
 *  - **Only the dialog's own keys** (`keys.ts` `answerSteps`): a digit, Tab,
 *    Up, Esc alone, Enter, and the text the user wrote here as their paste.
 *    The payload chooses one thing — which digit an option is, by its place.
 *    A digit pressed on the card is the digit Claude's dialog has for that
 *    row, or nothing.
 *  - **Only into this dialog, once, as far as it can be trusted.** The record
 *    is read afresh before the first key and before the last (same session,
 *    same dialog, still open and alone, same pane and process); one answer
 *    per occurrence (`answerStore`); and only the answers the card's trust
 *    allows (`trust.ts`): none when a key may already have answered the
 *    dialog or another may be in front of it, single keys when it may have
 *    been touched or its case wasn't probed, No alone for a payload cut to
 *    fit.
 *
 *  Every string it draws is the model's or an MCP server's: text, or markdown
 *  that loads nothing remote. A URL is never a link. */
import { type Ref, useEffect, useMemo, useState } from "react";

import type { PendingPrompt } from "../../bindings";
import { HelpIcon, ListIcon, TerminalIcon, WarningIcon } from "../../components/icons";
import { MarkdownDocument } from "../../components/Markdown";
import { useHeldFor } from "../../lib/useHeldFor";
import { alpha } from "../../theme/colors";
import {
  answerOf,
  answerSettled,
  answerStarted,
  cancelAnswer,
  lastAnsweredAt,
  mayAnswer,
  type Occurrence,
  useAnswer,
} from "./answerStore";
import type { SendTarget } from "./Composer";
import {
  type Dialog,
  type Option2,
  type QuestionView,
  type Rule,
  shownText,
  type ToolView,
} from "./dialog";
import { type Answer, type AnswerKind, answerSteps, answersFor } from "./keys";
import { PatchDiff } from "./PatchDiff";
import { enqueue } from "./paneWriter";
import type { Trust } from "./trust";
import { VIEW_SHORTCUT } from "./viewMode";

/** How long a sent answer may go unanswered before the card says so. */
export const ANSWER_LATE_MS = 5_000;

/** How long a card's answers stay inert after it appears. The next dialog
 *  (another of parallel tool calls) replaces an answered card in place a few
 *  hundred ms after its key: a double-click, or a second click on the same
 *  spot, would otherwise answer it unseen. */
export const ARM_MS = 600;

/** A card that appears this soon after the same session's last answer is
 *  marked as a new request: the one just answered was replaced in place. */
export const RENEWED_MS = 3_000;

/** The card's model, from the view: the dialog on record and what may be done
 *  with it now. */
export interface DialogCard {
  prompt: PendingPrompt;
  dialog: Dialog;
  sessionId: string;
  recordedAtMs: number;
  /** Which of its answers may be offered (`trust.ts`), and why not more —
   *  the reason of whatever set it, or null. */
  trust: Trust;
  why: string | null;
}

/** The answers that open a text field before they go. */
type TextKind = "yesTell" | "noTell" | "freeText" | "planChanges";

/** What option 2 says it does: its first suggestion's kind, nothing more.
 *  The row's grants, under it, say the rest. */
const RULE_LABEL: Record<Rule, string> = {
  addRules: "Yes, and don't ask again",
  addDirectories: "Yes, and allow access to the directory",
  acceptEdits: "Yes, and accept edits",
};

function labelOf(dialog: Dialog, choice: Answer): string {
  switch (choice.kind) {
    case "yes":
      return "Yes";
    case "always":
      return dialog.kind === "permission" && dialog.option2
        ? RULE_LABEL[dialog.option2.rule]
        : "Yes, always";
    case "no":
      return "No";
    case "yesTell":
    case "noTell":
    case "freeText":
    case "planChanges":
      return TEXT_LABEL[choice.kind];
    case "option":
      return dialog.kind === "questions"
        ? dialog.questions[0]?.options[choice.option]?.label || `Option ${choice.option + 1}`
        : "Option";
    case "picks":
    case "toggles":
      return "Submit answers";
    case "cancel":
      return "Cancel";
    case "planManual":
      return "Approve, and review each edit";
    case "reject":
      return "Reject the plan";
  }
}

/** The answers that open a text field, by name. */
const TEXT_LABEL: Record<TextKind, string> = {
  yesTell: "Yes, and tell Claude…",
  noTell: "No, and tell Claude what to do instead…",
  freeText: "Something else…",
  planChanges: "Keep planning: tell Claude what to change…",
};

/** What each text field asks for. */
const TEXT_PLACEHOLDER: Record<TextKind, string> = {
  yesTell: "What should Claude do next?",
  noTell: "What should Claude do instead?",
  freeText: "Your answer",
  planChanges: "What should change in the plan?",
};

/** The answers drawn as one list: the dialog's direct answers and its text
 *  fields. A row carries a digit only when it is the digit Claude's own dialog
 *  has for it — Yes is 1 and option 2 is 2, a question's options are 1 to N
 *  and "Something else" is N+1 — so a key pressed on the card is the key that
 *  row is in the terminal. No, Cancel, a plan's rows and the "tell Claude"
 *  rows have none. */
interface Row {
  label: string;
  hint?: string;
  /** Sent on its own (a direct answer), or the text field it opens. */
  choice: Answer | null;
  opens?: TextKind;
  digit?: number;
  /** What option 2 grants, drawn under it. */
  grants?: Option2["grants"];
}

function rowsOf(dialog: Dialog, offered: readonly AnswerKind[]): Row[] {
  const rows: Row[] = [];
  const has = (kind: AnswerKind) => offered.includes(kind);
  const direct = (choice: Answer, extra: Omit<Row, "label" | "choice"> = {}) => {
    if (has(choice.kind)) rows.push({ label: labelOf(dialog, choice), choice, ...extra });
  };
  const text = (kind: TextKind, digit?: number) => {
    if (has(kind)) rows.push({ label: TEXT_LABEL[kind], choice: null, opens: kind, digit });
  };
  if (dialog.kind === "permission") {
    direct({ kind: "yes" }, { digit: 1 });
    direct({ kind: "always" }, { digit: 2, grants: dialog.option2?.grants });
    direct({ kind: "no" }, { hint: "and stop" });
    text("yesTell");
    text("noTell");
  } else if (dialog.kind === "questions") {
    if (has("option")) {
      const options = dialog.questions[0]?.options ?? [];
      options.slice(0, 9).forEach((option, i) => {
        direct(
          { kind: "option", option: i },
          { hint: option.description || undefined, digit: i + 1 },
        );
      });
      text("freeText", options.length + 1);
    }
    // Several questions, or a multi-select one, are picked in the body and
    // submitted together; Cancel sits beside their Submit.
    if (!has("picks") && !has("toggles")) direct({ kind: "cancel" }, { hint: "and stop" });
  } else if (dialog.kind === "plan") {
    direct({ kind: "planManual" });
    text("planChanges");
    direct({ kind: "reject" }, { hint: "and stop" });
  }
  return rows;
}

export function AnswerCard({
  card,
  target,
  shown,
  focusRef,
}: {
  card: DialogCard;
  target: SendTarget;
  /** The conversation is the face on screen: hidden, an answer still typing
   *  gives up its remaining keys (the user types in the terminal now). */
  shown: boolean;
  /** Where the keyboard goes when the conversation comes on screen. */
  focusRef?: Ref<HTMLElement>;
}) {
  const { dialog, prompt } = card;
  const occurrence = useMemo<Occurrence>(
    () => ({ sessionId: card.sessionId, recordedAtMs: card.recordedAtMs }),
    [card.sessionId, card.recordedAtMs],
  );
  const state = useAnswer(occurrence);
  // Inert for its first moments (`ARM_MS`); a new request if it replaced the
  // card of an answer just given (`RENEWED_MS`).
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setArmed(true), ARM_MS);
    return () => window.clearTimeout(timer);
  }, []);
  const [renewed] = useState(() => {
    const at = lastAnsweredAt(card.sessionId);
    return at !== null && Date.now() - at <= RENEWED_MS && answerOf(occurrence) === null;
  });
  const [note, setNote] = useState<string | null>(null);
  const [mode, setMode] = useState<TextKind | null>(null);
  const [text, setText] = useState("");
  const [picks, setPicks] = useState<(number | null)[]>(() =>
    dialog.kind === "questions" ? dialog.questions.map(() => null) : [],
  );
  const [toggles, setToggles] = useState<number[]>([]);

  const locked = state !== null && state.status !== "held";
  const offered = locked ? [] : answersFor(dialog, card.trust);
  const rows = rowsOf(dialog, offered);
  const late = useHeldFor(state?.status === "sent", ANSWER_LATE_MS);

  // The view going away, or the terminal coming up in its place, takes the
  // keys an answer has not typed yet: the user types in the terminal now.
  useEffect(
    () => () => cancelAnswer(occurrence, "the conversation closed before it was all typed."),
    [occurrence],
  );
  useEffect(() => {
    if (!shown) cancelAnswer(occurrence, "the terminal was opened before it was all typed.");
  }, [shown, occurrence]);

  /** The answer the user picked, as the dialog's own keys, through the pane's
   *  queue. The record is read afresh before the first key and before the
   *  last, and the first read also asks whether anything reached the pane as
   *  the dialog appeared. Once its first key is out, the occurrence takes no
   *  other. */
  const answer = (choice: Answer) => {
    // The one place the card's first moments are inert: every click and digit
    // that answers comes here (opening a text field types nothing).
    if (!armed || !mayAnswer(occurrence)) return;
    const steps = answerSteps(dialog, choice, card.trust);
    if (!steps) return;
    const at = target.pane();
    if (!at) {
      setNote("The terminal isn't ready yet.");
      return;
    }
    const label = labelOf(dialog, choice);
    let checks = 0;
    // Its keys are left out of the pane's input watch: they go only once the
    // checks (before the first and the last) found this dialog on record,
    // open, alone and untouched, and the last is the one that closes it, so
    // the dialog drawn next is not one they can have answered
    // (`inputWatch.untracked`).
    const job = enqueue(
      at.input,
      steps,
      () =>
        target.recheckAnswer(at, {
          sessionId: card.sessionId,
          recordedAtMs: card.recordedAtMs,
          recordedState: prompt.kind === "permission" ? "permission" : "waiting",
          first: checks++ === 0,
        }),
      { untracked: true },
    );
    answerStarted(occurrence, label, job);
    setNote(null);
    setMode(null);
    void job.outcome.then((outcome) => answerSettled(occurrence, label, outcome));
  };

  const textReady = text.trim() !== "";
  const allPicked = picks.length > 0 && picks.every((p) => p !== null);

  return (
    <section
      ref={focusRef}
      tabIndex={-1}
      aria-label="Claude is asking"
      onKeyDown={(e) => {
        // A digit picks the row that has it while the card (not a text field)
        // has the keyboard: the same digit as in the terminal, or nothing. Esc
        // here answers nothing.
        if (e.metaKey || e.ctrlKey || e.altKey || !/^[1-9]$/.test(e.key)) return;
        if ((e.target as HTMLElement).closest("textarea, input")) return;
        const row = rows.find((r) => r.digit === Number(e.key));
        if (!row) return;
        e.preventDefault();
        if (row.choice) answer(row.choice);
        else if (row.opens) setMode(row.opens);
      }}
      className="rounded-lg border px-4 py-3.5"
      style={{
        borderColor: alpha(28, "var(--color-status-red)"),
        background: alpha(4, "var(--color-status-red)"),
      }}
    >
      <CardHead card={card} renewed={renewed} />
      <div className="mt-2 max-h-[38vh] overflow-y-auto">
        <DialogBody
          dialog={dialog}
          picks={picks}
          toggles={toggles}
          onPick={setPicks}
          onToggle={setToggles}
          choosing={offered.includes("picks") || offered.includes("toggles")}
          optionRows={offered.includes("option")}
        />
      </div>
      {prompt.truncated && (
        <p className="mt-1.5 text-xs text-muted-3">
          Part of this was cut to fit here, so it can only be turned down from here. The terminal
          shows all of it.
        </p>
      )}

      {rows.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {rows.map((row, i) => (
            // The rows are fixed for the occurrence, and labels can repeat.
            <div key={i} className="min-w-0">
              <button
                type="button"
                aria-label={row.label}
                aria-keyshortcuts={row.digit === undefined ? undefined : String(row.digit)}
                aria-pressed={row.opens !== undefined ? mode === row.opens : undefined}
                aria-disabled={!armed}
                onClick={() => (row.choice ? answer(row.choice) : row.opens && setMode(row.opens))}
                className={`flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-md border border-line-2 bg-raised px-3 py-2 text-left text-base text-fg-2 transition-colors hover:border-line-strong ${
                  armed ? "" : "opacity-50"
                }`}
              >
                <span className="flex h-4 min-w-4 flex-none items-center justify-center text-2xs text-muted-3 tabular-nums">
                  {row.digit !== undefined && (
                    <span className="flex h-4 min-w-4 items-center justify-center rounded border border-line-2">
                      {row.digit}
                    </span>
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                {row.hint && (
                  <span className="min-w-0 truncate text-xs text-muted-4">{row.hint}</span>
                )}
              </button>
              {row.grants && row.grants.length > 0 && (
                <ul className="mt-1 mb-0.5 ml-[30px] space-y-0.5 text-xs leading-[1.45] text-muted-3">
                  {row.grants.map((grant, g) => (
                    // One per thing granted, in the payload's order.
                    <li key={g} className="min-w-0 break-words">
                      Grants <span className="selectable font-mono text-fg-3">{grant.what}</span>
                      {grant.where && <span>, {grant.where}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {(offered.includes("picks") || offered.includes("toggles")) && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={offered.includes("picks") ? !allPicked : toggles.length === 0}
            aria-disabled={!armed}
            onClick={() =>
              offered.includes("picks")
                ? answer({ kind: "picks", options: picks.map((p) => p ?? -1) })
                : answer({ kind: "toggles", options: toggles })
            }
            className="cursor-pointer rounded-md bg-accent-fill px-3 py-1.5 text-sm font-medium disabled:cursor-default disabled:opacity-40"
            style={{ color: "var(--on-accent)" }}
          >
            Submit answers
          </button>
          <button
            type="button"
            aria-disabled={!armed}
            onClick={() => answer({ kind: "cancel" })}
            className="cursor-pointer rounded-md border border-line-2 px-3 py-1.5 text-sm text-fg-2 hover:border-line-strong"
          >
            Cancel
          </button>
        </div>
      )}

      {mode && offered.includes(mode) && (
        <div className="mt-2.5 flex items-end gap-2 rounded-lg field bg-input py-2 pr-2 pl-3.5">
          <textarea
            // biome-ignore lint/a11y/noAutofocus: the field the user just asked for.
            autoFocus
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // Closes the field; it never answers.
                e.preventDefault();
                setMode(null);
                return;
              }
              if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
              e.preventDefault();
              if (textReady) answer({ kind: mode, text });
            }}
            aria-label={TEXT_PLACEHOLDER[mode]}
            placeholder={TEXT_PLACEHOLDER[mode]}
            className="max-h-[160px] min-h-[22px] flex-1 resize-none bg-transparent py-0.5 text-base leading-[1.55] text-fg placeholder:text-muted-4"
          />
          <button
            type="button"
            disabled={!textReady}
            onClick={() => answer({ kind: mode, text })}
            className="flex-none cursor-pointer rounded-md bg-accent-fill px-2.5 py-1 text-sm font-medium disabled:cursor-default disabled:opacity-40"
            style={{ color: "var(--on-accent)" }}
          >
            Send
          </button>
        </div>
      )}

      <CardStatus card={card} state={state} late={late} note={note} offered={offered} />
    </section>
  );
}

/** What is asking, and who — and, when it replaced the card of an answer just
 *  given, that it is a new request. */
function CardHead({ card, renewed }: { card: DialogCard; renewed: boolean }) {
  const { dialog, prompt } = card;
  const title =
    dialog.kind === "questions"
      ? dialog.questions.length > 1
        ? "Claude has questions for you"
        : "Claude has a question for you"
      : dialog.kind === "plan"
        ? "Claude has a plan for you to review"
        : dialog.kind === "elicitation"
          ? `${dialog.server ?? "An MCP server"} asks for your input`
          : permissionTitle(dialog);
  return (
    <div className="flex min-w-0 items-center gap-2">
      {dialog.kind === "plan" ? (
        <ListIcon size={12} className="flex-none text-muted-2" />
      ) : dialog.kind === "questions" ? (
        <HelpIcon size={12} className="flex-none text-muted-2" />
      ) : (
        <WarningIcon size={12} className="flex-none text-status-red" />
      )}
      {renewed && (
        <span className="flex-none rounded-sm border border-line-2 px-1.5 text-xs font-medium text-fg-3">
          New request
        </span>
      )}
      <span className="min-w-0 truncate text-base font-medium text-fg-2">{title}</span>
      {prompt.agentType && (
        <span className="min-w-0 flex-none truncate text-xs text-muted-3">
          from the {shownText(prompt.agentType)} agent
        </span>
      )}
    </div>
  );
}

function permissionTitle(dialog: Extract<Dialog, { kind: "permission" }>): string {
  if (dialog.mcp)
    return `Claude wants to use ${dialog.mcp.tool} on ${dialog.mcp.server ?? "an MCP server"}`;
  switch (dialog.tool) {
    case "Bash":
      return "Claude wants to run a command";
    case "Edit":
      return "Claude wants to edit a file";
    case "Write":
      return "Claude wants to write a file";
    case "Read":
      return "Claude wants to read a file";
    case "WebFetch":
      return "Claude wants to fetch a page";
    case "WebSearch":
      return "Claude wants to search the web";
    default:
      return `Claude wants to use ${dialog.tool || "a tool"}`;
  }
}

/** One line under the answers: what became of the answer, or why there are
 *  fewer (or none) to pick. */
function CardStatus({
  card,
  state,
  late,
  note,
  offered,
}: {
  card: DialogCard;
  state: ReturnType<typeof useAnswer>;
  late: boolean;
  note: string | null;
  offered: readonly AnswerKind[];
}) {
  const { dialog } = card;
  let line: string | null = null;
  if (state?.status === "typing") line = `Answering: ${state.label}`;
  // "Nothing recorded" claims no more than that: an approved tool that writes
  // nothing while it runs leaves the record where the dialog left it.
  else if (state?.status === "sent")
    line = late
      ? `Sent: ${state.label}. Nothing recorded since; if the terminal still shows the dialog, answer it there.`
      : `Sent: ${state.label}`;
  else if (state?.status === "partial")
    line = `Stopped part-way through "${state.label}": ${state.reason} Finish it in the terminal.`;
  else if (note) line = note;
  else if (state?.status === "held") line = `Not answered: ${state.reason}`;
  else if (dialog.kind !== "elicitation") line = card.why;
  // An answer on its way, or sent, is not a reason to go to the terminal.
  const answering = state?.status === "typing" || state?.status === "sent";
  const terminal =
    state?.status === "partial" ||
    (!answering && (dialog.kind === "elicitation" || offered.length === 0));
  const auto = dialog.kind === "plan" && !state;
  return (
    <>
      {line && (
        <p role="status" className="mt-2 text-xs leading-[1.5] text-muted-3">
          {line}
        </p>
      )}
      {auto && (
        <p className="mt-1.5 text-sm leading-[1.5] text-muted-3">
          To approve into auto mode, use the terminal.
        </p>
      )}
      {terminal && (
        <p className="mt-1.5 flex items-center gap-1.5 text-sm leading-[1.5] text-muted-3">
          <TerminalIcon size={11} className="flex-none" />
          Answer it in the terminal: switch to Terminal above, or press {VIEW_SHORTCUT}.
        </p>
      )}
    </>
  );
}

/** A unified-diff hunk, as the tool cards draw an edit before it lands: every
 *  old line out, every new line in, from line 1. */
function replacementPatch(old: string, next: string): string {
  const lines = (text: string) => {
    const all = text.split("\n").map((l) => l.replace(/\r$/, ""));
    return text.endsWith("\n") ? all.slice(0, -1) : all;
  };
  const out = old === "" ? [] : lines(old);
  const added = next === "" ? [] : lines(next);
  return [
    `@@ -1,${out.length} +1,${added.length} @@`,
    ...out.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join("\n");
}

function creationPatch(content: string): string {
  const all = content.split("\n").map((l) => l.replace(/\r$/, ""));
  const lines = content.endsWith("\n") ? all.slice(0, -1) : all;
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

const WELL =
  "selectable rounded-md border border-line-2 bg-input px-2.5 py-2 font-mono text-xs leading-[1.55] whitespace-pre-wrap break-words";

function ToolBody({ view }: { view: ToolView }) {
  switch (view.kind) {
    case "command":
      return (
        <div className="space-y-1.5">
          <pre className={WELL}>{view.command}</pre>
          {view.description && (
            <p className="text-sm leading-[1.5] text-fg-3">{view.description}</p>
          )}
        </div>
      );
    case "edit":
      return (
        <div className="space-y-1.5">
          <p className="selectable font-mono text-xs break-all text-fg-3">
            {view.path}
            {view.all && <span className="ml-2 text-muted-4">every occurrence</span>}
          </p>
          <PatchDiff path={view.path} op="Update" patch={replacementPatch(view.old, view.next)} />
        </div>
      );
    case "write":
      return (
        <div className="space-y-1.5">
          <p className="selectable font-mono text-xs break-all text-fg-3">{view.path}</p>
          <PatchDiff path={view.path} op="Add" patch={creationPatch(view.content)} />
        </div>
      );
    case "fetch":
      return (
        <div className="space-y-1.5">
          <p className="selectable font-mono text-xs break-all text-fg-3">{view.url}</p>
          {view.prompt && <p className="text-sm leading-[1.5] text-fg-3">{view.prompt}</p>}
        </div>
      );
    case "json":
      return <pre className={WELL}>{view.text}</pre>;
  }
}

function DialogBody({
  dialog,
  picks,
  toggles,
  onPick,
  onToggle,
  choosing,
  optionRows,
}: {
  dialog: Dialog;
  picks: (number | null)[];
  toggles: number[];
  onPick: (next: (number | null)[]) => void;
  onToggle: (next: number[]) => void;
  /** The questions are picked here and submitted together. */
  choosing: boolean;
  /** The one question's options are the answer rows below: here, only what
   *  the rows can't show (their previews). */
  optionRows: boolean;
}) {
  switch (dialog.kind) {
    case "permission":
      return <ToolBody view={dialog.view} />;
    case "plan":
      return (
        <MarkdownDocument noRemote className="text-base leading-[1.65] text-fg-2">
          {dialog.plan}
        </MarkdownDocument>
      );
    case "elicitation":
      return (
        <div className="space-y-1.5 text-sm leading-[1.5] text-fg-3">
          {dialog.message && <p className="selectable">{dialog.message}</p>}
          {dialog.url !== null && (
            <p className="selectable font-mono text-xs break-all text-muted-2">{dialog.url}</p>
          )}
          {dialog.fields.length > 0 && (
            <ul className="space-y-1">
              {dialog.fields.map((field) => (
                <li key={field.name} className="text-sm">
                  <span className="font-medium text-fg-2">{field.title}</span>
                  <span className="ml-1.5 text-xs text-muted-4">
                    {field.choices.length > 0 ? field.choices.join(" · ") : field.type}
                    {field.required ? " · required" : ""}
                  </span>
                  {field.description && (
                    <span className="ml-1.5 text-muted-3">{field.description}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    case "questions":
      if (dialog.questions.length === 0) return <pre className={WELL}>{dialog.raw}</pre>;
      return (
        <div className="space-y-3">
          {dialog.questions.map((question, qi) => (
            <QuestionBlock
              key={`${qi}:${question.question}`}
              question={question}
              rows={optionRows}
              choose={
                !choosing
                  ? null
                  : question.multiSelect
                    ? {
                        kind: "toggle",
                        chosen: toggles,
                        set: (i) =>
                          onToggle(
                            toggles.includes(i) ? toggles.filter((t) => t !== i) : [...toggles, i],
                          ),
                      }
                    : {
                        kind: "pick",
                        chosen: picks[qi] === null ? [] : [picks[qi] as number],
                        set: (i) => onPick(picks.map((p, j) => (j === qi ? i : p))),
                      }
              }
            />
          ))}
        </div>
      );
  }
}

function QuestionBlock({
  question,
  rows,
  choose,
}: {
  question: QuestionView;
  /** Its options are drawn as the card's answer rows. */
  rows: boolean;
  choose: { kind: "pick" | "toggle"; chosen: number[]; set: (option: number) => void } | null;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="text-base leading-[1.5] text-fg-2">
        {question.header && (
          <span className="mr-1.5 rounded border border-line-2 px-1 text-2xs text-muted-3">
            {question.header}
          </span>
        )}
        {question.question}
        {question.multiSelect && <span className="ml-1.5 text-xs text-muted-4">Pick any</span>}
      </legend>
      <div className="mt-1.5 space-y-1">
        {question.options.map((option, i) =>
          rows && option.preview === null ? null : (
            <div key={`${i}:${option.label}`} className="min-w-0">
              {rows ? (
                <p className="text-xs text-muted-3">
                  {i + 1}. {option.label}
                </p>
              ) : choose ? (
                <label className="flex min-w-0 cursor-pointer items-baseline gap-2 text-sm text-fg-2">
                  <input
                    type={choose.kind === "pick" ? "radio" : "checkbox"}
                    checked={choose.chosen.includes(i)}
                    onChange={() => choose.set(i)}
                    disabled={i >= 9}
                    className="flex-none"
                  />
                  <span className="min-w-0">
                    {option.label}
                    {option.description && (
                      <span className="ml-1.5 text-xs text-muted-3">{option.description}</span>
                    )}
                  </span>
                </label>
              ) : (
                <p className="text-sm text-fg-3">
                  {option.label}
                  {option.description && (
                    <span className="ml-1.5 text-xs text-muted-4">{option.description}</span>
                  )}
                </p>
              )}
              {option.preview !== null && <pre className={`${WELL} mt-1`}>{option.preview}</pre>}
            </div>
          ),
        )}
      </div>
    </fieldset>
  );
}
