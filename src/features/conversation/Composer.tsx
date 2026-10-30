/** The Conversation view's composer: what the user writes, sent into the real
 *  Claude Code TUI as the keys their own clear, paste and Enter would send.
 *
 *  COMPLIANCE.md ("No output-parsing influences input") is why it is shaped the
 *  way it is:
 *
 *  - **Only the draft, only on a submit.** Nothing here reads the conversation,
 *    the hooks' messages or the terminal: the one text it ever types is what
 *    the user wrote into this box, when they press Enter or Send. Stop is one
 *    Esc, on a click.
 *  - **Through the terminal's own input path, one action at a time.** Every
 *    write goes through the pane's queue (`paneWriter`) to the pane's renderer
 *    (`PaneInput`), whose keys leave by the pane's one writer. The terminal is
 *    hidden, never bypassed.
 *  - **Never into a dialog.** Send opens while Claude is at its prompt and
 *    while it works (Claude queues a message typed then), and only on what the
 *    session's record says ({@link sendGate}): never while it records a dialog
 *    that Claude's own signs haven't shown closed for a while (an Enter there
 *    confirms whichever option is highlighted), never before the claude
 *    process in the pane has reported (no hook runs under Claude's startup
 *    dialogs), never over a link that isn't live. The record is read
 *    afresh before the first byte and again right before the Enter, which is
 *    given up if a dialog has appeared since.
 *  - **A paste left behind is replaced, not doubled.** Each send first empties
 *    Claude's input (`clear`), so a paste whose Enter was given up, or a prompt
 *    an early Stop put back, never goes in behind a second one.
 *
 *  And what the user wrote is never lost on the way: the draft stays in the box
 *  until the session has taken its paste and its Enter, and a message the
 *  session took is drawn until the record shows it (`composerStore`). */
import { type RefObject, useEffect, useRef, useState } from "react";

import type { AgentProcess, AgentState, PaneLink, SessionState } from "../../bindings";
import { ArrowUpIcon, PlayIcon, StopIcon, WarningIcon } from "../../components/icons";
import { Button } from "../../components/primitives";
import { alpha } from "../../theme/colors";
import type { PaneInput } from "../terminal/orchestrator";
import { AnswerCard, type DialogCard } from "./AnswerCard";
import {
  composerOf,
  noteFor,
  sendSettled,
  sendStarted,
  stopClicked,
  stopOver,
  stopUnheard,
  typeDraft,
  useTabComposer,
} from "./composerStore";
import { sendSteps, stopSteps } from "./keys";
import { enqueue } from "./paneWriter";
import { toolLabel } from "./turns";
import { VIEW_SHORTCUT } from "./viewMode";

/** Where the agent is, for what the composer shows. */
export type ComposerPhase =
  | "idle"
  | "working"
  | "background"
  | "asking"
  | "starting"
  | "ended"
  | "offline"
  | "reconnecting"
  | "lost";

/** What the composer shows, from the session's reconciled state and its pane —
 *  `null` while it has none, else whether the pane reaches its session. Display
 *  only: it never opens Send ({@link sendGate} does).
 *
 *  `mainAtPrompt` is the record's word ({@link SendGate.atPrompt}) that the main
 *  thread is at its prompt. Subagents run in the background, so a turn can end
 *  while they work on, and the reconciler reads that as delegating. That is
 *  `background`, not `working`: there is no turn for Stop to stop — its Esc
 *  would land on Claude's idle prompt. */
export function composerPhase(
  state: AgentState | null | undefined,
  pane: PaneLink | null,
  mainAtPrompt = false,
): ComposerPhase {
  if (pane === null) return "offline";
  // Nothing typed into a pane that can't reach its session arrives, whatever
  // the hooks last said.
  if (pane !== "live") return pane;
  switch (state) {
    case "idle":
      return "idle";
    case "active":
      return "working";
    case "delegating":
      return mainAtPrompt ? "background" : "working";
    case "permission":
    case "waiting":
      return "asking";
    case "exited":
      return "ended";
    default:
      // No hook has spoken yet: Claude is still coming up, and text typed into
      // a TUI that has not turned bracketed paste on would arrive as keys.
      return "starting";
  }
}

/** The session's row as the hook stored it, for {@link sendGate}. */
export type RecordedRow = Pick<
  SessionState,
  "recordedState" | "updatedAtMs" | "interruptedAtMs" | "prompt"
>;

