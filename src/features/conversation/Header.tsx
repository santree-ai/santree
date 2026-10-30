/** The Conversation view's header: which session this is and where it stands.
 *
 *  Its state is the attention machinery's own level (`lib/attention.ts`), never
 *  a second classification; its context fill and cost are the numbers Claude's
 *  status line reported (`session_usage_live`), the ones the status bar and the
 *  terminal's own bar show. A past session falls back to its record's totals. */
import { useState } from "react";

import type { ConversationMeta, SessionUsageLive, TodoItem } from "../../bindings";
import { BranchIcon, ChevronDownIcon, ClaudeSparkIcon, ListIcon } from "../../components/icons";
import { AttentionDot, attentionMeta } from "../../components/shell/AttentionDot";
import type { AttentionLevel } from "../../lib/attention";
import { displayFill, fillColor } from "../../lib/contextFill";
import { formatCompact, formatUsd } from "../../lib/format";
import { modelVersion, sessionStateMeta } from "../../theme/colors";
import type { AgentEntry } from "../agents/registry";
import type { AskKind } from "./Composer";
import { shownText } from "./dialog";
import { TodoList } from "./ToolCard";
import { totalTokens } from "./turns";

/** Claude's permission modes, in the words its own footer uses. Default
 *  (manual) is the absence of a mark. */
const MODE_LABEL: Record<string, string | null> = {
  default: null,
  acceptEdits: "accept edits",
  plan: "plan",
  auto: "auto",
  bypassPermissions: "bypass permissions",
  dontAsk: "don't ask",
};

/** A permission mode as the header names it: a known one in words, anything
 *  else as Claude spelled it. */
export function modeLabel(mode: string | null): string | null {
  if (!mode) return null;
  return mode in MODE_LABEL ? MODE_LABEL[mode] : shownText(mode);
}

/** What Claude asks, where it is more than a permission. */
const ASK_LABEL: Partial<Record<AskKind, string>> = {
  question: "Has a question",
  plan: "Plan to review",
};

/** The level's words, made specific by the hook's state when the two agree —
 *  "Needs permission" rather than "Needs you", "Has a question" when what it
 *  asks is a question — and never contradicting it. */
function stateLabel(level: AttentionLevel, entry: AgentEntry, ask: AskKind | null): string {
  const asked = ask ? ASK_LABEL[ask] : undefined;
  if (level === "needs-you" && asked) return asked;
  const state = entry.state;
  const specific = state ? sessionStateMeta[state]?.label : undefined;
  const agrees =
    (level === "needs-you" && (state === "permission" || state === "waiting")) ||
    (level === "working" && (state === "active" || state === "delegating")) ||
    (level === "idle" && state === "idle");
  return agrees && specific ? specific : attentionMeta[level].label;
}

export function ConversationHeader({
  meta,
  fallbackTitle,
  live,
  usage,
  todos,
  mode: hookMode = null,
  effort = null,
}: {
  meta: ConversationMeta | null;
  /** What to call a session the record has no title for yet. */
  fallbackTitle: string;
  /** The tab's agent and its level, when this is a live session, and what it
   *  asks while it does. */
  live: { entry: AgentEntry; level: AttentionLevel; ask: AskKind | null } | null;
  usage: SessionUsageLive | null;
  todos: TodoItem[] | null;
  /** The permission mode the hooks last carried: newer than the record's,
   *  which notes a change only with the next prompt. */
  mode?: string | null;
  /** The effort level the hooks (or the status line) last carried. */
  effort?: string | null;
}) {
  const model = meta?.model ?? usage?.model ?? null;
  const mode = modeLabel(hookMode ?? meta?.permissionMode ?? null);
  const style =
    usage?.outputStyle && usage.outputStyle !== "default" ? shownText(usage.outputStyle) : null;
  // How the session runs, in words: one line, set apart by dots.
  const settings = [
    model && (
      <span key="model" title={model}>
        {modelVersion(model)}
      </span>
    ),
    mode && (
      <span key="mode" title="Permission mode">
        {mode} mode
      </span>
    ),
    effort && (
      <span key="effort" title="Effort">
        {shownText(effort)} effort
      </span>
    ),
    style && (
      <span key="style" title="Output style">
        {style} style
      </span>
    ),
    usage?.vimMode && (
      <span key="vim" title="Vim mode">
        vim {shownText(usage.vimMode)}
      </span>
    ),
  ].filter(Boolean);
  return (
    <div className="flex-none border-b border-hairline bg-app">
      <div className="mx-auto w-full max-w-[760px] px-6 pt-3.5 pb-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex flex-none" title="Claude Code">
            <ClaudeSparkIcon size={14} />
          </span>
          <h2 className="min-w-0 truncate text-md font-semibold text-fg-bright">
            {meta?.title ?? fallbackTitle}
          </h2>
          {live && (
            <span className="ml-auto flex flex-none items-center gap-1.5 pl-3 text-sm text-muted-2">
              <AttentionDot level={live.level} size={7} />
              {stateLabel(live.level, live.entry, live.ask)}
            </span>
          )}
        </div>
        <div className="mt-1.5 flex min-w-0 items-center gap-3 text-sm text-muted-3">
          {settings.length > 0 && (
            <span className="flex flex-none items-center gap-1.5">
              {settings.flatMap((part, i) =>
                i === 0
                  ? [part]
                  : [
                      <span key={`sep-${i}`} aria-hidden className="text-muted-5">
                        ·
                      </span>,
                      part,
                    ],
              )}
            </span>
          )}
          {meta?.gitBranch && (
            <span className="flex min-w-0 items-center gap-1.5 text-muted-4" title={meta.gitBranch}>
              <BranchIcon size={11} className="flex-none" />
              <span className="truncate font-mono text-xs">{meta.gitBranch}</span>
            </span>
          )}
          <span className="ml-auto flex flex-none items-center gap-3 text-xs text-muted-3 tabular-nums">
            <ContextReading meta={meta} usage={usage} />
            <CostReading meta={meta} usage={usage} />
          </span>
        </div>
        {todos && todos.length > 0 && <TodoPin todos={todos} />}
      </div>
    </div>
  );
}

