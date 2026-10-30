/** How far an answer card may trust the dialog it draws, and so which of its
 *  answers it may offer: whether the dialog is still the one Claude drew —
 *  on screen, unanswered, untouched — and whether its keys were probed for
 *  this case. Each thing known gives a limit; the card's is the lowest, and
 *  says why. Pure, but for the pane's input watch it reads.
 *
 *  The levels, least first: `none` offers nothing; `reject`, Esc alone (No,
 *  Cancel, Reject); `basic`, also a digit that picks (Yes, an option);
 *  `lone`, also option 2; `full`, every answer the dialog has, the key
 *  sequences included (`keys.ts` `trustNeeded`). */
import type { PendingPrompt } from "../../bindings";
import { inputSince, quietSince } from "../terminal/inputWatch";
import type { Dialog } from "./dialog";
import { shownText } from "./dialog";
import { modeLabel } from "./Header";

export type Trust = "none" | "reject" | "basic" | "lone" | "full";

const ORDER: readonly Trust[] = ["none", "reject", "basic", "lone", "full"];

/** Whether `have` covers what `need` asks for. */
export const atLeast = (have: Trust, need: Trust): boolean =>
  ORDER.indexOf(have) >= ORDER.indexOf(need);

/** A level, and why it is not higher (null when nothing needs saying, or the
 *  card says it elsewhere). */
export interface Limit {
  level: Trust;
  reason: string | null;
}

export const NO_LIMIT: Limit = { level: "full", reason: null };

/** The lowest of `limits`, with its reason: of equals, the first. */
export function lowest(limits: readonly Limit[]): Limit {
  return limits.reduce(
    (low, limit) => (ORDER.indexOf(limit.level) < ORDER.indexOf(low.level) ? limit : low),
    NO_LIMIT,
  );
}

// ── The pane's input ────────────────────────────────────────────────────────

/** How long before a dialog's hook a key may already have answered it. Claude
 *  draws a dialog about 50 ms before its hook writes the row (longer under
 *  load), so a key in that gap — a Send's Enter, a Stop's Esc, a key typed in
 *  the terminal — can land on the dialog itself, and the record would not
 *  show it until the next real change (an approved tool records nothing until
 *  it ends). */
export const ANSWERED_BEFORE_MS = 1_000;

/** How long before a dialog's hook the pane must have had no input for the
 *  answers that assume it untouched (row 1 highlighted, the first tab, empty
 *  fields): a key pressed in the terminal moves them. */
export const QUIET_BEFORE_MS = 2_000;

/** What the pane's input says of a dialog recorded at `recordedAtMs`:
 *  - `quiet`: watched, and nothing reached it from `QUIET_BEFORE_MS` before;
 *  - `near`: nothing from `ANSWERED_BEFORE_MS` before, but not that far back;
 *  - `seen`: input reached it as the dialog appeared, or since;
 *  - `unwatched`: this page wasn't watching it then (a reload, a re-attach, a
 *    pane newer than the dialog). */
export type InputState = "quiet" | "near" | "seen" | "unwatched";

export function inputStateOf(paneId: number | null, recordedAtMs: number): InputState {
  if (quietSince(paneId, recordedAtMs - QUIET_BEFORE_MS)) return "quiet";
  if (quietSince(paneId, recordedAtMs - ANSWERED_BEFORE_MS)) return "near";
  return inputSince(paneId, recordedAtMs - ANSWERED_BEFORE_MS) ? "seen" : "unwatched";
}

export function inputLimit(state: InputState): Limit {
  switch (state) {
    case "quiet":
      return NO_LIMIT;
    case "near":
      return {
        level: "lone",
        reason:
          "The terminal had input around this dialog, so only answers it can't change are here.",
      };
    case "seen":
      return {
        level: "none",
        reason: "The terminal had input as this dialog appeared, so it may be answered already.",
      };
    case "unwatched":
      return {
        level: "none",
        reason:
          "This page wasn't watching the terminal when this dialog appeared, so it can't tell whether it was answered there.",
      };
  }
}

// ── What was probed ─────────────────────────────────────────────────────────

/** The Claude Code release the dialogs' keys were probed on. Every answer is
 *  offered on its line from there on (2.1.312 and its later patches); any other
 *  release, an unknown one included, gets the single keys only, which mean the
 *  same in every dialog seen. */
export const PROBED_CLAUDE = { major: 2, minor: 1, patch: 312, text: "2.1.312" } as const;

export function versionLimit(cliVersion: string | null): Limit {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(cliVersion?.trim() ?? "");
  if (
    parts &&
    Number(parts[1]) === PROBED_CLAUDE.major &&
    Number(parts[2]) === PROBED_CLAUDE.minor &&
    Number(parts[3]) >= PROBED_CLAUDE.patch
  ) {
    return NO_LIMIT;
  }
  const runs = cliVersion?.trim()
    ? `runs ${shownText(cliVersion.trim())}`
    : "doesn't say its version";
  return {
    level: "lone",
    reason: `These answers' keys were tested on Claude Code ${PROBED_CLAUDE.text}, and this session ${runs}, so only single keys are offered.`,
  };
}

/** The permission modes a tool's dialog was probed under, which the mode
 *  reason names. Bash's rows vary with the mode: accept edits draws default's
 *  rows, Tab and Up to No (it only drops a `setMode` suggestion, which
 *  `ruleOf` reads), plan mode has no auto-mode row (so 3 is No there), and
 *  outside these nothing was seen. */
export const PROBED_MODES: ReadonlySet<string> = new Set(["default", "acceptEdits"]);

/** A tool's permission dialog raised outside the probed modes gets Yes and No
 *  only. Questions and plans don't depend on the mode this way. */
export function modeLimit(dialog: Dialog, permissionMode: string | null): Limit {
  if (dialog.kind !== "permission") return NO_LIMIT;
  if (permissionMode !== null && PROBED_MODES.has(permissionMode)) return NO_LIMIT;
  const mode = permissionMode ? `${modeLabel(permissionMode)} mode` : "an unknown mode";
  return {
    level: "basic",
    reason: `These answers were tested in the default and accept edits modes, and this dialog came up in ${mode}, so only Yes and No are offered.`,
  };
}

/** A payload cut to fit can't be approved from a card that doesn't show all
 *  of it. The card's own note about the cut says so. */
export function truncatedLimit(truncated: boolean): Limit {
  return truncated ? { level: "reject", reason: null } : NO_LIMIT;
}

/** No claude seen in the pane yet: nothing to answer to. */
export const BLOCKED: Limit = {
  level: "none",
  reason: "Answers open once Claude Code is seen running in the terminal.",
};

// ── What the record says of the dialog ──────────────────────────────────────

/** Whether the dialog on record is the one on screen, by the marks the backend
 *  sets on it. Closed (`closedAtMs`, by Claude's own signs): a key now lands on
 *  whatever came after it. Stacked: recorded while the one before it was still
 *  open — parallel calls fire every request at once and Claude shows them one
 *  at a time, the ones behind firing nothing when they come forward — so the
 *  dialog in front may be another, and a key would answer that one. The card
 *  and the answer's check both read it here. */
export function recordLimit(prompt: Pick<PendingPrompt, "stacked" | "closedAtMs">): Limit {
  if (prompt.closedAtMs !== null) {
    return { level: "none", reason: "Claude has moved past this dialog." };
  }
  if (prompt.stacked) {
    return {
      level: "none",
      reason: "Claude has more than one request waiting, and the terminal shows which comes first.",
    };
  }
  return NO_LIMIT;
}
