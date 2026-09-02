/**
 * The Reviews tab's merge-queue panel — the detail pane when a project's "Merge
 * queue" row is the destination. Lists the PRs waiting to merge into the repo's
 * default branch, in queue order, highlighting the viewer's own so they can see
 * where they sit in line, and leads with what the queue is doing: how many are
 * in it, when the next one lands, and how much it has merged lately — the three
 * numbers GitHub's own queue page leads with.
 *
 * It reads as a page, not a pane: one centered column at reading width, the way
 * a pull request does, because it is looked at rather than worked in.
 *
 * Unlike the inbox in the rail, this question is scoped to a single repository —
 * so every state here names the `owner/name` it is about. Without that, "this
 * repository has no merge queue" sat beside an org-wide inbox showing another
 * repo's PRs, and neither said which repository it meant.
 */
import { useNavigate } from "@tanstack/react-router";
import { openUrl } from "@tauri-apps/plugin-opener";

import type { MergeQueue, MergeQueueEntry } from "../../bindings";
import { Avatar } from "../../components/Avatar";
import { GitHubLogo, MergeQueueIcon, PrIcon } from "../../components/icons";
import { Button, Dot, EmptyState, Skeleton } from "../../components/primitives";
import { RelativeTime } from "../../components/RelativeTime";
import { formatCompact } from "../../lib/format";
import { useMergeQueue } from "../../lib/queries";
import { formatDuration, isoMs } from "../../lib/relativeTime";
import { alpha, mergeQueueStateMeta } from "../../theme/colors";
import { GitHubNotConnected } from "./GitHubNotConnected";
import { useReviewsModel } from "./model";

