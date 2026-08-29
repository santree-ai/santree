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
import { Dot, Dropdown, Pill } from "../../components/primitives";
import { attentionMeta } from "../../components/shell/AttentionDot";
import { EstimateBars, PriorityBars } from "../../components/WorkSignals";
import { shortRepoName } from "../../lib/repoName";
import { statusColor, statusLabel } from "../../theme/colors";
import { isStartable, type TicketRow as Row } from "./useTickets";

/** 10px labels in 16px pills — the row's third tier, under title and key. */
const TAG_CLASS = "h-4 gap-1 px-[5px] font-mono text-[10px] leading-none";

/** The chip's second half: who is on it, or how many are. */
function agentLabelOf(row: Row): string | null {
  if (row.agents.length > 1) return `${row.agents.length} agents`;
  const kind = row.agents[0]?.agentKind ?? row.worktree?.agent;
  return kind ?? null;
}

/** What the started-work chip says: "worktree", where it lives when that isn't
 *  obvious (the ticket could have been started in more than one repo), and who
 *  is on it. */
function worktreeLabelOf(row: Row): string {
  const parts = ["worktree"];
  if (row.repos.length > 1) parts.push(shortRepoName(row.repo));
  const agent = agentLabelOf(row);
  if (agent) parts.push(agent);
  return parts.join(" · ");
}

const START_CLASS =
  "cursor-pointer rounded px-1.5 py-0.5 font-mono text-[10px] text-muted-2 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-hover hover:text-fg-2 focus-visible:opacity-100";

/** The trailing action. A ticket that only one repo can run starts on click; one
 *  that several repos carry asks which — the repo is the one thing a ticket
 *  doesn't know about itself. ⌘-click (on the item, for the menu) runs it in the
 *  background either way. */
function StartAction({
  row,
  onStart,
}: {
  row: Row;
  onStart: (row: Row, background: boolean, repo: string) => void;
}) {
  if (row.repos.length === 1) {
    return (
      <button
        type="button"
        onClick={(e) => onStart(row, e.metaKey || e.ctrlKey, row.repo)}
        title="Start in a new worktree (⌘-click to run in the background)"
        className={START_CLASS}
      >
        Start ▸
      </button>
    );
  }
  return (
    <Dropdown
      align="right"
      trigger={(toggle) => (
        <button
          type="button"
          onClick={toggle}
          title="Start in a new worktree — pick the repo (⌘-click a repo to run in the background)"
          className={START_CLASS}
        >
          Start ▸
        </button>
      )}
    >
      {(close) =>
        row.repos.map((repo) => (
          <button
            key={repo}
            type="button"
            role="menuitem"
            onClick={(e) => {
              close();
              onStart(row, e.metaKey || e.ctrlKey, repo);
            }}
            title={repo}
            className="flex h-7 w-full cursor-pointer items-center rounded px-2 text-left text-[12px] whitespace-nowrap text-fg-2 hover:bg-hover"
          >
            {shortRepoName(repo)}
          </button>
        ))
      }
    </Dropdown>
  );
}

export const TicketRow = memo(function TicketRow({
  row,
  active = false,
  onOpen,
  onStart,
}: {
  row: Row;
  /** This is the ticket the inspector is showing. */
  active?: boolean;
  /** Open the ticket in the inspector. */
  onOpen: (row: Row) => void;
  /** Start it in a new worktree in `repo`; `background` is the ⌘-click path. */
  onStart: (row: Row, background: boolean, repo: string) => void;
}) {
  const { task } = row;
  const startable = isStartable(row);

  return (
    // A row-wide hover surface holding two click targets: the row itself opens
    // the ticket, the trailing action starts it — so the action can't be a nested
    // button inside the row's own.
    <div className="selection-row group flex h-8 items-center rounded-md" data-active={active}>
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
            // The sidebar's dot and this chip answer the same question, so they
            // read from the one attention vocabulary rather than each picking a
            // hue for "done".
            color={attentionMeta[row.attention.level].color}
            className={TAG_CLASS}
            title="Already being worked on — open it in Trees"
          >
            {worktreeLabelOf(row)}
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
        {startable && <StartAction row={row} onStart={onStart} />}
      </span>
    </div>
  );
});
