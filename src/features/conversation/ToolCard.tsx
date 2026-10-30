/** A tool call as the Conversation view draws it: one row (what it did, to
 *  what, how it ended, how long it took) that opens onto the detail its kind
 *  has — a command's output, an edit's diff, a subagent's report and its own
 *  conversation. A plan put to the user and questions asked of them are drawn
 *  open, as cards, because they are the agent talking to you rather than a
 *  step. Every body is mounted only once opened: a folded call costs a row. */
import { memo, type ReactNode, useState } from "react";

import type {
  FileChange,
  Question,
  TodoItem,
  ToolCall,
  ToolOutput,
  ToolStatus,
} from "../../bindings";
import {
  AgentsIcon,
  BlockedIcon,
  BoltIcon,
  CheckIcon,
  CloseIcon,
  FilesIcon,
  GlobeIcon,
  HelpIcon,
  ListIcon,
  MessageSquareIcon,
  PencilIcon,
  SearchIcon,
  StopIcon,
  TerminalIcon,
} from "../../components/icons";
import { Markdown, MarkdownDocument } from "../../components/Markdown";
import { Dot, Spinner } from "../../components/primitives";
import { subagentStatusMeta } from "../../theme/colors";
import { DiffStat } from "../reviews/DiffStat";
import { Clamped } from "./Clamped";
import { PatchDiff } from "./PatchDiff";
import { ActivityRow, STEP_INDENT, StepLabel } from "./Row";
import { displayPath, durationLabel, firstLine, useConversationScope } from "./scope";
import { type ItemOf, toolLabel } from "./turns";

/** A code or output well: commands, file text, JSON. */
const WELL = "rounded-md border border-line bg-input px-3 py-2 font-mono text-sm leading-[1.6]";

/** A line of small print under a body: an exit code, a cut. */
const NOTE = "text-xs text-muted-4";

const STATUS_LABEL: Record<ToolStatus, string> = {
  Running: "Running",
  Done: "Done",
  Failed: "Failed",
  Denied: "Denied",
  Interrupted: "Interrupted",
};

/** A step's icon, or how it ended when that is the news: running while the
 *  agent works, failed, denied, interrupted — or, the agent no longer working,
 *  no result on record. Done is the step's own icon. */
export function StepIcon({
  status,
  live,
  icon,
}: {
  status: ToolStatus;
  live: boolean;
  icon: ReactNode;
}) {
  const label = status === "Running" && !live ? "No result recorded" : STATUS_LABEL[status];
  return (
    <span role="img" aria-label={label} title={label} className="flex items-center justify-center">
      {status === "Running" ? (
        live ? (
          <Spinner size={10} color="var(--color-status-green)" />
        ) : (
          <span className="h-2 w-2 rounded-full border border-muted-4" />
        )
      ) : status === "Done" ? (
        icon
      ) : status === "Failed" ? (
        <CloseIcon size={11} className="text-status-red" />
      ) : status === "Denied" ? (
        <BlockedIcon size={11} className="text-status-amber" />
      ) : (
        <StopIcon size={11} className="text-muted-3" />
      )}
    </span>
  );
}

/** What a call's row says: an icon, a verb, and the thing it acted on. */
interface Head {
  icon: ReactNode;
  verb: string;
  /** Drawn in mono: a path, a command, a pattern. */
  object?: string;
  /** The whole object, when the row shows a shortened one. */
  title?: string;
  /** After the object: line counts, a subagent's type and state. */
  meta?: ReactNode;
}

const OP_VERB: Record<FileChange["op"], string> = {
  Add: "Created",
  Update: "Edited",
  Delete: "Deleted",
};

