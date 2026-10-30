/**
 * The composer's provenance (COMPLIANCE.md, "No output-parsing influences
 * input"): the only text it ever types is the user's draft — as their own clear,
 * paste and Enter, through the pane's queue, on their submit — while Claude is
 * at its prompt or working, and never into a dialog the record shows, before
 * the claude in the pane has reported, or over a link that isn't live. Stop is
 * one Esc.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { AgentProcess, PendingPrompt } from "../../bindings";
import type { PaneInput } from "../terminal/orchestrator";
import {
  type Ask,
  askOf,
  Composer,
  type ComposerPhase,
  composerPhase,
  processFloor,
  type RecordedRow,
  type SendGate,
  type SendTarget,
  STOP_REST_MS,
  sendGate,
} from "./Composer";
import { resetComposers } from "./composerStore";
import { enterGap } from "./keys";

/** A pane that records what it was asked to type, in order, and answers the
 *  send's fresh reads of the record from `rechecks` (nothing amiss once they
 *  run out). */
function fakePane() {
  const pane = {
    typed: [] as string[],
    refuse: false,
    rechecks: [] as (string | null)[],
    asked: 0,
    input: undefined as unknown as PaneInput,
    target: undefined as unknown as SendTarget,
  };
  pane.input = {
    paste: async (text) => {
      pane.typed.push(`paste:${text}`);
      return !pane.refuse;
    },
    press: async (key) => {
      pane.typed.push(key);
      return !pane.refuse;
    },
  };
  pane.target = {
    pane: () => ({ input: pane.input, floor: 1_000 }),
    recheck: async () => {
      pane.asked += 1;
      return pane.rechecks.shift() ?? null;
    },
    recheckAnswer: async () => "no dialog here",
  };
  return pane;
}

const row = (r: Partial<RecordedRow> = {}): RecordedRow => ({
  recordedState: "idle",
  updatedAtMs: 2_000,
  interruptedAtMs: null,
  prompt: null,
  ...r,
});
/** The gate's clock in these tests. */
const NOW = 10_000;
const pendingPrompt = (over: Partial<PendingPrompt> = {}): PendingPrompt => ({
  kind: "permission",
  toolName: "Bash",
  toolInput: JSON.stringify({ command: "touch a" }),
  suggestions: "[]",
  mcpServer: null,
  agentId: null,
  agentType: null,
  permissionMode: "default",
  promptId: null,
  recordedAtMs: 2_000,
  truncated: false,
  stacked: false,
  closedAtMs: null,
  callEndedAtMs: null,
  ...over,
});
const AT_PROMPT = sendGate("live", 1_000, row(), NOW);
const WORKING = sendGate("live", 1_000, row({ recordedState: "active" }), NOW);

const draw = (
  phase: ComposerPhase,
  pane: ReturnType<typeof fakePane>,
  o: {
    key?: string;
    gate?: SendGate;
    recordedAt?: number | null;
    ask?: Ask;
    shown?: boolean;
  } = {},
) => (
  <Composer
    draftKey={o.key ?? "tree:a:tab:1"}
    phase={phase}
    gate={o.gate ?? (phase === "working" ? WORKING : AT_PROMPT)}
    recordedAt={o.recordedAt ?? null}
    target={pane.target}
    ask={o.ask ?? askOf("permission", "run Bash", null)}
    latestPrompt="u-1"
    journalSeq={10}
    shown={o.shown ?? true}
    focusOnShow
  />
);

/** Let `ms` pass, and everything the pane's queue does meanwhile. */
const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const box = () => screen.getByRole("textbox", { name: "Message Claude Code" });
const sendButton = () => screen.getByRole("button", { name: "Send" });
const CLEAR = "clear";

beforeEach(() => {
  vi.useFakeTimers();
  resetComposers();
});
afterEach(() => vi.useRealTimers());

