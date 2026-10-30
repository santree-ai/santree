/**
 * The Conversation view over its own reads of the session: its send, its
 * answers to a dialog, and what it draws from the hooks.
 *
 * A send's last look before the Enter is a fresh read — the commands
 * themselves, never the cache: Claude draws a dialog about 50 ms before its
 * hook lands, and the cache lags behind that. The Enter goes only if the record
 * shows no dialog, the pane is the one the paste went into, and the claude in
 * it is the same process. The same look comes before the first key. An answer
 * looks the same way, and also needs the very dialog the card drew.
 *
 * And a message the session took is drawn until the record shows it.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type {
  AgentProcess,
  AgentState,
  LiveText,
  PaneLink,
  PendingPrompt,
  SessionState,
} from "../../bindings";
import { applyRead, type ConversationJournal } from "../../lib/conversationJournal";
import { conversationItem, conversationRead, NO_META } from "../../test/conversationFixture";
import { session } from "../../test/fixtures";
import type { PaneInput, TerminalTab } from "../terminal/orchestrator";

const KEY = "tree:a:tab:1";
const REPO = "acme/app";

const world = vi.hoisted(() => ({
  rows: [] as SessionState[],
  processes: [] as AgentProcess[],
  /** What each fresh read answers, in turn; the cached world once they run out. */
  fresh: [] as [SessionState[], AgentProcess[]][],
  reads: 0,
  typed: [] as string[],
  /** The agent as the attention machinery sees it. */
  state: "active" as AgentState,
  journal: undefined as ConversationJournal | undefined,
  link: "live" as PaneLink,
  liveText: null as LiveText | null,
  /** Runs as a fresh read is made: what happens meanwhile. */
  duringRead: null as (() => void) | null,
  /** When the pane was last typed into. */
  keyAt: 0,
}));
const terminalActions = vi.hoisted(() => ({
  holdRow: vi.fn(),
  detachEmbeds: vi.fn(),
  close: vi.fn(),
}));

vi.mock("../../lib/queries", () => ({
  queryKeys: { sessionStates: ["session-states"], agentProcesses: ["agent-processes"] },
  readSessionNow: async () => {
    world.reads += 1;
    world.duringRead?.();
    return world.fresh.shift() ?? [world.rows, world.processes];
  },
  useSessionStates: () => ({ data: world.rows }),
  useAgentProcesses: () => ({ data: world.processes }),
  useConversation: () => ({ data: world.journal, error: null, refetch: () => {} }),
  useSessionUsageLive: () => ({ data: [] }),
  useSessionLiveText: () => world.liveText,
  useServerStatus: () => ({ data: undefined }),
}));
vi.mock("../agents/useAgents", async () => {
  const { agentEntry } = await import("../../test/fixtures");
  return {
    useAgentEntries: () => [
      agentEntry({
        bucket: "working",
        state: world.state,
        repo: "acme/app",
        termKey: "tree:a:tab:1",
      }),
    ],
  };
});
vi.mock("../terminal/TerminalsContext", async () => {
  const { inputReached } = await import("../terminal/inputWatch");
  // The pane's one writer, as `TerminalView` wires it: what is typed reaches
  // the input watch as it is typed, before the paste or press returns.
  const type = (what: string) => {
    inputReached(7, what);
    world.typed.push(what);
    world.keyAt = Date.now();
    return true;
  };
  const input: PaneInput = {
    paste: async (text) => type(`paste:${text}`),
    press: async (key) => type(key),
  };
  const tab: TerminalTab = {
    key: "term-1",
    title: "Claude",
    source: "issue",
    refId: "tree:a:tab:1",
    agent: { kind: "Claude", repo: "acme/app", termKey: "tree:a:tab:1" },
  };
  const terminals = {
    tabs: [tab],
    linkOf: () => world.link,
    paneIdOf: () => 7,
    inputFor: () => input,
    ...terminalActions,
  };
  return { useTerminals: () => terminals };
});