export function MergeQueuePane() {
  const { repo } = useReviewsModel();
  const navigate = useNavigate();
  const { data: view, isLoading, isError } = useMergeQueue(repo);
  const queue = view?.queue ?? null;
  // The scope the header and both empty states are about. Falls back to santree's
  // own name for the repo when its `origin` isn't a GitHub remote we can parse —
  // an unnamed empty state is the defect, so never render one.
  const scope = view?.repo || repo;
  const count = queue?.entries.length ?? 0;

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-app">
      <div className="mx-auto w-full max-w-[760px] px-6 pt-8 pb-12">
        <div className="flex items-center gap-2.5">
          <MergeQueueIcon size={16} className="flex-none text-muted-3" />
          <h1 className="text-[18px] font-semibold text-fg-bright">Merge queue</h1>
          {queue?.branch && (
            <span className="rounded-[5px] border border-line-2 bg-input-alt px-1.5 py-px font-mono text-[11px] text-fg-2">
              {queue.branch}
            </span>
          )}
          {queue && (
            <Button
              size="sm"
              className="ml-auto"
              onClick={() => openUrl(queue.url)}
              title="Open the queue on GitHub"
            >
              <GitHubLogo size={11} />
              GitHub
            </Button>
          )}
        </div>
        <div className="mt-1 font-mono text-[11px] text-muted-3">{scope}</div>

        {queue && <QueueStats queue={queue} />}

        {isLoading && !queue && <QueueSkeleton />}

        {isError && (
          <div className="mt-16">
            <EmptyState
              title="Couldn't load the merge queue"
              subtitle="GitHub returned an error. Check that gh is authenticated and try again."
            />
          </div>
        )}

        {!isLoading && !isError && view && !view.githubConnected && (
          <div className="mt-16">
            <GitHubNotConnected
              onOpenSettings={() => navigate({ to: "/settings", search: { section: "github" } })}
            />
          </div>
        )}

        {!isLoading && !isError && view?.githubConnected && !queue && (
          <div className="mt-16">
            <EmptyState
              title="No merge queue"
              subtitle={`${scope} doesn't have a merge queue enabled on its default branch.`}
            />
          </div>
        )}

        {queue && count === 0 && (
          <div className="mt-16">
            <EmptyState
              title="Queue is empty"
              subtitle={`No pull requests are waiting to merge into ${scope} right now.`}
            />
          </div>
        )}

        {queue && count > 0 && (
          <div className="mt-5 overflow-hidden rounded-[10px] border border-line-2">
            <div className="flex items-center gap-2 border-b border-line bg-raised px-4 py-2 text-[11.5px] font-medium text-muted-2">
              <PrIcon size={12} className="text-muted-3" />
              {count} queued
            </div>
            {queue.entries.map((e) => (
              <QueueRow key={`${e.prNumber}`} entry={e} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** The queue's three numbers: what is in it, when the front of the line lands
 *  (GitHub's estimate — absent until the queue has merged enough to have one),
 *  and how much it has merged in the last 30 days. A dash, not a zero, for an
 *  estimate GitHub didn't give: "0s" would be a promise. */
function QueueStats({ queue }: { queue: MergeQueue }) {
  const cells = [
    { label: "In queue", value: String(queue.entries.length), hint: undefined },
    {
      label: "Next merge",
      value: queue.nextEstimatedSecs != null ? `~${formatDuration(queue.nextEstimatedSecs)}` : "—",
      hint: "GitHub's estimate for the entry at the front of the queue",
    },
    {
      label: "Merged · 30 days",
      value: queue.mergedLast30Days != null ? formatCompact(queue.mergedLast30Days) : "—",
      hint: `Pull requests merged into ${queue.repo} in the last 30 days`,
    },
  ];
  return (
    <dl className="mt-5 grid grid-cols-3 gap-px overflow-hidden rounded-[10px] border border-line-2 bg-line-2">
      {cells.map((cell) => (
        <div key={cell.label} className="bg-app px-4 py-3" title={cell.hint}>
          <dt className="text-[10px] font-medium tracking-[0.06em] text-muted-4 uppercase">
            {cell.label}
          </dt>
          <dd className="mt-1.5 font-mono text-[20px] leading-none font-semibold text-fg-bright tabular-nums">
            {cell.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function QueueRow({ entry }: { entry: MergeQueueEntry }) {
  const state = mergeQueueStateMeta[entry.state];
  const enqueued = isoMs(entry.enqueuedAt);
  return (
    <div
      className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
      style={entry.isMine ? { background: alpha(6) } : undefined}
    >
      {/* Position in line — front of the queue is #1. */}
      <span
        className="flex h-6 w-6 flex-none items-center justify-center rounded-full font-mono text-[11px] font-semibold"
        style={
          entry.isMine
            ? { background: "var(--accent-fill)", color: "var(--on-accent)" }
            : { background: "var(--color-input-alt)", color: "var(--color-muted-2)" }
        }
      >
        {entry.position}
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <button
          type="button"
          onClick={() => openUrl(entry.prUrl)}
          title="Open on GitHub"
          className="min-w-0 cursor-pointer truncate text-left text-[13px] leading-[1.3] font-medium text-fg hover:underline"
        >
          {entry.prTitle}
        </button>
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-3">
          <span className="font-mono">#{entry.prNumber}</span>
          {entry.isMine && (
            <span
              className="rounded-[4px] px-1 font-mono text-[8.5px] uppercase"
              style={{ color: "var(--accent-text)", border: `1px solid ${alpha(40)}` }}
            >
              yours
            </span>
          )}
          <span className="text-muted-4">·</span>
          <Avatar name={entry.author} src={entry.authorAvatarUrl} size={14} />
          <span className="truncate">{entry.author}</span>
          {enqueued !== null && (
            <>
              <span className="text-muted-4">·</span>
              <span className="whitespace-nowrap">
                enqueued <RelativeTime ms={enqueued} />
              </span>
            </>
          )}
          {entry.estimatedSecs != null && (
            <>
              <span className="text-muted-4">·</span>
              <span className="whitespace-nowrap">
                ~{formatDuration(entry.estimatedSecs)} to merge
              </span>
            </>
          )}
        </div>
      </div>

      {state.label && (
        <span
          className="flex flex-none items-center gap-1.5 font-mono text-[10.5px]"
          style={{ color: state.color }}
          title={state.label}
        >
          <Dot color={state.color} size={6} />
          {state.label}
        </span>
      )}
    </div>
  );
}

function QueueSkeleton() {
  return (
    <div className="mt-5 overflow-hidden rounded-[10px] border border-line-2">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
        >
          <Skeleton className="h-6 w-6 rounded-full" />
          <div className="flex-1">
            <Skeleton className="mb-2 h-3 w-3/5" />
            <Skeleton className="h-2.5 w-2/5" />
          </div>
        </div>
      ))}
    </div>
  );
}
