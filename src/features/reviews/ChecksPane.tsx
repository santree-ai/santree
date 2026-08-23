/**
 * The "Checks" tab: the PR's individual CI checks (the head commit's check runs +
 * status contexts), grouped by outcome ({@link groupChecks}) into collapsible
 * sections. A failed check expands inline to its failing steps, its annotations,
 * and — on demand — the raw GitHub Actions job log, with a "Fix CI with AI" button
 * above the sections.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";

import type { CheckLogLevel, CheckLogLine, PrCheck, ReviewPr } from "../../bindings";
import { ChevronDownIcon, GitHubLogo } from "../../components/icons";
import { EmptyState, Skeleton, Spinner } from "../../components/primitives";
import { usePrCheckLog, usePrDetail } from "../../lib/queries";
import { splitRepoSlug } from "../../lib/repo";
import { checkStatusMeta } from "../../theme/colors";
import { groupChecks, SKIPPED_KEY, toggleCollapsed } from "./checks";
import { FixCiButton } from "./FixCiButton";
import { useReviewsModel } from "./model";

// GitHub annotation levels → tint. `notice` is informational; error/warning
// map to the shared status palette so they read the same as check glyphs.
const annotationLevelColor: Record<string, string> = {
  // GitHub's CheckAnnotationLevel enum: FAILURE | WARNING | NOTICE (lowercased).
  failure: "var(--color-status-red)",
  error: "var(--color-status-red)",
  warning: "var(--color-status-amber)",
  notice: "var(--color-muted-3)",
};

// GitHub Actions runner-marker levels → the same status palette the check glyphs
// use, so a log error reads identically to a failed-step glyph.
const logLevelColor: Record<CheckLogLevel, string> = {
  Error: "var(--color-status-red)",
  Warning: "var(--color-status-amber)",
  Command: "var(--color-muted-3)",
  Normal: "var(--color-muted-2)",
};

export function ChecksPane({ pr }: { pr: ReviewPr }) {
  const [owner, name] = splitRepoSlug(pr.repo);
  const { repo: santreeRepo } = useReviewsModel();
  const { data: detail, isLoading } = usePrDetail(owner, name, pr.number);
  // Section keys that are collapsed. The skipped/neutral group starts collapsed.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set([SKIPPED_KEY]));

  if (isLoading) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <BodySkeleton />
      </div>
    );
  }

  const checks = detail?.checks ?? [];
  if (checks.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-app">
        <EmptyState title="No checks reported" subtitle="This PR has no CI checks." />
      </div>
    );
  }

  const groups = groupChecks(checks);
  const allKeys = groups.map((g) => g.key);
  const toggle = (key: string, all: boolean) =>
    setCollapsed((prev) => toggleCollapsed(prev, key, allKeys, all));

  const failed = checks.filter((c) => c.status === "Failure");

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      {failed.length > 0 && (
        <div className="mb-4 flex items-center justify-end">
          <FixCiButton pr={pr} santreeRepo={santreeRepo} failed={failed} />
        </div>
      )}
      {groups.map((g) => {
        const isCollapsed = collapsed.has(g.key);
        return (
          <section key={g.key} className="mb-4">
            <button
              type="button"
              onClick={(e) => toggle(g.key, e.metaKey || e.ctrlKey)}
              title={`${isCollapsed ? "Expand" : "Collapse"} (⌘-click for all)`}
              className="mb-1.5 flex w-full cursor-pointer items-center gap-1.5 font-mono text-[10px] tracking-[.06em] uppercase hover:brightness-125"
              style={{ color: g.color }}
            >
              <ChevronDownIcon
                size={11}
                className={`flex-none transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
              />
              {g.glyph} {g.checks.length} {g.label}
            </button>
            {!isCollapsed && <CheckGroup checks={g.checks} owner={owner} name={name} />}
          </section>
        );
      })}
    </div>
  );
}

function CheckGroup({ checks, owner, name }: { checks: PrCheck[]; owner: string; name: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      {checks.map((c, i) => (
        <CheckRow key={`${c.name}-${i}`} check={c} owner={owner} name={name} />
      ))}
    </div>
  );
}

/** One CI check row. Failed checks with step/annotation detail expand inline to
 *  show what broke; every row links to the run's details page when available. */
function CheckRow({ check, owner, name }: { check: PrCheck; owner: string; name: string }) {
  const m = checkStatusMeta[check.status];
  // A failed Actions run always has a job log to offer, even with no
  // steps/annotations — so it's expandable on its `jobId` alone.
  const canShowLog = check.status === "Failure" && check.jobId != null;
  const hasDetail = check.steps.length > 0 || check.annotations.length > 0 || canShowLog;
  // Failed runs start expanded — the detail is the reason you opened this tab.
  const [open, setOpen] = useState(hasDetail);

  // A check that fails mid-poll (the common case: opened while CI was still running)
  // expands too. Keyed on the *transition* into failure, so a failed check the user
  // has since collapsed stays collapsed across re-renders.
  const failed = check.status === "Failure";
  const wasFailed = useRef(failed);
  useEffect(() => {
    if (failed && !wasFailed.current) setOpen(true);
    wasFailed.current = failed;
  }, [failed]);

  const header = (
    <>
      <span className="flex-none font-mono text-[12px]" style={{ color: m.color }}>
        {m.glyph}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-2">{check.name}</span>
      {check.description && (
        <span className="flex-none font-mono text-[10.5px] text-muted-4">{check.description}</span>
      )}
    </>
  );
  const rowCls = "flex items-center gap-2.5 rounded-md border border-line-2 bg-input px-3 py-2";

  if (!hasDetail) {
    return check.url ? (
      <button
        type="button"
        onClick={() => openUrl(check.url as string)}
        title="Open check details"
        className={`${rowCls} w-full cursor-pointer text-left hover:border-line-strong`}
      >
        {header}
      </button>
    ) : (
      <div className={rowCls}>{header}</div>
    );
  }

  return (
    <div className="rounded-md border border-line-2 bg-input px-3 py-2">
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left"
          title={open ? "Collapse" : "Expand"}
        >
          <ChevronDownIcon
            size={11}
            className={`flex-none text-muted-4 transition-transform ${open ? "" : "-rotate-90"}`}
          />
          {header}
        </button>
        {check.url && (
          <button
            type="button"
            onClick={() => openUrl(check.url as string)}
            title="Open check details"
            className="flex-none cursor-pointer text-muted-4 hover:text-fg-2"
          >
            <GitHubLogo size={13} />
          </button>
        )}
      </div>
      {open && <CheckDetail check={check} owner={owner} name={name} />}
    </div>
  );
}

