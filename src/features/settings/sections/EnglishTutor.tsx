/**
 * Settings → English tutor: the writing coach that rides along on the Claude
 * sessions santree launches.
 *
 * Three things in one pane, in the order you'd use them: the toggle, the log it
 * produces, and the analysis of that log. The log deliberately isn't replayed into
 * sessions at startup — a thousand corrections is ~25k tokens every session would
 * pay for, to surface a handful of patterns. Reading it is a thing you do on
 * purpose, here, and the analysis runs only when you press a button.
 *
 * The log is **read-only**: the agent appends to it mid-turn, so an edit box here
 * would race an in-flight append and silently lose one of the two.
 */

import { useState } from "react";

import type { AnalysisScope, EnglishDay, EnglishLog } from "../../../bindings";
import {
  ChevronRightIcon,
  ClaudeSparkIcon,
  RefreshIcon,
  WarningIcon,
} from "../../../components/icons";
import { Markdown } from "../../../components/Markdown";
import { Button, EmptyState, RunningStatus, Spinner } from "../../../components/primitives";
import { RelativeTime } from "../../../components/RelativeTime";
import {
  ENGLISH_TUTOR_KEY,
  useEnglishAnalysis,
  useEnglishLog,
  useRunEnglishAnalysis,
  useSetSetting,
  useSetting,
} from "../../../lib/queries";
import { Block, Heading, ToggleRow } from "../widgets";

/** The analysis windows, in widening order. Each answers a different question —
 *  that's why they're named buttons rather than a date picker. */
const SCOPES: { scope: AnalysisScope; label: string; hint: string }[] = [
  { scope: "LastWeek", label: "Last 7 days", hint: "What's going wrong right now" },
  {
    scope: "LastMonth",
    label: "Last 30 days",
    hint: "Current habits, with enough volume to be real",
  },
  { scope: "SinceLast", label: "Since last", hint: "Only what's new since the previous analysis" },
  {
    scope: "Everything",
    label: "Everything",
    hint: "Trends — including what you've already retired",
  },
];

const SCOPE_LABEL: Record<AnalysisScope, string> = {
  LastWeek: "last 7 days",
  LastMonth: "last 30 days",
  SinceLast: "since the previous analysis",
  Everything: "the whole log",
};

/** An ISO `YYYY-MM-DD` as a local calendar date. Built from parts rather than
 *  `new Date(iso)`, which parses a bare date as UTC midnight and renders as the
 *  *previous* day for anyone west of Greenwich. */
function localDate(iso: string): Date | null {
  const [y, m, d] = iso.split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
}

const DAY_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
});

function formatDay(iso: string): string {
  const d = localDate(iso);
  return d ? DAY_FMT.format(d) : iso;
}

export function EnglishTutorSection() {
  const { data: enabledRaw } = useSetting("app", ENGLISH_TUTOR_KEY);
  const enabled = enabledRaw === "true";
  const { mutate: setSetting } = useSetSetting();

  const { data: log, isLoading: logLoading } = useEnglishLog();
  const { data: analysis } = useEnglishAnalysis();
  const { mutate: analyze, isPending, variables: running } = useRunEnglishAnalysis();

  const entries = log?.entryCount ?? 0;
  // The analysis was taken at a point in the log's history; once the agent has
  // appended past that, say so rather than presenting it as current.
  const behind = analysis ? Math.max(0, entries - (analysis.entryCount ?? 0)) : 0;

  return (
    <>
      <Heading
        title="English tutor"
        subtitle="Have the agent correct your English as you work, and keep a log of what to practice."
      />
      <div className="flex flex-col gap-5">
        <div className="rounded-xl border border-line-2 bg-raised px-4 py-0.5">
          <ToggleRow
            label="Correct my English"
            hint="Every Claude session santree starts opens its reply with any mistakes in your message, then appends them to the practice log below. Takes effect on sessions started from now on — running ones keep the setting they launched with."
            on={enabled}
            onChange={(next) =>
              setSetting({ scope: "app", key: ENGLISH_TUTOR_KEY, value: next ? "true" : "false" })
            }
          />
        </div>

        <Block
          title="Practice log"
          subtitle={
            log ? (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>
                  {entries === 0
                    ? "No corrections yet."
                    : `${entries} correction${entries === 1 ? "" : "s"} across ${log.days.length} day${log.days.length === 1 ? "" : "s"}.`}
                </span>
                {log.updatedAtMs != null && entries > 0 && (
                  <span className="text-muted-4">
                    Last <RelativeTime ms={log.updatedAtMs} />.
                  </span>
                )}
                <span className="font-mono text-[10.5px] break-all text-muted-4">{log.path}</span>
              </span>
            ) : (
              "The file the agent appends corrections to."
            )
          }
        >
          <LogView log={log} loading={logLoading} />
        </Block>

        <Block
          title="Analysis"
          subtitle="Turns the log into a shortlist of habits to break, weighted toward recent entries. One Claude call per run — nothing happens until you pick a window."
        >
          <div className="mb-3 flex flex-wrap gap-2">
            {SCOPES.map(({ scope, label, hint }) => (
              <Button
                key={scope}
                size="sm"
                disabled={isPending || entries === 0}
                onClick={() => analyze(scope)}
                title={hint}
              >
                {isPending && running === scope ? (
                  <Spinner size={10} />
                ) : (
                  <ClaudeSparkIcon size={11} />
                )}
                {label}
              </Button>
            ))}
          </div>
          {isPending && (
            <div className="mb-3 rounded-xl border border-line-2 bg-raised px-4 py-3">
              <RunningStatus
                active
                label={`Reading the log${running ? ` (${SCOPE_LABEL[running]})` : ""}…`}
                // A thousand corrections in and a structured answer out is minutes
                // of work, not a stall — the run has its own long deadline.
                slowLabel="Still working — a long log takes a few minutes."
              />
            </div>
          )}
          {analysis ? (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-3">
                <span>
                  Covering {SCOPE_LABEL[analysis.scope]} ·{" "}
                  <RelativeTime ms={analysis.createdAtMs} />
                </span>
                {behind > 0 && (
                  <span className="flex items-center gap-1 text-muted-4">
                    <RefreshIcon size={9} />
                    {behind} newer correction{behind === 1 ? "" : "s"} since
                  </span>
                )}
              </div>
              <div className="rounded-xl border border-line-2 bg-raised px-4 py-3">
                <Markdown>{analysis.text}</Markdown>
              </div>
            </>
          ) : (
            <EmptyState
              className="py-8"
              title={entries === 0 ? "Nothing to analyze yet." : "No analysis yet."}
              subtitle={
                entries === 0
                  ? "Turn the tutor on and write a few messages — corrections land in the log, and the log is what gets analyzed."
                  : "Pick a window above to turn the log into a shortlist of what to work on."
              }
            />
          )}
        </Block>
      </div>
    </>
  );
}