import { inputReached, watchInput } from "../terminal/inputWatch";
import { ANSWER_LATE_MS, ARM_MS } from "./AnswerCard";
import { resetAnswers } from "./answerStore";
import { CLOSED_SETTLE_MS } from "./Composer";
import { ConversationView, ECHO_LATE_MS } from "./ConversationView";
import { resetComposers } from "./composerStore";

const working = (over: Partial<SessionState> = {}) => [
  session({
    sessionId: "s1",
    repo: REPO,
    termKey: KEY,
    state: "active",
    updatedAtMs: 2_000,
    ...over,
  }),
];
const claude = (startedAtMs: number): AgentProcess[] => [
  { termKey: KEY, paneAgentKind: "Claude", agentKind: "Claude", paneId: 7, startedAtMs },
];

let unwatch = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  resetComposers();
  resetAnswers();
  world.rows = working();
  world.processes = claude(1_000);
  world.fresh = [];
  world.reads = 0;
  world.typed = [];
  world.state = "active";
  world.journal = applyRead(undefined, conversationRead({ reset: true }));
  world.link = "live";
  world.liveText = null;
  world.duringRead = null;
  world.keyAt = 0;
  vi.clearAllMocks();
});
afterEach(() => unwatch());

const onResume = vi.fn();
const view = () => (
  <QueryClientProvider client={new QueryClient()}>
    <ConversationView
      target={{ kind: "tab", repo: REPO, termKey: KEY }}
      live={{ repo: REPO, termKey: KEY }}
      onResume={onResume}
    />
  </QueryClientProvider>
);
const box = () => screen.getByRole("textbox", { name: "Message Claude Code" });
const send = async (text: string) => {
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.keyDown(box(), { key: "Enter" });
  await act(() => vi.advanceTimersByTimeAsync(2_000));
};
afterEach(() => vi.useRealTimers());

it.each<[string, [SessionState[], AgentProcess[]][], string[], string | null]>([
  ["nothing changed: the Enter goes", [], ["clear", "paste:hi", "enter"], null],
  [
    "a dialog recorded since the paste: no Enter",
    [
      [working(), claude(1_000)],
      [working({ recordedState: "permission", state: "permission" }), claude(1_000)],
    ],
    ["clear", "paste:hi"],
    "Not sent: Claude opened a dialog. It's in Claude's input; sending again replaces it.",
  ],
  [
    "another claude in the pane since the paste: no Enter",
    [
      [working(), claude(1_000)],
      [working({ updatedAtMs: 5_000 }), claude(4_000)],
    ],
    ["clear", "paste:hi"],
    "Not sent: Claude Code is no longer the process in the terminal. It's in Claude's input; sending again replaces it.",
  ],
  [
    "a dialog recorded before the first key, the cache not knowing yet: nothing typed",
    [[working({ recordedState: "waiting", state: "waiting" }), claude(1_000)]],
    [],
    "Not sent: Claude opened a dialog.",
  ],
])("re-reads the session before typing: %s", async (_, fresh, typed, note) => {
  world.fresh = fresh;
  render(view());
  await send("hi");
  expect(world.typed).toEqual(typed);
  expect(world.reads).toBe(typed.length === 0 ? 1 : 2);
  if (note) {
    expect(screen.getByText(note)).toBeVisible();
    expect(box()).toHaveValue("hi");
  } else {
    expect(box()).toHaveValue("");
    // Drawn as sent until the record shows it; Claude is working, so queued —
    // for as long as it works, which says nothing about the message.
    await act(() => vi.advanceTimersByTimeAsync(ECHO_LATE_MS));
    expect(screen.getByText("Queued: Claude reads it when it's done")).toBeVisible();
  }
});