it("sends the draft at Claude's prompt or while it works, as the user's clear, paste and Enter; never into a dialog, before Claude reports, or over a link that isn't live", async () => {
  const pane = fakePane();
  const draft = "Run the tests\nthen commit";
  // A relaunched tab inherits its last process's row, older than the claude
  // now in the pane: a key now could answer a startup dialog no hook reports.
  const inherited = sendGate("live", 3_000, row(), NOW);
  const { rerender } = render(draw("idle", pane, { gate: inherited }));
  fireEvent.change(box(), { target: { value: draft } });
  expect(screen.getByText("Waiting for Claude Code to reach its prompt.")).toBeVisible();
  fireEvent.keyDown(box(), { key: "Enter" });
  await pass(5_000);
  expect(pane.typed).toEqual([]);
  // Nor Stop, though the display says Claude works (the last process's row,
  // not yet quiet): an Esc under the startup dialogs answers them.
  rerender(draw("working", pane, { gate: inherited }));
  expect(screen.getByRole("button", { name: /Stop/ })).toBeDisabled();

  // The record holds a dialog — a background subagent's, say, while the
  // display shows the main thread idle: an Enter would confirm it.
  rerender(
    draw("idle", pane, {
      gate: sendGate("live", 1_000, row({ recordedState: "permission" }), NOW),
    }),
  );
  expect(sendButton()).toBeDisabled();
  fireEvent.keyDown(box(), { key: "Enter" });
  // Nor over a link that is down, whatever the hooks last said.
  rerender(draw("reconnecting", pane, { gate: sendGate("reconnecting", 1_000, row(), NOW) }));
  expect(sendButton()).toBeDisabled();
  fireEvent.keyDown(box(), { key: "Enter" });
  await pass(5_000);
  expect(pane.typed).toEqual([]);

  // While Claude works, Claude's own queue takes the message. Shift+Enter is a
  // new line; Enter sends: the clear as a write of its own, then the paste,
  // then — once the paste has settled — Enter, the record read afresh before
  // the first key and again before the Enter.
  rerender(draw("working", pane));
  expect(screen.getByText("Claude is working: a message now waits in its queue.")).toBeVisible();
  fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
  await pass(0);
  expect(pane.typed).toEqual([]);
  fireEvent.keyDown(box(), { key: "Enter" });
  await pass(enterGap(draft) - 1);
  expect(pane.typed).toEqual([CLEAR, `paste:${draft}`]);
  // What is being sent holds still until the session has it.
  expect(box()).toHaveAttribute("readonly");
  expect(sendButton()).toBeDisabled();
  await pass(1);
  expect(pane.typed).toEqual([CLEAR, `paste:${draft}`, "enter"]);
  expect(pane.asked).toBe(2);
  expect(box()).toHaveValue("");

  // An empty draft sends nothing.
  fireEvent.click(sendButton());
  await pass(5_000);
  expect(pane.typed).toHaveLength(3);
});

// The Enter used to go on a timer once the paste landed, checked against the
// cached record: a dialog drawn in between got the Enter, which confirms its
// highlighted option. And a paste whose Enter was given up locked Send, since a
// second paste would have gone in behind it.
it("gives up the Enter if Claude opened a dialog after the paste: the draft stays, says why, and the next send replaces Claude's copy", async () => {
  const pane = fakePane();
  pane.rechecks = [null, "Claude opened a dialog."];
  render(draw("working", pane));
  fireEvent.change(box(), { target: { value: "and push" } });
  fireEvent.keyDown(box(), { key: "Enter" });
  await pass(5_000);
  expect(pane.typed).toEqual([CLEAR, "paste:and push"]);
  expect(box()).toHaveValue("and push");
  expect(
    screen.getByText(
      "Not sent: Claude opened a dialog. It's in Claude's input; sending again replaces it.",
    ),
  ).toBeVisible();

  // No lock: the next send empties Claude's input first, so nothing goes in twice.
  fireEvent.click(sendButton());
  await pass(5_000);
  expect(pane.typed).toEqual([CLEAR, "paste:and push", CLEAR, "paste:and push", "enter"]);
  expect(box()).toHaveValue("");

  // A write the session refused leaves the draft where it was.
  pane.refuse = true;
  fireEvent.change(box(), { target: { value: "hello" } });
  fireEvent.keyDown(box(), { key: "Enter" });
  await pass(5_000);
  expect(box()).toHaveValue("hello");
  expect(screen.getByText("The terminal didn't take it. Not sent.")).toBeVisible();
});

// With the terminal up in its place, the user types there: an Enter pressed
// behind them would send whatever they had typed. The view switching or going
// away used to keep only the draft; now it keeps the draft and says why.
it("gives up a send's Enter when the terminal comes up in its place or the view goes; the draft waits", async () => {
  const pane = fakePane();
  const { rerender, unmount } = render(draw("idle", pane));
  fireEvent.change(box(), { target: { value: "first" } });
  fireEvent.keyDown(box(), { key: "Enter" });
  await pass(100);
  rerender(draw("idle", pane, { shown: false }));
  await pass(5_000);
  expect(pane.typed).toEqual([CLEAR, "paste:first"]);

  // Back on the conversation: the draft is where it was, with what became of it.
  rerender(draw("idle", pane, { shown: true }));
  expect(box()).toHaveValue("first");
  expect(box()).toHaveFocus();
  expect(
    screen.getByText(
      "Not sent: the terminal was opened before its Enter. It's in Claude's input; sending again replaces it.",
    ),
  ).toBeVisible();

  fireEvent.keyDown(box(), { key: "Enter" });
  await pass(100);
  unmount();
  await pass(5_000);
  expect(pane.typed).toEqual([CLEAR, "paste:first", CLEAR, "paste:first"]);
  render(draw("idle", pane));
  expect(box()).toHaveValue("first");
});