/** How long after a stored dialog's close Send and Stop wait before typing
 *  over it. In a serial pair the next dialog is usually on screen by the time
 *  the first one's call end is stamped: drawn 33-54 ms after the answer, while
 *  its own hook lands 45-70 ms after the draw (CLI 2.1.312, probed). Until
 *  that hook lands the record shows the first dialog closed and nothing newer,
 *  and an Enter would confirm the next one's highlighted row, an Esc answer
 *  it. The probed figures are an unloaded machine's; under load (load
 *  averages of 30 seen) the hook's tail runs far past them. 2 s covers that,
 *  and costs an approved long tool only 2 s more after it ends. */
export const CLOSED_SETTLE_MS = 2_000;

const RUNNING = "Claude is running what was approved; Send opens when it finishes.";

/** Whether Send may open — and, when it may not though the box is there, why. */
export interface SendGate {
  open: boolean;
  /** A few honest words for a composer whose Send is off. */
  reason: string | null;
  /** Whether Stop may press its Esc: the claude process in the pane has
   *  reported (the record has anything of it, newer than its start) over a
   *  live link, so Claude is past its startup dialogs, which no hook reports;
   *  and no dialog on record is up or closed less than
   *  {@link CLOSED_SETTLE_MS} ago, when the Esc could land on the next one. */
  stop: boolean;
  /** The record has the main thread at its prompt, newer than the process: a
   *  turn's end, the session's start, or Claude's interrupt marker. */
  atPrompt: boolean;
  /** When this answer changes with the clock alone (a stored dialog's close
   *  settling, for Stop or for Send), or null when only a new record can
   *  change it. */
  changesAt: number | null;
}

const STARTING_HINT = "Waiting for Claude Code to reach its prompt.";

const closed = (reason: string | null): SendGate => ({
  open: false,
  reason,
  stop: false,
  atPrompt: false,
  changesAt: null,
});

/**
 * Whether Send may open, on the session's own record and only on writes newer
 * than the claude process in the pane (`floor`, its start by the process
 * table): an older one belongs to an earlier process — a relaunched tab
 * inherits its last session's row, and its keys would go to a shell, or to the
 * new claude's startup dialogs, which no hook reports. With no floor — no
 * claude seen in the pane — there is nothing to type to.
 *
 * Open at Claude's prompt and while it works: a message typed during a turn
 * waits in Claude's queue. Shut while the record holds a dialog (a permission,
 * a question, a plan), unless Claude's interrupt marker came after it, or the
 * dialog's own call ended {@link CLOSED_SETTLE_MS} before `now` (this Mac's
 * clock, which the hook stamps with too). Only the call's end
 * (`callEndedAtMs`) opens Send: a status-line render (`closedAtMs`) is
 * timing, not evidence, and one that ran late under load would read as the
 * close of a dialog still up, which Send's Enter would then approve — and
 * nothing newer would ever be recorded to catch it. Stop waits for the close
 * by either sign, so it stays there through a long approved tool.
 */
export function sendGate(
  link: PaneLink | null,
  floor: number | null,
  row: RecordedRow | null,
  now: number,
): SendGate {
  if (link !== "live") return closed(null);
  if (floor === null) return closed("Send opens once Claude Code is seen running in the terminal.");
  if (!row) return closed(STARTING_HINT);
  const interrupted = row.interruptedAtMs !== null && row.interruptedAtMs > floor;
  // Everything recorded predates this process: it has just started, or resumed.
  if (!interrupted && (row.updatedAtMs ?? 0) <= floor) return closed(STARTING_HINT);
  if (row.recordedState === "exited") return closed("The session has ended.");
  const atPrompt = interrupted || row.recordedState === "idle";
  if (atPrompt || (row.recordedState !== "permission" && row.recordedState !== "waiting")) {
    return { open: true, reason: null, stop: true, atPrompt, changesAt: null };
  }
  const closedAt = row.prompt?.closedAtMs ?? null;
  const endedAt = row.prompt?.callEndedAtMs ?? null;
  const stopAt = closedAt === null ? null : closedAt + CLOSED_SETTLE_MS;
  const sendAt = endedAt === null ? null : endedAt + CLOSED_SETTLE_MS;
  const open = sendAt !== null && sendAt <= now;
  const ahead = [stopAt, sendAt].filter((at): at is number => at !== null && at > now);
  return {
    open,
    reason: open
      ? null
      : closedAt !== null && endedAt === null
        ? RUNNING
        : "Send opens once Claude moves past its dialog.",
    stop: stopAt !== null && stopAt <= now,
    atPrompt: false,
    changesAt: ahead.length > 0 ? Math.min(...ahead) : null,
  };
}

