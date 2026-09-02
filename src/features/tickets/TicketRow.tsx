/**
 * One ticket in the cross-repo list. Presentational.
 *
 * The row is scanned, not read: key and title carry identity, everything else is
 * a state answer to "can I start this, or is something already on it?". Hue is
 * spent only on that state — hierarchy is opacity and muted tokens — so a page
 * of a hundred rows still resolves to the handful that want a decision.
 *
 * Its columns, left to right, in Linear's own order: the priority mark (three
 * dashes when there is none, so the keys line up); the key, hanging from its
 * heading's label (the list hands it `indent`); the state ring; the title,
 * which is what gives; the state answer — a PR chip, the worktree already on
 * it, the blocker, or the green pill; and the planning signals Linear's list
 * ends a row with, when the ticket carries them — its cycle, its estimate, its
 * due date, and whose it is. Whatever comes last sits flush
 * with the right edge every heading's due date reaches: nothing at the
 * trailing edge is reserved, for hover or for a signal that isn't there — the
 * one action a row offers *is* its state pill.
 *
 * A right-click is the rest: the pill's and the mark's actions spelled out, the
 * background run the pill hides behind ⌘, the way to pick the project for one
 * run of a ticket several carry, the worktree already on a started ticket (its
 * chip names it but can't open it), and the ticket's own address.
 *
 * Which project a start runs in is not the row's question. The list answers it
 * once — the one project that carries the ticket, the Work default, or a
 * dialog — and answers it the same way for the queue (`useWorkRepoGate`).
 */
import { memo } from "react";
import { Avatar } from "../../components/Avatar";
import { BranchIcon, CheckIcon, PlayIcon, QueueIcon } from "../../components/icons";
import { MarkdownTitle } from "../../components/Markdown";
import { linearTicketItems } from "../../components/menuRows";
import { PrChips } from "../../components/PrChip";
import { ContextMenu, type ContextMenuItem, Pill } from "../../components/primitives";
import { attentionMeta } from "../../components/shell/AttentionDot";
import {
  CycleTag,
  EstimateTag,
  IssueDueDate,
  PriorityBars,
  StatusGlyph,
} from "../../components/WorkSignals";
import { useLinearIssueUrl } from "../../lib/queries";
import { shortRepoName } from "../../lib/repoName";
import { statusLabel } from "../../theme/colors";
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

/** The green pill's two faces: "Ready" at rest, "Start" once the row is hovered
 *  or reached by keyboard. Both words are five characters of the same mono
 *  face, so the swap moves nothing. */
const START_LABEL = (
  <>
    <span className="group-hover:hidden group-has-[:focus-visible]:hidden">Ready</span>
    <span className="hidden group-hover:inline group-has-[:focus-visible]:inline">Start</span>
  </>
);

/** The accessible name stays put while the visible word changes. */
const START_NAME = "Ready — start in a new worktree";

/** Start the ticket. `background` is the ⌘-click path; `pick` asks which
 *  project regardless of the default — the menu's "Run in another project…". */
export type OnStart = (row: Row, opts: { background: boolean; pick?: boolean }) => void;

/** The row's one action, and its "Ready" state in the same pill: a ticket that
 *  can be started says so, and the saying is the button. It used to be a second
 *  control in a slot held open at the trailing edge, which every other row wore
 *  as a gap. It used to ask which project, too, when several carried the ticket
 *  — a dropdown under the pill, on every click; that answer is the list's now,
 *  given once. ⌘-click runs it in the background. `relative` lifts the pill
 *  above the row's stretched open button. */
function StartAction({ row, onStart }: { row: Row; onStart: OnStart }) {
  return (
    <Pill
      color="var(--color-status-green)"
      className={`relative ${TAG_CLASS}`}
      aria-label={START_NAME}
      title="Start in a new worktree (⌘-click to run in the background)"
      onClick={(e) => onStart(row, { background: e.metaKey || e.ctrlKey })}
    >
      {START_LABEL}
    </Pill>
  );
}

/** The row's right-click menu. Same words as the graph's ("Run", the way the
 *  inspector's button says it), the background run, and — on a ticket several
 *  projects carry — the way past the default for this one run. */
function menuFor(
  row: Row,
  url: string | null,
  opts: {
    queued: boolean;
    onStart: OnStart;
    onToggleQueue?: (row: Row) => void;
    onOpenWorktree?: (row: Row) => void;
  },
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (isStartable(row)) {
    items.push(
      {
        kind: "action",
        key: "run",
        label: "Run",
        icon: <PlayIcon size={12} />,
        run: () => opts.onStart(row, { background: false }),
      },
      {
        kind: "action",
        key: "run-bg",
        label: "Run in the background",
        icon: <PlayIcon size={12} />,
        run: () => opts.onStart(row, { background: true }),
      },
    );
    if (row.repos.length > 1) {
      items.push({
        kind: "action",
        key: "run-pick",
        label: "Run in another project…",
        icon: <BranchIcon size={12} />,
        run: () => opts.onStart(row, { background: false, pick: true }),
      });
    }
  }
  const { onToggleQueue, onOpenWorktree } = opts;
  if (onToggleQueue) {
    items.push({
      kind: "action",
      key: "queue",
      label: opts.queued ? "Remove from queue" : "Add to queue",
      icon: <QueueIcon size={13} />,
      run: () => onToggleQueue(row),
    });
  }
  if (row.worktree && onOpenWorktree) {
    items.push({
      kind: "action",
      key: "worktree",
      label: "Open worktree",
      icon: <BranchIcon size={12} />,
      run: () => onOpenWorktree(row),
    });
  }
  if (items.length > 0) items.push({ kind: "rule", key: "rule-linear" });
  items.push(...linearTicketItems(row.task.id, url));
  return items;
}

