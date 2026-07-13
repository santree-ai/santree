/**
 * Right pane of the Reviews tab. A shared header (repo · #number · branch · open)
 * sits above two tabs:
 *  - **Pull request** — the PR's description, conversation, and per-file diff.
 *  - **Issue** — the linked Linear ticket, found from the `[AK-123]` tag in the
 *    PR title (the same PR↔ticket convention the worktree flow uses) and rendered
 *    with the shared `DiscussionPane`, like the Trees "Issue" tab.
 *
 * PR detail is fetched lazily per selection (`usePrDetail`); the ticket lazily via
 * `useTriageDetail`. Both show skeletons while loading; the header renders
 * immediately from the already-loaded list row.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";

import type {
  CheckLog,
  CheckLogLevel,
  CheckLogLine,
  CheckStatus,
  PrCheck,
  PrLabel,
  Reviewer,
  ReviewPr,
} from "../../bindings";
import { commands } from "../../bindings";
import { Avatar } from "../../components/Avatar";
import { DiscussionPane, DiscussionSkeleton } from "../../components/IssueDiscussion";
import {
  AgentsIcon,
  BranchIcon,
  CheckIcon,
  ChevronDownIcon,
  ClaudeSparkIcon,
  CloseIcon,
  CopyIcon,
  GitHubLogo,
  LinearLogo,
  PanelIcon,
  PlusIcon,
} from "../../components/icons";
import {
  Button,
  Dot,
  Dropdown,
  EmptyState,
  MENU_ITEM,
  Pill,
  Skeleton,
  Spinner,
  Tabs,
} from "../../components/primitives";
import { RelativeTime } from "../../components/RelativeTime";
import {
  queryKeys,
  unwrap,
  usePrCheckLog,
  usePrDetail,
  useRepoLabels,
  useSetPrLabels,
  useTriageDetail,
} from "../../lib/queries";
import { splitRepoSlug } from "../../lib/repo";
import { useAppUi } from "../../state/AppContext";
import { toast } from "../../state/toast";
import {
  accentActiveStyle,
  alpha,
  checkRollupMeta,
  checkStatusMeta,
  mergeQueueMeta,
  priorityColor,
  readableLabelColor,
  reviewDecisionMeta,
} from "../../theme/colors";
import { useResolvedTheme } from "../../theme/useResolvedTheme";
import { MergeQueuePane } from "./MergeQueuePane";
import { useReviewsModel } from "./model";
import { PrInfoPanel } from "./PrInfoPanel";
import { PrReviewPane } from "./PrReviewPane";

type DetailTab = "pr" | "checks" | "issue";

/**
 * The Linear ticket id for a PR: prefer the `[AK-123]` tag in the title (the
 * worktree flow's convention), then fall back to the head branch — which usually
 * embeds it lower-cased (e.g. `jonathansandoval/msg-5033-ai-explanation` →
 * "MSG-5033"). `null` when neither carries one.
 */
export function ticketIdFor(pr: { title: string; headRef: string }): string | null {
  // Title: uppercase only, so prose like "service-ticket" can't false-match.
  const fromTitle = pr.title.match(/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/)?.[1];
  if (fromTitle) return fromTitle;
  // Branch: case-insensitive (branches are lower-cased), normalized to uppercase.
  const m = pr.headRef.match(/\b([a-z][a-z0-9]{1,9})-(\d+)\b/i);
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null;
}

export function ReviewDetail() {
  const { active, showMergeQueue } = useReviewsModel();

  if (showMergeQueue) return <MergeQueuePane />;

  if (!active) {
    return (
      <div className="flex min-w-0 flex-1 flex-col bg-app">
        <EmptyState
          title="Select a pull request"
          subtitle="Pick a PR from the left to review it."
        />
      </div>
    );
  }
  // Keyed remount so per-PR query state, the active tab, and scroll reset on switch.
  // The info rail spans the whole detail area (header, tabs, body) alongside the
  // PR pane, so the description stays visible across every tab.
  return (
    <div key={active.id} className="flex min-w-0 flex-1">
      <PrPane pr={active} />
      <PrInfoPanel pr={active} />
    </div>
  );
}