/**
 * The gate's floor: when the claude process in the tab's pane started, from the
 * process table's answer about that very pane — the session the tab is attached
 * to now (`paneId`), so an answer still cached about a pane a resume replaced
 * (an older process, older than its own idle row) can't pass for this one's.
 * `null` when the table shows no claude there: a shell at its prompt, a claude
 * that exited, a pane not scanned yet, a Daedalus pane.
 */
export function processFloor(
  processes: readonly AgentProcess[] | undefined,
  termKey: string,
  paneId: number | null,
): number | null {
  if (paneId === null) return null;
  const own = processes?.find(
    (p) =>
      p.termKey === termKey &&
      p.paneAgentKind === "Claude" &&
      p.agentKind === "Claude" &&
      p.paneId === paneId,
  );
  return own?.startedAtMs ?? null;
}

/** What a lost pane's notice offers. */
export interface LostPane {
  resume?: () => void;
  close: () => void;
  resumeBlocked?: string;
}

/** The pane a send types into, read at the moment of the user's action, and
 *  the claude process in it (its start, the gate's floor). */
export interface SendPane {
  input: PaneInput;
  floor: number;
}

/** The dialog an answer is for, as the card drew it. */
export interface AnsweredDialog {
  sessionId: string;
  recordedAtMs: number;
  /** The state the hook stored with the dialog — and that the display, which
   *  reads the session's reconciled state, must still show. */
  recordedState: AgentState;
  /** The answer's first check, before any key of its own: input that reached
   *  the pane as the dialog appeared (`trust.ts` `ANSWERED_BEFORE_MS`) was
   *  someone else's (an answer's own keys are left out of the watch), and may
   *  have answered it; and a pane this page wasn't watching then can't be
   *  vouched for. */
  first: boolean;
}

/** How the composer, and the answer card, reach their pane. */
export interface SendTarget {
  /** The pane now, or null while there is none (or no claude seen in it). */
  pane: () => SendPane | null;
  /** The session's state read afresh — a command, not the cache: why typing
   *  into `at` must stop now, or null to go on. */
  recheck: (at: SendPane) => Promise<string | null>;
  /** The same, for an answer: also why the dialog it answers may no longer be
   *  the one on screen. */
  recheckAnswer: (at: SendPane, dialog: AnsweredDialog) => Promise<string | null>;
}

/** What Claude waits on the user for: a question, a plan to approve, a tool's
 *  permission, or any other input. */
export type AskKind = "question" | "plan" | "permission" | "input";

export interface Ask {
  kind: AskKind;
  /** The hook's own words, when it gave any. */
  message: string | null;
}

/** The tool a hook's message names: `santree-hook` words a permission request
 *  as "run <tool>" when Claude's gives none of its own (`read_hook_input`), and
 *  Claude's permission notification ends "…permission to use <tool>". */
function askedTool(message: string | null): string | null {
  if (!message) return null;
  return (
    /^run (\S+)$/.exec(message.trim())?.[1] ??
    /permission to use (\S+?)\.?$/.exec(message.trim())?.[1] ??
    null
  );
}

/** What Claude is asking, for the card that says so. A question
 *  (AskUserQuestion) and a plan to approve (ExitPlanMode) reach the hooks as
 *  permission requests for the tool that asks them, so the tool the hook names
 *  decides first; failing a name, a question or plan the record shows still
 *  unanswered (`pending`); failing that, the hook's state. Display only: what
 *  Claude asks never reaches the draft. */
export function askOf(
  state: "permission" | "waiting",
  message: string | null,
  pending: "question" | "plan" | null,
): Ask {
  const tool = askedTool(message);
  const kind: AskKind =
    tool === "AskUserQuestion"
      ? "question"
      : tool === "ExitPlanMode"
        ? "plan"
        : tool
          ? "permission"
          : (pending ?? (state === "permission" ? "permission" : "input"));
  return { kind, message };
}

