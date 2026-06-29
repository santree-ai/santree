/** A single row in the triage queue (left rail). */
import { type CSSProperties, memo } from "react";

import type { TriageTicket } from "../../bindings";
import { alpha } from "../../theme/colors";
import { PriorityPill } from "./PriorityPill";

/**
 * Memoized so re-renders of the queue (selection change, background refetch)
 * only re-render the row whose `active` flips, not every row. `onHover` warms
 * the detail cache so the click feels instant.
 */
export const QueueRow = memo(function QueueRow({
  ticket,
  active,
  onSelect,
  onHover,
}: {
  ticket: TriageTicket;
  active: boolean;
  onSelect: (id: string) => void;
  onHover: (id: string) => void;
}) {
  const snoozed = !!ticket.snoozedUntil;
  const style: CSSProperties = active
    ? {
        border: `1px solid ${alpha(33)}`,
        background: alpha(5),
      }
    : { border: "1px solid transparent", background: "transparent" };

  return (
    <button
      type="button"
      data-ticket-id={ticket.id}
      onClick={() => onSelect(ticket.id)}
      onMouseEnter={() => onHover(ticket.id)}
      className="mb-[5px] w-full min-w-0 cursor-pointer overflow-hidden rounded-[9px] px-[11px] py-[11px] text-left transition-colors hover:bg-hover"
      style={{ ...style, opacity: snoozed ? 0.55 : 1 }}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className="flex-none font-mono text-[10.5px] text-muted-2">{ticket.id}</span>
        <PriorityPill priority={ticket.priority} muted={snoozed} />
        {snoozed ? (
          <span className="ml-auto flex flex-none items-center gap-1 font-mono text-[10px] text-muted-4">
            💤 {ticket.snoozedUntil}
          </span>
        ) : (
          <span className="ml-auto flex-none font-mono text-[10px] text-muted-4">{ticket.age}</span>
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
        {ticket.sla && !snoozed && (
          <span className="ml-auto flex-none font-mono text-status-red/80">{ticket.sla}</span>
        )}
      </div>
    </button>
  );
});
