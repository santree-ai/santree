/**
 * Settings → English tutor: the writing coach that rides along on the Claude
 * sessions santree launches.
 *
 * Three things in one pane, in the order you'd use them: the toggle, the log it
 * produces, and the analysis of that log. The log deliberately isn't replayed into
 * sessions at startup — a thousand corrections is ~25k tokens every session would
 * pay for, to surface a handful of patterns. Reading it is a thing you do on
 * purpose, here, and the analysis runs only when you press the button.
 *
 * The log is **read-only** on purpose: the agent appends to it mid-turn, so an
 * edit box here would race an in-flight append and silently lose one of the two.
 */

import type { EnglishLog } from "../../../bindings";
import { ClaudeSparkIcon, RefreshIcon } from "../../../components/icons";
import { Markdown } from "../../../components/Markdown";
import { Button, EmptyState, Spinner } from "../../../components/primitives";
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

export function EnglishTutorSection() {
  const { data: enabledRaw } = useSetting("app", ENGLISH_TUTOR_KEY);
  const enabled = enabledRaw === "true";
  const { mutate: setSetting } = useSetSetting();

  const { data: log, isLoading: logLoading } = useEnglishLog();
  const { data: analysis } = useEnglishAnalysis();
  const { mutate: analyze, isPending } = useRunEnglishAnalysis();

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
                    : `${entries} correction${entries === 1 ? "" : "s"}.`}
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
          subtitle="Reads the whole log and tells you which habits to break next, weighted toward recent entries. One Claude call, run only when you ask."
        >
          <div className="mb-3 flex items-center gap-2.5">
            <Button size="sm" disabled={isPending || entries === 0} onClick={() => analyze()}>
              {isPending ? <Spinner size={10} /> : <ClaudeSparkIcon size={11} />}
              {isPending ? "Reading the log…" : analysis ? "Re-analyze" : "Analyze"}
            </Button>
            {analysis && (
              <span className="flex items-center gap-1.5 text-[11.5px] text-muted-3">
                <RelativeTime ms={analysis.createdAtMs} />
                {behind > 0 && (
                  <span className="flex items-center gap-1 text-muted-4">
                    <RefreshIcon size={9} />
                    {behind} newer correction{behind === 1 ? "" : "s"} since
                  </span>
                )}
              </span>
            )}
          </div>
          {analysis ? (
            <div className="rounded-xl border border-line-2 bg-raised px-4 py-3">
              <Markdown>{analysis.text}</Markdown>
            </div>
          ) : (
            <EmptyState
              className="py-8"
              title={entries === 0 ? "Nothing to analyze yet." : "No analysis yet."}
              subtitle={
                entries === 0
                  ? "Turn the tutor on and write a few messages — corrections land in the log, and the log is what gets analyzed."
                  : "Press Analyze to turn the log into a shortlist of what to work on."
              }
            />
          )}
        </Block>
      </div>
    </>
  );
}

/** The log itself, in a fixed-height scroller. Rendered as plain monospace text,
 *  not markdown: every line is `- original -> correction (reason)`, and the value
 *  is in scanning them, not in typography. */
function LogView({ log, loading }: { log: EnglishLog | undefined; loading: boolean }) {
  if (loading) {
    return (
      <div className="flex h-[240px] items-center justify-center rounded-xl border border-line-2 bg-raised">
        <Spinner />
      </div>
    );
  }
  if (!log || log.entryCount === 0) {
    return (
      <EmptyState
        className="py-8"
        title="The log is empty."
        subtitle="Corrections show up here as the agent makes them."
      />
    );
  }
  return (
    // A `readOnly` textarea rather than a styled div: it's natively focusable and
    // keyboard-scrollable (a div would need a `tabIndex` the a11y lint rightly
    // rejects on a non-interactive element), and select-all/copy comes free.
    <textarea
      readOnly
      value={log.text}
      aria-label="English practice log (read-only)"
      className="h-[280px] w-full resize-none overflow-auto rounded-xl border border-line-2 bg-raised px-4 py-3 font-mono text-[11.5px] leading-[1.7] text-fg-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]"
    />
  );
}
