/**
 * The Reviews tab's full-height right rail — everything you consult *while*
 * reading a PR, in two tabs:
 *  - **Description** — the AI {@link ReviewBriefSection}, the PR's body and
 *    top-level conversation, plus any inline threads whose file isn't in the diff.
 *  - **Issue** — the linked Linear ticket, found from the PR title / branch (the
 *    same PR↔ticket convention the worktree flow uses).
 *
 * The rail spans the whole detail area — header, tabs, and body — so whichever of
 * these you're consulting stays *beside* the diff instead of replacing it. That's
 * why the ticket and the AI live here rather than in the main tab bar: a review is
 * the code read against its ticket, and a tab that hides the code to show the
 * ticket makes you flip back and forth to do it.
 *
 * Collapsible + resizable (drag its left edge or ⌘L). Reuses the already-cached
 * `usePrDetail` fetch, so the description costs nothing here.
 */
import { type CSSProperties, useRef } from "react";

import type { AgentKind, PrComment, ReviewPr } from "../../bindings";
import { Avatar } from "../../components/Avatar";
import { Markdown } from "../../components/Markdown";
import { EdgeResizeHandle, Tabs } from "../../components/primitives";
import { RelativeTime } from "../../components/RelativeTime";
import { useAddPrConversationComment, usePrDetail, useReviewDrafts } from "../../lib/queries";
import { isoMs } from "../../lib/relativeTime";
import { splitRepoSlug } from "../../lib/repo";
import { useEdgeResize } from "../../lib/useEdgeResize";
import { CommentComposer } from "./CommentComposer";
import { useReviewsModel } from "./model";
import { PrThreadCard } from "./PrThreadCard";
import { ReviewBriefSection } from "./ReviewBriefSection";
import { ReviewDraftCard } from "./ReviewDraftCard";
import { ReviewIssuePane } from "./ReviewIssuePane";
import { ReviewWorklist } from "./ReviewWorklist";
import { ticketIdFor } from "./ticket";
import { useStartWorkFromReviews } from "./useStartWork";

export type PanelTab = "description" | "issue";

const DEFAULT_W = 400;
const MIN_W = 300;
const MAX_W = 720;

