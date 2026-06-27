/**
 * The issue detail header: id + priority + status picker + the Refresh / Open /
 * Investigate actions, plus the title and author/labels meta row. Renders
 * instantly from the queue row; the richer fields fill in once the detail loads.
 */
import { openUrl } from "@tauri-apps/plugin-opener";

import type { TriageDetail, TriageTicket } from "../../bindings";
import { Avatar } from "../../components/Avatar";
import { LinearLogo, RefreshIcon } from "../../components/icons";
import { Skeleton } from "../../components/primitives";
import { priorityColor } from "../../theme/colors";
import { StatusPicker } from "./StatusPicker";

/** The AI "spark" glyph for the Investigate button — a big 4-point star + a small one. */
function InvestigateIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2.2c.3 2.6 1 4.5 2.2 5.6 1.1 1.2 3 1.9 5.6 2.2-2.6.3-4.5 1-5.6 2.2-1.2 1.1-1.9 3-2.2 5.6-.3-2.6-1-4.5-2.2-5.6-1.1-1.2-3-1.9-5.6-2.2 2.6-.3 4.5-1 5.6-2.2 1.2-1.1 1.9-3 2.2-5.6Z" />
      <path d="M18.5 14.5c.15 1.3.5 2.25 1.1 2.8.55.6 1.5.95 2.8 1.1-1.3.15-2.25.5-2.8 1.1-.6.55-.95 1.5-1.1 2.8-.15-1.3-.5-2.25-1.1-2.8-.55-.6-1.5-.95-2.8-1.1 1.3-.15 2.25-.5 2.8-1.1.6-.55.95-1.5 1.1-2.8Z" />
    </svg>
  );
}

export function IssueHeader({
  ticket,
  detail,
  onSetState,
  investigating,
  onInvestigate,
  onRefresh,
  refreshing,
}: {
  ticket: TriageTicket;
  detail?: TriageDetail;
  onSetState: (stateId: string) => void;
  investigating: boolean;
  onInvestigate: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const pc = priorityColor[ticket.priority];
  return (
    <div className="flex-none border-b border-hairline px-5 pt-4 pb-3.5">
      <div className="mb-2 flex items-center gap-2.5">
        <span className="font-mono text-[11.5px] text-muted-2">{ticket.id}</span>
        <span
          className="rounded px-[7px] py-[1.5px] font-mono text-[9px] font-semibold tracking-[.04em] uppercase"
          style={{ color: pc, background: `${pc}15`, border: `1px solid ${pc}40` }}
        >
          {ticket.priority}
        </span>
        <StatusPicker detail={detail} onSetState={onSetState} />
        {ticket.sla && (
          <span className="font-mono text-[10.5px] text-status-red/90">{ticket.sla}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            title="Refresh this issue from Linear"
            aria-label="Refresh"
            className="flex h-[27px] w-[27px] cursor-pointer items-center justify-center rounded-md border border-line-2 bg-input text-muted-2 hover:text-fg-2 disabled:cursor-default"
          >
            <RefreshIcon size={13} className={refreshing ? "animate-spin" : ""} />
          </button>
          <button
            type="button"
            onClick={() => detail && openUrl(detail.url)}
            disabled={!detail}
            className="flex cursor-pointer items-center gap-1.5 rounded-md border border-line-2 bg-input px-2.5 py-1.5 text-[11px] text-muted-2 hover:text-fg-2 disabled:cursor-default disabled:opacity-40"
          >
            <LinearLogo size={12} className="text-[color:var(--linear-brand)]" />
            Open Issue
          </button>
          <button
            type="button"
            onClick={onInvestigate}
            title="Open a terminal to investigate this issue"
            className="flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors"
            style={{
              color: "var(--accent)",
              borderColor: investigating
                ? "color-mix(in srgb, var(--accent) 55%, transparent)"
                : "color-mix(in srgb, var(--accent) 30%, transparent)",
              background: investigating
                ? "color-mix(in srgb, var(--accent) 20%, transparent)"
                : "color-mix(in srgb, var(--accent) 11%, transparent)",
            }}
          >
            <InvestigateIcon size={13} />
            Investigate
          </button>
        </div>
      </div>
      <div className="mb-2 text-[17px] leading-[1.3] font-semibold text-fg-bright">
        {ticket.title}
      </div>
      <div className="flex min-h-[17px] flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[11px] text-muted-3">
        {detail ? (
          <>
            <span className="flex items-center gap-1.5">
              <Avatar name={detail.author} src={detail.authorAvatarUrl} size={17} />
              {detail.author}
            </span>
            <span className="text-muted-5">·</span>
            <span>{detail.created}</span>
            {detail.project && (
              <>
                <span className="text-muted-5">·</span>
                <span>{detail.project}</span>
              </>
            )}
            {detail.labels.map((l) => (
              <span
                key={l}
                className="rounded border border-line-2 bg-input px-1.5 py-px font-mono text-[10px] text-muted-2"
              >
                {l}
              </span>
            ))}
          </>
        ) : (
          // Author/labels arrive with the detail — placeholder until then.
          <>
            <Skeleton className="h-3.5 w-3.5 rounded-full" />
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3.5 w-14 rounded" />
            <Skeleton className="h-3.5 w-20 rounded" />
          </>
        )}
      </div>
      {ticket.snoozedUntil && (
        <div className="mt-2.5 flex items-center gap-2 rounded-md border border-line-2 bg-input px-2.5 py-1.5 text-[11px] text-muted-2">
          💤 Snoozed until {ticket.snoozedUntil} — sits at the bottom of the queue until then.
        </div>
      )}
    </div>
  );
}
