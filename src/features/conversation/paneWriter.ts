/** The one way the Conversation view types into a pane: a queue per pane, so
 *  one action's writes never interleave with another's (a Stop clicked during
 *  a send waits for the send's write in flight, then cancels the rest of it).
 *
 *  It types only the steps an action hands it (`keys.ts`), through the pane's
 *  own renderer (`PaneInput`: xterm's paste and key input, which leave by the
 *  pane's one writer), and an action is started only by the user's click or
 *  Enter in the view (COMPLIANCE.md; `compliance.test.ts` reads the view's
 *  modules to pin that). The timers here only space the steps of one such
 *  action — they never start one.
 *
 *  Whatever the steps say, nothing reaches the pane within `ESC_GAP_MS` of an
 *  Esc this queue sent: Claude Code would read the pair as one Alt chord and
 *  drop the Esc. */
import { untracked } from "../terminal/inputWatch";
import type { PaneInput } from "../terminal/orchestrator";
import { ESC_GAP_MS, type Step } from "./keys";

/** How an action's sequence ended, and how many writes it made first. */
export type Outcome =
  | { kind: "done" }
  /** The session refused a write; nothing after it was typed. */
  | { kind: "refused"; typed: number }
  /** The action's guard gave a reason at a `check`. */
  | { kind: "held"; reason: string; typed: number }
  /** Given up by the view — a Stop, the view going away — before a write. */
  | { kind: "cancelled"; reason: string; typed: number };

/** One action's place in its pane's queue. */
export interface WriteJob {
  /** Type nothing more. A write already handed to the pane completes; a wait
   *  or a check under way ends with this reason. */
  cancel: (reason: string) => void;
  readonly outcome: Promise<Outcome>;
}

interface Lane {
  /** The last action queued on the pane, settled or not. */
  tail: Promise<unknown>;
  /** When this queue's last Esc reached the pane (0: never). */
  escAt: number;
}

/** One lane per pane. A resumed tab gets a new pane, and so a new lane. */
const lanes = new WeakMap<PaneInput, Lane>();

/** What a running action has been told: whether to stop, and how to wake a
 *  wait to hear it. */
class Control {
  reason: string | null = null;
  private wake: (() => void) | null = null;

  cancel(reason: string) {
    if (this.reason !== null) return;
    this.reason = reason;
    this.wake?.();
  }

  /** Resolves after `ms`, or at once on a cancel. */
  sleep(ms: number): Promise<void> {
    if (this.reason !== null || ms <= 0) return Promise.resolve();
    return new Promise((done) => {
      const finish = () => {
        clearTimeout(timer);
        this.wake = null;
        done();
      };
      const timer = setTimeout(finish, ms);
      this.wake = finish;
    });
  }
}

/** How an action's writes are typed. */
export interface QueueOptions {
  /** An answer's keys, left out of the pane's input watch
   *  (`inputWatch.untracked`, which says why that is safe for them alone). */
  untracked?: boolean;
}

/** Queue `steps` on `pane`, behind whatever is queued there already. `guard`
 *  answers each `check`: a reason ends the sequence, as does a read that
 *  fails (nothing goes on unverified). */
export function enqueue(
  pane: PaneInput,
  steps: readonly Step[],
  guard?: () => Promise<string | null>,
  options: QueueOptions = {},
): WriteJob {
  const lane = lanes.get(pane) ?? { tail: Promise.resolve(), escAt: 0 };
  lanes.set(pane, lane);
  const control = new Control();
  const untrack = options.untracked === true;
  const outcome = lane.tail.then(() => run(pane, lane, steps, guard, control, untrack));
  // The next action waits for this one however it ends.
  lane.tail = outcome.catch(() => undefined);
  return { cancel: (reason) => control.cancel(reason), outcome };
}

async function run(
  pane: PaneInput,
  lane: Lane,
  steps: readonly Step[],
  guard: (() => Promise<string | null>) | undefined,
  control: Control,
  untrack: boolean,
): Promise<Outcome> {
  let typed = 0;
  const cancelled = (): Outcome | null =>
    control.reason === null ? null : { kind: "cancelled", reason: control.reason, typed };
  for (const step of steps) {
    const stop = cancelled();
    if (stop) return stop;
    if (step.kind === "wait") {
      await control.sleep(step.ms);
      continue;
    }
    if (step.kind === "check") {
      const reason = guard
        ? await guard().catch(() => "the session's state couldn't be read.")
        : null;
      if (reason !== null) return { kind: "held", reason, typed };
      continue;
    }
    await control.sleep(lane.escAt + ESC_GAP_MS - Date.now());
    const late = cancelled();
    if (late) return late;
    let taken = false;
    const type = () => (step.kind === "paste" ? pane.paste(step.text) : pane.press(step.key));
    try {
      taken = await (untrack ? untracked(type) : type());
    } catch {
      // A pane that throws has not taken it.
    }
    typed++;
    if (step.kind === "key" && step.key === "escape") lane.escAt = Date.now();
    if (!taken) return { kind: "refused", typed };
  }
  return { kind: "done" };
}