export function PrInfoPanel({
  pr,
  tab,
  onTabChange,
  activeReviewAgent,
}: {
  pr: ReviewPr;
  tab: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  activeReviewAgent: AgentKind | null;
}) {
  const resizeTarget = useRef<HTMLDivElement>(null);
  const {
    infoCollapsed,
    toggleInfo,
    infoWidth,
    setInfoWidth,
    repo: santreeRepo,
    focusFile,
    openAiReview,
  } = useReviewsModel();
  const [owner, name] = splitRepoSlug(pr.repo);
  const { data: detail } = usePrDetail(owner, name, pr.number);
  const { data: drafts } = useReviewDrafts(pr.repo, pr.number);
  const ticketId = ticketIdFor(pr);
  // From here the PR has no worktree yet, so starting work creates one and
  // navigates to it — the Trees host skips both (see useStartWork).
  const startWork = useStartWorkFromReviews(pr, santreeRepo);

  const resize = useEdgeResize({
    cssVar: "--rev-right",
    target: resizeTarget,
    width: infoWidth,
    min: MIN_W,
    max: MAX_W,
    edge: "left",
    onCommit: setInfoWidth,
    collapse: { at: 200, resetTo: DEFAULT_W, onCollapse: toggleInfo },
  });

  const files = new Set((detail?.files ?? []).map((f) => f.path));
  const orphanThreads = (detail?.threads ?? []).filter((t) => !files.has(t.path));
  // A draft on a file the diff doesn't list at all (GitHub caps the file list, and
  // a push can drop a file). It has no card to sit under, so it surfaces here
  // rather than silently not existing.
  const orphanDrafts = (drafts ?? []).filter((d) => !files.has(d.path));

  return (
    <div
      ref={resizeTarget}
      className={`relative flex-none flex-col overflow-hidden border-l border-hairline bg-deep ${
        infoCollapsed ? "hidden" : "flex"
      }`}
      style={
        {
          "--rev-right": `${infoWidth}px`,
          width: `var(--rev-right, ${DEFAULT_W}px)`,
        } as CSSProperties
      }
    >
      <EdgeResizeHandle edge="left" {...resize} />

      <Tabs
        className="flex-none px-4"
        value={tab}
        onChange={onTabChange}
        tabs={[
          { value: "description", label: "Description" },
          { value: "issue", label: "Issue", dimmed: !ticketId },
        ]}
      />

      {tab === "description" && (
        <div className="selectable min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <ReviewWorklist
            pr={pr}
            detail={detail}
            drafts={drafts ?? []}
            onFocusFile={focusFile}
            onStartWork={startWork}
          />
          <ReviewBriefSection
            pr={pr}
            activeReviewAgent={activeReviewAgent}
            santreeRepo={santreeRepo}
            onJump={focusFile}
            onStartReview={openAiReview}
          />
          <SidebarLabel>Description</SidebarLabel>
          <Markdown>{detail?.body?.trim() || "_No description._"}</Markdown>
          {orphanThreads.length > 0 && (
            <div className="mt-6 border-t border-hairline pt-4">
              <SidebarLabel>Comments on other files</SidebarLabel>
              <div className="overflow-hidden rounded-lg border border-line-2">
                {orphanThreads.map((t, i) => (
                  <PrThreadCard
                    key={`${t.path}:${t.line}:${i}`}
                    thread={t}
                    prRepo={pr.repo}
                    number={pr.number}
                  />
                ))}
              </div>
            </div>
          )}
          {orphanDrafts.length > 0 && (
            <div className="mt-6 border-t border-hairline pt-4">
              <SidebarLabel>AI drafts on other files</SidebarLabel>
              <div className="overflow-hidden rounded-lg border border-line-2">
                {orphanDrafts.map((d) => (
                  <ReviewDraftCard
                    key={d.id}
                    draft={d}
                    target={{
                      prRepo: pr.repo,
                      number: pr.number,
                      prId: pr.id,
                      headSha: detail?.headSha ?? "",
                      pendingReviewId: detail?.pendingReviewId ?? null,
                    }}
                    stale={!!detail?.headSha && d.headSha !== detail.headSha}
                  />
                ))}
              </div>
            </div>
          )}
          <Conversation pr={pr} comments={detail?.comments ?? []} />
        </div>
      )}

      {tab === "issue" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <ReviewIssuePane repo={santreeRepo} ticketId={ticketId} />
        </div>
      )}
    </div>
  );
}

function SidebarLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2.5 font-mono text-[10px] tracking-[.06em] text-muted-4 uppercase">
      {children}
    </div>
  );
}

/** The PR's top-level conversation — issue comments and review summaries (inline
 *  review threads render in the diff, not here) — with the box to add to it.
 *
 *  The composer renders even on a PR nobody has commented on: "no conversation
 *  yet" is exactly when you want to start one. */
function Conversation({ pr, comments }: { pr: ReviewPr; comments: PrComment[] }) {
  const { mutate, isPending } = useAddPrConversationComment(pr.repo, pr.number);
  return (
    <div className="mt-6 border-t border-hairline pt-4">
      <SidebarLabel>Conversation</SidebarLabel>
      {comments.length > 0 && (
        <div className="mb-3 flex flex-col gap-3">
          {comments.map((c, i) => (
            <div key={`${c.author}-${c.createdAt}-${i}`} className="flex gap-2">
              <Avatar name={c.author} src={c.authorAvatarUrl} size={20} />
              <div className="min-w-0 flex-1 rounded-lg border border-line-2 bg-raised px-3 py-2">
                <div className="mb-1 flex items-center gap-2 text-[11px]">
                  <span className="font-medium text-fg-2">{c.author}</span>
                  {c.kind === "Review" && <span className="text-muted-4">reviewed</span>}
                  <RelativeTime
                    ms={isoMs(c.createdAt)}
                    className="ml-auto font-mono text-[9.5px] text-muted-4"
                  />
                </div>
                <Markdown>{c.body}</Markdown>
              </div>
            </div>
          ))}
        </div>
      )}
      <CommentComposer
        rows={3}
        pending={isPending}
        placeholder="Comment on this pull request…"
        primary={{
          label: "Comment",
          busyLabel: "Posting…",
          onSubmit: (body, done) => mutate(body, { onSuccess: done }),
        }}
      />
    </div>
  );
}