function headOf(call: ToolCall, cwd: string | null): Head {
  const input = call.input;
  switch (input.kind) {
    case "command":
      return {
        icon: <TerminalIcon size={12} />,
        verb: "Ran",
        object: firstLine(input.command),
        title: input.description ? `${input.description}\n\n${input.command}` : input.command,
      };
    case "edit": {
      const [only] = input.files;
      const added = input.files.reduce((n, f) => n + f.added, 0);
      const removed = input.files.reduce((n, f) => n + f.removed, 0);
      const stat = <DiffStat additions={added} deletions={removed} className="text-xs" />;
      if (input.files.length === 1 && only) {
        return {
          icon: <PencilIcon size={12} />,
          verb: OP_VERB[only.op],
          object: displayPath(only.path, cwd),
          title: only.path,
          meta: stat,
        };
      }
      return {
        icon: <PencilIcon size={12} />,
        verb: input.files.length > 1 ? `Edited ${input.files.length} files` : "Edited files",
        meta: input.files.length > 1 ? stat : undefined,
      };
    }
    case "read":
      return {
        icon: <FilesIcon size={12} />,
        verb: "Read",
        object: displayPath(input.path, cwd),
        title: input.path,
        meta: input.lines ? <span>{input.lines}</span> : undefined,
      };
    case "search":
      return {
        icon: <SearchIcon size={12} />,
        verb: "Searched for",
        object: input.pattern,
        meta: input.scope ? (
          <span className="truncate" title={input.scope}>
            in {displayPath(input.scope, cwd)}
          </span>
        ) : undefined,
      };
    case "fetch":
      return { icon: <GlobeIcon size={12} />, verb: "Fetched", object: input.url };
    case "webSearch":
      return { icon: <GlobeIcon size={12} />, verb: "Searched the web for", object: input.query };
    case "agent": {
      const status = call.subagent ? subagentStatusMeta[call.subagent.status] : null;
      const type = call.subagent?.agentType ?? input.agentType;
      return {
        icon: <AgentsIcon size={12} />,
        verb: input.description ?? "Subagent",
        meta: (
          <>
            {type && <span className="text-xs">{type}</span>}
            {status?.color && (
              <span className="flex flex-none items-center gap-1">
                <Dot color={status.color} size={6} glow={status.glow} />
                {status.label}
              </span>
            )}
          </>
        ),
      };
    }
    case "plan":
      return { icon: <ListIcon size={12} />, verb: "Proposed a plan" };
    case "todos": {
      const done = input.items.filter((t) => t.status === "Completed").length;
      return {
        icon: <ListIcon size={12} />,
        verb: "Updated the todo list",
        meta: (
          <span className="tabular-nums">
            {done}/{input.items.length}
          </span>
        ),
      };
    }
    case "questions":
      return {
        icon: <HelpIcon size={12} />,
        verb: input.questions.length === 1 ? "Asked a question" : "Asked questions",
      };
    case "other": {
      const server = /^mcp__(.+?)__/.exec(call.name)?.[1];
      return {
        icon: <BoltIcon size={12} />,
        verb: "Used",
        object: toolLabel(call.name),
        title: call.name,
        meta: server ? <span>{server}</span> : undefined,
      };
    }
  }
}

/** The icon a call's kind is drawn with. */
export function toolIcon(call: ToolCall): ReactNode {
  return headOf(call, null).icon;
}

/** A duration in the rows' own column, quiet and aligned. */
export function Took({ ms }: { ms: number }) {
  return <span className="text-xs text-muted-4 tabular-nums">{durationLabel(ms)}</span>;
}

/** A call folded to its row, opening onto its detail. */
export const ToolRow = memo(function ToolRow({
  item,
  live,
}: {
  item: ItemOf<"tool">;
  /** The agent is working now, so a call with no result is still running. */
  live: boolean;
}) {
  const scope = useConversationScope();
  const call = item.body;
  const [open, setOpen] = useState(false);
  const head = headOf(call, scope?.cwd ?? null);
  return (
    <div className="min-w-0">
      <ActivityRow
        icon={<StepIcon status={call.status} live={live} icon={head.icon} />}
        meta={head.meta}
        trailing={call.durationMs !== null ? <Took ms={call.durationMs} /> : undefined}
        open={open}
        onToggle={() => setOpen((o) => !o)}
        title={head.title}
      >
        {head.verb}
        {head.object && (
          <>
            {" "}
            <span className="font-mono text-sm text-fg-3">{head.object}</span>
          </>
        )}
      </ActivityRow>
      {open && (
        <div className={`${STEP_INDENT} pt-1 pb-3`}>
          <ToolBody call={call} live={live} />
        </div>
      )}
    </div>
  );
});

function ToolBody({ call, live }: { call: ToolCall; live: boolean }) {
  const input = call.input;
  switch (input.kind) {
    case "command":
      return (
        <div className="space-y-2">
          {input.description && (
            <p className="text-base leading-[1.55] text-muted-3">{input.description}</p>
          )}
          <Clamped text={`$ ${input.command}`} lines={8} className={`${WELL} text-fg-3`} />
          <Output output={call.output} pending={call.status === "Running" && live} />
        </div>
      );
    case "edit":
      return (
        <div className="space-y-1">
          {input.files.length === 0 ? (
            <p className={NOTE}>The record names no file.</p>
          ) : input.files.length === 1 && input.files[0] ? (
            <FileDiff file={input.files[0]} />
          ) : (
            input.files.map((file) => <FileRow key={file.path} file={file} />)
          )}
          {call.output?.isError && (
            <Output output={call.output} pending={call.status === "Running" && live} />
          )}
        </div>
      );
    case "read":
    case "search":
    case "webSearch":
      return <Output output={call.output} pending={call.status === "Running" && live} />;
    case "fetch":
      return (
        <div className="space-y-2">
          {input.prompt && (
            <p className="text-base leading-[1.55] text-muted-3">Asked: {input.prompt}</p>
          )}
          {call.output && !call.output.isError ? (
            <ProseOutput output={call.output} />
          ) : (
            <Output output={call.output} pending={call.status === "Running" && live} />
          )}
        </div>
      );
    case "agent":
      return <SubagentBody call={call} brief={input.prompt} live={live} />;
    case "todos":
      return <TodoList items={input.items} />;
    case "plan":
      return (
        <MarkdownDocument noRemote className={PLAN_PROSE}>
          {input.markdown}
        </MarkdownDocument>
      );
    case "questions":
      return <QuestionList questions={input.questions} />;
    case "other":
      return (
        <div className="space-y-2">
          <Clamped text={input.json} lines={10} className={`${WELL} text-fg-3`} />
          <Output output={call.output} pending={call.status === "Running" && live} />
        </div>
      );
  }
}

