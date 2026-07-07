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
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";

import type { CheckStatus, PrCheck, PrComment, Reviewer, ReviewPr } from "../../bindings";
import { Avatar } from "../../components/Avatar";
import { DiscussionPane, DiscussionSkeleton } from "../../components/IssueDiscussion";
import {
  AgentsIcon,
  BranchIcon,
  ChevronDownIcon,
  CopyIcon,
  GitHubLogo,
  LinearLogo,
} from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { Button, Dot, EmptyState, Pill, Skeleton, Tabs } from "../../components/primitives";
import { RelativeTime } from "../../components/RelativeTime";
import { usePrDetail, useTriageDetail } from "../../lib/queries";
import { toast } from "../../state/toast";
import {
  checkRollupMeta,
  checkStatusMeta,
  mergeQueueMeta,
  priorityColor,
  reviewDecisionMeta,
} from "../../theme/colors";
import { DiffViewer } from "../trees/DiffViewer";
import { MergeQueuePane } from "./MergeQueuePane";
import { useReviewsModel } from "./model";

type DetailTab = "pr" | "checks" | "issue";

/** Split an "owner/name" slug into its parts. */
function splitRepo(slug: string): [string, string] {
  const [owner, ...rest] = slug.split("/");
  return [owner, rest.join("/")];
}

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
  return <PrPane key={active.id} pr={active} />;
}

function PrPane({ pr }: { pr: ReviewPr }) {
  const { repo: santreeRepo } = useReviewsModel();
  const [tab, setTab] = useState<DetailTab>("pr");
  const ticketId = ticketIdFor(pr);
  const decision = reviewDecisionMeta[pr.reviewDecision];
  const checks = checkRollupMeta[pr.checks];

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-app">
      {/* Shared header — identity on the left, actions on the right; each row
          spans the full width rather than stacking everything on one side. */}
      <div className="flex-none border-b border-hairline px-5 py-3.5">
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

      {tab === "pr" && <PrBody pr={pr} />}
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

function PrBody({ pr }: { pr: ReviewPr }) {
  const [owner, name] = splitRepo(pr.repo);
  const { data: detail, isLoading } = usePrDetail(owner, name, pr.number);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="selectable min-w-0 flex-1 overflow-y-auto px-5 py-4">
        {isLoading ? (
          <BodySkeleton />
        ) : (
          <>
            <Markdown>{detail?.body?.trim() || "_No description._"}</Markdown>
            <Conversation comments={detail?.comments ?? []} />
          </>
        )}
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto border-l border-hairline px-4 py-4">
        <div className="mb-2.5 font-mono text-[10px] tracking-[.06em] text-muted-4 uppercase">
          Changed files
        </div>
        {isLoading ? (
          <BodySkeleton />
        ) : detail && detail.files.length > 0 ? (
          detail.files.map((f) => (
            <div key={f.path} className="mb-3 overflow-hidden rounded-lg border border-line-2">
              <div className="flex items-center gap-2 border-b border-line-2 bg-raised px-3 py-1.5 font-mono text-[11px]">
                <span className="min-w-0 flex-1 truncate text-fg-2">{f.path}</span>
                <span className="flex-none text-muted-4">
                  <span className="text-status-green">+{f.additions}</span>{" "}
                  <span className="text-status-red">−{f.deletions}</span>
                </span>
              </div>
              <DiffViewer path={f.path} diff={f.patch ?? ""} oldText="" newText="" mode="unified" />
            </div>
          ))
        ) : (
          <EmptyState title="No file changes" />
        )}
      </div>
    </div>
  );
}

/** One CI check row — links to the run's details page when one is available. */
function CheckRow({ check }: { check: PrCheck }) {
  const m = checkStatusMeta[check.status];
  const inner = (
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
  const cls =
    "flex items-center gap-2.5 rounded-md border border-line-2 bg-input px-3 py-2 text-left";
  return check.url ? (
    <button
      type="button"
      onClick={() => openUrl(check.url as string)}
      title="Open check details"
      className={`${cls} w-full cursor-pointer hover:border-line-strong`}
    >
      {inner}
    </button>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

function CheckGroup({ checks }: { checks: PrCheck[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {checks.map((c, i) => (
        <CheckRow key={`${c.name}-${i}`} check={c} />
      ))}
    </div>
  );
}

/** The PR's individual CI checks (head commit's check runs + status contexts),
 *  grouped by outcome: failed first, then running, then passed; skipped/other
 *  collapsed at the bottom (they're rarely what you're looking for). */
function ChecksPane({ pr }: { pr: ReviewPr }) {
  const [owner, name] = splitRepo(pr.repo);
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

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
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
            {!isCollapsed && <CheckGroup checks={g.checks} />}
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

function Conversation({ comments }: { comments: PrComment[] }) {
  if (comments.length === 0) return null;
  return (
    <div className="mt-6 border-t border-hairline pt-4">
      <div className="mb-3 font-mono text-[10px] tracking-[.06em] text-muted-4 uppercase">
        Conversation
      </div>
      <div className="flex flex-col gap-3.5">
        {comments.map((c, i) => (
          <div key={`${c.author}-${c.createdAt}-${i}`} className="flex gap-2.5">
            <Avatar name={c.author} src={c.authorAvatarUrl} size={22} />
            <div className="min-w-0 flex-1 rounded-lg border border-line-2 bg-raised px-3 py-2">
              <div className="mb-1 flex items-center gap-2 text-[11px]">
                <span className="font-medium text-fg-2">{c.author}</span>
                {c.kind === "Review" && <span className="text-muted-4">reviewed</span>}
                {c.kind === "ReviewThread" && c.path && (
                  <span className="truncate font-mono text-[10px] text-muted-4">{c.path}</span>
                )}
              </div>
              <Markdown>{c.body}</Markdown>
            </div>
          </div>
        ))}
      </div>
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