function PrPane({ pr }: { pr: ReviewPr }) {
  const { repo: santreeRepo, infoCollapsed, toggleInfo } = useReviewsModel();
  const [tab, setTab] = useState<DetailTab>("pr");
  const ticketId = ticketIdFor(pr);
  const decision = reviewDecisionMeta[pr.reviewDecision];
  const checks = checkRollupMeta[pr.checks];

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-app">
      {/* Shared header — identity on the left, actions on the right; each row
          spans the full width rather than stacking everything on one side. */}
      <div className="flex-none border-b border-hairline px-5 pt-3.5 pb-2">
        <div className="mb-2 flex items-center gap-2">
          <span className="font-mono text-[12px] text-muted-3">{pr.repo}</span>
          <span className="font-mono text-[12px]" style={{ color: "var(--accent)" }}>
            #{pr.number}
          </span>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(pr.headRef);
                toast.success("Branch copied.");
              }}
              title={`Copy branch — ${pr.headRef}`}
              className="group flex min-w-0 max-w-[300px] cursor-pointer items-center gap-1.5 rounded-md border border-line-2 bg-input px-2 py-1 font-mono text-[10.5px] text-[color:var(--color-branch)] hover:border-line-strong"
            >
              <BranchIcon size={11} className="flex-none" />
              <span className="truncate">{pr.headRef}</span>
              <CopyIcon size={11} className="flex-none text-muted-3 group-hover:text-fg-2" />
            </button>
            <Button
              size="sm"
              onClick={() => openUrl(pr.url)}
              title="Open on GitHub"
              className="flex-none"
            >
              <GitHubLogo size={11} />
              Open
            </Button>
            <button
              type="button"
              onClick={toggleInfo}
              aria-pressed={!infoCollapsed}
              title={`${infoCollapsed ? "Show" : "Hide"} details (⌘L)`}
              className="flex-none cursor-pointer rounded-md border border-line-2 bg-input p-1.5 hover:border-line-strong"
              style={infoCollapsed ? { color: "var(--color-muted-3)" } : accentActiveStyle()}
            >
              <PanelIcon size={13} />
            </button>
          </div>
        </div>
        <h1 className="mb-2 text-[16px] leading-[1.3] font-semibold text-fg-bright">{pr.title}</h1>
        <div className="flex flex-wrap items-center gap-2.5 text-[11px]">
          <span className="flex items-center gap-1.5 text-muted-2">
            <Avatar name={pr.author} src={pr.authorAvatarUrl} size={16} />
            {pr.author}
          </span>
          <Pill color={decision.color} className="px-1.5 py-px text-[10px] font-medium">
            {decision.label}
          </Pill>
          {pr.isInMergeQueue && (
            <Pill color={mergeQueueMeta.color} className="px-1.5 py-px text-[10px] font-medium">
              {mergeQueueMeta.glyph} {mergeQueueMeta.label}
            </Pill>
          )}
          <span className="flex items-center gap-1 font-mono" style={{ color: checks.color }}>
            {checks.glyph} {checks.label}
          </span>
          <span className="ml-auto font-mono text-muted-3">
            <span className="text-status-green">+{pr.additions}</span>{" "}
            <span className="text-status-red">−{pr.deletions}</span>
          </span>
        </div>
        {pr.reviewers.length > 0 && <Reviewers reviewers={pr.reviewers} />}
        <PrLabels pr={pr} />
      </div>

      <Tabs
        className="flex-none px-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "pr", label: "Pull request" },
          {
            value: "checks",
            label: "Checks",
            badge: (
              <span className="font-mono text-[11px]" style={{ color: checks.color }}>
                {checks.glyph}
              </span>
            ),
          },
          { value: "issue", label: "Issue", dimmed: !ticketId },
        ]}
      />

      {tab === "pr" && <PrReviewPane pr={pr} />}
      {tab === "checks" && <ChecksPane pr={pr} />}
      {tab === "issue" && <ReviewIssuePane repo={santreeRepo} ticketId={ticketId} />}
    </div>
  );
}

/** Requested reviewers on the PR — people as avatar+login chips, teams as a
 *  bordered chip with a people glyph. */
