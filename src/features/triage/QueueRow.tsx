/** A single row in the triage queue (left rail). */
import { type CSSProperties, memo } from "react";

import type { AgentKind, TriageTicket } from "../../bindings";
import { AgentIcon } from "../../components/icons";
import { RelativeTime, SlaCountdown } from "../../components/RelativeTime";
import { formatSnoozeLabel } from "../../lib/relativeTime";
import { alpha } from "../../theme/colors";
import { PriorityPill } from "./PriorityPill";

/**
 * Memoized so re-renders of the queue (selection change, background refetch)
 * only re-render the row whose `active`/`selected`/`investigating` flips, not
 * every row. `onHover` warms the detail cache so the click feels instant.
 *
 * Like IssueRow, the row is a container with two click targets: the checkbox
 * queues the ticket for batch investigation, the card selects it. The checkbox
 * column is always present so rows align; a row whose investigation is already
 * live shows its provider icon there instead, and a snoozed row a disabled box.
 */
export const QueueRow = memo(function QueueRow({
  ticket,
  active,
  selectable,
  selected,
  investigating,
  started,
  agentKinds,
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
  /** A past investigation left a stored (resumable) session — not live now. */
  started: boolean;
  /** Providers with a live or durable investigation on this ticket. */
  agentKinds: AgentKind[];
  onSelect: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onHover: (id: string) => void;
}) {
  const snoozeLabel =
    ticket.snoozedUntilMs != null ? formatSnoozeLabel(ticket.snoozedUntilMs) : null;
  const snoozed = snoozeLabel != null;
  const style: CSSProperties = active
    ? {
        border: `1px solid ${alpha(33)}`,
        background: alpha(5),
      }
    : { border: "1px solid transparent", background: "transparent" };
  const boxStyle: CSSProperties = selected
    ? { background: "var(--accent-fill)", border: "1px solid var(--accent-fill)" }
    : { border: "1px solid var(--color-line-strong)" };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only warms a cache; both real actions are buttons inside.
    <div
      data-ticket-id={ticket.id}
      onMouseEnter={() => onHover(ticket.id)}
      className="mb-[5px] flex w-full min-w-0 items-stretch overflow-hidden rounded-[9px] transition-colors hover:bg-hover"
      style={{
        ...style,
        opacity: snoozed ? 0.62 : 1,
        // Snoozed rows are dimmed and sunk to the bottom, but dimming alone is
        // easy to miss — an amber left stripe marks the "parked until later"
        // rows at a glance. Sits under the active/selected border, not fighting it.
        boxShadow: snoozed ? "inset 3px 0 0 var(--color-status-amber)" : undefined,
      }}
    >
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
        {investigating ? (
          <span className="flex items-center -space-x-1">
            {agentKinds.map((agent) => (
              <AgentIcon key={agent} kind={agent} size={12} />
            ))}
          </span>
        ) : (
          <span
            className={`flex h-3.5 w-3.5 items-center justify-center rounded text-[9px] font-bold text-[color:var(--on-accent)] transition-colors ${
              selectable ? "" : "opacity-45"
            }`}
            style={boxStyle}
          >
            {selected ? "✓" : ""}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={() => onSelect(ticket.id)}
        className="min-w-0 flex-1 cursor-pointer overflow-hidden rounded-r-[9px] py-[11px] pr-[11px] pl-1 text-left"
      >
        <div className="mb-1.5 flex items-center gap-2">
          <span className="flex-none font-mono text-[10.5px] text-muted-2">{ticket.id}</span>
          {/* A past (not-live) investigation is resumable — mark it with a faint
              provider icon; the checkbox stays so it can still be batch-resumed.
              A live one already shows the icon in the checkbox column. */}
          {started && !investigating && (
            <span
              title="Investigation started; resumable"
              className="flex flex-none items-center opacity-60"
            >
              <span className="flex items-center -space-x-1">
                {agentKinds.map((agent) => (
                  <AgentIcon key={agent} kind={agent} size={11} />
                ))}
              </span>
            </span>
          )}
          <PriorityPill priority={ticket.priority} muted={snoozed} />
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
        <div
          className="line-clamp-2 text-[12.5px] leading-[1.35] text-fg-3"
          style={{ overflowWrap: "anywhere" }}
        >
          {ticket.title}
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-muted-4">
          <span className="min-w-0 truncate">{ticket.meta}</span>
          {!snoozed && (
            <SlaCountdown
              breachMs={ticket.slaBreachMs}
              className="ml-auto flex-none font-mono text-status-red/80"
            />
          )}
        </div>
      </button>
    </div>
  );
});