/** The asking card's words. */
function askCopy(ask: Ask | undefined): { title: string; detail: string | null } {
  switch (ask?.kind) {
    case "question":
      return { title: "Claude has a question for you", detail: null };
    case "plan":
      return {
        title: "Claude has a plan for you to review",
        detail: "Approve it, or tell Claude what to change.",
      };
    case "permission": {
      const tool = askedTool(ask.message);
      return {
        title: "Claude needs your permission",
        detail: tool ? `It wants to use ${toolLabel(tool)}.` : ask.message,
      };
    }
    default:
      return { title: "Claude is waiting for your input", detail: ask?.message ?? null };
  }
}

/** How long Stop rests after a click, and how long the record has to show what
 *  the Esc did before the composer takes it that Claude stopped before its
 *  first reply — which it records nowhere. */
export const STOP_REST_MS = 3000;

/** Why a send in flight gives up its remaining keys. */
const LEFT_FOR_TERMINAL = "the terminal was opened before its Enter.";
const VIEW_GONE = "the conversation closed before its Enter.";
const STOPPED = "Stop was pressed before its Enter.";

const PHASE_HINT: Record<ComposerPhase, string> = {
  idle: "",
  working: "Claude is working: a message now waits in its queue.",
  background: "Background agents are working. A message now starts a new turn.",
  asking: "",
  starting: STARTING_HINT,
  ended: "The session has ended.",
  offline: "The terminal isn't running.",
  reconnecting: "Send opens when the terminal is back.",
  lost: "Send is off until the session is resumed.",
};

/** What stands between the box and the session, said above the box. */
function noticeFor(
  phase: ComposerPhase,
  stopped: { restored: boolean } | null,
): { title: string; detail: string } | null {
  if (phase === "lost") {
    return {
      title: "This terminal's session is gone",
      detail:
        "santree lost it: the santree server stopped, or it never got a session. Nothing was restarted.",
    };
  }
  if (phase === "reconnecting") {
    return {
      title: "The terminal is reconnecting",
      detail: "Claude Code is still running there.",
    };
  }
  if (stopped) {
    // An Esc before Claude's first reply leaves no trace in the record and
    // fires no hook: Claude puts the prompt back in its input instead.
    return stopped.restored
      ? {
          title: "Claude stopped before replying and put your message back in its input",
          detail: "It's back here too. Sending replaces Claude's copy.",
        }
      : {
          title: "Claude may have put the prompt back in its input",
          detail: "If it stopped before replying, the prompt is there. Sending replaces it.",
        };
  }
  return null;
}