// Claude shows a message it queued only once it gets to it, so the wait counts
// only while it isn't working. Past it, the view says so and offers the message
// back; it sends nothing again.
it("draws a sent message until the record shows it, and offers it back once Claude has sat on it", async () => {
  world.state = "idle";
  world.rows = working({ recordedState: "idle", state: "idle" });
  const { rerender } = render(view());
  await send("first");
  expect(screen.getByText("Sent")).toBeVisible();
  await act(() => vi.advanceTimersByTimeAsync(ECHO_LATE_MS));
  expect(screen.getByText("Claude hasn't shown this yet.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Put it back in the composer" }));
  expect(box()).toHaveValue("first");
  expect(screen.queryByText("Claude hasn't shown this yet.")).toBeNull();

  await send("second");
  expect(screen.getByText("second")).toBeVisible();
  world.journal = applyRead(
    undefined,
    conversationRead({
      reset: true,
      items: [
        conversationItem("u-2", 0, 1, {
          kind: "user",
          text: "second",
          images: 0,
          origin: "Typed",
        }),
      ],
    }),
  );
  rerender(view());
  // The record's prompt (and the header's title, taken from it); no echo.
  expect(screen.queryByText("Sent")).toBeNull();
  expect(screen.getAllByText("second")).toHaveLength(2);
});

// ── Answering a dialog ──────────────────────────────────────────────────────

/** A moment on this Mac's clock; the claude in the pane started a minute
 *  before, and the dialog was recorded ten seconds after. */
const T = 1_700_000_000_000;
const PROMPT_AT = T + 10_000;

/** A Bash permission request as Claude 2.1.312's hook stores it, texts
 *  replaced. */
const bashPrompt = (over: Partial<PendingPrompt> = {}): PendingPrompt => ({
  kind: "permission",
  toolName: "Bash",
  toolInput: JSON.stringify({ command: "touch probe-a", description: "Create probe file" }),
  suggestions: JSON.stringify([
    { type: "addDirectories", directories: ["/work"], destination: "session" },
    { type: "setMode", mode: "acceptEdits", destination: "session" },
  ]),
  mcpServer: null,
  agentId: null,
  agentType: null,
  permissionMode: "default",
  promptId: "p-1",
  recordedAtMs: PROMPT_AT,
  truncated: false,
  stacked: false,
  closedAtMs: null,
  callEndedAtMs: null,
  ...over,
});
const asking = (prompt: PendingPrompt = bashPrompt()) =>
  working({
    state: prompt.kind === "permission" ? "permission" : "waiting",
    recordedState: prompt.kind === "permission" ? "permission" : "waiting",
    event: prompt.kind === "permission" ? "PermissionRequest" : "Elicitation",
    updatedAtMs: prompt.recordedAtMs,
    prompt,
  });

/** Claude asks (`prompt`) in a session that runs `cliVersion`, the pane
 *  watched by this page since `watchedFrom`. */
function dialogUp(prompt: PendingPrompt = bashPrompt(), watchedFrom = T, cliVersion = "2.1.312") {
  vi.setSystemTime(watchedFrom);
  unwatch = watchInput(7);
  vi.setSystemTime(PROMPT_AT + 1_000);
  world.state = prompt.kind === "permission" ? "permission" : "waiting";
  world.rows = asking(prompt);
  world.processes = claude(T - 60_000);
  world.journal = applyRead(
    undefined,
    conversationRead({ reset: true, meta: { ...NO_META, cliVersion } }),
  );
}

const row = (name: string) => screen.getByRole("button", { name });
const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const card = () => screen.getByRole("region", { name: "Claude is asking" });

/** The card drawn, and past the moment its answers stay inert. */
async function cardUp(...args: Parameters<typeof dialogUp>) {
  dialogUp(...args);
  const utils = render(view());
  await pass(ARM_MS);
  return utils;
}

/** Which answers a Bash card offers, as its trust level (`trust.ts`). */
function offeredLevel() {
  const has = (name: string) => screen.queryByRole("button", { name }) !== null;
  if (!has("No")) return "none";
  if (!has("Yes")) return "reject";
  if (!has("Yes, and allow access to the directory")) return "basic";
  if (!has("Yes, and tell Claude…")) return "lone";
  return "full";
}