/** Failed steps + error annotations for a failed check, plus the raw job log
 *  (on demand), shown when expanded. */
function CheckDetail({ check, owner, name }: { check: PrCheck; owner: string; name: string }) {
  // Steps are ordered; the failing one(s) are what matter, but showing the run's
  // step list gives context on where it broke. Highlight non-passing steps.
  const failedSteps = check.steps.filter((s) => s.status === "Failure");
  const steps = failedSteps.length > 0 ? failedSteps : check.steps;
  return (
    <div className="mt-1.5 flex flex-col gap-2 border-t border-line-2 pt-2">
      {steps.length > 0 && (
        <div className="flex flex-col gap-1">
          {steps.map((s) => {
            const sm = checkStatusMeta[s.status];
            return (
              <div key={s.number} className="flex items-center gap-2 text-[11.5px]">
                <span className="flex-none font-mono text-[11px]" style={{ color: sm.color }}>
                  {sm.glyph}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-2">{s.name}</span>
              </div>
            );
          })}
        </div>
      )}
      {check.annotations.map((a, i) => {
        const color = annotationLevelColor[a.level] ?? "var(--color-status-red)";
        return (
          <div
            key={`${a.path ?? ""}-${a.startLine ?? i}-${i}`}
            className="rounded-md border border-line-2 bg-app px-2.5 py-2"
            style={{ borderLeft: `2px solid ${color}` }}
          >
            <div className="mb-1 flex items-center gap-2 font-mono text-[10px]">
              <span className="uppercase" style={{ color }}>
                {a.level || "error"}
              </span>
              {a.path && (
                <span className="min-w-0 truncate text-muted-3">
                  {a.path}
                  {a.startLine != null && `:${a.startLine}`}
                </span>
              )}
            </div>
            {a.title && <div className="mb-0.5 text-[11.5px] font-medium text-fg-2">{a.title}</div>}
            <div className="text-[11.5px] leading-snug whitespace-pre-wrap text-muted-2">
              {a.message}
            </div>
            {a.rawDetails && (
              <pre className="mt-1.5 overflow-x-auto rounded bg-input px-2 py-1.5 font-mono text-[10.5px] leading-snug text-muted-3">
                {a.rawDetails}
              </pre>
            )}
          </div>
        );
      })}
      {check.status === "Failure" && check.jobId != null && (
        <CheckLogSection owner={owner} name={name} jobId={check.jobId} url={check.url} />
      )}
    </div>
  );
}

/** Lazily-loaded raw job log for a failed check, sliced to the failing step.
 *  Loose output is always visible; `##[group]` sections collapse — the same
 *  expand-on-demand shape as GitHub's step view. */
function CheckLogSection({
  owner,
  name,
  jobId,
  url,
}: {
  owner: string;
  name: string;
  jobId: number;
  url: string | null;
}) {
  const [show, setShow] = useState(false);
  const { data: log, isLoading } = usePrCheckLog(owner, name, jobId, show);
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        className="flex w-fit cursor-pointer items-center gap-1.5 font-mono text-[10px] tracking-[.06em] text-muted-3 uppercase hover:text-fg-2"
      >
        <ChevronDownIcon
          size={11}
          className={`flex-none transition-transform ${show ? "" : "-rotate-90"}`}
        />
        {show ? "Hide output log" : "Show output log"}
      </button>
      {show && (
        <div className="overflow-hidden rounded-md border border-line-2 bg-app">
          {isLoading ? (
            <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-3">
              <Spinner size={11} /> Loading log…
            </div>
          ) : !log || log.blocks.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-muted-3">No log output.</div>
          ) : (
            <div className="max-h-[440px] overflow-auto py-1 font-mono text-[11px] leading-[1.55]">
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
          )}
        </div>
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
function LogLine({ text, level }: { text: string; level: CheckLogLevel }) {
  return (
    <div className="px-3 break-words whitespace-pre-wrap" style={{ color: logLevelColor[level] }}>
      {text || " "}
    </div>
  );
}

function BodySkeleton() {
  return (
    <div className="space-y-2.5">
      <Skeleton className="h-3.5 w-1/3" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-11/12" />
      <Skeleton className="h-3 w-4/5" />
      <Skeleton className="mt-4 h-24 w-full rounded-lg" />
    </div>
  );
}
