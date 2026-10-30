/**
 * Test-only: the Conversation view's journal, built the way `conversation_read`
 * hands it over, for the tests of the store and of the journal's rendering. It
 * lives under `src/test`, outside the app's own build, so it can never be drawn
 * in production.
 *
 * Shaped on a real Claude Code session's record (the backend's parser fixture
 * covers the same kinds): placeholder text, real structure — a command before
 * the first prompt, a finished turn with a run of tools and a reply, and a
 * latest turn that asks a question and puts a plan to the user.
 */
import type {
  ConversationItem,
  ConversationMeta,
  ConversationRead,
  ItemBody,
  ToolCall,
} from "../bindings";

/** A fixed moment the session's records are stamped from. */
export const T0 = 1_700_000_000_000;

export function conversationItem(
  id: string,
  seq: number,
  turn: number,
  body: ItemBody,
  atMs: number | null = null,
): ConversationItem {
  return { id, seq, turn, atMs, body };
}

/** A tool call's body: done, no result, unless the caller says otherwise. */
export function toolBody(call: Pick<ToolCall, "callId" | "name" | "input"> & Partial<ToolCall>) {
  const body: ItemBody = {
    kind: "tool",
    status: "Done",
    output: null,
    durationMs: null,
    subagent: null,
    ...call,
  };
  return body;
}

export const NO_META: ConversationMeta = {
  title: null,
  model: null,
  cwd: null,
  gitBranch: null,
  cliVersion: null,
  permissionMode: null,
  context: null,
  usage: null,
  truncated: false,
};

export function conversationRead(over: Partial<ConversationRead> = {}): ConversationRead {
  return {
    availability: "Ready",
    agent: "Claude",
    sessionId: "session-1",
    cursor: { epoch: "epoch-1", rev: 0 },
    reset: false,
    items: [],
    meta: NO_META,
    ...over,
  };
}

const out = (text: string, over: Partial<NonNullable<ToolCall["output"]>> = {}) => ({
  text,
  truncated: false,
  isError: false,
  exitCode: null,
  ...over,
});

/** Three turns: 0 before any prompt, 1 finished, 2 the latest. */
export const SESSION: ConversationItem[] = [
  conversationItem("u-cmd", 0, 0, {
    kind: "user",
    text: "/model sonnet",
    images: 0,
    origin: "Command",
  }),
  conversationItem(
    "u-p1",
    1,
    1,
    { kind: "user", text: "Fix the flaky login test", images: 0, origin: "Typed" },
    T0,
  ),
  conversationItem("a-r1", 2, 1, { kind: "reasoning", text: "", durationMs: 4200 }, T0 + 1_000),
  conversationItem("a-t1", 3, 1, { kind: "agent", text: "Looking at the test first." }, T0 + 2_000),
  conversationItem(
    "tool:read-1",
    4,
    1,
    toolBody({
      callId: "read-1",
      name: "Read",
      input: { kind: "read", path: "/repo/src/login.test.ts", lines: "lines 1–80" },
      output: out("placeholder file text"),
      durationMs: 40,
    }),
    T0 + 3_000,
  ),
  conversationItem(
    "tool:bash-1",
    5,
    1,
    toolBody({
      callId: "bash-1",
      name: "Bash",
      input: { kind: "command", command: "pnpm test login", description: "Run the login tests" },
      status: "Failed",
      output: out("placeholder failure", { isError: true, exitCode: 1 }),
      durationMs: 5_200,
    }),
    T0 + 4_000,
  ),
  conversationItem(
    "tool:edit-1",
    6,
    1,
    toolBody({
      callId: "edit-1",
      name: "Edit",
      input: {
        kind: "edit",
        files: [
          {
            path: "/repo/src/login.test.ts",
            op: "Update",
            patch: "@@ -10,3 +10,4 @@\n context a\n-old line\n+new line\n+second line\n context b",
            added: 2,
            removed: 1,
            truncated: false,
          },
        ],
      },
    }),
    T0 + 50_000,
  ),
  conversationItem(
    "a-t2",
    7,
    1,
    { kind: "agent", text: "Fixed: the test waits now." },
    T0 + 60_000,
  ),
  conversationItem(
    "u-end1",
    8,
    1,
    {
      kind: "turnEnd",
      durationMs: 72_000,
      usage: { input: 1_200, output: 3_000, cacheRead: 14_000, cacheWrite: 0, reasoning: 0 },
    },
    T0 + 72_000,
  ),
  conversationItem(
    "u-p2",
    9,
    2,
    { kind: "user", text: "Now tidy the helpers", images: 0, origin: "Typed" },
    T0 + 100_000,
  ),
  conversationItem(
    "tool:ask-1",
    10,
    2,
    toolBody({
      callId: "ask-1",
      name: "AskUserQuestion",
      input: {
        kind: "questions",
        questions: [
          {
            header: "Scope",
            question: "Which helpers?",
            options: ["Only login", "Every auth helper"],
            answer: "Only login",
          },
        ],
      },
    }),
  ),
  conversationItem(
    "tool:read-2",
    11,
    2,
    toolBody({
      callId: "read-2",
      name: "Read",
      input: { kind: "read", path: "/repo/src/auth/login.ts", lines: null },
    }),
  ),
  conversationItem(
    "tool:read-3",
    12,
    2,
    toolBody({
      callId: "read-3",
      name: "Read",
      input: { kind: "read", path: "/repo/src/auth/session.ts", lines: null },
    }),
  ),
  conversationItem(
    "tool:grep-1",
    13,
    2,
    toolBody({
      callId: "grep-1",
      name: "Grep",
      input: { kind: "search", pattern: "retryLogin", scope: "/repo/src" },
    }),
  ),
  conversationItem(
    "tool:bash-2",
    14,
    2,
    toolBody({
      callId: "bash-2",
      name: "Bash",
      input: { kind: "command", command: "git status", description: null },
    }),
  ),
  conversationItem("n-mode", 15, 2, {
    kind: "notice",
    tone: "Info",
    text: "Permission mode: plan",
  }),
  conversationItem(
    "tool:plan-1",
    16,
    2,
    toolBody({
      callId: "plan-1",
      name: "ExitPlanMode",
      input: { kind: "plan", markdown: "## Plan\n\n- Move the retry into one helper" },
      status: "Running",
    }),
  ),
];
