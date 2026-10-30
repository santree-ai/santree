/**
 * What the Conversation view types for each action, read against Claude Code's
 * own key map (docs/conversation.md, the contract's "Safe key sequences"), and
 * how the pane's queue runs it: the timing is part of what the keys mean to
 * Claude. An Esc followed within ~20 ms by another byte is read as one Alt
 * chord — the Esc is dropped, and an Esc then `1` approved a Bash command — and
 * an Enter that shares the paste's write can land in the paste as a new line.
 *
 * The answers' rows use the payloads' real shapes (Claude Code 2.1.312's
 * PermissionRequest), every text replaced.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { PendingPrompt } from "../../bindings";
import type { PaneInput } from "../terminal/orchestrator";
import type { TerminalKey } from "../terminal/types";
import { dialogOf } from "./dialog";
import {
  type Answer,
  answerSteps,
  ESC_GAP_MS,
  enterGap,
  type Step,
  sendSteps,
  stopSteps,
} from "./keys";
import { enqueue } from "./paneWriter";
import type { Trust } from "./trust";

const CLEAR = "\x0b".repeat(16) + "\x15".repeat(16);
const NAMED: Partial<Record<TerminalKey, string>> = {
  enter: "\r",
  escape: "\x1b",
  clear: CLEAR,
  tab: "\t",
  up: "\x1b[A",
};
const bytesOf = (key: TerminalKey) => NAMED[key] ?? key;

/** A pane that records each write — what xterm would send for it — and when. */
function pane() {
  const writes: { at: number; bytes: string }[] = [];
  const take = async (bytes: string) => {
    writes.push({ at: Date.now(), bytes });
    return true;
  };
  const input: PaneInput = {
    paste: (text) => take(`paste:${text}`),
    press: (key) => take(bytesOf(key)),
  };
  return { input, writes };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it.each<[string, Step[], Step[]]>([
  [
    "send: its own clear, the paste, and Enter alone after the paste has settled, the record read before the first key and before the Enter",
    sendSteps("fix it"),
    [
      { kind: "check" },
      { kind: "key", key: "clear" },
      { kind: "paste", text: "fix it" },
      { kind: "wait", ms: 500 },
      { kind: "check" },
      { kind: "key", key: "enter" },
    ],
  ],
  [
    "stop: one Esc, alone, then nothing for 100 ms",
    stopSteps(),
    [
      { kind: "key", key: "escape" },
      { kind: "wait", ms: ESC_GAP_MS },
    ],
  ],
])("%s", (_, steps, expected) => {
  expect(steps).toEqual(expected);
  expect(ESC_GAP_MS).toBeGreaterThanOrEqual(100);
  // A long paste takes Claude longer to take in; the Enter waits for it, to a cap.
  expect(enterGap("x".repeat(80_000))).toBe(1_000);
});

// The writer, not only the steps, keeps the gap: an action that starts right
// behind a Stop (a click on Send the moment Stop was clicked) waits it out.
it("lets nothing reach the pane within 100 ms of an Esc, the next action's first key included", async () => {
  const { input, writes } = pane();
  const stop = enqueue(input, [{ kind: "key", key: "escape" }]);
  const send = enqueue(input, sendSteps("next"), async () => null);
  await vi.runAllTimersAsync();
  expect(await stop.outcome).toEqual({ kind: "done" });
  expect(await send.outcome).toEqual({ kind: "done" });
  expect(writes.map((w) => w.bytes)).toEqual(["\x1b", CLEAR, "paste:next", "\r"]);
  expect(writes[1].at - writes[0].at).toBeGreaterThanOrEqual(ESC_GAP_MS);
  expect(writes[3].at - writes[2].at).toBeGreaterThanOrEqual(500);
});

// One pane's actions never interleave: a Stop clicked during a send's wait for
// its Enter goes after the send's writes, and the Enter it gave up never comes.
it("runs one pane's actions one at a time, and a cancelled send presses nothing more", async () => {
  const { input, writes } = pane();
  const send = enqueue(input, sendSteps("fix it"), async () => null);
  const stop = enqueue(input, stopSteps());
  await vi.advanceTimersByTimeAsync(200);
  expect(writes.map((w) => w.bytes)).toEqual([CLEAR, "paste:fix it"]);

  send.cancel("Stop was pressed before its Enter.");
  await vi.runAllTimersAsync();
  expect(await send.outcome).toEqual({
    kind: "cancelled",
    reason: "Stop was pressed before its Enter.",
    typed: 2,
  });
  expect(await stop.outcome).toEqual({ kind: "done" });
  expect(writes.map((w) => w.bytes)).toEqual([CLEAR, "paste:fix it", "\x1b"]);
});

/** A dialog as its hook stored it: `PendingPrompt`, `toolInput` as JSON. */
function asked(
  toolName: string | null,
  input: unknown,
  suggestions: unknown = null,
  over: Partial<PendingPrompt> = {},
) {
  return dialogOf({
    kind: "permission",
    toolName,
    toolInput: JSON.stringify(input),
    suggestions: suggestions === null ? null : JSON.stringify(suggestions),
    mcpServer: null,
    agentId: null,
    agentType: null,
    permissionMode: "default",
    promptId: "p-1",
    recordedAtMs: 1_000,
    truncated: false,
    stacked: false,
    closedAtMs: null,
    callEndedAtMs: null,
    ...over,
  });
}

const BASH = { command: "touch probe-a", description: "Create probe file" };
const DIR_RULE = [
  { type: "addDirectories", directories: ["/work"], destination: "session" },
  { type: "setMode", mode: "acceptEdits", destination: "session" },
];
const question = (options: number, extra: Record<string, unknown> = {}) => ({
  question: "Which color?",
  header: "Color",
  options: Array.from({ length: options }, (_, i) => ({
    label: `Option ${i + 1}`,
    description: "Placeholder",
  })),
  multiSelect: false,
  ...extra,
});

const bash = asked("Bash", BASH, DIR_RULE);
const plan = asked("ExitPlanMode", { plan: "# Plan\n\n1. Step", planFilePath: "/plans/p.md" });

/** Steps as one line: `check 1`, `check escape wait100`, … */
const shown = (steps: Step[] | null) =>
  steps
    ?.map((s) =>
      s.kind === "check"
        ? "check"
        : s.kind === "wait"
          ? `wait${s.ms}`
          : s.kind === "paste"
            ? `paste(${s.text})`
            : s.key,
    )
    .join(" ") ?? null;

const ESC = "check escape wait100";

it.each<[string, ReturnType<typeof asked>, Answer, Trust, string | null]>([
  // Permissions probed on every answer (Bash, Edit, Write, Read, WebSearch, mcp__*).
  ["Bash: Yes is row 1's digit", bash, { kind: "yes" }, "full", "check 1"],
  ["Bash: option 2 when Claude offered a rule", bash, { kind: "always" }, "full", "check 2"],
  [
    "Bash: no option 2 for an empty list — row 2 is auto mode",
    asked("Bash", BASH, []),
    { kind: "always" },
    "full",
    null,
  ],
  [
    "MCP under an ask rule: no suggestions, and no option 2 though the row is there",
    asked("mcp__probe__echo", { text: "hi" }, null, { mcpServer: "probe" }),
    { kind: "always" },
    "full",
    null,
  ],
  // Option 2 only when every suggestion is a kind, in a shape, the card can
  // name in full: what the row grants is then all on the card.
  [
    "Bash: no option 2 when a suggestion switches to a mode other than accept edits",
    asked("Bash", BASH, [{ type: "setMode", mode: "bypassPermissions", destination: "session" }]),
    { kind: "always" },
    "full",
    null,
  ],
  [
    "Bash: no option 2 when a rule is not an allow",
    asked("Bash", BASH, [
      { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "deny", destination: "session" },
    ]),
    { kind: "always" },
    "full",
    null,
  ],
  [
    "Bash: no option 2 when any one suggestion is of a kind not known",
    asked("Bash", BASH, [...DIR_RULE, { type: "removeRules", destination: "session" }]),
    { kind: "always" },
    "full",
    null,
  ],
  ["Bash: No is Esc alone", bash, { kind: "no" }, "full", ESC],
  [
    "Bash: Yes and a message is Tab on row 1, the paste, then Enter alone",
    bash,
    { kind: "yesTell", text: "Also log it" },
    "full",
    "check tab wait300 paste(Also log it) wait500 check enter",
  ],
  [
    "Bash: No and what to do is Up (it wraps to No), Tab, the paste, Enter",
    bash,
    { kind: "noTell", text: "Use mkdir" },
    "full",
    "check up wait300 tab wait300 paste(Use mkdir) wait500 check enter",
  ],
  [
    "a text answer with nothing left in it",
    bash,
    { kind: "noTell", text: " \x1b\x03 " },
    "full",
    null,
  ],
  // Below full trust (`trust.ts`): what each level keeps.
  ["lone: no sequence that assumes row 1", bash, { kind: "yesTell", text: "x" }, "lone", null],
  ["lone: option 2 is still its digit", bash, { kind: "always" }, "lone", "check 2"],
  ["basic: no option 2", bash, { kind: "always" }, "basic", null],
  ["basic: Yes is still its digit", bash, { kind: "yes" }, "basic", "check 1"],
  ["reject: no Yes", bash, { kind: "yes" }, "reject", null],
  ["reject: No is still Esc alone", bash, { kind: "no" }, "reject", ESC],
  ["none: not even No", bash, { kind: "no" }, "none", null],
  // WebFetch: no text answer (a paste there is swallowed).
  [
    "WebFetch: option 2 for the domain",
    asked("WebFetch", { url: "https://docs.example.invalid/x", prompt: "Summarize" }, [
      {
        type: "addRules",
        destination: "localSettings",
        rules: [{ toolName: "WebFetch", ruleContent: "domain:docs.example.invalid" }],
        behavior: "allow",
      },
    ]),
    { kind: "always" },
    "full",
    "check 2",
  ],
  [
    "WebFetch: no text answers",
    asked("WebFetch", { url: "https://docs.example.invalid/x" }, []),
    { kind: "yesTell", text: "x" },
    "full",
    null,
  ],
  // A tool nobody probed: Yes and No only.
  [
    "another tool: Yes",
    asked("NotebookEdit", { notebook_path: "/n.ipynb" }, DIR_RULE),
    { kind: "yes" },
    "full",
    "check 1",
  ],
  [
    "another tool: no option 2",
    asked("NotebookEdit", {}, DIR_RULE),
    { kind: "always" },
    "full",
    null,
  ],
  ["another tool: no text", asked("NotebookEdit", {}), { kind: "noTell", text: "x" }, "full", null],
  // AskUserQuestion.
  [
    "one question: an option's digit picks and submits",
    asked("AskUserQuestion", { questions: [question(3)] }),
    { kind: "option", option: 1 },
    "full",
    "check 2",
  ],
  [
    "one question: no digit past its options",
    asked("AskUserQuestion", { questions: [question(3)] }),
    { kind: "option", option: 3 },
    "full",
    null,
  ],
  [
    "one question: Type something is row N+1, then the paste and Enter",
    asked("AskUserQuestion", { questions: [question(3)] }),
    { kind: "freeText", text: "Purple" },
    "full",
    "check 4 wait300 paste(Purple) wait500 check enter",
  ],
  [
    "previews have no Type something row",
    asked("AskUserQuestion", {
      questions: [
        {
          ...question(2),
          options: [
            { label: "A", description: "", preview: "+--+" },
            { label: "B", description: "" },
          ],
        },
      ],
    }),
    { kind: "freeText", text: "x" },
    "full",
    null,
  ],
  [
    "several questions: a digit each, then 1 on Submit",
    asked("AskUserQuestion", { questions: [question(3), question(2)] }),
    { kind: "picks", options: [1, 0] },
    "full",
    "check 2 wait300 1 wait300 check 1",
  ],
  [
    "several questions: no digit past a question's options",
    asked("AskUserQuestion", { questions: [question(3), question(2)] }),
    { kind: "picks", options: [1, 2] },
    "full",
    null,
  ],
  [
    "several questions with a preview layout: Cancel only (never probed)",
    asked("AskUserQuestion", {
      questions: [
        question(2),
        {
          ...question(2),
          options: [
            { label: "A", description: "", preview: "+--+" },
            { label: "B", description: "" },
          ],
        },
      ],
    }),
    { kind: "picks", options: [0, 0] },
    "full",
    null,
  ],
  [
    "several questions with a multi-select one: Cancel only",
    asked("AskUserQuestion", { questions: [question(3), question(2, { multiSelect: true })] }),
    { kind: "picks", options: [0, 0] },
    "full",
    null,
  ],
  [
    "a multi-select question: its digits, Tab to Submit, then 1",
    asked("AskUserQuestion", { questions: [question(3, { multiSelect: true })] }),
    { kind: "toggles", options: [2, 0] },
    "full",
    "check 3 wait300 1 wait300 tab wait300 check 1",
  ],
  [
    "a multi-select question with a preview layout: Cancel only (never probed)",
    asked("AskUserQuestion", {
      questions: [
        {
          ...question(2, { multiSelect: true }),
          options: [
            { label: "A", description: "", preview: "+--+" },
            { label: "B", description: "" },
          ],
        },
      ],
    }),
    { kind: "toggles", options: [0] },
    "full",
    null,
  ],
  [
    "a question: Cancel is Esc alone",
    asked("AskUserQuestion", { questions: [question(2)] }),
    { kind: "cancel" },
    "full",
    ESC,
  ],
  // ExitPlanMode: never a digit (row 1 is auto mode, BYPASS, clear context…).
  [
    "a plan: approve with manual edits is Up, Up, Enter",
    plan,
    { kind: "planManual" },
    "full",
    "check up wait300 up wait300 check enter",
  ],
  [
    "a plan: keep planning is Up (its field), the paste, Enter",
    plan,
    { kind: "planChanges", text: "Add a test step" },
    "full",
    "check up wait300 paste(Add a test step) wait500 check enter",
  ],
  ["a plan: no digit", plan, { kind: "yes" }, "full", null],
  ["a plan: Reject is Esc alone", plan, { kind: "reject" }, "full", ESC],
  ["a plan below full trust: Reject only", plan, { kind: "planManual" }, "lone", null],
  // MCP elicitation: answered in the terminal.
  [
    "an elicitation: nothing",
    dialogOf({
      kind: "elicitation",
      toolName: null,
      toolInput: JSON.stringify({ message: "Pick", mode: "url", url: "https://example.invalid/a" }),
      suggestions: null,
      mcpServer: "probe",
      agentId: null,
      agentType: null,
      permissionMode: null,
      promptId: null,
      recordedAtMs: 1_000,
      truncated: false,
      stacked: false,
      closedAtMs: null,
      callEndedAtMs: null,
    }),
    { kind: "cancel" },
    "full",
    null,
  ],
])("answers with the dialog's own keys — %s", (_, dialog, answer, trust, expected) => {
  expect(shown(answerSteps(dialog, answer, trust))).toBe(expected);
});
