/** A dialog Claude is showing, read from its own hook payload
 *  (`SessionState.prompt`): what the answer card draws, and the facts its
 *  answers depend on (`keys.ts` `answerSteps`). Pure.
 *
 *  Every string here is the model's or an MCP server's: the card draws it as
 *  text (or as markdown that loads nothing remote), and none of it is ever
 *  typed. What the payload decides is only which of the dialog's own keys
 *  exist — which tool asks (its family), whether Claude offered a rule (option
 *  2), and how many options each question has. */
import type { PendingPrompt } from "../../bindings";
import { withoutControls } from "../terminal/agentProvider";

/** Which answers a permission dialog has, by the tool that asks (the
 *  contract's per-tool table, docs/conversation.md). `standard`: every answer
 *  was probed on it. `webFetch`: no text answers (a paste there is
 *  swallowed). `other`: a tool nobody probed — Yes and No only. */
export type ToolFamily = "standard" | "webFetch" | "other";

/** What option 2 does, by the kind of Claude's first suggestion: the row's
 *  label says the kind and claims nothing more (the dialog's own wording of it
 *  varies with the command, the mode and the account). */
export type Rule = "addRules" | "addDirectories" | "acceptEdits";

/** Option 2, when Claude offered rules the card can name: its label's kind,
 *  and everything it grants, one line per thing granted — a `curl … | sh`
 *  command's one row grants every `sh` command too. */
export interface Option2 {
  rule: Rule;
  grants: { what: string; where: string | null }[];
}

/** A tool's input as the card draws it. */
export type ToolView =
  | { kind: "command"; command: string; description: string | null }
  | { kind: "edit"; path: string; old: string; next: string; all: boolean }
  | { kind: "write"; path: string; content: string }
  | { kind: "fetch"; url: string; prompt: string | null }
  | { kind: "json"; text: string };

export interface QuestionView {
  header: string;
  question: string;
  options: { label: string; description: string; preview: string | null }[];
  multiSelect: boolean;
}

export interface ElicitationField {
  name: string;
  title: string;
  description: string | null;
  type: string;
  choices: string[];
  required: boolean;
}

export type Dialog =
  | {
      kind: "permission";
      tool: string;
      family: ToolFamily;
      /** An MCP tool's server and its own name. */
      mcp: { server: string | null; tool: string } | null;
      view: ToolView;
      /** What option 2 does, when Claude offered rules the card can name:
       *  never for an empty list (row 2 is then "switch to auto mode"), none,
       *  or any suggestion of a kind or shape this build doesn't know. */
      option2: Option2 | null;
    }
  | { kind: "questions"; questions: QuestionView[]; raw: string }
  | { kind: "plan"; plan: string }
  | {
      kind: "elicitation";
      server: string | null;
      message: string;
      mode: string;
      fields: ElicitationField[];
      /** URL mode's address, as text: never a link, never opened. */
      url: string | null;
    };

/** The tools every answer was probed on (Bash, Edit, Write, Read, WebSearch,
 *  and MCP tools). */
const STANDARD = new Set(["Bash", "Edit", "Write", "Read", "WebSearch"]);

/** A terminal escape sequence: CSI, OSC (to BEL or ST), or a lone ESC pair. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC and BEL are what is being stripped.
const ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

/** The bidirectional formatting characters (marks, embeddings, overrides,
 *  isolates). The terminal draws a command in its logical order, so one of
 *  these must not make the card read differently from what would run. */
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** Text from the payload as the transcript's text is drawn: no terminal escape
 *  sequences, no control characters but tab and newline — and no bidi
 *  formatting, each shown as U+FFFD where it was. */
export function shownText(value: string): string {
  return withoutControls(value.replace(ESCAPE, ""), "\t\n").replace(BIDI, "\uFFFD");
}

function parse(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? shownText(v) : null);

/** The payload's JSON, indented, its strings made safe to draw. */
function prettyJson(value: unknown, raw: string): string {
  if (value === null) return shownText(raw);
  try {
    return shownText(JSON.stringify(value, null, 2));
  } catch {
    return shownText(raw);
  }
}

/** Where a suggestion is saved, as the card says it. */
function whereOf(destination: unknown): string | null {
  switch (destination) {
    case "session":
      return "for this session";
    case "localSettings":
      return "saved to this project's local settings";
    case "projectSettings":
      return "saved to this project's settings";
    case "userSettings":
      return "saved to your user settings";
    default:
      return typeof destination === "string" ? shownText(destination) : null;
  }
}

/** One suggestion, when it is a kind the card knows in the shape the probes
 *  saw: its kind and what it grants. Null for anything else. */