/** The log, newest day first, each day collapsible. Reversed for display only —
 *  the backend ships days in the file's own (chronological) order. */
function LogView({ log, loading }: { log: EnglishLog | undefined; loading: boolean }) {
  if (loading) {
    return (
      <div className="flex h-[200px] items-center justify-center rounded-xl border border-line-2 bg-raised">
        <Spinner />
      </div>
    );
  }
  if (!log || log.days.length === 0) {
    return (
      <EmptyState
        className="py-8"
        title="The log is empty."
        subtitle="Corrections show up here as the agent makes them."
      />
    );
  }
  const newestFirst = [...log.days].reverse();
  const unparsed = log.unparsed ?? 0;
  return (
    <div className="flex flex-col gap-2">
      {unparsed > 0 && (
        // Never silently hide entries: if the format drifted, say so here rather
        // than quietly showing a shorter log than the file holds.
        <div className="flex items-center gap-1.5 rounded-lg border border-line-2 px-3 py-2 text-[11.5px] text-muted-3">
          <WarningIcon size={11} />
          {unparsed} line{unparsed === 1 ? "" : "s"} in the file couldn't be read as a correction
          and {unparsed === 1 ? "isn't" : "aren't"} shown below.
        </div>
      )}
      <div className="max-h-[420px] overflow-auto rounded-xl border border-line-2 bg-raised">
        {newestFirst.map((day, i) => (
          <DaySection key={day.date} day={day} defaultOpen={i === 0} />
        ))}
      </div>
    </div>
  );
}

/** One day, collapsed to a header until opened. The newest day starts open — it's
 *  the one you came to read. */
function DaySection({ day, defaultOpen }: { day: EnglishDay; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-line first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]"
      >
        <ChevronRightIcon
          size={11}
          className={`flex-none text-muted-4 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="text-[12.5px] font-medium text-fg-2">{formatDay(day.date)}</span>
        <span className="font-mono text-[10.5px] text-muted-4">{day.date}</span>
        <span className="ml-auto font-mono text-[10.5px] text-muted-3">{day.entries.length}</span>
      </button>
      {open && (
        <ul className="flex flex-col gap-1.5 px-3 pt-0.5 pb-3">
          {day.entries.map((e, i) => (
            // Entries have no id and the same correction can legitimately repeat
            // on a day, so the index is the only key available. Safe here: the
            // list is immutable once rendered — nothing reorders or splices it.
            <li
              key={i}
              className="flex flex-wrap items-baseline gap-x-1.5 text-[12px] leading-[1.6]"
            >
              <span className="text-muted-3 line-through decoration-muted-4/60">{e.original}</span>
              <span className="text-muted-4">→</span>
              <span className="font-medium text-fg-2">{e.correction}</span>
              {e.reason && <span className="text-[11px] text-muted-4">{e.reason}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
