import { ViewShell } from "../chrome";
import { type DemoTicket, TRIAGE_DETAIL, TRIAGE_QUEUE } from "../data";
import { AsciiSpinner, ClaudeSpark, PriorityPill } from "../widgets";

/** Triage: the Linear inbox — queue rail + ticket detail + Investigate. */

function QueueRow({ ticket }: { ticket: DemoTicket }) {
  const isActive = ticket.id === TRIAGE_DETAIL.id;
  return (
    <div
      className={`relative flex items-center gap-2 rounded-md px-2 py-1.5 ${
        isActive ? "bg-white/5" : ""
      } ${ticket.state === "snoozed" ? "opacity-50" : ""}`}
    >
      {/* Snoozed rows carry the amber inset stripe. */}
      {ticket.state === "snoozed" && (
        <span
          className="absolute inset-y-1 left-0 w-[2px] rounded-full bg-status-amber/70"
          aria-hidden
        />
      )}
      <span className="size-2.5 rounded-[3px] border border-line" />
      <PriorityPill priority={ticket.priority} />
      <span className="font-mono text-[9px] text-muted-4">{ticket.id}</span>
      <span className="truncate text-[10.5px] text-fg/90">{ticket.title}</span>
      <span className="ml-auto flex items-center gap-1.5">
        {ticket.state === "investigating" && (
          <span className="flex items-center gap-1 text-accent">
            <ClaudeSpark />
            <AsciiSpinner className="text-[9px]" />
          </span>
        )}
        <span className="font-mono text-[9px] tabular-nums text-muted-4">{ticket.age}</span>
      </span>
    </div>
  );
}

export function TriageView({ live: _live }: { live: boolean }) {
  return (
    <ViewShell
      sidebar={
        <>
          <div className="flex items-center gap-2 px-3 pb-2 pt-3">
            <span className="text-[11px] font-medium text-fg">Queue</span>
            {/* Mine/All segmented control */}
            <span className="ml-auto flex rounded-md border border-hairline p-px font-mono text-[9px]">
              <span className="rounded-[5px] bg-white/8 px-2 py-0.5 text-fg">Mine</span>
              <span className="px-2 py-0.5 text-muted-2">All</span>
            </span>
          </div>
          <div className="flex flex-col gap-0.5 px-1.5">
            {TRIAGE_QUEUE.map((t) => (
              <QueueRow key={t.id} ticket={t} />
            ))}
          </div>
        </>
      }
      main={
        <div className="flex min-h-0 flex-1 flex-col px-6 py-5">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-muted-2">{TRIAGE_DETAIL.id}</span>
            <PriorityPill priority={TRIAGE_DETAIL.priority} />
            <span
              className="rounded px-1 py-px font-mono text-[9px] uppercase tracking-wide text-status-blue"
              style={{ background: "color-mix(in srgb, currentcolor 12%, transparent)" }}
            >
              {TRIAGE_DETAIL.status}
            </span>
          </div>
          <h3 className="mt-2 text-[15px] font-medium text-fg">{TRIAGE_DETAIL.title}</h3>
          <div className="mt-3 flex max-w-[560px] flex-col gap-2 text-[11px] leading-relaxed text-muted">
            {TRIAGE_DETAIL.body.map((p) => (
              <p key={p.slice(0, 24)}>{p}</p>
            ))}
          </div>
          <div className="mt-auto flex items-center gap-2 pb-1">
            <span className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[11px] font-medium text-on-accent">
              <ClaudeSpark size={10} />
              Investigate
              <span className="text-on-accent/60">▾</span>
            </span>
            <span className="rounded-lg border border-hairline bg-white/3 px-3 py-1.5 text-[11px] text-muted">
              Snooze
            </span>
            <span className="rounded-lg border border-hairline bg-white/3 px-3 py-1.5 text-[11px] text-muted">
              Assign
            </span>
          </div>
        </div>
      }
    />
  );
}