export function Composer({
  draftKey,
  phase,
  gate,
  recordedAt,
  target,
  ask,
  dialog = null,
  latestPrompt,
  journalSeq,
  shown = true,
  focusOnShow = false,
  onStopped,
  lost = null,
}: {
  /** Whose draft this is — the tab's term key. */
  draftKey: string;
  /** What to show ({@link composerPhase}). */
  phase: ComposerPhase;
  /** Whether Send may open ({@link sendGate}). */
  gate: SendGate;
  /** When the session's record last said anything — the hook's stored write
   *  or Claude's interrupt marker, the newer — or null with no record: what
   *  tells a Stop it was heard. */
  recordedAt: number | null;
  /** The pane, read at the moment of a click. */
  target: SendTarget;
  /** What Claude is asking, when it is. */
  ask?: Ask;
  /** The dialog on screen, from its own hook payload, when the record has it:
   *  drawn with its answers in place of the plain card. */
  dialog?: DialogCard | null;
  /** The record's latest prompt (its item id, null before the first), or
   *  `undefined` until the record has been read: which turn a Stop stops. */
  latestPrompt?: string | null;
  /** The record's last item: a message sent now shows once a prompt after it
   *  lands. */
  journalSeq: number;
  /** The conversation is the face on screen. Hidden behind the terminal, a
   *  send's Enter not yet pressed is given up: the user is typing there now. */
  shown?: boolean;
  /** Take the keyboard each time the conversation comes on screen — as a
   *  terminal does when its tab is shown in the focused group. */
  focusOnShow?: boolean;
  /** Stop's Esc reached the session: the record is worth reading again. */
  onStopped?: () => void;
  /** A lost pane's way back, as its own notice in the terminal offers it:
   *  Resume (on the click only; `resumeBlocked` says why it can't yet) and
   *  Close. */
  lost?: LostPane | null;
}) {
  const { draft, note, sending, stop: stopMark } = useTabComposer(draftKey);
  const box = useRef<HTMLTextAreaElement>(null);
  const card = useRef<HTMLElement>(null);
  const [rested, setRested] = useState(false);

  // A Stop holds until the record has anything newer than the click: until
  // then Claude may have taken the Esc before its first reply, which it records
  // nowhere, and put the prompt back in its input.
  const stopHeld = stopMark !== null && !(recordedAt !== null && recordedAt > stopMark.at);
  const stopUnheardNow = stopHeld && rested;
  // Stopped before its first reply, Claude is back at its prompt while the
  // display, which only decays, still says it works.
  const shownPhase = stopUnheardNow && phase === "working" ? "idle" : phase;
  const ready =
    gate.open && (shownPhase === "idle" || shownPhase === "working" || shownPhase === "background");
  const canSend = ready && sending === null && draft.trim() !== "";

  // Read by a send as it settles, after the render that started it.
  const seqNow = useRef(journalSeq);
  seqNow.current = journalSeq;
  const onStoppedRef = useRef(onStopped);
  onStoppedRef.current = onStopped;

  // The view going away takes a send's Enter with it: pressed later, it would
  // land in whatever the user is looking at by then.
  useEffect(() => () => composerOf(draftKey).sending?.cancel(VIEW_GONE), [draftKey]);
  // So does the terminal coming up in its place: the user types there now.
  useEffect(() => {
    if (!shown) composerOf(draftKey).sending?.cancel(LEFT_FOR_TERMINAL);
  }, [shown, draftKey]);

  // Each time the conversation comes on screen, the keyboard comes with it:
  // into the box, or — while Claude asks and there is none — onto the card.
  // Never otherwise behind the user's back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the face coming up is the one trigger.
  useEffect(() => {
    if (shown && focusOnShow) (box.current ?? card.current)?.focus({ preventScroll: true });
  }, [shown]);

  // Past its rest, a Stop the record hasn't answered was an Esc before
  // Claude's first reply.
  const stopAt = stopMark?.at ?? null;
  useEffect(() => {
    setRested(false);
    if (stopAt === null) return;
    const timer = window.setTimeout(
      () => setRested(true),
      Math.max(0, stopAt + STOP_REST_MS - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [stopAt]);
  // Claude put the message back in its input: it comes back here too, once.
  useEffect(() => {
    if (stopUnheardNow && stopAt !== null) stopUnheard(draftKey, stopAt);
  }, [stopUnheardNow, stopAt, draftKey]);
  // The record has moved on past the Stop: nothing is held for it any more.
  useEffect(() => {
    if (stopAt !== null && !stopHeld) stopOver(draftKey, stopAt);
  }, [stopAt, stopHeld, draftKey]);

  // Grow with the draft, to a cap; past it the box scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `draft` is the trigger, not an input.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft]);

  /** The draft as the user's own clear, paste and Enter, through the pane's
   *  queue: the record is read afresh before the first byte and again before
   *  the Enter, which is given up if Claude has opened a dialog meanwhile. The
   *  box holds still until the session took both; the message is drawn from
   *  then until the record shows it. */
  const send = () => {
    // The store, not this render: a second click before the re-render is not
    // a second send.
    if (!canSend || composerOf(draftKey).sending) return;
    const at = target.pane();
    if (!at) {
      noteFor(draftKey, "The terminal isn't ready yet.");
      return;
    }
    const key = draftKey;
    const text = draft;
    const queued = shownPhase === "working";
    const job = enqueue(at.input, sendSteps(text), () => target.recheck(at));
    sendStarted(key, job);
    void job.outcome.then((outcome) =>
      sendSettled(key, text, outcome, { afterSeq: seqNow.current, queued }),
    );
  };

  /** One Esc, through the same queue: it gives up a send's Enter not yet
   *  pressed, and is held (see `stopHeld`) until the record shows anything
   *  newer, so there is never a second behind it. */
  const stop = () => {
    if (shownPhase !== "working" || stopHeld || !gate.stop) return;
    const at = target.pane();
    if (!at) {
      noteFor(draftKey, "The terminal isn't ready yet.");
      return;
    }
    const key = draftKey;
    const when = Date.now();
    composerOf(key).sending?.cancel(STOPPED);
    stopClicked(key, when, latestPrompt);
    void enqueue(at.input, stopSteps()).outcome.then((outcome) => {
      if (outcome.kind === "done") {
        onStoppedRef.current?.();
        return;
      }
      // Nothing was pressed, so there is nothing to wait to hear about.
      stopOver(key, when);
      noteFor(key, "Couldn't reach the terminal. Nothing was pressed.");
    });
  };

  if (phase === "asking" && dialog) {
    return (
      <AnswerCard
        key={`${dialog.sessionId}:${dialog.recordedAtMs}`}
        card={dialog}
        target={target}
        shown={shown}
        focusRef={card}
      />
    );
  }

  if (phase === "asking") {
    const red = "var(--color-status-red)";
    const copy = askCopy(ask);
    return (
      <div
        ref={card as RefObject<HTMLDivElement>}
        role="status"
        tabIndex={-1}
        className="rounded-lg border px-4 py-3"
        style={{ borderColor: alpha(35, red), background: alpha(6, red) }}
      >
        <div className="text-base font-medium text-fg-2">{copy.title}</div>
        {copy.detail && (
          <p className="selectable mt-0.5 text-sm leading-[1.5] text-fg-3">{copy.detail}</p>
        )}
        <p className="mt-0.5 text-sm leading-[1.5] text-muted-3">
          Answer it in the terminal: switch to Terminal above, or press {VIEW_SHORTCUT}.
        </p>
      </div>
    );
  }

  const notice = noticeFor(phase, stopUnheardNow ? stopMark : null);
  // Why Send is off, most specific first — the record's reason over what the
  // display shows, which can say "working" over a dialog still on record — or,
  // with it on, what a message does now.
  const why = (!gate.open && gate.reason) || PHASE_HINT[shownPhase];
  const hint = sending ? "Sending…" : (note ?? why);
  return (
    <div>
      {notice && (
        <div
          role="status"
          className="mb-2.5 flex items-center gap-3 rounded-lg border border-line-2 bg-raised px-3.5 py-3"
        >
          <WarningIcon size={13} className="flex-none text-status-amber" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-fg-2">{notice.title}</div>
            <div className="text-xs leading-[1.5] text-muted-3">{notice.detail}</div>
            {phase === "lost" && lost?.resume && lost.resumeBlocked && (
              <div className="mt-0.5 text-xs leading-[1.5] text-muted-2">{lost.resumeBlocked}</div>
            )}
          </div>
          {phase === "lost" && lost?.resume && (
            <Button
              variant="primary"
              size="sm"
              onClick={lost.resume}
              disabled={!!lost.resumeBlocked}
              aria-label="Resume this session"
            >
              <PlayIcon size={10} />
              Resume
            </Button>
          )}
          {phase === "lost" && lost && (
            <Button size="sm" onClick={lost.close} aria-label="Close this tab">
              Close
            </Button>
          )}
        </div>
      )}
      <div className="field flex items-end gap-2 rounded-xl bg-input py-2 pr-2 pl-3.5">
        <textarea
          ref={box}
          rows={1}
          value={draft}
          onChange={(e) => typeDraft(draftKey, e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            send();
          }}
          // What is being sent stays as it was sent until the session has it.
          readOnly={sending !== null}
          disabled={phase === "ended" || phase === "offline"}
          aria-label="Message Claude Code"
          placeholder="Message Claude Code"
          className="max-h-[220px] min-h-[22px] flex-1 resize-none bg-transparent py-1 text-md leading-[1.6] text-fg placeholder:text-muted-4 disabled:opacity-60"
        />
        {/* Gone once a Stop goes unheard: a second Esc would open Claude's
            rewind menu, not stop anything. */}
        {shownPhase === "working" ? (
          <Button
            variant="outline"
            size="sm"
            onClick={stop}
            disabled={stopHeld || !gate.stop}
            title="Press Esc in Claude Code"
          >
            <StopIcon size={10} />
            {stopHeld ? "Stopping…" : "Stop"}
          </Button>
        ) : null}
        <button
          type="button"
          onClick={send}
          disabled={!canSend}
          aria-label="Send"
          title={canSend ? "Send (Enter)" : sending ? "Sending…" : why || "Write something to send"}
          className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md bg-accent-fill transition-opacity disabled:cursor-default disabled:opacity-25"
          style={{ color: "var(--on-accent)" }}
        >
          <ArrowUpIcon size={13} />
        </button>
      </div>
      {/* One line, one thing: what became of the last send, or why Send is
          off, or — when it is on — how to use it. */}
      <div role="status" className="mt-2 px-1 text-xs leading-[1.5] text-muted-4">
        {hint || "Enter to send · Shift+Enter for a new line"}
      </div>
    </div>
  );
}
