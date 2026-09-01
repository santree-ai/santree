/**
 * A single row in the triage queue (left rail).
 *
 * The row speaks the **sidebar tree's** visual language, not a card language of
 * its own: `.tree-card` for the state fills (translucent hover, translucent
 * selected, no border, no accent spine), the density tokens for rhythm, and the
 * muted tiers for hierarchy — identifier line, title, context line. A rail that
 * is on screen all day with exactly one row lit reads better as *rows* than as a
 * column of outlined boxes, and it is the same read as the project tree three
 * hundred pixels to its left.
 *
 * Hue is spent only where it means something: an agent's live state (the dot),
 * a breached or nearly-breached SLA, a near or overdue date, the priority bars.
 * Everything structural — ids, project names, assignees, timestamps — is muted
 * ink. That is why the snoozed row's amber left stripe is gone: amber already
 * means "due soon" two lines below it, so a second amber meaning "parked until
 * later" was the same signal saying the opposite thing. Snoozed rows keep the
 * three signals that do not collide — dimmed, sunk into their own lane, and
 * labelled with their wake date.
 *
 * Memoized so re-renders of the queue (selection change, background refetch)
 * only re-render the row whose `active`/`selected`/`investigating` flips, not
 * every row. `onHover` warms the detail cache so the click feels instant.
 *
 * Like IssueRow, the row is a container with two click targets: the checkbox
 * queues the ticket for batch investigation, the card selects it. The checkbox
 * column is always present so rows align, and its filled state is the row's one
 * inverted patch — `--accent-fill` paired with `--on-accent`, never raw accent.
 */
import { type CSSProperties, memo } from "react";

import type { AgentKind, SessionState, TriageTicket } from "../../bindings";
import { AgentIcon, GripIcon } from "../../components/icons";
import { MarkdownTitle } from "../../components/Markdown";
import { Dot, ProjectGlyph } from "../../components/primitives";
import { RelativeTime } from "../../components/RelativeTime";
import {
  EstimateBars,
  IssueDueDate,
  PriorityBars,
  ProjectDueDate,
} from "../../components/WorkSignals";
import { formatSla, formatSnoozeLabel, useLiveNow } from "../../lib/relativeTime";
import { palette, sessionStateMeta } from "../../theme/colors";

/** One working day. Inside this the triage clock is worth a color; beyond it a
 *  countdown is reference, not news. */
const SLA_URGENT_MS = 24 * 60 * 60 * 1000;

/**
 * The triage clock, toned like {@link IssueDueDate}: red once breached, amber
 * inside the last day, plain muted ink otherwise. The unconditional red it used
 * to wear made "SLA in 4d" shout as loudly as "SLA breached", which is the
 * decorative-color habit the monochrome pass exists to remove.
 *
 * It reads `useLiveNow` itself rather than taking `now` from the row, so the
 * shared 30s tick re-renders this span and not every row in the queue.
 */
function SlaSignal({ breachMs }: { breachMs: number | null }) {
  const now = useLiveNow();
  const label = formatSla(breachMs, now);
  if (label == null || breachMs == null) return null;
  const left = breachMs - now;
  const color =
    left <= 0
      ? "var(--color-status-red)"
      : left <= SLA_URGENT_MS
        ? "var(--color-status-amber)"
        : "var(--color-muted-4)";
  return (
    <span
      className="flex-none font-mono text-[9px] tabular-nums"
      style={{ color }}
      title={left <= 0 ? "Triage SLA has been breached" : "Time left on the triage SLA"}
    >
      {label}
    </span>
  );
}