function Reviewers({ reviewers }: { reviewers: Reviewer[] }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[11px]">
      <span className="text-muted-4">Reviewers</span>
      {reviewers.map((r) =>
        r.kind === "User" ? (
          <span key={`u:${r.name}`} className="flex items-center gap-1 text-muted-2">
            <Avatar name={r.name} src={r.avatarUrl} size={15} />
            {r.name}
          </span>
        ) : (
          <span
            key={`t:${r.name}`}
            className="flex items-center gap-1 rounded-md border border-line-2 bg-input px-1.5 py-0.5 text-[10px] text-muted-2"
            title={`Team: ${r.name}`}
          >
            <AgentsIcon size={11} />
            {r.name}
          </span>
        ),
      )}
    </div>
  );
}

/** The PR's labels ("tags"), editable inline: each is a removable colored chip,
 *  and a "＋" dropdown toggles any of the repo's labels on or off. Labels live on
 *  the (deduped) PR detail; edits write straight through to GitHub optimistically,
 *  so the row updates instantly. */
function PrLabels({ pr }: { pr: ReviewPr }) {
  const [owner, name] = splitRepoSlug(pr.repo);
  const { data: detail } = usePrDetail(owner, name, pr.number);
  const { mutate: setLabels } = useSetPrLabels(owner, name, pr.number);
  // Fetch the repo's palette only once the picker opens (labels rarely change).
  const [picking, setPicking] = useState(false);
  const { data: repoLabels = [] } = useRepoLabels(owner, name, picking);

  // The labels row lives on the PR detail; show nothing until it loads.
  if (!detail) return null;
  const labels = detail.labels;
  const assigned = new Set(labels.map((l) => l.name));

  const toggle = (label: PrLabel) =>
    setLabels(
      assigned.has(label.name) ? labels.filter((l) => l.name !== label.name) : [...labels, label],
    );

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className="text-muted-4">Labels</span>
      {labels.map((l) => (
        <LabelChip
          key={l.name}
          label={l}
          onRemove={() => setLabels(labels.filter((x) => x !== l))}
        />
      ))}
      {labels.length === 0 && <span className="text-muted-3">None</span>}
      <Dropdown
        open={picking}
        onOpenChange={setPicking}
        menuClassName="w-64 overflow-hidden"
        trigger={(t) => (
          <button
            type="button"
            onClick={t}
            title="Add or remove labels"
            className="flex cursor-pointer items-center gap-1 rounded border border-dashed border-line-3 px-1.5 py-px text-[10.5px] text-muted-2 hover:border-line-strong hover:text-fg-2"
          >
            <PlusIcon size={10} /> Label
          </button>
        )}
      >
        {() => <LabelPicker labels={repoLabels} assigned={assigned} onToggle={toggle} />}
      </Dropdown>
    </div>
  );
}

/** One assigned label — a colored chip with an inline remove (×) button. The
 *  chip's whole palette derives from a lightness-clamped version of the label's
 *  raw hex so pale labels (e.g. `risk:high`) stay legible in both themes. */
