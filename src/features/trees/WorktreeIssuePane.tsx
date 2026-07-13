/**
 * The Trees "Issue" tab: the Linear issue a worktree is for, rendered like the
 * Triage detail — id · status · title · author/labels, then the description and
 * comment thread. Read-only context for the work happening in the worktree.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef } from "react";

import type { Worktree } from "../../bindings";
import { Avatar } from "../../components/Avatar";
import { DiscussionPane, DiscussionSkeleton } from "../../components/IssueDiscussion";
import { LinearLogo } from "../../components/icons";
import { Button, Dot } from "../../components/primitives";
import { RelativeTime } from "../../components/RelativeTime";
import { useSetWorktreeTitle, useTriageDetail } from "../../lib/queries";
import { statusColor, statusLabel } from "../../theme/colors";

export function WorktreeIssuePane({ repo, worktree }: { repo: string; worktree: Worktree }) {
  const { data: detail } = useTriageDetail(repo, worktree.id);
  // Only treat the fetched detail as this issue's once its id matches (avoids
  // flashing the previous worktree's body while a new one loads).
  const ready = detail?.id === worktree.id ? detail : undefined;

  // Self-heal the stored title: when the live Linear title differs from what's
  // cached on the worktree (imported/renamed tickets), persist it so the sidebar
  // card stays accurate. Once per view — this pane is keyed by worktree id.
  const { mutate: refreshTitle } = useSetWorktreeTitle(repo);
  const healed = useRef(false);
  useEffect(() => {
    const live = ready?.title;
    if (!live || healed.current || live === worktree.title) return;
    healed.current = true;
    refreshTitle({ id: worktree.id, title: live });
  }, [ready?.title, worktree.id, worktree.title, refreshTitle]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-app">
      <div className="flex-none border-b border-hairline px-5 pt-4 pb-3.5">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="font-mono text-[11px] text-muted-2">{worktree.id}</span>
          {/* No status when the ticket isn't in the current tasks fetch — the
              backend doesn't invent one, and neither does the UI. */}
          {worktree.status && (
            <span className="flex items-center gap-1.5 text-[11px] text-muted-2">
              <Dot color={statusColor[worktree.status]} size={7} />
              {statusLabel[worktree.status]}
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
          {ready?.title ?? worktree.title}
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