export const QueueRow = memo(function QueueRow({
  ticket,
  active,
  selectable,
  selected,
  investigating,
  agentKinds,
  agentStates,
  manual = false,
  manualDisabled = false,
  dragging = false,
  onManualDragStart,
  onManualDragOver,
  onManualDragEnd,
  onManualMove,
  onSelect,
  onToggleSelect,
  onHover,
}: {
  ticket: TriageTicket;
  active: boolean;
  /** Whether the row can join the batch-investigate selection. */
  selectable: boolean;
  selected: boolean;
  /** A live investigation session exists for this ticket. */
  investigating: boolean;
  /** Providers with a live or durable investigation on this ticket. */
  agentKinds: AgentKind[];
  /** Newest structured activity for each provider attached to this ticket. */
  agentStates: SessionState[];
  /** Manual-order controls are shown only for the sortable queue lane. */
  manual?: boolean;
  /** Manual order is visible but immutable on a read-only Linear connection. */
  manualDisabled?: boolean;
  dragging?: boolean;
  onManualDragStart?: (id: string) => void;
  onManualDragOver?: (id: string) => void;
  onManualDragEnd?: () => void;
  onManualMove?: (id: string, direction: -1 | 1) => void;
  onSelect: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onHover: (id: string) => void;
}) {
  const snoozeLabel =
    ticket.snoozedUntilMs != null ? formatSnoozeLabel(ticket.snoozedUntilMs) : null;
  const snoozed = snoozeLabel != null;
  // The one inverted patch on the row. `--accent-fill` / `--on-accent` are a
  // pair: the fill inverts per theme and the ink on it inverts with it.
  const boxStyle: CSSProperties = selected
    ? { background: "var(--accent-fill)", border: "1px solid var(--accent-fill)" }
    : { border: "1px solid var(--border-defined)" };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only warms a cache; both real actions are buttons inside.
    <div
      data-ticket-id={ticket.id}
      data-active={active}
      onMouseEnter={() => onHover(ticket.id)}
      onDragEnter={() => onManualDragOver?.(ticket.id)}
      onDragOver={(event) => {
        if (manual && !manualDisabled) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!manual || manualDisabled) return;
        event.preventDefault();
        onManualDragEnd?.();
      }}
      className="tree-card group flex w-full min-w-0 items-stretch"
      style={{ opacity: dragging ? 0.42 : snoozed ? 0.62 : 1 }}
    >
      {manual && (
        // A permanently reserved slot that only fades: revealing a control on
        // hover must never reflow the row under the pointer revealing it.
        <button
          type="button"
          draggable={!manualDisabled}
          disabled={manualDisabled}
          aria-label={`Reorder ${ticket.id}`}
          title={
            manualDisabled
              ? "Manual ordering requires Linear read-write access"
              : "Drag to reorder · Option + ↑/↓"
          }
          onDragStart={(event) => {
            if (manualDisabled) return;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", ticket.id);
            onManualDragStart?.(ticket.id);
          }}
          onDragEnd={() => onManualDragEnd?.()}
          onKeyDown={(event) => {
            if (!event.altKey || manualDisabled) return;
            if (event.key === "ArrowUp") {
              event.preventDefault();
              onManualMove?.(ticket.id, -1);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              onManualMove?.(ticket.id, 1);
            }
          }}
          className="flex w-4 flex-none cursor-grab items-start justify-center pt-(--density-standard) text-muted-4 opacity-0 transition-opacity hover:text-fg-2 focus-visible:opacity-100 active:cursor-grabbing disabled:cursor-not-allowed group-hover:opacity-100"
        >
          <GripIcon size={11} />
        </button>
      )}
      <button
        type="button"
        onClick={selectable ? () => onToggleSelect(ticket.id) : undefined}
        disabled={!selectable}
        aria-label={
          investigating
            ? "Investigation running"
            : selected
              ? "Remove from investigation selection"
              : "Add to investigation selection"
        }
        aria-pressed={selectable ? selected : undefined}
        className={`flex flex-none items-start pt-(--density-standard) pr-1 pl-1.5 ${
          selectable ? "cursor-pointer" : "cursor-default"
        }`}
      >
        <span
          className={`flex h-3.5 w-3.5 items-center justify-center rounded text-[9px] font-bold text-[color:var(--on-accent)] transition-colors ${
            selectable ? "" : "opacity-45"
          }`}
          style={boxStyle}
        >
          {selected ? "✓" : ""}
        </span>
      </button>
      <button
        type="button"
        onClick={() => onSelect(ticket.id)}
        className="min-w-0 flex-1 cursor-pointer overflow-hidden py-(--density-standard) pr-2 pl-1 text-left"
      >
        {/* Identity. Mono, tabular and muted, so the ids form a scannable column
            and the row's only bright thing stays the title under them. */}
        <div className="flex items-center gap-2 font-mono text-[10px] tabular-nums">
          <span className="flex-none text-muted-3">{ticket.id}</span>
          {ticket.priority !== "None" && <PriorityBars priority={ticket.priority} />}
          {ticket.estimate != null && ticket.estimate > 0 && (
            <EstimateBars estimate={ticket.estimate} />
          )}
          <span className="ml-auto flex-none text-muted-4">
            {snoozed ? snoozeLabel : <RelativeTime ms={ticket.createdAtMs} />}
          </span>
        </div>
        {/* The title carries the row, the way the worktree card's does: one step
            of weight and one step of value, brightening when it is the open one. */}
        <MarkdownTitle
          className={`mt-1 block line-clamp-2 text-[13px] leading-[1.35] font-medium ${
            active ? "text-fg" : "text-fg-2"
          }`}
        >
          {ticket.title}
        </MarkdownTitle>
        {/* Context, on one line instead of two stacked strips split by a
            hairline — a divider inside a row turns a list into a dashboard. */}
        <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-muted-4">
          {ticket.project && (
            // Shrinkable, not `flex-none`: in a 300px rail a long project name
            // must give way to the assignee beside it rather than shove it out.
            <span className="flex min-w-0 items-center gap-1">
              <ProjectGlyph
                color={ticket.projectColor ?? "var(--color-muted-4)"}
                icon={ticket.projectIcon}
                size={5}
              />
              <span className="min-w-0 truncate">{ticket.project}</span>
              <ProjectDueDate date={ticket.projectTargetDate} />
            </span>
          )}
          {ticket.project && ticket.meta && <span className="flex-none text-muted-5">·</span>}
          <span className="min-w-0 truncate">{ticket.meta}</span>
          <span className="ml-auto flex flex-none items-center gap-1.5">
            <IssueDueDate date={ticket.dueDate} />
            {!snoozed && <SlaSignal breachMs={ticket.slaBreachMs} />}
          </span>
        </div>
        {/* An agent gets its OWN line inside the card, exactly as it does in the
            project tree — dot for state, glyph for identity, muted words. The
            state color lives in the dot alone; a colored label would put hue on
            text that is only ever read after the dot has already answered. */}
        {agentKinds.length > 0 && (
          <div className="mt-1 flex min-h-4 items-center gap-2.5 text-[10.5px] text-muted-3">
            {agentKinds.map((agent) => {
              const state = agentStates.find((candidate) => candidate.agentKind === agent);
              const meta = state ? sessionStateMeta[state.state] : undefined;
              const color = meta?.color ?? (investigating ? palette.green : palette.muted);
              const label = meta?.short ?? (investigating ? "open" : "resume");
              return (
                <span
                  key={agent}
                  className="flex min-w-0 items-center gap-1.5"
                  title={meta?.label ?? (investigating ? "Session open" : "Resume session")}
                >
                  <Dot color={color} size={5} glow={meta?.glow} />
                  <AgentIcon kind={agent} size={10} className="flex-none text-muted-4" />
                  <span className="truncate">{label}</span>
                </span>
              );
            })}
          </div>
        )}
      </button>
    </div>
  );
});