it("says what Claude asks without a way to answer here, and Stop is one Esc that gives up a send's Enter", async () => {
  const pane = fakePane();
  const { rerender } = render(draw("asking", pane));

  // A dialog has no box to type into, and nothing is typed. The keyboard is
  // on the card, not left on the terminal hidden behind the view; the way to
  // the terminal is the switch, not a button that jumps there.
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByText("Claude needs your permission")).toBeVisible();
  expect(screen.getByText("It wants to use Bash.")).toBeVisible();
  expect(screen.getByRole("status")).toHaveFocus();
  expect(screen.queryByRole("button")).toBeNull();
  // A question and a plan reach the hooks as permission requests for the tool
  // that asks them ("run AskUserQuestion"), and used to read as one.
  expect(askOf("permission", "run AskUserQuestion", null).kind).toBe("question");
  expect(askOf("permission", "run ExitPlanMode", null).kind).toBe("plan");
  expect(askOf("waiting", null, "question").kind).toBe("question");
  expect(askOf("waiting", "Choose a database", null).kind).toBe("input");

  // Working, a send waiting for its Enter: Stop gives the Enter up, then
  // presses Esc, once — never a second while the record has nothing newer
  // than the click, which would open Claude's rewind menu.
  rerender(draw("working", pane, { recordedAt: 1_000 }));
  fireEvent.change(box(), { target: { value: "x" } });
  fireEvent.keyDown(box(), { key: "Enter" });
  await pass(100);
  fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
  fireEvent.click(screen.getByRole("button", { name: /Stopping/ }));
  await pass(200);
  expect(pane.typed).toEqual([CLEAR, "paste:x", "escape"]);
  expect(box()).toHaveValue("x");
  expect(
    screen.getByText(
      "Not sent: Stop was pressed before its Enter. It's in Claude's input; sending again replaces it.",
    ),
  ).toBeVisible();
});

// An Esc before Claude's first reply records nothing and fires no hook: Claude
// puts the prompt back in its input, and the view used to say only that it
// "may have", with Send held off.
it("puts the message back after an early Stop, and the next send replaces Claude's copy", async () => {
  const pane = fakePane();
  const key = "tree:a:tab:9";
  const { rerender } = render(draw("idle", pane, { key, recordedAt: 1_000 }));
  fireEvent.change(box(), { target: { value: "do it" } });
  fireEvent.keyDown(box(), { key: "Enter" });
  await pass(5_000);
  expect(box()).toHaveValue("");

  rerender(draw("working", pane, { key, recordedAt: 1_000 }));
  fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
  await pass(STOP_REST_MS);
  expect(
    screen.getByText("Claude stopped before replying and put your message back in its input"),
  ).toBeVisible();
  expect(box()).toHaveValue("do it");
  expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
  expect(pane.typed).toEqual([CLEAR, "paste:do it", "enter", "escape"]);

  // Sending right away is fine: its clear takes Claude's copy out first.
  rerender(draw("idle", pane, { key, recordedAt: 1_000 }));
  fireEvent.click(sendButton());
  await pass(5_000);
  expect(pane.typed.slice(4)).toEqual([CLEAR, "paste:do it", "enter"]);

  // The record moves on past the click: the word about it goes.
  rerender(draw("idle", pane, { key, recordedAt: Date.now() + 1 }));
  expect(
    screen.queryByText("Claude stopped before replying and put your message back in its input"),
  ).toBeNull();
});