/** What a call returned, bounded, saying so when it was cut. `pending`: no
 *  result yet, and the agent is still working on it. */
function Output({ output, pending }: { output: ToolOutput | null; pending: boolean }) {
  if (!output) {
    return <p className={NOTE}>{pending ? "No result yet." : "No result recorded."}</p>;
  }
  const notes = [
    output.exitCode !== null ? `exit ${output.exitCode}` : null,
    output.truncated ? "output truncated" : null,
  ].filter(Boolean);
  return (
    <div className="space-y-1">
      {output.text.trim() ? (
        <Clamped
          text={output.text}
          lines={12}
          className={`${WELL} ${output.isError ? "text-status-red" : "text-fg-3"}`}
        />
      ) : (
        <p className={NOTE}>No output.</p>
      )}
      {notes.length > 0 && <p className={`${NOTE} tabular-nums`}>{notes.join(" · ")}</p>}
    </div>
  );
}

/** A result that is prose (a fetched page's summary, a subagent's report). */
function ProseOutput({ output }: { output: ToolOutput }) {
  return (
    <div className="space-y-1">
      <div className="max-h-96 overflow-y-auto rounded-md bg-raised px-3.5 py-2.5">
        <Markdown noRemote className="text-base leading-[1.65] text-fg-3">
          {output.text}
        </Markdown>
      </div>
      {output.truncated && <p className={NOTE}>truncated</p>}
    </div>
  );
}

/** One file of a multi-file edit: a row that opens its diff. */
function FileRow({ file }: { file: FileChange }) {
  const scope = useConversationScope();
  const [open, setOpen] = useState(false);
  return (
    <div>
      <ActivityRow
        icon={<PencilIcon size={12} />}
        meta={<DiffStat additions={file.added} deletions={file.removed} className="text-xs" />}
        open={open}
        onToggle={() => setOpen((o) => !o)}
        title={file.path}
      >
        {OP_VERB[file.op]}{" "}
        <span className="font-mono text-sm text-fg-3">
          {displayPath(file.path, scope?.cwd ?? null)}
        </span>
      </ActivityRow>
      {open && (
        <div className={`${STEP_INDENT} pt-1 pb-2`}>
          <FileDiff file={file} />
        </div>
      )}
    </div>
  );
}

function FileDiff({ file }: { file: FileChange }) {
  return (
    <div className="space-y-1">
      {file.patch ? (
        <PatchDiff path={file.path} op={file.op} patch={file.patch} />
      ) : (
        <p className={NOTE}>The record says the file changed, not how.</p>
      )}
      {file.truncated && <p className={NOTE}>diff truncated</p>}
    </div>
  );
}

/** A subagent: what it was asked, what it reported, and — read only when asked
 *  for — its own conversation, drawn with the same components on a quiet panel
 *  of its own. */
