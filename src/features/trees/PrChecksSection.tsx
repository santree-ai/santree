/**
 * The PR pane's CI section: a summary line you can collapse, then one row per
 * check, each expanding to its **metadata** — status, timings, the run and job
 * ids — and two actions.
 *
 * Metadata only is the point. The Reviews tab's Checks pane is a full-width
 * surface that can afford steps, annotations and the raw log inline; this is a
 * ~300px column beside the work, where the useful question is "what is red, and
 * how do I get at it" — so the detail lives one click away in the main area
 * ("View full details"), and the fix goes through the queue.
 *
 * Reuses `groupChecks`/`tallyChecks` from the Reviews feature rather than
 * re-deriving: what counts as failing has to have one answer.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";

import type { PrCheck, ReviewPr } from "../../bindings";
import { ChevronDownIcon, GitHubLogo } from "../../components/icons";
import { Button, Skeleton } from "../../components/primitives";
import { usePrDetail, useReviewWorkItems } from "../../lib/queries";
import { splitRepoSlug } from "../../lib/repo";
import { checkStatusMeta } from "../../theme/colors";
import {
  groupChecks,
  isRunning,
  SKIPPED_KEY,
  tallyChecks,
  toggleCollapsed,
} from "../reviews/checks";
import { QueueAction } from "../reviews/QueueAction";
import { RunningDot } from "../reviews/RunningDot";
import { useTrees } from "./model";

/** An absolute timestamp, short — a check that ran twenty minutes ago and one
 *  that ran last Tuesday should be told apart at a glance. */