// The gate used to open only at the prompt, and read the reconciled state,
// which quiets a pending prompt to idle on silence alone. What it reads now has
// cases that don't show from the code.
it("opens Send on the record of the claude in this very pane: at its prompt or working, never on a dialog", () => {
  const key = "tree:a:tab:1";
  const claude = (paneId: number, startedAtMs: number): AgentProcess => ({
    termKey: key,
    paneAgentKind: "Claude",
    agentKind: "Claude",
    paneId,
    startedAtMs,
  });
  // The tab resumed into pane 9; the answer about pane 7, the one it replaced,
  // is still cached.
  const processes = [claude(7, 1_000), claude(9, 5_000)];
  const floor = processFloor(processes, key, 9);
  expect(floor).toBe(5_000);
  // The old process's row would pass against the old pane's start: the pane id
  // is what keeps it from opening Send for the new one.
  expect(
    sendGate("live", processFloor(processes, key, 7), row({ updatedAtMs: 3_000 }), NOW).open,
  ).toBe(true);
  // Older: Claude may still be under its startup dialogs, where a key — an Esc
  // for Stop included — answers them.
  expect(sendGate("live", floor, row({ updatedAtMs: 3_000 }), NOW)).toMatchObject({
    open: false,
    stop: false,
  });
  // Newer than the process: at its prompt, or working (Claude queues it).
  expect(sendGate("live", floor, row({ updatedAtMs: 6_000 }), NOW)).toEqual({
    open: true,
    reason: null,
    stop: true,
    atPrompt: true,
    changesAt: null,
  });
  expect(
    sendGate("live", floor, row({ recordedState: "active", updatedAtMs: 6_000 }), NOW),
  ).toEqual({
    open: true,
    reason: null,
    stop: true,
    atPrompt: false,
    changesAt: null,
  });
  // A dialog on record: shut — unless Claude's interrupt marker came after it
  // (an Esc on the dialog), which no hook reports.
  const dialog = row({ recordedState: "permission", updatedAtMs: 6_000 });
  expect(sendGate("live", floor, dialog, NOW)).toMatchObject({ open: false, stop: false });
  expect(sendGate("live", floor, { ...dialog, interruptedAtMs: 7_000 }, NOW).open).toBe(true);
  // Or once its own call has ended, and that has held for CLOSED_SETTLE_MS:
  // the dialog that follows is on screen before its hook lands, while the one
  // before reads closed. Then it is a working turn's message, not a prompt's.
  const asked = (over: Partial<PendingPrompt>) => ({
    ...dialog,
    prompt: pendingPrompt({ recordedAtMs: 6_000, ...over }),
  });
  const ended = (ago: number) => asked({ closedAtMs: NOW - ago, callEndedAtMs: NOW - ago });
  expect(sendGate("live", floor, ended(1_000), NOW)).toEqual({
    open: false,
    reason: "Send opens once Claude moves past its dialog.",
    stop: false,
    atPrompt: false,
    changesAt: NOW + 1_000,
  });
  expect(sendGate("live", floor, ended(2_500), NOW)).toEqual({
    open: true,
    reason: null,
    stop: true,
    atPrompt: false,
    changesAt: null,
  });
  // Closed by a status-line render alone, the call still running: a render is
  // timing, and one late under load would open Send onto a dialog still up.
  // Stop waits out the same settle, then stays for the rest of the tool.
  const rendered = (ago: number) => asked({ closedAtMs: NOW - ago });
  expect(sendGate("live", floor, rendered(100), NOW)).toEqual({
    open: false,
    reason: "Claude is running what was approved; Send opens when it finishes.",
    stop: false,
    atPrompt: false,
    changesAt: NOW + 1_900,
  });
  expect(sendGate("live", floor, rendered(60_000), NOW)).toMatchObject({ open: false, stop: true });
  // A newer dialog on record, open; or an open one recorded behind another.
  expect(
    sendGate("live", floor, { ...asked({ recordedAtMs: 6_500 }), updatedAtMs: 6_500 }, NOW).open,
  ).toBe(false);
  expect(sendGate("live", floor, asked({ stacked: true }), NOW).open).toBe(false);
  expect(
    sendGate("live", floor, row({ recordedState: "exited", updatedAtMs: 6_000 }), NOW).open,
  ).toBe(false);
  // No claude in the pane (exited, a shell, a Codex), or not this pane's.
  expect(processFloor([claude(9, 5_000)], key, null)).toBeNull();
  expect(processFloor([{ ...claude(9, 5_000), agentKind: "Codex" }], key, 9)).toBeNull();
  expect(sendGate("live", null, row({ updatedAtMs: 6_000 }), NOW).open).toBe(false);
  expect(sendGate("live", floor, null, NOW).open).toBe(false);

  // Delegating is two things: a running main turn handing work to a subagent
  // (Stop stops it), or background agents running on after the turn ended —
  // the record has the main thread at its prompt, and there is nothing to stop.
  const delegating = (r: RecordedRow) =>
    composerPhase("delegating", "live", sendGate("live", floor, r, NOW).atPrompt);
  expect(delegating(row({ recordedState: "active", updatedAtMs: 6_000 }))).toBe("working");
  expect(delegating(row({ updatedAtMs: 6_000 }))).toBe("background");
  expect(composerPhase("idle", "lost")).toBe("lost");
});

it("says a lost session's way back is the terminal's, and sends nothing to it", async () => {
  const pane = fakePane();
  render(draw("lost", pane, { gate: sendGate("lost", 1_000, row(), NOW) }));
  expect(screen.getByText("This terminal's session is gone")).toBeVisible();
  expect(screen.queryByRole("button", { name: /terminal/i })).toBeNull();
  fireEvent.change(box(), { target: { value: "hello" } });
  expect(sendButton()).toBeDisabled();
  fireEvent.keyDown(box(), { key: "Enter" });
  await pass(5_000);
  expect(pane.typed).toEqual([]);
});
