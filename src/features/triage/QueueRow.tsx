/** A single row in the triage queue (left rail). */
import { type CSSProperties, memo } from "react";

import type { AgentKind, SessionState, TriageTicket } from "../../bindings";
import { AgentIcon, GripIcon } from "../../components/icons";
import { MarkdownTitle } from "../../components/Markdown";
import { Dot, ProjectGlyph } from "../../components/primitives";
import { RelativeTime, SlaCountdown } from "../../components/RelativeTime";
import {
  EstimateBars,
  IssueDueDate,
  PriorityBars,
  ProjectDueDate,
} from "../../components/WorkSignals";
import { formatSnoozeLabel } from "../../lib/relativeTime";
import { palette, sessionStateMeta } from "../../theme/colors";

/**
 * Memoized so re-renders of the queue (selection change, background refetch)
 * only re-render the row whose `active`/`selected`/`investigating` flips, not
 * every row. `onHover` warms the detail cache so the click feels instant.
 *
 * Like IssueRow, the row is a container with two click targets: the checkbox
 * queues the ticket for batch investigation, the card selects it. The checkbox
 * column is always present so rows align. Provider activity belongs in the
 * metadata ledger, leaving selection and session state as separate signals.
 */
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
  const boxStyle: CSSProperties = selected
    ? { background: "var(--accent-fill)", border: "1px solid var(--accent-fill)" }
    : { border: "1px solid var(--color-line-strong)" };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only warms a cache; both real actions are buttons inside.
    <div
      data-ticket-id={ticket.id}
      data-active={active}
      data-queued={selected}
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
      className="entity-card mb-[5px] flex w-full min-w-0 items-stretch overflow-hidden transition-colors"
      style={{
        opacity: dragging ? 0.42 : snoozed ? 0.62 : 1,
        // Snoozed rows are dimmed and sunk to the bottom, but dimming alone is
        // easy to miss — an amber left stripe marks the "parked until later"
        // rows at a glance. Sits under the active/selected border, not fighting it.
        boxShadow: snoozed && !active ? "inset 3px 0 0 var(--color-status-amber)" : undefined,
      }}
    >
      {manual && (
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
          className="flex w-5 flex-none cursor-grab items-center justify-center text-muted-5 hover:text-muted-2 active:cursor-grabbing disabled:cursor-not-allowed"
        >
          <GripIcon size={12} />
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
        className={`flex flex-none items-start rounded-l-[9px] py-[13px] pr-0.5 pl-2 ${
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
        className="min-w-0 flex-1 cursor-pointer overflow-hidden rounded-r-[9px] py-[11px] pr-[11px] pl-1 text-left"
      >
        <div className="mb-1.5 flex items-center gap-2">
          <span className="flex-none font-mono text-[10.5px] text-muted-2">{ticket.id}</span>
          {ticket.priority !== "None" && <PriorityBars priority={ticket.priority} />}
          {ticket.estimate != null && ticket.estimate > 0 && (
            <EstimateBars estimate={ticket.estimate} />
          )}
          {snoozed ? (
            <span className="ml-auto flex flex-none items-center gap-1 font-mono text-[10px] text-muted-4">
              {snoozeLabel}
            </span>
          ) : (
            <RelativeTime
              ms={ticket.createdAtMs}
              className="ml-auto flex-none font-mono text-[10px] text-muted-4"
            />
          )}
        </div>
        <MarkdownTitle className="block line-clamp-2 text-[12.5px] leading-[1.35] text-fg-3">
          {ticket.title}
        </MarkdownTitle>
        <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-muted-4">
          <span className="min-w-0 truncate">{ticket.meta}</span>
          <IssueDueDate date={ticket.dueDate} />
          {!snoozed && (
            <SlaCountdown
              breachMs={ticket.slaBreachMs}
              className="ml-auto flex-none font-mono text-status-red/80"
            />
          )}
        </div>
        {(ticket.project || agentKinds.length > 0) && (
          <div className="mt-1.5 flex min-w-0 items-center gap-1.5 border-t border-hairline pt-1.5 font-mono text-[9.5px] text-muted-4">
            {ticket.project && (
              <>
                <ProjectGlyph
                  color={ticket.projectColor ?? "var(--color-muted-4)"}
                  icon={ticket.projectIcon}
                  size={5}
                />
                <span className="min-w-0 truncate">{ticket.project}</span>
                <ProjectDueDate date={ticket.projectTargetDate} />
              </>
            )}
            {agentKinds.length > 0 && (
              <span className="ml-auto flex flex-none items-center gap-2">
                {agentKinds.map((agent) => {
                  const state = agentStates.find((candidate) => candidate.agentKind === agent);
                  const meta = state ? sessionStateMeta[state.state] : undefined;
                  const color = meta?.color ?? (investigating ? palette.green : palette.muted);
                  const label = meta?.short ?? (investigating ? "open" : "resume");
                  return (
                    <span
                      key={agent}
                      className="flex items-center gap-1"
                      title={meta?.label ?? (investigating ? "Session open" : "Resume session")}
                    >
                      <AgentIcon kind={agent} size={10} />
                      <Dot color={color} size={4} glow={meta?.glow} />
                      <span style={{ color }}>{label}</span>
                    </span>
                  );
                })}
              </span>
            )}
          </div>
        )}
      </button>
    </div>
  );
});