function stamp(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function PrChecksSection({ pr }: { pr: ReviewPr }) {
  const [owner, name] = splitRepoSlug(pr.repo);
  const { data: detail, isLoading } = usePrDetail(owner, name, pr.number);
  // Collapsed until asked. The summary line is the answer nearly every time, and
  // a repo can put well over a hundred checks on one change — expanding by
  // default buries the conversation and the brief under a wall of rows.
  const [open, setOpen] = useState(false);
  // The skipped/neutral group starts collapsed — it is rarely what you came for.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set([SKIPPED_KEY]));

  if (isLoading) {
    return (
      <div className="space-y-1.5 px-3 py-2">
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-6 w-full rounded" />
        <Skeleton className="h-6 w-full rounded" />
      </div>
    );
  }

  const checks = detail?.checks ?? [];
  if (checks.length === 0) {
    return (
      <div className="border-b border-hairline px-3 py-2 text-[11px] text-muted-4">
        No checks reported.
      </div>
    );
  }

  const tally = tallyChecks(checks);
  const groups = groupChecks(checks);
  const allKeys = groups.map((g) => g.key);

  return (
    <section className="border-b border-hairline">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left text-[11px] transition-colors hover:bg-hover"
      >
        <ChevronDownIcon
          size={11}
          className={`flex-none text-muted-4 transition-transform ${open ? "" : "-rotate-90"}`}
        />
        {/* Same order as the sections below — failed, then still running, then the
            outcomes you don't have to do anything about. The line and the list
            can't rank the run differently. */}
        {tally.failing > 0 && (
          <Tally color={checkStatusMeta.Failure} n={tally.failing} label="failing" />
        )}
        {tally.running > 0 && (
          <Tally color={checkStatusMeta.Pending} n={tally.running} label="running" pulse />
        )}
        {tally.passing > 0 && (
          <Tally color={checkStatusMeta.Success} n={tally.passing} label="passing" />
        )}
        {tally.other > 0 && <Tally color={checkStatusMeta.Skipped} n={tally.other} label="other" />}
      </button>

      {/* Scrolls in its own box rather than growing the pane: a repo that runs a
          hundred path-filter checks would otherwise push the conversation and the
          review brief below the fold, and those are what the pane is for. */}
      {open && (
        <div className="max-h-[45vh] overflow-y-auto pb-1">
          {groups.map((g) => {
            const groupCollapsed = collapsed.has(g.key);
            return (
              <div key={g.key}>
                <button
                  type="button"
                  onClick={(e) =>
                    setCollapsed((prev) =>
                      toggleCollapsed(prev, g.key, allKeys, e.metaKey || e.ctrlKey),
                    )
                  }
                  title={`${groupCollapsed ? "Expand" : "Collapse"} (⌘-click for all)`}
                  className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-1 text-left font-mono text-[9.5px] tracking-[.06em] uppercase transition-colors hover:bg-hover"
                  style={{ color: g.color }}
                >
                  <ChevronDownIcon
                    size={9}
                    className={`flex-none transition-transform ${groupCollapsed ? "-rotate-90" : ""}`}
                  />
                  {g.running && <RunningDot />}
                  {g.checks.length} {g.label}
                </button>
                {!groupCollapsed &&
                  g.checks.map((check, i) => (
                    <CheckRow key={`${check.name}-${i}`} check={check} pr={pr} />
                  ))}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Tally({
  color,
  n,
  label,
  pulse = false,
}: {
  color: { color: string; glyph: string };
  n: number;
  label: string;
  /** Render the in-progress dot instead of the status glyph. */
  pulse?: boolean;
}) {
  return (
    <span className="flex items-center gap-1" style={{ color: color.color }}>
      <span className="flex items-center font-mono">{pulse ? <RunningDot /> : color.glyph}</span>
      <span className="tabular-nums">{n}</span>
      <span className="text-muted-3">{label}</span>
    </span>
  );
}

function CheckRow({ check, pr }: { check: PrCheck; pr: ReviewPr }) {
  const [open, setOpen] = useState(false);
  const meta = checkStatusMeta[check.status];

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-1 text-left transition-colors hover:bg-hover"
      >
        <ChevronDownIcon
          size={9}
          className={`flex-none text-muted-4 transition-transform ${open ? "" : "-rotate-90"}`}
        />
        <span
          className="flex w-[1ch] flex-none items-center justify-center font-mono text-[11px]"
          style={{ color: meta.color }}
        >
          {isRunning(check) ? <RunningDot label={meta.label} /> : meta.glyph}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-3">{check.name}</span>
      </button>
      {open && <CheckMeta check={check} pr={pr} />}
    </div>
  );
}

/** What an expanded check says about itself. Every row is conditional on a real
 *  value: a status context has no run behind it, so it has no timings and no ids,
 *  and inventing "—" placeholders would be four rows of nothing. */
function CheckMeta({ check, pr }: { check: PrCheck; pr: ReviewPr }) {
  const { showCheckLog } = useTrees();
  const { data: items } = useReviewWorkItems(pr.repo, pr.number);
  const queued = items?.some((item) => item.source === "check" && item.sourceId === check.name);
  const started = stamp(check.startedAt);
  const completed = stamp(check.completedAt);

  return (
    <div className="mx-3 mb-1.5 rounded-md border border-line-2 bg-input px-2.5 py-2">
      <dl className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[10.5px] text-muted-3">
        <Meta label="Status">{checkStatusMeta[check.status].label}</Meta>
        {check.description && <Meta label="From">{check.description}</Meta>}
        {started && <Meta label="Started">{started}</Meta>}
        {completed && <Meta label="Completed">{completed}</Meta>}
        {check.jobId != null && (
          <span className="font-mono text-muted-4">check #{check.jobId}</span>
        )}
        {check.runId != null && (
          <span className="font-mono text-muted-4">workflow #{check.runId}</span>
        )}
      </dl>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {check.jobId != null && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              showCheckLog({
                jobId: check.jobId as number,
                name: check.name,
                url: check.url,
                prRepo: pr.repo,
              })
            }
            title="Open this run's output in the main area"
          >
            View full details
          </Button>
        )}
        {check.status === "Failure" && (
          <QueueAction
            prRepo={pr.repo}
            number={pr.number}
            queued={!!queued}
            title="Queue this failure for the agent to fix with everything else"
            item={{
              // The backend re-resolves the check and writes the row's text
              // itself; this is only what to show if the mutation is still in
              // flight when the list re-renders.
              body: `Fix failing check: ${check.name}`,
              source: "check",
              sourceId: check.name,
              path: null,
              line: null,
              startLine: null,
              onRight: null,
            }}
          />
        )}
        {check.url && (
          <button
            type="button"
            onClick={() => openUrl(check.url as string)}
            title="Open on GitHub"
            aria-label="Open this check on GitHub"
            className="ml-auto flex-none cursor-pointer text-muted-4 transition-colors hover:text-fg-2"
          >
            <GitHubLogo size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span>
      <dt className="inline text-muted-4">{label}: </dt>
      <dd className="inline text-fg-3">{children}</dd>
    </span>
  );
}
