/**
 * How the Conversation view reads a turn: who asked, what the agent did, what it
 * answered, and what it cost. Pure functions over the journal's items, so the
 * folding rules are one place and the components only draw.
 *
 * A turn is everything the backend filed under one `turn` number: the prompt the
 * user typed, the agent's work (its prose, its reasoning, its tool calls, any
 * notice), its final reply, and the `turnEnd` record. Some items land after the
 * end — a background task's completion arrives as the user — and are drawn
 * after the footer, where they happened.
 */
import type {
  ConversationItem,
  FileChange,
  ItemBody,
  TokenUsage,
  ToolCall,
  ToolInput,
} from "../../bindings";

type Body<K extends ItemBody["kind"]> = Extract<ItemBody, { kind: K }>;

/** An item whose body is known to be of kind `K`. */
export type ItemOf<K extends ItemBody["kind"]> = ConversationItem & { body: Body<K> };

export function isKind<K extends ItemBody["kind"]>(
  item: ConversationItem,
  kind: K,
): item is ItemOf<K> {
  return item.body.kind === kind;
}

export interface TurnStats {
  /** The record's own figure when the turn ended, else first item to last. */
  durationMs: number | null;
  /** Tool calls. */
  steps: number;
  /** Distinct files the turn's edits touched, and their lines. */
  files: { count: number; added: number; removed: number };
  usage: TokenUsage | null;
}

export interface TurnModel {
  /** The prompt that opened the turn; turn 0 (before any) has none. */
  prompt: ItemOf<"user"> | null;
  /** Everything between the prompt and the reply, in order. */
  work: ConversationItem[];
  /** The agent's last words, once nothing it did came after them. */
  answer: ItemOf<"agent"> | null;
  end: ItemOf<"turnEnd"> | null;
  /** What was recorded after the turn ended. */
  after: ConversationItem[];
  stats: TurnStats;
}

/** A prompt in the sense of "the user asked": typed at the prompt, or typed
 *  while the agent was busy and delivered when it was free. */
function isPrompt(item: ConversationItem): item is ItemOf<"user"> {
  return isKind(item, "user") && (item.body.origin === "Typed" || item.body.origin === "Queued");
}

export function buildTurn(items: readonly ConversationItem[]): TurnModel {
  const endAt = items.findIndex((item) => item.body.kind === "turnEnd");
  const main = endAt === -1 ? items : items.slice(0, endAt);
  const after = endAt === -1 ? [] : items.slice(endAt + 1);
  const end = endAt === -1 ? null : (items[endAt] as ItemOf<"turnEnd">);

  const promptAt = main.findIndex(isPrompt);
  let lastTool = -1;
  main.forEach((item, i) => {
    if (item.body.kind === "tool") lastTool = i;
  });
  let answerAt = -1;
  for (let i = main.length - 1; i > lastTool && i > promptAt; i--) {
    if (main[i].body.kind === "agent") {
      answerAt = i;
      break;
    }
  }
  return {
    prompt: promptAt === -1 ? null : (main[promptAt] as ItemOf<"user">),
    work: main.filter((_, i) => i !== promptAt && i !== answerAt),
    answer: answerAt === -1 ? null : (main[answerAt] as ItemOf<"agent">),
    end,
    after,
    stats: turnStats(main, end),
  };
}

function turnStats(main: readonly ConversationItem[], end: ItemOf<"turnEnd"> | null): TurnStats {
  const tools = main.filter((item): item is ItemOf<"tool"> => item.body.kind === "tool");
  const touched = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const tool of tools) {
    for (const file of editedFiles(tool.body)) {
      touched.add(file.path);
      added += file.added;
      removed += file.removed;
    }
  }
  const first = main.find((item) => item.atMs !== null)?.atMs ?? null;
  const last = [...main].reverse().find((item) => item.atMs !== null)?.atMs ?? null;
  return {
    durationMs: end?.body.durationMs ?? (first !== null && last !== null ? last - first : null),
    steps: tools.length,
    files: { count: touched.size, added, removed },
    usage: end?.body.usage ?? null,
  };
}

/** The files a call changed, or none for a call that changes no file. */
export function editedFiles(call: ToolCall): FileChange[] {
  return call.input.kind === "edit" ? call.input.files : [];
}

/** Every token class, as Session history counts a session's. Null-safe: the
 *  bridge carries a float as `number | null`. */
export function totalTokens(usage: TokenUsage): number {
  return (
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
  );
}

/** A turn's work as the view draws it: consecutive tool calls (with the
 *  reasoning between them) become one run, folded into a sentence; prose,
 *  prompts and notices stand on their own, and so do a plan put to the user and
 *  questions asked of them — those are the agent talking to you, not a step. */
export type Segment =
  | { kind: "item"; item: ConversationItem }
  | { kind: "run"; key: string; items: ConversationItem[] };

/** A call drawn on its own rather than folded into a run. */
export function standsAlone(item: ConversationItem): boolean {
  const body = item.body;
  return body.kind === "tool" && (body.input.kind === "plan" || body.input.kind === "questions");
}

