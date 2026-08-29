/**
 * A failed check's raw GitHub Actions job log, sliced to the failing step.
 *
 * Split out of the Checks pane because it now has two hosts that want it at very
 * different sizes: the Reviews tab expands it inline under a check (bounded, so
 * the list around it stays navigable), and the Trees main area opens it
 * full-height from a check's "View full details" — the right panel is a ~300px
 * column, and a CI log is not a 300px object. The height therefore comes from the
 * caller, not from here.
 *
 * Loose output is always visible; `##[group]` sections collapse behind their
 * title, which is the same shape GitHub's own step view uses.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";

import type { CheckLog, CheckLogLine } from "../../bindings";
import { ChevronDownIcon } from "../../components/icons";
import { checkLogLevelColor } from "../../theme/colors";

export function CheckLogBody({
  log,
  url,
  className = "max-h-[440px]",
}: {
  log: CheckLog;
  /** The run's page on GitHub — offered when the log was truncated. */
  url: string | null;
  /** The scroll container's sizing. Defaults to the bounded inline treatment. */
  className?: string;
}) {
  if (log.blocks.length === 0) {
    return <div className="px-3 py-2 text-[11px] text-muted-3">No log output.</div>;
  }
  return (
    <div className={`overflow-auto py-1 font-mono text-[11px] leading-[1.55] ${className}`}>
      {log.truncated && (
        <div className="px-3 pb-1 text-[10px] text-muted-4">
          Earlier lines omitted.{" "}
          {url ? (
            <button
              type="button"
              onClick={() => openUrl(url)}
              className="cursor-pointer underline hover:text-fg-2"
            >
              Open the full log on GitHub
            </button>
          ) : (
            "See the full log on GitHub."
          )}
        </div>
      )}
      {log.blocks.map((b, i) =>
        b.kind === "line" ? (
          <LogLine key={i} text={b.text} level={b.level} />
        ) : (
          <LogGroup key={i} title={b.title} lines={b.lines} />
        ),
      )}
    </div>
  );
}

/** A `##[group]` section — collapsed behind its title by default, like GitHub. */
function LogGroup({ title, lines }: { title: string; lines: CheckLogLine[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-1.5 px-3 text-left text-muted-3 hover:text-fg-2"
      >
        <ChevronDownIcon
          size={10}
          className={`flex-none transition-transform ${open ? "" : "-rotate-90"}`}
        />
        <span className="min-w-0 truncate">{title}</span>
      </button>
      {open && (
        <div className="pl-3.5">
          {lines.map((l, i) => (
            <LogLine key={i} text={l.text} level={l.level} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One raw-log line, tinted by level. Empty lines keep their height so blank
 *  runs in the log read the way they do on GitHub. */
function LogLine({ text, level }: { text: string; level: CheckLogLine["level"] }) {
  return (
    <div
      className="px-3 break-words whitespace-pre-wrap"
      style={{ color: checkLogLevelColor[level] }}
    >
      {text || " "}
    </div>
  );
}