function LabelChip({ label, onRemove }: { label: PrLabel; onRemove: () => void }) {
  const theme = useResolvedTheme();
  const color = readableLabelColor(label.color, theme);
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-medium"
      style={{ color, background: alpha(14, color), border: `1px solid ${alpha(42, color)}` }}
      title={label.description ?? undefined}
    >
      {label.name}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove label ${label.name}`}
        className="flex cursor-pointer items-center opacity-70 hover:opacity-100"
      >
        <CloseIcon size={9} />
      </button>
    </span>
  );
}

/** The add/remove-labels dropdown body: a filter box over the repo's palette, each
 *  row a toggle (checked when currently assigned). */
function LabelPicker({
  labels,
  assigned,
  onToggle,
}: {
  labels: PrLabel[];
  assigned: Set<string>;
  onToggle: (label: PrLabel) => void;
}) {
  const [q, setQ] = useState("");
  const filtered = labels.filter((l) => l.name.toLowerCase().includes(q.toLowerCase().trim()));
  return (
    <div>
      <div className="border-b border-line-3 p-1.5">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter labels…"
          className="w-full rounded border border-line-3 bg-input px-2 py-1 text-[11.5px] text-fg-2 outline-none focus:border-line-strong"
        />
      </div>
      <div className="max-h-64 overflow-y-auto py-1">
        {filtered.length === 0 ? (
          <div className="px-3 py-2 text-[11.5px] text-muted-3">No labels.</div>
        ) : (
          filtered.map((l) => (
            <button key={l.name} type="button" onClick={() => onToggle(l)} className={MENU_ITEM}>
              <span
                className="h-2.5 w-2.5 flex-none rounded-full"
                style={{ background: `#${l.color}` }}
              />
              <span className="min-w-0 flex-1 truncate" title={l.description ?? undefined}>
                {l.name}
              </span>
              {assigned.has(l.name) && <CheckIcon size={12} className="flex-none text-accent" />}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

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

/** One raw-log line, tinted by level. Empty lines keep their height so blank
 *  runs in the log read the way they do on GitHub. */
function LogLine({ text, level }: { text: string; level: CheckLogLevel }) {
  return (
    <div className="px-3 break-words whitespace-pre-wrap" style={{ color: logLevelColor[level] }}>
      {text || " "}
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
                  Earlier lines omitted —{" "}
                  {url ? (
                    <button
                      type="button"
                      onClick={() => openUrl(url)}
                      className="cursor-pointer underline hover:text-fg-2"
                    >
                      open full log on GitHub
                    </button>
                  ) : (
                    "see the full log on GitHub"
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

function CheckGroup({ checks, owner, name }: { checks: PrCheck[]; owner: string; name: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      {checks.map((c, i) => (
        <CheckRow key={`${c.name}-${i}`} check={c} owner={owner} name={name} />
      ))}
    </div>
  );
}

/** Flatten a fetched CheckLog back into plain text for the AI fix prompt: loose
 *  lines verbatim, group sections as a title + indented body. */
function checkLogToText(log: CheckLog): string {
  return log.blocks
    .map((b) =>
      b.kind === "line" ? b.text : [b.title, ...b.lines.map((l) => `  ${l.text}`)].join("\n"),
    )
    .join("\n");
}

/** "Fix CI with AI": find-or-create the PR's worktree (checked out on its head
 *  branch), write a CI-fix prompt from the failing job logs, then hand off to the
 *  Trees tab which opens a Fix-CI Claude tab (commit/push denied — the user does
 *  that from Trees). Enabled only when there's a failed check with a fetchable
 *  Actions job log. */
function FixCiButton({
  pr,
  santreeRepo,
  failed,
}: {
  pr: ReviewPr;
  santreeRepo: string;
  failed: PrCheck[];
}) {
  const [owner, name] = splitRepoSlug(pr.repo);
  const { requestFixCiLaunch, addPendingLaunches, removePendingLaunch } = useAppUi();
  const navigate = useNavigate();
  const qc = useQueryClient();

  // Only failed checks whose Actions job log we can actually fetch are useful.
  const fixable = failed.filter((c) => c.jobId != null);
  if (fixable.length === 0) return null;

  // Land in Trees at once and reconcile in the background — the worktree create, a
  // log fetch per failing job, and the prompt render are seconds of round-trips, and
  // every other launch path in the app navigates first rather than holding the user
  // on a spinner. The Fix-CI tab opens itself once the prompt file exists (Trees
  // waits on `fixCiLaunch`); until then the sidebar shows the usual "Creating
  // workspace…" placeholder.
  function run() {
    const issueId = ticketIdFor(pr) ?? `pr-${pr.number}`;
    addPendingLaunches([{ id: issueId, title: pr.title, project: null, agent: "Claude" }]);
    navigate({ to: "/trees" });

    void (async () => {
      try {
        // Find-or-create a worktree on the PR's head branch (so the fix lands there).
        const worktree = await unwrap(
          commands.createWorktreeForPr(santreeRepo, issueId, pr.title, pr.headRef, null, "Claude"),
        );
        // Let the Trees list pick up the new worktree so its Fix-CI launch effect fires.
        await qc.invalidateQueries({ queryKey: queryKeys.worktrees(santreeRepo) });
        // Gather each failing job's log and label it by check name.
        const logs = await Promise.all(
          fixable.map(async (c) => {
            const log = await unwrap(commands.prCheckLog(owner, name, c.jobId));
            return `### ${c.name}\n\n${checkLogToText(log)}`;
          }),
        );
        const promptPath = await unwrap(
          commands.fixCiPrompt(santreeRepo, issueId, logs.join("\n\n")),
        );
        requestFixCiLaunch({ worktreeId: worktree.id, tabId: crypto.randomUUID(), promptPath });
      } catch (e) {
        removePendingLaunch(issueId);
        toast.error(e instanceof Error ? e.message : "Couldn't start the CI fix.");
      }
    })();
  }

  return (
    <Button size="sm" onClick={run} title="Fix the failing checks with Claude">
      <ClaudeSparkIcon size={11} />
      Fix CI with AI
    </Button>
  );
}

/** The PR's individual CI checks (head commit's check runs + status contexts),
 *  grouped by outcome: failed first, then running, then passed; skipped/other
 *  collapsed at the bottom (they're rarely what you're looking for). */
function ChecksPane({ pr }: { pr: ReviewPr }) {
  const [owner, name] = splitRepoSlug(pr.repo);
  const { repo: santreeRepo } = useReviewsModel();
  const { data: detail, isLoading } = usePrDetail(owner, name, pr.number);
  // Section keys that are collapsed. The skipped/neutral group starts collapsed.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(["skipped"]));

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

  const of = (s: CheckStatus) => checks.filter((c) => c.status === s);
  // Build the sections that actually have checks, most-actionable first; skipped
  // + other non-pass/fail outcomes collapse into one trailing "skipped" group.
  const groups: { key: string; color: string; glyph: string; label: string; checks: PrCheck[] }[] =
    [];
  for (const s of ["Failure", "Pending", "Success"] as CheckStatus[]) {
    const list = of(s);
    if (list.length > 0) {
      const m = checkStatusMeta[s];
      groups.push({ key: s, color: m.color, glyph: m.glyph, label: m.label, checks: list });
    }
  }
  const skipped = [...of("Skipped"), ...of("Neutral")];
  if (skipped.length > 0) {
    const m = checkStatusMeta.Skipped;
    groups.push({
      key: "skipped",
      color: m.color,
      glyph: m.glyph,
      label: "skipped",
      checks: skipped,
    });
  }

  const allKeys = groups.map((g) => g.key);
  const toggle = (key: string, all: boolean) => {
    setCollapsed((prev) => {
      // ⌘/Ctrl-click: mirror this section's resulting state onto every section —
      // collapsing an expanded one collapses all; expanding a collapsed one expands all.
      if (all) return prev.has(key) ? new Set() : new Set(allKeys);
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const failed = of("Failure");

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

/** The linked Linear ticket for the PR — same shared discussion view the Trees
 *  "Issue" tab uses. `ticketId` is null when the PR title has no ticket tag. */
function ReviewIssuePane({ repo, ticketId }: { repo: string; ticketId: string | null }) {
  const { data: detail } = useTriageDetail(repo, ticketId);
  // Guard against flashing the previous ticket's body while a new one loads.
  const ready = ticketId && detail?.id === ticketId ? detail : undefined;

  if (!ticketId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-app">
        <EmptyState
          title="No linked ticket"
          subtitle="This PR's title has no ticket id (e.g. [AK-123])."
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-app">
      <div className="flex-none border-b border-hairline px-5 pt-4 pb-3.5">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="font-mono text-[11px] text-muted-2">{ticketId}</span>
          {ready && (
            <span className="flex items-center gap-1.5 text-[11px] text-muted-2">
              <Dot color={priorityColor[ready.priority]} size={7} />
              {ready.state}
            </span>
          )}
          {ready && (
            <Button
              size="sm"
              onClick={() => openUrl(ready.url)}
              title="Open in Linear"
              className="ml-auto"
            >
              <LinearLogo size={11} className="text-[color:var(--linear-brand)]" />
              Open
            </Button>
          )}
        </div>
        <div className="text-[15px] leading-[1.3] font-semibold text-fg-bright">
          {ready?.title ?? ticketId}
        </div>
        {ready && (
          <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[10.5px] text-muted-3">
            <span className="flex items-center gap-1.5">
              <Avatar name={ready.author} src={ready.authorAvatarUrl} size={15} />
              {ready.author}
            </span>
            <span className="text-muted-5">·</span>
            <RelativeTime ms={ready.createdAtMs} />
            {ready.labels.map((l) => (
              <span
                key={l}
                className="rounded border border-line-2 bg-input px-1.5 py-px font-mono text-[9.5px] text-muted-2"
              >
                {l}
              </span>
            ))}
          </div>
        )}
      </div>
      {ready ? <DiscussionPane detail={ready} repo={repo} /> : <DiscussionSkeleton />}
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