export const TicketRow = memo(function TicketRow({
  row,
  indent,
  active = false,
  queued = false,
  onOpen,
  onStart,
  onToggleQueue,
  onOpenWorktree,
}: {
  row: Row;
  /** Where the key starts: the label column of the heading the row hangs under. */
  indent: number;
  /** This is the ticket the inspector is showing. */
  active?: boolean;
  /** The ticket is in the launch queue. */
  queued?: boolean;
  /** Open the ticket in the inspector. */
  onOpen: (row: Row) => void;
  /** Start it in a new worktree — where is the list's call (see {@link OnStart}). */
  onStart: OnStart;
  /** Put the ticket in the launch queue, or take it out. Absent when it can't
   *  be queued — it isn't the active repo's, or it isn't launchable — and the
   *  row then offers no mark. */
  onToggleQueue?: (row: Row) => void;
  /** Open the worktree already on the ticket, in Trees (the menu's row). */
  onOpenWorktree?: (row: Row) => void;
}) {
  const { task } = row;
  const startable = isStartable(row);
  const linkFor = useLinearIssueUrl(row.repo);
  const menu = menuFor(row, linkFor(task.id), { queued, onStart, onToggleQueue, onOpenWorktree });

  return (
    // `contents`: the menu's wrapper takes no box of its own, so the row stays
    // the list's child and lays out exactly as it did without a menu.
    <ContextMenu items={menu} className="contents">
      {/* The row's words can't live inside its open button, because the start
          pill is a button too and ARIA makes a button's children presentational
          — so the open control is a *stretched* button underneath, and the pill
          sits above it (the shape the sidebar's cards take). `tree-row`, not
          `selection-row`: this list is on screen all day with exactly one row
          lit, and the accent spine the latter draws down a rounded row's edge
          read as a black smear. */}
      <div
        className="tree-row group relative flex h-8 items-center gap-2 pr-2"
        style={{ paddingLeft: indent }}
        data-active={active}
      >
        <button
          type="button"
          // ⌘-click queues instead of opening — the graph's gesture for the same
          // thing, and quicker than the mark for a run of rows.
          onClick={(e) =>
            onToggleQueue && (e.metaKey || e.ctrlKey) ? onToggleQueue(row) : onOpen(row)
          }
          aria-label={`Open ${task.id}: ${task.title}`}
          title={`${task.id} · ${statusLabel[task.status]}${onToggleQueue ? "\n⌘-click to queue" : ""}`}
          className="absolute inset-0 cursor-pointer rounded-md"
        />
        {/* The queue mark, in the gutter the indent leaves before the key — the
          filled checkbox is how the graph's nodes carry membership too. Shown
          on hover, and always while the ticket is in. Positioned, so it sits
          above the stretched open button. */}
        {onToggleQueue && (
          // biome-ignore lint/a11y/useSemanticElements: a styled checkbox in a row's gutter, not a form field.
          <button
            type="button"
            role="checkbox"
            aria-checked={queued}
            aria-label={
              queued
                ? `Remove ${task.id} from the launch queue`
                : `Add ${task.id} to the launch queue`
            }
            onClick={() => onToggleQueue(row)}
            className={`absolute top-1/2 flex h-3.5 w-3.5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-[3px] border transition-[opacity,background-color,border-color] focus-visible:opacity-100 group-hover:opacity-100 ${
              queued
                ? "border-transparent bg-accent-fill opacity-100"
                : "border-line-strong bg-input opacity-0 hover:border-fg-2"
            }`}
            style={{ left: indent - 22, color: "var(--on-accent)" }}
          >
            {queued && <CheckIcon size={9} />}
          </button>
        )}
        <span className="flex w-4 flex-none justify-center">
          <PriorityBars priority={task.priority} showNone />
        </span>
        {/* Wide enough for an eight-character key (MSG-5488): the column used to
          be 52px, which is where those truncated to "MSG-54…". */}
        <span className="w-14 flex-none truncate font-mono text-[11px] text-muted-4">
          {task.id}
        </span>
        <StatusGlyph status={task.status} size={12} />
        <MarkdownTitle className="block min-w-0 flex-1 truncate text-[13px] text-fg-2">
          {task.title}
        </MarkdownTitle>
        {row.blockedBy && row.worktree === null && (
          <Pill color="var(--color-muted-3)" className={TAG_CLASS}>
            Blocked · {row.blockedBy}
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
        {startable && <StartAction row={row} onStart={onStart} />}
        {/* Gone when empty: a row with neither bar ends on its state chip, flush
          with the edge, rather than a column's width short of it — which, under
          a milestone where nothing carried a priority, read as the whole block
          sitting a step in from the rest of the list. */}
        <span className="flex flex-none items-center gap-2.5 empty:hidden">
          {task.cycle && <CycleTag cycle={task.cycle} />}
          {task.estimate != null && task.estimate > 0 && <EstimateTag estimate={task.estimate} />}
          <IssueDueDate date={task.dueDate} />
          {/* Whose it is, on every row that has an owner — yours included. It
              used to show only on someone else's, which made the face read as
              "not you" rather than as the assignee, and left most rows without
              one. */}
          {task.assignee && <Avatar name={task.assignee} src={task.assigneeAvatarUrl} size={14} />}
        </span>
      </div>
    </ContextMenu>
  );
});