/** How full the context window is: the status line's figure, else what the
 *  record says is in it. */
function ContextReading({
  meta,
  usage,
}: {
  meta: ConversationMeta | null;
  usage: SessionUsageLive | null;
}) {
  if (usage?.usedPct !== null && usage?.usedPct !== undefined) {
    const pct = displayFill(usage.usedPct);
    const color = fillColor(pct);
    return (
      <span
        role="img"
        aria-label={`Context ${pct}% full`}
        title={`Context ${pct}% full${
          usage.inputTokens !== null && usage.contextSize !== null
            ? ` (${formatCompact(usage.inputTokens)} of ${formatCompact(usage.contextSize)} tokens)`
            : ""
        }`}
        className="flex items-center gap-1"
      >
        <ContextRing pct={pct} color={color} />
        <span className="tabular-nums" style={{ color }}>
          {pct}%
        </span>
      </span>
    );
  }
  const used = meta?.context?.usedTokens;
  if (used === null || used === undefined) return null;
  return <span className="tabular-nums">{formatCompact(used)} in context</span>;
}

/** What the session has cost: Claude's own estimate from its status line, else
 *  the tokens its record counts. */
function CostReading({
  meta,
  usage,
}: {
  meta: ConversationMeta | null;
  usage: SessionUsageLive | null;
}) {
  if (usage?.costUsd !== null && usage?.costUsd !== undefined) {
    return (
      <span className="tabular-nums" title="This session so far, by Claude Code's estimate">
        {formatUsd(usage.costUsd)}
      </span>
    );
  }
  if (!meta?.usage) return null;
  return <span className="tabular-nums">{formatCompact(totalTokens(meta.usage))} tokens</span>;
}

function ContextRing({ pct, color }: { pct: number; color: string }) {
  const r = 5;
  const circumference = 2 * Math.PI * r;
  return (
    <svg width={13} height={13} viewBox="0 0 14 14" aria-hidden className="flex-none">
      <circle cx="7" cy="7" r={r} fill="none" stroke="var(--color-line-strong)" strokeWidth={2} />
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={`${(circumference * pct) / 100} ${circumference}`}
        transform="rotate(-90 7 7)"
      />
    </svg>
  );
}

/** The latest todo list, pinned under the header: progress and what is in hand,
 *  opening onto the whole list. */
function TodoPin({ todos }: { todos: TodoItem[] }) {
  const [open, setOpen] = useState(false);
  const done = todos.filter((t) => t.status === "Completed").length;
  const current = todos.find((t) => t.status === "InProgress");
  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="-mx-2 flex w-[calc(100%+1rem)] min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-muted-3 transition-colors hover:bg-hover hover:text-fg-2"
      >
        <ListIcon size={12} className="flex-none" />
        <span className="flex-none text-xs tabular-nums">
          {done}/{todos.length}
        </span>
        <span className="min-w-0 truncate">
          {current ? current.text : done === todos.length ? "All done" : "To do"}
        </span>
        <ChevronDownIcon
          size={10}
          className={`ml-auto flex-none transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="mt-1.5 mb-1 max-h-56 overflow-y-auto pl-6">
          <TodoList items={todos} />
        </div>
      )}
    </div>
  );
}
