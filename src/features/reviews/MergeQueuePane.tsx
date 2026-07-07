/**
 * The Reviews tab's merge-queue panel — shown in the detail pane when the "Merge
 * queue" sidebar button is active. Lists the PRs waiting to merge into the repo's
 * default branch, in queue order, highlighting the viewer's own PRs so they can
 * see where they sit in line. Data comes from `useMergeQueue` (the active repo's
 * default-branch queue); an empty/absent queue renders the relevant empty state.
 */
import { openUrl } from "@tauri-apps/plugin-opener";

import type { MergeQueueEntry } from "../../bindings";
import { Avatar } from "../../components/Avatar";
import { GitHubLogo } from "../../components/icons";
import { Button, Dot, EmptyState, Skeleton } from "../../components/primitives";
import { useMergeQueue } from "../../lib/queries";
import { alpha, mergeQueueStateMeta } from "../../theme/colors";
import { useReviewsModel } from "./model";

export function MergeQueuePane() {
  const { repo } = useReviewsModel();
  const { data: queue, isLoading, isError } = useMergeQueue(repo);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-app">
      <div className="flex-none border-b border-hairline px-5 py-3.5">
        <div className="flex items-center gap-2">
          <h1 className="text-[16px] font-semibold text-fg-bright">Merge queue</h1>
          {queue && queue.entries.length > 0 && (
            <span className="rounded-[5px] border border-line-2 bg-input-alt px-1.5 py-px font-mono text-[10.5px] text-muted-2">
              {queue.entries.length} in queue
            </span>
          )}
        </div>
        {queue && (
          <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-muted-3">
            <span>{queue.repo}</span>
            {queue.branch && (
              <>
                <span className="text-muted-4">→</span>
                <span>{queue.branch}</span>
              </>
            )}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {isLoading && !queue && <QueueSkeleton />}

        {isError && (
          <div className="mt-16">
            <EmptyState
              title="Couldn't load the merge queue"
              subtitle="GitHub returned an error. Check that gh is authenticated and try again."
            />
          </div>
        )}

        {!isLoading && !isError && !queue && (
          <div className="mt-16">
            <EmptyState
              title="No merge queue"
              subtitle="This repository doesn't have a merge queue enabled on its default branch."
            />
          </div>
        )}

        {queue && queue.entries.length === 0 && (
          <div className="mt-16">
            <EmptyState
              title="Queue is empty"
              subtitle="No pull requests are waiting to merge right now."
            />
          </div>
        )}

        {queue?.entries.map((e) => (
          <QueueRow key={`${e.prNumber}`} entry={e} />
        ))}
      </div>
    </div>
  );
}

function QueueRow({ entry }: { entry: MergeQueueEntry }) {
  const state = mergeQueueStateMeta[entry.state];
  return (
    <div
      className="mb-1.5 flex items-center gap-3 rounded-[10px] border px-3 py-2.5"
      style={
        entry.isMine
          ? { borderColor: alpha(45), background: alpha(8) }
          : { borderColor: "var(--color-line-2)", background: "transparent" }
      }
    >
      {/* Position in line — front of the queue is #1. */}
      <span
        className="flex h-6 w-6 flex-none items-center justify-center rounded-full font-mono text-[11px] font-semibold"
        style={
          entry.isMine
            ? { background: "var(--accent)", color: "var(--on-accent)" }
            : { background: "var(--color-input-alt)", color: "var(--color-muted-2)" }
        }
      >
        {entry.position}
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[11px] text-muted-3">#{entry.prNumber}</span>
          {entry.isMine && (
            <span
              className="rounded-[4px] px-1 font-mono text-[8.5px] uppercase"
              style={{ color: "var(--accent)", border: `1px solid ${alpha(40)}` }}
            >
              yours
            </span>
          )}
        </div>
        <span className="truncate text-[13px] leading-[1.3] text-fg-2">{entry.prTitle}</span>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-3">
          <Avatar name={entry.author} src={entry.authorAvatarUrl} size={14} />
          <span className="truncate">{entry.author}</span>
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

      <Button
        size="sm"
        onClick={() => openUrl(entry.prUrl)}
        title="Open on GitHub"
        className="flex-none"
      >
        <GitHubLogo size={11} />
      </Button>
    </div>
  );
}

function QueueSkeleton() {
  return (
    <div>
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="mb-1.5 flex items-center gap-3 rounded-[10px] border border-line-2 px-3 py-2.5"
        >
          <Skeleton className="h-6 w-6 rounded-full" />
          <div className="flex-1">
            <Skeleton className="mb-2 h-2.5 w-12" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        </div>
      ))}
    </div>
  );
}
