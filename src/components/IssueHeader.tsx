/**
 * The ticket page's header: id + priority + status picker + SLA, the Refresh /
 * Open Issue actions (and whatever the host adds after them), then the title and
 * the meta row (`IssueMeta` — author, project, labels, points, cycle, due date).
 *
 * Detail-driven. The richer fields — author, labels, the team's states — arrive
 * with the detail; a host that already holds the ticket's row (Triage's queue)
 * passes it as `summary` so the frame renders before the fetch lands, and a host
 * that holds nothing but the id (a worktree, a pull request) gets a skeleton in
 * the title's place rather than the bare id standing in for a name.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ReactNode } from "react";

import type { Priority, TriageDetail } from "../bindings";
import { formatSnoozeLabel } from "../lib/relativeTime";
import { IssueMeta } from "./IssueMeta";
import { LinearLogo, RefreshIcon } from "./icons";
import { MarkdownTitle } from "./Markdown";
import { PriorityPill } from "./PriorityPill";
import { Button, Skeleton } from "./primitives";
import { SlaCountdown } from "./RelativeTime";
import { StatusPicker } from "./StatusPicker";

/** The fields a queue row already knows before the detail lands; a TriageTicket
 *  satisfies it structurally. */
export interface IssueSummary {
  title: string;
  priority: Priority;
  slaBreachMs: number | null;
  snoozedUntilMs: number | null;
}

export function IssueHeader({
  id,
  detail,
  summary,
  onSetState,
  linearReadOnly = false,
  onRefresh,
  refreshing,
  actions,
}: {
  id: string;
  detail: TriageDetail | undefined;
  summary?: IssueSummary;
  onSetState: (stateId: string) => void;
  /** Linear granted read-only, so the status picker is shown but inert. */
  linearReadOnly?: boolean;
  onRefresh: () => void;
  refreshing: boolean;
  /** Host actions rendered after "Open Issue" (Triage passes its "Investigate
   *  with X" button). */
  actions?: ReactNode;
}) {
  // The detail is the truth once it lands; the summary is the same fields as the
  // host last saw them, good enough to draw the frame with.
  const known: IssueSummary | undefined = detail ?? summary;

  return (
    <div className="flex-none border-b border-hairline px-5 pt-4 pb-3.5">
      <div className="mb-2 flex items-center gap-2.5">
        <span className="font-mono text-[11.5px] text-muted-2">{id}</span>
        {known && <PriorityPill priority={known.priority} />}
        <StatusPicker detail={detail} onSetState={onSetState} readOnly={linearReadOnly} />
        {known && (
          <SlaCountdown
            breachMs={known.slaBreachMs}
            className="font-mono text-[10.5px] text-status-red/90"
          />
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
          <Button size="sm" onClick={() => detail && openUrl(detail.url)} disabled={!detail}>
            <LinearLogo size={12} className="text-[color:var(--linear-brand)]" />
            Open Issue
          </Button>
          {actions}
        </div>
      </div>
      {known ? (
        <MarkdownTitle className="mb-2 block text-[17px] leading-[1.3] font-semibold text-fg-bright">
          {known.title}
        </MarkdownTitle>
      ) : (
        // Sized to the title line it stands in for, so nothing shifts when the
        // name lands.
        <Skeleton className="mb-2 h-[22px] w-2/3" />
      )}
      {detail ? (
        <IssueMeta detail={detail} withoutPriority />
      ) : (
        // The meta row arrives with the detail — a placeholder shaped like it
        // until then, so nothing shifts when it lands.
        <div className="flex min-h-[17px] flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <Skeleton className="h-3.5 w-3.5 rounded-full" />
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3.5 w-14 rounded" />
          <Skeleton className="h-3.5 w-20 rounded" />
        </div>
      )}
      {known?.snoozedUntilMs != null && (
        <div className="mt-2.5 flex items-center gap-2 rounded-md border border-line-2 bg-input px-2.5 py-1.5 text-[11px] text-muted-2">
          Snoozed until {formatSnoozeLabel(known.snoozedUntilMs)}. It waits in the sidebar's Snoozed
          group until then.
        </div>
      )}
    </div>
  );
}
