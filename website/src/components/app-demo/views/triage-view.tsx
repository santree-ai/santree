import { ViewShell } from "../chrome";
import { type DemoTicket, TRIAGE_DETAIL, TRIAGE_QUEUE } from "../data";
import {
  AsciiSpinner,
  ClaudeSpark,
  InitialsAvatar,
  LinearMark,
  PriorityPill,
  RefreshGlyph,
  SelectBox,
} from "../widgets";

/** Triage: the Linear inbox — queue rail + issue detail, shaped like the real
 * QueueRow (checkbox column, id + priority + age, two-line title, meta + SLA)
 * and IssueHeader (actions at the top right, not the bottom). */

function QueueRow({ ticket, live }: { ticket: DemoTicket; live: boolean }) {
  const isActive = ticket.id === TRIAGE_DETAIL.id;
  const snoozed = ticket.state === "snoozed";
  const investigating = ticket.state === "investigating";
  return (
    <div
      className="flex items-stretch overflow-hidden rounded-[9px]"
      style={{
        border: `1px solid ${isActive ? "color-mix(in srgb, var(--color-accent) 33%, transparent)" : "transparent"}`,
        background: isActive
          ? "color-mix(in srgb, var(--color-accent) 5%, transparent)"
          : "transparent",
        opacity: snoozed ? 0.62 : 1,
        // The amber inset stripe marking a "parked until later" row.
        boxShadow: snoozed ? "inset 3px 0 0 var(--color-status-amber)" : undefined,
      }}
    >
      {/* Checkbox column: a live investigation shows the spark here instead. */}
      <span className="flex shrink-0 items-start py-[13px] pl-2 pr-0.5">
        {investigating ? (
          <span className="flex items-center gap-1 text-accent">
            <ClaudeSpark size={12} />
            {live && <AsciiSpinner className="text-[9px]" />}
          </span>
        ) : (
          <SelectBox faint={snoozed} />
        )}
      </span>
      <div className="min-w-0 flex-1 py-[11px] pl-1 pr-[11px]">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="shrink-0 font-mono text-[10.5px] text-muted-2">{ticket.id}</span>
          <PriorityPill priority={ticket.priority} muted={snoozed} />
          <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-4">
            {snoozed ? `💤 ${ticket.age}` : ticket.age}
          </span>
        </div>
        <div className="truncate text-[12.5px] leading-[1.35] text-fg/85">{ticket.title}</div>
        <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-muted-4">
          <span className="min-w-0 truncate">{ticket.meta}</span>
          {ticket.sla && !snoozed && (
            <span className="ml-auto shrink-0 font-mono text-status-red/80">{ticket.sla}</span>
          )}
        </div>
      </div>
    </div>
  );
}

export function TriageView({ live }: { live: boolean }) {
  return (
    <ViewShell
      sidebar={
        <>
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hairline px-3">
            <span className="text-[12px] font-semibold text-fg/90">Queue</span>
            {/* Mine/All segmented control */}
            <span className="ml-auto flex rounded-md border border-hairline p-px font-mono text-[9px]">
              <span className="rounded-[5px] bg-white/8 px-2 py-0.5 text-fg">Mine</span>
              <span className="px-2 py-0.5 text-muted-2">All</span>
            </span>
          </div>
          <div className="flex min-h-0 flex-col gap-[5px] overflow-hidden p-2">
            {TRIAGE_QUEUE.map((t) => (
              <QueueRow key={t.id} ticket={t} live={live} />
            ))}
          </div>
        </>
      }
      main={
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Issue header: id + priority + status + SLA, actions on the right. */}
          <div className="shrink-0 border-b border-hairline px-5 pb-3.5 pt-4">
            <div className="mb-2 flex items-center gap-2.5">
              <span className="font-mono text-[11.5px] text-muted-2">{TRIAGE_DETAIL.id}</span>
              <PriorityPill priority={TRIAGE_DETAIL.priority} />
              <span
                className="flex items-center gap-1 rounded px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-status-blue"
                style={{ background: "color-mix(in srgb, currentcolor 12%, transparent)" }}
              >
                {TRIAGE_DETAIL.status} ▾
              </span>
              <span className="font-mono text-[10.5px] text-status-red/90">
                {TRIAGE_DETAIL.sla}
              </span>
              <span className="ml-auto flex items-center gap-2">
                <span className="flex size-[27px] items-center justify-center rounded-md border border-line-2 bg-white/3 text-muted-2">
                  <RefreshGlyph size={13} />
                </span>
                <span className="flex items-center gap-1.5 rounded-lg border border-line-2 bg-white/3 px-2.5 py-1.5 text-[11px] font-medium text-muted">
                  <LinearMark size={12} className="text-[#5e6ad2]" />
                  Open Issue
                </span>
                <span
                  className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-accent"
                  style={{
                    background: "color-mix(in srgb, var(--color-accent) 11%, transparent)",
                    border: "1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)",
                  }}
                >
                  <ClaudeSpark size={11} />
                  Investigate
                </span>
              </span>
            </div>
            <h3 className="mb-2 text-[17px] font-semibold leading-[1.3] text-fg">
              {TRIAGE_DETAIL.title}
            </h3>
            <div className="flex items-center gap-2.5 text-[11px] text-muted-2">
              <span className="flex items-center gap-1.5">
                <InitialsAvatar initials={TRIAGE_DETAIL.authorInitials} />
                {TRIAGE_DETAIL.author}
              </span>
              <span className="text-muted-4">·</span>
              <span>{TRIAGE_DETAIL.created}</span>
              <span className="text-muted-4">·</span>
              <span>{TRIAGE_DETAIL.project}</span>
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-2.5 px-5 py-4">
            <div className="flex max-w-[560px] flex-col gap-2 text-[12px] leading-relaxed text-muted">
              {TRIAGE_DETAIL.body.map((p) => (
                <p key={p.slice(0, 24)}>{p}</p>
              ))}
            </div>
          </div>
        </div>
      }
    />
  );
}
