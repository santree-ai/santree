/**
 * One ticket in the cross-repo list. Presentational.
 *
 * The row is scanned, not read: key and title carry identity, everything else is
 * a state answer to "can I start this, or is something already on it?". Hue is
 * spent only on that state — hierarchy is opacity and muted tokens — so a page
 * of a hundred rows still resolves to the handful that want a decision.
 */
import { memo } from "react";

import { MarkdownTitle } from "../../components/Markdown";
import { PrChips } from "../../components/PrChip";
import { Dot, Pill } from "../../components/primitives";
import { EstimateBars, PriorityBars } from "../../components/WorkSignals";
import type { AttentionLevel } from "../../lib/attention";
import { palette, sessionStateMeta, statusColor, statusLabel } from "../../theme/colors";
import { isStartable, type TicketRow as Row } from "./useTickets";

/** 10px labels in 16px pills — the row's third tier, under title and key. */
const TAG_CLASS = "h-4 gap-1 px-[5px] font-mono text-[10px] leading-none";

/** What the live-agent chip speaks in: red asks for you, green is running, amber
 *  just finished, muted is at rest. Mirrors the Agents panel's bucket colors. */
const ATTENTION_COLOR: Record<AttentionLevel, string> = {
  "needs-you": sessionStateMeta.waiting.color,
  working: sessionStateMeta.active.color,
  done: sessionStateMeta.idle.color,
  idle: palette.muted,
};

/** The chip's second half: who is on it, or how many are. */
function agentLabelOf(row: Row): string | null {
  if (row.agents.length > 1) return `${row.agents.length} agents`;
  const kind = row.agents[0]?.agentKind ?? row.worktree?.agent;
  return kind ?? null;
}

export const TicketRow = memo(function TicketRow({
  row,
  onOpen,
  onStart,
}: {
  row: Row;
  /** Open the ticket: its worktree in Trees, or the ticket in the graph. */
  onOpen: (row: Row) => void;
  /** Start it in a new worktree; `background` is the ⌘-click path. */
  onStart: (row: Row, background: boolean) => void;
}) {
  const { task } = row;
  const startable = isStartable(row);
  const agent = agentLabelOf(row);

  return (
    // A row-wide hover surface holding two click targets: the row itself opens
    // the ticket, the trailing action starts it — so the action can't be a nested
    // button inside the row's own.
    <div className="selection-row group flex h-8 items-center rounded-md">
      <button
        type="button"
        onClick={() => onOpen(row)}
        title={`${task.id} · ${statusLabel[task.status]}`}
        className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md pl-2 text-left"
      >
        <span className="w-[52px] flex-none truncate font-mono text-[11px] text-muted-4">
          {task.id}
        </span>
        <Dot color={statusColor[task.status]} size={6} />
        <MarkdownTitle className="block min-w-0 flex-1 truncate text-[13px] text-fg-2">
          {task.title}
        </MarkdownTitle>
        {row.blockedBy && row.worktree === null && (
          <Pill color="var(--color-muted-3)" className={TAG_CLASS}>
            Blocked · {row.blockedBy}
          </Pill>
        )}
        {startable && (
          <Pill color="var(--color-status-green)" className={TAG_CLASS}>
            Ready
          </Pill>
        )}
        <PrChips prs={row.prs} interactive={false} />
        {row.worktree && (
          <Pill
            color={ATTENTION_COLOR[row.attention.level]}
            className={TAG_CLASS}
            title="Already being worked on — open it in Trees"
          >
            worktree{agent ? ` · ${agent}` : ""}
          </Pill>
        )}
        <span className="ml-auto flex flex-none items-center gap-2 pl-2">
          {task.priority !== "None" && <PriorityBars priority={task.priority} />}
          {task.estimate != null && task.estimate > 0 && <EstimateBars estimate={task.estimate} />}
        </span>
      </button>
      {/* The slot is always reserved: revealing the action on hover must not
          reflow the signals it sits next to. */}
      <span className="flex w-[54px] flex-none justify-end pr-1.5">
        {startable && (
          <button
            type="button"
            onClick={(e) => onStart(row, e.metaKey || e.ctrlKey)}
            title="Start in a new worktree (⌘-click to run in the background)"
            className="cursor-pointer rounded px-1.5 py-0.5 font-mono text-[10px] text-muted-2 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-hover hover:text-fg-2 focus-visible:opacity-100"
          >
            Start ▸
          </button>
        )}
      </span>
    </div>
  );
});