function suggestionOf(entry: unknown): { rule: Rule; grants: Option2["grants"] } | null {
  if (!isRecord(entry)) return null;
  const where = whereOf(entry.destination);
  switch (entry.type) {
    case "addRules": {
      const rules = entry.rules;
      if (entry.behavior !== "allow" || !Array.isArray(rules) || rules.length === 0) return null;
      const grants: Option2["grants"] = [];
      for (const rule of rules) {
        if (!isRecord(rule) || typeof rule.toolName !== "string") return null;
        if (rule.ruleContent !== undefined && typeof rule.ruleContent !== "string") return null;
        const tool = shownText(rule.toolName);
        const what =
          typeof rule.ruleContent === "string" ? `${tool}(${shownText(rule.ruleContent)})` : tool;
        grants.push({ what, where });
      }
      return { rule: "addRules", grants };
    }
    case "addDirectories": {
      const dirs = entry.directories;
      if (!Array.isArray(dirs) || dirs.length === 0 || !dirs.every((d) => typeof d === "string")) {
        return null;
      }
      return {
        rule: "addDirectories",
        grants: dirs.map((dir: string) => ({ what: `access to ${shownText(dir)}`, where })),
      };
    }
    case "setMode":
      return entry.mode === "acceptEdits"
        ? { rule: "acceptEdits", grants: [{ what: "accept edits", where }] }
        : null;
    default:
      return null;
  }
}

/** Option 2, from the suggestions Claude offered: only when every one is a
 *  kind the card knows, in the shape the probes saw — so that the row's grants
 *  can all be named — and labelled by the first's kind, the row Claude draws.
 *  An empty list (row 2 is then "switch to auto mode"), none at all, or
 *  anything else offers no option 2. */
export function ruleOf(suggestions: string | null): Option2 | null {
  const list = parse(suggestions);
  if (!Array.isArray(list) || list.length === 0) return null;
  const known = list.map(suggestionOf);
  if (known.some((k) => k === null)) return null;
  const all = known as NonNullable<ReturnType<typeof suggestionOf>>[];
  return { rule: all[0].rule, grants: all.flatMap((k) => k.grants) };
}

function familyOf(tool: string): ToolFamily {
  if (tool === "WebFetch") return "webFetch";
  if (STANDARD.has(tool) || tool.startsWith("mcp__")) return "standard";
  return "other";
}

function viewOf(tool: string, input: unknown, raw: string): ToolView {
  const field = (key: string) => (isRecord(input) ? str(input[key]) : null);
  const json: ToolView = { kind: "json", text: prettyJson(input, raw) };
  switch (tool) {
    case "Bash": {
      const command = field("command");
      return command === null
        ? json
        : { kind: "command", command, description: field("description") };
    }
    case "Edit": {
      const path = field("file_path");
      if (path === null) return json;
      const all = isRecord(input) && input.replace_all === true;
      return {
        kind: "edit",
        path,
        old: field("old_string") ?? "",
        next: field("new_string") ?? "",
        all,
      };
    }
    case "Write": {
      const path = field("file_path");
      return path === null ? json : { kind: "write", path, content: field("content") ?? "" };
    }
    case "WebFetch": {
      const url = field("url");
      return url === null ? json : { kind: "fetch", url, prompt: field("prompt") };
    }
    default:
      return json;
  }
}

function questionsOf(input: unknown): QuestionView[] | null {
  if (!isRecord(input) || !Array.isArray(input.questions)) return null;
  const out: QuestionView[] = [];
  for (const q of input.questions) {
    if (!isRecord(q) || !Array.isArray(q.options)) return null;
    const options = q.options.map((o) =>
      isRecord(o)
        ? {
            label: str(o.label) ?? "",
            description: str(o.description) ?? "",
            preview: str(o.preview),
          }
        : null,
    );
    if (options.some((o) => o === null)) return null;
    out.push({
      header: str(q.header) ?? "",
      question: str(q.question) ?? "",
      options: options as QuestionView["options"],
      multiSelect: q.multiSelect === true,
    });
  }
  return out;
}

function fieldsOf(schema: unknown): ElicitationField[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  return Object.entries(schema.properties).map(([name, spec]) => {
    const s = isRecord(spec) ? spec : {};
    return {
      name: shownText(name),
      title: str(s.title) ?? shownText(name),
      description: str(s.description),
      type: str(s.type) ?? "value",
      choices: Array.isArray(s.enum) ? s.enum.map((c) => shownText(String(c))) : [],
      required: required.includes(name),
    };
  });
}

/** The dialog a pending prompt is. */
export function dialogOf(prompt: PendingPrompt): Dialog {
  const input = parse(prompt.toolInput);
  if (prompt.kind === "elicitation") {
    const field = (key: string) => (isRecord(input) ? str(input[key]) : null);
    return {
      kind: "elicitation",
      server: prompt.mcpServer === null ? null : shownText(prompt.mcpServer),
      message: field("message") ?? "",
      mode: field("mode") ?? "",
      fields: isRecord(input) ? fieldsOf(input.requested_schema) : [],
      url: field("url"),
    };
  }
  const tool = prompt.toolName ?? "";
  if (tool === "AskUserQuestion") {
    return {
      kind: "questions",
      questions: questionsOf(input) ?? [],
      raw: prettyJson(input, prompt.toolInput),
    };
  }
  if (tool === "ExitPlanMode") {
    const plan = isRecord(input) ? str(input.plan) : null;
    return { kind: "plan", plan: plan ?? prettyJson(input, prompt.toolInput) };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  return {
    kind: "permission",
    tool: shownText(tool),
    family: familyOf(tool),
    mcp: mcp
      ? {
          server: prompt.mcpServer === null ? shownText(mcp[1]) : shownText(prompt.mcpServer),
          tool: shownText(mcp[2]),
        }
      : null,
    view: viewOf(tool, input, prompt.toolInput),
    option2: ruleOf(prompt.suggestions),
  };
}