it("answers a dialog with its own key, once: a remount finds it answered", async () => {
  const { unmount } = await cardUp();
  expect(screen.getByText("Claude wants to run a command")).toBeVisible();
  expect(screen.getByText("touch probe-a")).toBeVisible();
  // Option 2 says its first suggestion's kind, and under it what it grants.
  expect(row("Yes, and allow access to the directory")).toBeVisible();
  fireEvent.click(row("Yes"));
  await pass(1_000);
  expect(world.typed).toEqual(["1"]);
  expect(world.reads).toBe(1);
  expect(screen.getByText("Sent: Yes")).toBeVisible();
  expect(screen.queryByRole("button", { name: "No" })).toBeNull();

  // One answer per occurrence: the next dialog is drawn ~90 ms after the key,
  // and a second key would answer it. A view mounted again finds it taken.
  unmount();
  render(view());
  expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
  await pass(ANSWER_LATE_MS);
  expect(
    screen.getByText(
      "Sent: Yes. Nothing recorded since; if the terminal still shows the dialog, answer it there.",
    ),
  ).toBeVisible();
  expect(world.typed).toEqual(["1"]);
});

// The next of parallel tool calls replaces an answered card in place a few
// hundred ms after its key: a double-click, or a second click on the same spot,
// would answer it unseen.
it("draws the next request as new, and inert at first", async () => {
  const { rerender } = await cardUp();
  fireEvent.click(row("Yes"));
  await pass(1_000);
  // Its hook 100 ms after the key that answered the last one: the card's own
  // keys are not input that may have answered this one.
  const next = world.keyAt + 100;
  vi.setSystemTime(next + 100);
  world.rows = asking(bashPrompt({ recordedAtMs: next }));
  rerender(view());
  expect(screen.getByText("New request")).toBeVisible();
  fireEvent.click(row("Yes"));
  fireEvent.keyDown(card(), { key: "1" });
  await pass(ARM_MS - 100);
  fireEvent.click(row("Yes"));
  await pass(100);
  expect(world.typed).toEqual(["1"]);
  // Armed, it answers as any card does, with every answer it has.
  expect(offeredLevel()).toBe("full");
  fireEvent.click(row("Yes"));
  await pass(1_000);
  expect(world.typed).toEqual(["1", "1"]);
});

const MOVED = "Claude has moved past this dialog.";
const STACKED =
  "Claude has more than one request waiting, and the terminal shows which comes first.";
it.each<[string, () => SessionState[], string]>([
  // The next of two parallel tool calls: the same tool, a new recording.
  ["a new recording", () => asking(bashPrompt({ recordedAtMs: PROMPT_AT + 90 })), MOVED],
  // Approved in the terminal: the stored row stays the dialog's until the
  // tool's next real change, but the record shows the tool running…
  [
    "the session reading as working again",
    () => asking().map((r) => ({ ...r, state: "active" as const })),
    MOVED,
  ],
  // …or Claude's own signs (a status-line render, the call's end) close it.
  ["Claude's signs closing it", () => asking(bashPrompt({ closedAtMs: PROMPT_AT + 1_500 })), MOVED],
  ["it read as recorded behind another", () => asking(bashPrompt({ stacked: true })), STACKED],
])("types nothing when a fresh read no longer vouches for the dialog the card drew (%s), and offers it again", async (_, moved, says) => {
  await cardUp();
  world.fresh = [[moved(), claude(T - 60_000)]];
  fireEvent.click(row("Yes"));
  await pass(1_000);
  expect(world.typed).toEqual([]);
  expect(screen.getByText(`Not answered: ${says}`)).toBeVisible();
  expect(row("Yes")).toBeEnabled();
});