function SubagentBody({ call, brief, live }: { call: ToolCall; brief: string; live: boolean }) {
  const scope = useConversationScope();
  const [open, setOpen] = useState(false);
  const agentId = call.subagent?.agentId ?? null;
  return (
    <div className="space-y-3">
      <div>
        <StepLabel>Brief</StepLabel>
        <Clamped text={brief} lines={6} className="text-base leading-[1.6] text-muted-2" />
      </div>
      {call.output && (
        <div>
          <StepLabel>Report</StepLabel>
          {call.output.isError ? (
            <Output output={call.output} pending={call.status === "Running" && live} />
          ) : (
            <ProseOutput output={call.output} />
          )}
        </div>
      )}
      {agentId && scope?.renderSubagent && (
        <div>
          <ActivityRow
            icon={<MessageSquareIcon size={12} />}
            open={open}
            onToggle={() => setOpen((o) => !o)}
          >
            {open ? "Hide its conversation" : "Show its conversation"}
          </ActivityRow>
          {open && (
            <div className="mt-2 rounded-lg bg-raised px-4 py-4">
              {scope.renderSubagent(agentId, call.subagent?.status === "Running")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const TODO_MARK = {
  Completed: <CheckIcon size={10} className="text-muted-4" />,
  InProgress: <span className="h-1.5 w-1.5 rounded-full bg-status-green" />,
  Pending: null,
} as const;

/** A todo list as the agent last wrote it. */
export function TodoList({ items }: { items: TodoItem[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((todo, i) => (
        <li key={`${i}:${todo.text}`} className="flex items-start gap-2.5 text-base leading-[1.5]">
          <span
            role="img"
            aria-label={
              todo.status === "Completed"
                ? "Done"
                : todo.status === "InProgress"
                  ? "In progress"
                  : "To do"
            }
            className="mt-[3px] flex h-3 w-3 flex-none items-center justify-center rounded-sm border border-line-strong"
          >
            {TODO_MARK[todo.status]}
          </span>
          <span
            className={
              todo.status === "Completed"
                ? "text-muted-4 line-through"
                : todo.status === "InProgress"
                  ? "font-medium text-fg-2"
                  : "text-fg-3"
            }
          >
            {todo.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Whether `answer` — one option, or several joined — includes `option`. */
function chose(answer: string | null, option: string): boolean {
  if (!answer) return false;
  return answer === option || answer.split(/,\s*/).includes(option);
}

function QuestionList({ questions }: { questions: Question[] }) {
  return (
    <div className="space-y-4">
      {questions.map((q, i) => {
        const free = q.answer !== null && !q.options.some((option) => chose(q.answer, option));
        return (
          <div key={`${i}:${q.question}`}>
            {q.header && <div className="mb-0.5 text-xs font-medium text-muted-4">{q.header}</div>}
            <div className="selectable text-base leading-[1.6] text-fg-2">{q.question}</div>
            {q.options.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {q.options.map((option) => {
                  const picked = chose(q.answer, option);
                  return (
                    <span
                      key={option}
                      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-sm ${
                        picked
                          ? "border-line-strong bg-raised-2 font-medium text-fg"
                          : "border-line-2 text-muted-3"
                      }`}
                    >
                      {picked && <CheckIcon size={10} />}
                      {option}
                    </span>
                  );
                })}
              </div>
            )}
            {free && (
              <div className="mt-2 text-base text-fg-2">
                <span className="text-muted-4">Answered: </span>
                <span className="selectable">{q.answer}</span>
              </div>
            )}
            {q.answer === null && <div className={`mt-2 ${NOTE}`}>No answer recorded.</div>}
          </div>
        );
      })}
    </div>
  );
}

const PLAN_PROSE = "text-base leading-[1.7] text-fg-2";

/** What the user did with a plan, as far as the record says. */
const PLAN_STATE: Record<ToolStatus, string> = {
  Running: "Waiting for your answer",
  Done: "Approved",
  Failed: "Not approved",
  Denied: "Not approved",
  Interrupted: "Interrupted",
};

/** A plan or a set of questions, drawn open as a card of its own. */
export const AskCard = memo(function AskCard({
  item,
  live,
}: {
  item: ItemOf<"tool">;
  live: boolean;
}) {
  const call = item.body;
  const input = call.input;
  const plan = input.kind === "plan";
  const long = plan && (input.markdown.length > 1600 || input.markdown.split("\n").length > 30);
  const [full, setFull] = useState(false);
  const state =
    call.status === "Running" && !live
      ? "No answer recorded"
      : plan
        ? PLAN_STATE[call.status]
        : call.status === "Running"
          ? "Waiting for your answer"
          : null;
  return (
    <div className="rounded-lg border border-line-2 bg-raised px-4 pt-3 pb-3.5">
      <div className="mb-2 flex items-center gap-2 text-sm text-muted-3">
        {plan ? <ListIcon size={12} /> : <HelpIcon size={12} />}
        <span className="font-medium text-fg-2">{plan ? "Plan" : "Questions"}</span>
        {state && <span className="ml-auto text-sm text-muted-4">{state}</span>}
      </div>
      {input.kind === "plan" ? (
        <>
          <div className={long && !full ? "max-h-72 overflow-hidden" : undefined}>
            <MarkdownDocument noRemote className={PLAN_PROSE}>
              {input.markdown}
            </MarkdownDocument>
          </div>
          {long && (
            <button
              type="button"
              onClick={() => setFull((f) => !f)}
              className="mt-2 cursor-pointer text-sm font-medium text-muted-3 hover:text-fg-2"
            >
              {full ? "Show less" : "Show the whole plan"}
            </button>
          )}
        </>
      ) : input.kind === "questions" ? (
        <QuestionList questions={input.questions} />
      ) : null}
    </div>
  );
});