export function segments(items: readonly ConversationItem[]): Segment[] {
  const out: Segment[] = [];
  let run: ConversationItem[] = [];
  const flush = () => {
    // Reasoning with no call beside it is not a run of anything.
    if (run.some((item) => item.body.kind === "tool")) {
      out.push({ kind: "run", key: run[0].id, items: run });
    } else {
      for (const item of run) out.push({ kind: "item", item });
    }
    run = [];
  };
  for (const item of items) {
    if ((item.body.kind === "tool" && !standsAlone(item)) || item.body.kind === "reasoning") {
      run.push(item);
    } else {
      flush();
      out.push({ kind: "item", item });
    }
  }
  flush();
  return out;
}

/** "once", "twice", "3 times". */
function times(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** An MCP tool's own name without its server (`mcp__linear__get_issue` →
 *  `get_issue`); any other name as it is. */
export function toolLabel(name: string): string {
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  return mcp ? mcp[2] : name;
}

type Phrase = (calls: ToolCall[]) => string;

/** What a run of each kind of call did, as a phrase. */
const PHRASE: Record<ToolInput["kind"], Phrase> = {
  command: (calls) => `ran ${count(calls.length, "command")}`,
  edit: (calls) => {
    const files = calls.flatMap(editedFiles);
    const paths = new Set(files.map((f) => f.path)).size;
    const verb = files.every((f) => f.op === "Add")
      ? "created"
      : files.every((f) => f.op === "Delete")
        ? "deleted"
        : "edited";
    return `${verb} ${count(paths || calls.length, "file")}`;
  },
  read: (calls) => {
    const paths = new Set(calls.map((c) => (c.input.kind === "read" ? c.input.path : ""))).size;
    return `read ${count(paths, "file")}`;
  },
  search: (calls) => `searched ${times(calls.length)}`,
  fetch: (calls) => `fetched ${count(calls.length, "page")}`,
  webSearch: (calls) => `searched the web ${times(calls.length)}`,
  agent: (calls) => `ran ${count(calls.length, "subagent")}`,
  plan: (calls) => (calls.length === 1 ? "proposed a plan" : `proposed ${calls.length} plans`),
  todos: () => "updated the todo list",
  questions: (calls) =>
    `asked ${count(
      calls.reduce((n, c) => n + (c.input.kind === "questions" ? c.input.questions.length : 0), 0),
      "question",
    )}`,
  other: (calls) => {
    const names = [...new Set(calls.map((c) => toolLabel(c.name)))];
    if (names.length === 1) {
      return `used ${names[0]}${calls.length > 1 ? ` ${times(calls.length)}` : ""}`;
    }
    return names.length === 2 ? `used ${names[0]} and ${names[1]}` : `used ${names.length} tools`;
  },
};

/** One sentence for a run of calls, kinds in the order they first appear:
 *  "Read 3 files, searched twice, ran 1 command". */
export function runSentence(calls: readonly ToolCall[]): string {
  const byKind = new Map<ToolInput["kind"], ToolCall[]>();
  for (const call of calls) {
    const list = byKind.get(call.input.kind);
    if (list) list.push(call);
    else byKind.set(call.input.kind, [call]);
  }
  const text = [...byKind].map(([kind, list]) => PHRASE[kind](list)).join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The latest prompt the record holds, by id; null before the first. */
export function latestPromptId(items: readonly ConversationItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) if (isPrompt(items[i])) return items[i].id;
  return null;
}

/** The question or plan the latest turn still waits on the user for, as the
 *  record has it: a call that asks (AskUserQuestion, ExitPlanMode) and has no
 *  answer yet. An earlier turn's is history, whatever its status says. */
export function pendingAsk(items: readonly ConversationItem[]): "question" | "plan" | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (isPrompt(item)) return null;
    const body = item.body;
    if (body.kind !== "tool" || body.status !== "Running") continue;
    if (body.input.kind === "questions") return "question";
    if (body.input.kind === "plan") return "plan";
  }
  return null;
}

/** The latest todo list anyone wrote in the conversation, for the pin under the
 *  header. */
export function latestTodos(items: readonly ConversationItem[]) {
  for (let i = items.length - 1; i >= 0; i--) {
    const body = items[i].body;
    if (body.kind === "tool" && body.input.kind === "todos") return body.input.items;
  }
  return null;
}

/** Whether the record already has the reply Claude was drawing (its live text,
 *  from the MessageDisplay hook): the latest turn holds agent prose from about
 *  when that reply began, or prose that starts with what was drawn. Then the
 *  live text has done its job and the record's own item stands. */
export function liveTextLanded(
  live: { text: string; startedAtMs: number | null },
  turn: { items: readonly ConversationItem[] } | undefined,
): boolean {
  const drawn = live.text.trim();
  return (turn?.items ?? []).some(
    (item) =>
      isKind(item, "agent") &&
      ((live.startedAtMs !== null && item.atMs !== null && item.atMs >= live.startedAtMs - 1000) ||
        (drawn !== "" && item.body.text.trim().startsWith(drawn))),
  );
}

/** Whether the latest turn records an error of its own (an API error the
 *  transcript kept as a notice). */
export function turnEndedInError(
  turn: { items: readonly ConversationItem[] } | undefined,
): boolean {
  return (turn?.items ?? []).some((item) => isKind(item, "notice") && item.body.tone === "Error");
}