it("tells Claude what to do instead: Up, Tab, the user's text, Enter — the record read before the first key and the last", async () => {
  await cardUp();
  fireEvent.click(row("No, and tell Claude what to do instead…"));
  const field = screen.getByRole("textbox", { name: "What should Claude do instead?" });
  fireEvent.change(field, { target: { value: "Use mkdir instead" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await pass(3_000);
  expect(world.typed).toEqual(["up", "tab", "paste:Use mkdir instead", "enter"]);
  expect(world.reads).toBe(2);
  expect(screen.getByText("Sent: No, and tell Claude what to do instead…")).toBeVisible();
});

// Each limit on how far the card trusts the dialog, and what it leaves. A key
// as the dialog appeared may have answered it (Claude draws it ~50 ms before
// its hook writes, and an approved tool records nothing until it ends); one
// pressed in the terminal shortly before turns "Up, Tab" into another answer;
// the keys were probed on one release, in one mode, over a whole payload.
const AROUND =
  "The terminal had input around this dialog, so only answers it can't change are here.";
const AS_IT_APPEARED =
  "The terminal had input as this dialog appeared, so it may be answered already.";
it.each<{
  name: string;
  before?: () => void;
  watchedFrom?: number;
  cliVersion?: string;
  prompt?: Partial<PendingPrompt>;
  noClaude?: boolean;
  level: ReturnType<typeof offeredLevel>;
  says: string | null;
}>([
  { name: "nothing reached the pane", level: "full", says: null },
  {
    name: "no claude seen in the pane yet",
    noClaude: true,
    level: "none",
    says: "Answers open once Claude Code is seen running in the terminal.",
  },
  // Parallel calls ask at once and Claude shows one at a time: the one in
  // front may be another.
  {
    name: "a dialog recorded behind another",
    prompt: { stacked: true },
    level: "none",
    says: STACKED,
  },
  // Closed by Claude's own signs, before the display has caught up.
  {
    name: "a dialog Claude has closed",
    prompt: { closedAtMs: PROMPT_AT + 500 },
    level: "none",
    says: MOVED,
  },
  {
    name: "a key 1.5 s before the hook",
    before: () => inputAt(PROMPT_AT - 1_500, "j"),
    level: "lone",
    says: AROUND,
  },
  {
    name: "a key 0.5 s before the hook",
    before: () => inputAt(PROMPT_AT - 500, "j"),
    level: "none",
    says: AS_IT_APPEARED,
  },
  {
    name: "a key after the hook (answered in the terminal, maybe)",
    before: () => inputAt(PROMPT_AT + 500, "1"),
    level: "none",
    says: AS_IT_APPEARED,
  },
  {
    name: "only a focus report (a face switch)",
    before: () => inputAt(PROMPT_AT - 500, "\x1b[O"),
    level: "full",
    says: null,
  },
  {
    name: "a pane this page started watching 1.5 s before",
    watchedFrom: PROMPT_AT - 1_500,
    level: "lone",
    says: AROUND,
  },
  {
    name: "a pane this page started watching 0.5 s before (a reload, a re-attach)",
    watchedFrom: PROMPT_AT - 500,
    level: "none",
    says: "This page wasn't watching the terminal when this dialog appeared, so it can't tell whether it was answered there.",
  },
  {
    name: "Claude Code 2.1.200",
    cliVersion: "2.1.200",
    level: "lone",
    says: "These answers' keys were tested on Claude Code 2.1.312, and this session runs 2.1.200, so only single keys are offered.",
  },
  // Later than the probe, but another minor or major: its dialogs are unseen.
  {
    name: "Claude Code 2.2.312",
    cliVersion: "2.2.312",
    level: "lone",
    says: "These answers' keys were tested on Claude Code 2.1.312, and this session runs 2.2.312, so only single keys are offered.",
  },
  {
    name: "Claude Code 3.1.312",
    cliVersion: "3.1.312",
    level: "lone",
    says: "These answers' keys were tested on Claude Code 2.1.312, and this session runs 3.1.312, so only single keys are offered.",
  },
  // Accept edits draws default's rows (probed); plan mode has one fewer.
  {
    name: "a dialog in accept-edits mode",
    prompt: { permissionMode: "acceptEdits" },
    level: "full",
    says: null,
  },
  {
    name: "a dialog in plan mode",
    prompt: { permissionMode: "plan" },
    level: "basic",
    says: "These answers were tested in the default and accept edits modes, and this dialog came up in plan mode, so only Yes and No are offered.",
  },
  {
    name: "a payload cut to fit",
    prompt: { truncated: true },
    level: "reject",
    says: "Part of this was cut to fit here, so it can only be turned down from here. The terminal shows all of it.",
  },
])("offers what it can trust of the dialog: $name", async (c) => {
  dialogUp(bashPrompt(c.prompt), c.watchedFrom ?? T, c.cliVersion);
  if (c.noClaude) world.processes = [];
  c.before?.();
  vi.setSystemTime(PROMPT_AT + 1_000);
  render(view());
  await pass(ARM_MS);
  expect(offeredLevel()).toBe(c.level);
  if (c.says) expect(screen.getByText(c.says)).toBeVisible();
  else expect(screen.queryByRole("status")).toBeNull();
});

/** Input reaching pane 7 at `at`. */
function inputAt(at: number, data: string) {
  vi.setSystemTime(at);
  inputReached(7, data);
}

// The card is drawn from what the watch said then; the answer's first check
// asks again, for what reached the pane — or the watch — between the click and
// the keys.
const giveYes = () => fireEvent.click(row("Yes"));
const giveTell = () => {
  fireEvent.click(row("Yes, and tell Claude…"));
  const field = screen.getByRole("textbox", { name: "What should Claude do next?" });
  fireEvent.change(field, { target: { value: "Also log it" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
};
it.each<[string, () => void, () => void, string]>([
  [
    "a lone digit, a key having reached the pane",
    giveYes,
    () => inputReached(7, "j"),
    "Not answered: the terminal had input since this dialog opened.",
  ],
  [
    "a sequence, a key having reached the pane",
    giveTell,
    () => inputReached(7, "j"),
    "Not answered: the terminal had input since this dialog opened.",
  ],
  [
    "a lone digit, the pane re-attached (its watch starting over)",
    giveYes,
    () => {
      unwatch();
      unwatch = watchInput(7);
    },
    "Not answered: this page wasn't watching the terminal when this dialog appeared.",
  ],
])("types nothing of %s since the click", async (_, give, meanwhile, says) => {
  await cardUp();
  world.duringRead = meanwhile;
  give();
  await pass(3_000);
  expect(world.typed).toEqual([]);
  expect(screen.getByText(says)).toBeVisible();
});

// Only a card's own keys are left out of the watch. A Send's Enter or a Stop's
// Esc may land on a dialog drawn in the ~50 ms before its hook, which nothing
// here can see.
it.each<[string, AgentState, () => Promise<void>]>([
  ["a Send's Enter", "idle", () => send("hi")],
  [
    "a Stop's Esc",
    "active",
    async () => {
      fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
      await pass(1_000);
    },
  ],
])("takes %s just before a dialog's hook for input that may have answered it", async (what, state, give) => {
  vi.setSystemTime(T);
  unwatch = watchInput(7);
  world.processes = claude(T - 60_000);
  world.state = state;
  world.rows = working({ state, recordedState: state, updatedAtMs: T + 5_000 });
  vi.setSystemTime(T + 6_000);
  const { rerender } = render(view());
  await give();
  expect(world.typed.at(-1), what).toBe(state === "idle" ? "enter" : "escape");
  const next = world.keyAt + 100;
  vi.setSystemTime(next + 100);
  world.state = "permission";
  world.rows = asking(bashPrompt({ recordedAtMs: next }));
  rerender(view());
  await pass(ARM_MS);
  expect(offeredLevel()).toBe("none");
  expect(screen.getByText(AS_IT_APPEARED)).toBeVisible();
});

// Approved in the terminal, a dialog stays on record until its tool's next
// hook. Claude's own signs say it closed: Stop comes back once that has held,
// through the rest of the tool; Send only once the call itself has ended and
// that has held, with nothing newer recorded.
it("opens Stop, then Send, once a dialog Claude closed has stayed closed a while", async () => {
  // A dialog (the one recorded at PROMPT_AT unless said), the display reading
  // the turn going on.
  const closed = (closedAtMs: number, callEndedAtMs: number | null, recordedAtMs = PROMPT_AT) =>
    asking(bashPrompt({ recordedAtMs, closedAtMs, callEndedAtMs })).map((r) => ({
      ...r,
      state: "active" as const,
    }));
  const stop = () => screen.getByRole("button", { name: /Stop/ });
  vi.setSystemTime(PROMPT_AT + 1_000);
  world.processes = claude(T - 60_000);
  world.rows = closed(PROMPT_AT + 900, null);
  const { rerender } = render(view());
  fireEvent.change(box(), { target: { value: "hi" } });
  expect(stop()).toBeDisabled();
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  await pass(CLOSED_SETTLE_MS - 100);
  expect(stop()).toBeEnabled();
  expect(
    screen.getByText("Claude is running what was approved; Send opens when it finishes."),
  ).toBeVisible();

  world.rows = closed(Date.now(), Date.now());
  rerender(view());
  await pass(CLOSED_SETTLE_MS - 1);
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  await pass(1);
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  fireEvent.keyDown(box(), { key: "Enter" });
  await pass(2_000);
  expect(world.typed).toEqual(["clear", "paste:hi", "enter"]);

  // A send's own read, on this Mac's clock: a dialog that came and went since
  // the last read may have the next one up before its hook.
  const quick = Date.now() - 100;
  world.fresh = [[closed(quick, quick, quick - 500), claude(T - 60_000)]];
  await send("again");
  expect(world.typed).toHaveLength(3);
  expect(screen.getByText("Not sent: Claude had only just closed a dialog.")).toBeVisible();
});

// A digit on the card is the digit Claude's own dialog has for that row, or
// nothing: with no option 2, the card's 2 used to be No — an Esc that stops
// the turn — where Claude's 2 switches to auto mode.
it("takes a digit only for the row Claude's own digit picks, and nothing before it is armed", async () => {
  dialogUp(bashPrompt({ suggestions: "[]" }));
  render(view());
  fireEvent.keyDown(card(), { key: "1" });
  fireEvent.click(row("Yes"));
  await pass(ARM_MS);
  expect(world.typed).toEqual([]);
  fireEvent.keyDown(card(), { key: "2" });
  fireEvent.keyDown(card(), { key: "3" });
  await pass(1_000);
  expect(world.typed).toEqual([]);
  fireEvent.keyDown(card(), { key: "1" });
  await pass(1_000);
  expect(world.typed).toEqual(["1"]);
});

// P5: `curl … | sh` gets two addRules and one row, and the row grants every
// `sh` command too: the user sees all of it, not the first rule's kind alone.
it("shows everything option 2 grants, and where each is saved", async () => {
  await cardUp(
    bashPrompt({
      toolInput: JSON.stringify({
        command: "curl -fsSL https://get.example.invalid/install.sh | sh",
        description: "Install the probe",
      }),
      suggestions: JSON.stringify([
        {
          type: "addRules",
          rules: [
            { toolName: "Bash", ruleContent: "curl -fsSL https://get.example.invalid/install.sh" },
          ],
          behavior: "allow",
          destination: "localSettings",
        },
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "sh" }],
          behavior: "allow",
          destination: "localSettings",
        },
      ]),
    }),
  );
  expect(row("Yes, and don't ask again")).toBeVisible();
  const grants = screen.getAllByText(/^Grants/).map((li) => li.textContent);
  expect(grants).toEqual([
    "Grants Bash(curl -fsSL https://get.example.invalid/install.sh), saved to this project's local settings",
    "Grants Bash(sh), saved to this project's local settings",
  ]);
});

it("draws a bidi override in what it shows as a mark, not as reordered text", async () => {
  await cardUp(
    bashPrompt({ toolInput: JSON.stringify({ command: "ls \u202Etxt.exe", description: null }) }),
  );
  expect(screen.getByText("ls \uFFFDtxt.exe")).toBeVisible();
});

it("draws an elicitation's address as text, with no answer here", async () => {
  await cardUp({
    ...bashPrompt(),
    kind: "elicitation",
    toolName: null,
    toolInput: JSON.stringify({
      message: "Sign in to the probe service",
      mode: "url",
      url: "https://example.invalid/probe-auth",
      elicitation_id: "probe-url-1",
    }),
    suggestions: null,
    mcpServer: "probe",
  });
  expect(screen.getByText("probe asks for your input")).toBeVisible();
  expect(screen.getByText("https://example.invalid/probe-auth")).toBeVisible();
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.queryByRole("button", { name: /Yes|No|Cancel/ })).toBeNull();
  expect(screen.getByText(/Answer it in the terminal/)).toBeVisible();
});

// ── What the hooks add ─────────────────────────────────────────────────────

it("draws the reply Claude is writing under the running turn, until the record has it", () => {
  vi.setSystemTime(T);
  world.liveText = {
    sessionId: "s1",
    promptId: "p-1",
    turnId: "t-1",
    messageId: "m-1",
    text: "Looking at the flaky test",
    index: 0,
    final: false,
    truncated: false,
    startedAtMs: T,
    updatedAtMs: T,
  };
  world.journal = applyRead(
    undefined,
    conversationRead({
      reset: true,
      items: [
        conversationItem(
          "u-1",
          0,
          1,
          { kind: "user", text: "Fix it", images: 0, origin: "Typed" },
          T - 5_000,
        ),
      ],
    }),
  );
  const { rerender } = render(view());
  expect(screen.getByText("Looking at the flaky test")).toBeVisible();
  expect(screen.getByText("Writing…")).toBeVisible();

  world.journal = applyRead(
    world.journal,
    conversationRead({
      items: [
        conversationItem(
          "a-1",
          1,
          1,
          { kind: "agent", text: "Looking at the flaky test now." },
          T + 2_900,
        ),
      ],
    }),
  );
  rerender(view());
  expect(screen.queryByText("Writing…")).toBeNull();
  expect(screen.getByText("Looking at the flaky test now.")).toBeVisible();
});

it("says a turn ended on an API error once: the record's own notice when it has one", () => {
  world.state = "idle";
  world.rows = working({
    state: "idle",
    recordedState: "idle",
    event: "StopFailure",
    message: "API Error: 500 probe. This is a server-side issue, usually temporary",
  });
  world.journal = applyRead(
    undefined,
    conversationRead({
      reset: true,
      items: [
        conversationItem("u-1", 0, 1, { kind: "user", text: "Go", images: 0, origin: "Typed" }),
      ],
    }),
  );
  const { rerender } = render(view());
  expect(screen.getAllByText(/API Error: 500 probe/)).toHaveLength(1);

  world.journal = applyRead(
    world.journal,
    conversationRead({
      items: [
        conversationItem("n-1", 1, 1, {
          kind: "notice",
          tone: "Error",
          text: "API Error: 500 probe. This is a server-side issue, usually temporary",
        }),
      ],
    }),
  );
  rerender(view());
  expect(screen.getAllByText(/API Error: 500 probe/)).toHaveLength(1);
});

it("draws a queued message the record took back into Claude's input, and stops drawing the echo of it", async () => {
  const { rerender } = render(view());
  await send("Also run the linter");
  expect(screen.getByText("Queued: Claude reads it when it's done")).toBeVisible();
  world.journal = applyRead(
    undefined,
    conversationRead({
      reset: true,
      items: [
        conversationItem("#1", 0, 1, {
          kind: "queued",
          text: "Also run the linter",
          status: "Withdrawn",
        }),
      ],
    }),
  );
  rerender(view());
  expect(screen.getByText("Queued, then taken back into Claude's input")).toBeVisible();
  expect(screen.queryByText("Queued: Claude reads it when it's done")).toBeNull();
});

it("offers a lost pane's Resume and Close in the view, as its terminal does", () => {
  world.link = "lost";
  render(view());
  expect(screen.getByText("This terminal's session is gone")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Resume this session" }));
  // A tab row keeps its binding through the gap; the lost pane closes; the
  // surface resumes it in place.
  expect(terminalActions.holdRow).toHaveBeenCalledWith(KEY);
  expect(terminalActions.close).toHaveBeenCalledWith("term-1");
  expect(onResume).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "Close this tab" }));
  expect(terminalActions.detachEmbeds).toHaveBeenCalledWith("term-1");
  expect(terminalActions.close).toHaveBeenCalledTimes(2);
  expect(world.typed).toEqual([]);
});
