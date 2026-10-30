/** The journal's non-tool entries: what was sent as the user, the agent's prose,
 *  its reasoning, and the notices between them. Each is memoized on its item, so
 *  a read that changes nothing about it renders nothing of it.
 *
 *  The page has two sides. What the user sent sits on the right, in a soft
 *  bubble; what the agent did reads down the left, its prose on the column's
 *  edge and each step as an {@link ActivityRow}. */
import { memo, useState } from "react";

import { MessageSquareIcon, SparklesIcon, WarningIcon } from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { alpha } from "../../theme/colors";
import { Clamped } from "./Clamped";
import { ActivityRow, STEP_INDENT } from "./Row";
import { durationLabel, firstLine } from "./scope";
import type { ItemOf } from "./turns";

/** Prose sizes, shared with the tool cards' text so the page reads as one. */
export const PROSE = "text-[13.5px] leading-[1.7] text-fg-2";

/** The bubble what the user sent is drawn in. */
const BUBBLE = "max-w-[85%] rounded-lg px-3.5 py-2";

/** What the user sent. A prompt they typed is the page's anchor; a command is a
 *  chip; what Claude Code recorded as the user without their typing it (a
 *  background task finishing, injected context, a compaction summary) is quiet
 *  and folded. */
export const UserItem = memo(function UserItem({ item }: { item: ItemOf<"user"> }) {
  const { text, images, origin } = item.body;
  if (origin === "Command") return <CommandItem text={text} />;
  if (origin === "Injected") return <InjectedItem text={text} />;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className={`${BUBBLE} bg-raised-2`}>
        <Clamped text={text} lines={14} className="text-[13.5px] leading-[1.6] text-fg" />
        {images > 0 && (
          <div className="mt-1 text-[11.5px] text-muted-3">
            {images === 1 ? "1 image" : `${images} images`}
          </div>
        )}
      </div>
      {origin === "Queued" && (
        <span
          className="pr-1 text-[11px] text-muted-4"
          title="Typed while Claude was working, and sent when it was free"
        >
          Queued
        </span>
      )}
    </div>
  );
});

/** A slash command or shell escape is a chip on the user's side; what it
 *  printed is output on the left. */
function CommandItem({ text }: { text: string }) {
  const command = /^[/!]/.test(text.trimStart());
  if (command) {
    return (
      <div className="flex justify-end">
        <code className="selectable max-w-[85%] truncate rounded-lg bg-raised-2 px-2.5 py-1 font-mono text-[12px] text-fg-2">
          {text.trim()}
        </code>
      </div>
    );
  }
  return (
    <Clamped
      text={text}
      lines={6}
      className="rounded-md border border-line bg-input px-3 py-2 font-mono text-[11.5px] leading-[1.6] text-muted-2"
    />
  );
}

/** Markup Claude Code wraps its own messages in, for a one-line preview only. */
const WRAPPER_TAG = /<\/?[a-z][a-z0-9-]*>/gi;

/** What Claude Code recorded as the user without their typing it, unwrapped:
 *  one line opens nothing (it is drawn whole), more opens onto the rest. */
function InjectedItem({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const plain = text
    .replace(WRAPPER_TAG, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
  const preview = firstLine(plain);
  const icon = <MessageSquareIcon size={12} />;
  const title = "Recorded as you, but not typed by you";
  if (plain === preview) {
    return (
      <ActivityRow icon={icon} title={title} wrap>
        {preview}
      </ActivityRow>
    );
  }
  return (
    <div>
      <ActivityRow icon={icon} open={open} onToggle={() => setOpen((o) => !o)} title={title}>
        {preview}
      </ActivityRow>
      {open && (
        <div className={`${STEP_INDENT} pt-1 pb-2`}>
          <Clamped
            text={plain.slice(plain.indexOf(preview) + preview.length).trim()}
            lines={40}
            className="text-[12px] leading-[1.6] text-muted-3"
          />
        </div>
      )}
    </div>
  );
}

export const AgentItem = memo(function AgentItem({ item }: { item: ItemOf<"agent"> }) {
  return (
    <Markdown noRemote className={PROSE}>
      {item.body.text}
    </Markdown>
  );
});

/** "Thought for 12s". Claude records most thinking with no text at all, only
 *  how long it took, so the row opens only when there is something to read. */
export const ReasoningItem = memo(function ReasoningItem({ item }: { item: ItemOf<"reasoning"> }) {
  const [open, setOpen] = useState(false);
  const { text, durationMs } = item.body;
  const label =
    durationMs === null
      ? "Thought"
      : durationMs < 1000
        ? "Thought briefly"
        : `Thought for ${durationLabel(durationMs)}`;
  const icon = <SparklesIcon size={12} />;
  if (!text.trim()) return <ActivityRow icon={icon}>{label}</ActivityRow>;
  return (
    <div>
      <ActivityRow icon={icon} open={open} onToggle={() => setOpen((o) => !o)}>
        {label}
      </ActivityRow>
      {open && (
        <div className={`${STEP_INDENT} pt-1 pb-2`}>
          <Markdown noRemote className="text-[12.5px] leading-[1.65] text-muted-3">
            {text}
          </Markdown>
        </div>
      )}
    </div>
  );
});

/** What each state of a queued message means for it. */
const QUEUE_STATE = {
  Pending: "Queued: Claude reads it when it's done",
  Delivered: "Queued, then delivered",
  Withdrawn: "Queued, then taken back into Claude's input",
} as const;

/** A message typed while Claude worked, where it was queued: drawn whole while
 *  it waits, and as one quiet line once it has left the queue — delivered (the
 *  prompt it became is drawn where it landed) or taken back into Claude's
 *  input (Up at its prompt recalls it to edit). */
export const QueuedItem = memo(function QueuedItem({ item }: { item: ItemOf<"queued"> }) {
  const { text, status } = item.body;
  if (status !== "Pending") {
    return (
      <div className="flex min-w-0 justify-end gap-2 text-[11.5px] text-muted-4">
        <span className="flex-none">{QUEUE_STATE[status]}</span>
        <span className="min-w-0 truncate text-muted-3">{firstLine(text)}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <div className={`${BUBBLE} border border-dashed border-line-3`}>
        <Clamped text={text} lines={8} className="text-[13.5px] leading-[1.6] text-fg-3" />
      </div>
      <span className="pr-1 text-[11px] text-muted-4">{QUEUE_STATE.Pending}</span>
    </div>
  );
});

/** A compaction, an interruption, a mode change: a quiet divider. An error is
 *  the one notice that is drawn as one. */
export const NoticeItem = memo(function NoticeItem({ item }: { item: ItemOf<"notice"> }) {
  const { tone, text } = item.body;
  if (tone === "Error") return <ErrorNote text={text} />;
  return (
    <div className="flex items-center gap-3 py-1 text-[11.5px] text-muted-4">
      <span aria-hidden className="h-px min-w-6 flex-1 bg-line" />
      <span className="selectable min-w-0 text-center">{text}</span>
      <span aria-hidden className="h-px min-w-6 flex-1 bg-line" />
    </div>
  );
});

/** An error, in the one red the page uses. */
export function ErrorNote({ text }: { text: string }) {
  const red = "var(--color-status-red)";
  return (
    <div
      role="note"
      className="flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-[12.5px] leading-[1.55]"
      style={{ borderColor: alpha(28, red), background: alpha(6, red), color: red }}
    >
      <WarningIcon size={13} className="mt-[3px] flex-none" />
      <span className="selectable min-w-0 break-words">{text}</span>
    </div>
  );
}
