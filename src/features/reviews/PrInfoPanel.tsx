/**
 * The Reviews tab's full-height right rail: the AI {@link ReviewBriefSection}, the
 * selected PR's description and top-level conversation (issue comments + review
 * summaries), plus any inline threads whose file isn't in the diff. It spans the
 * whole detail area — header, tabs, and body — so the brief's reading order and
 * the description stay beside you while you move between the Pull request /
 * Checks / Issue tabs. Collapsible + resizable (drag its left edge or ⌘L); when
 * collapsed it renders nothing (the header's panel button / ⌘L bring it back).
 * Reuses the already-cached `usePrDetail` fetch, so it's free here.
 */
import type { PrComment, ReviewPr } from "../../bindings";
import { Avatar } from "../../components/Avatar";
import { Markdown } from "../../components/Markdown";
import { EdgeResizeHandle } from "../../components/primitives";
import { RelativeTime } from "../../components/RelativeTime";
import { useAddPrConversationComment, usePrDetail } from "../../lib/queries";
import { isoMs } from "../../lib/relativeTime";
import { splitRepoSlug } from "../../lib/repo";
import { useEdgeResize } from "../../lib/useEdgeResize";
import { CommentComposer } from "./CommentComposer";
import { useReviewsModel } from "./model";
import { PrThreadCard } from "./PrThreadCard";
import { ReviewBriefSection } from "./ReviewBriefSection";

const DEFAULT_W = 400;
const MIN_W = 300;
const MAX_W = 760;

export function PrInfoPanel({ pr }: { pr: ReviewPr }) {
  const { infoCollapsed, toggleInfo, infoWidth, setInfoWidth } = useReviewsModel();
  const [owner, name] = splitRepoSlug(pr.repo);
  const { data: detail } = usePrDetail(owner, name, pr.number);

  const resize = useEdgeResize({
    cssVar: "--rev-right",
    width: infoWidth,
    min: MIN_W,
    max: MAX_W,
    edge: "left",
    onCommit: setInfoWidth,
    collapse: { at: 200, resetTo: DEFAULT_W, onCollapse: toggleInfo },
  });

  // Fully hidden when collapsed — the header's panel button (⌘L) brings it back.
  if (infoCollapsed) return null;

  const files = new Set((detail?.files ?? []).map((f) => f.path));
  const orphanThreads = (detail?.threads ?? []).filter((t) => !files.has(t.path));

  return (
    <div
      className="relative flex flex-none flex-col overflow-hidden border-l border-hairline bg-deep"
      style={{ width: `var(--rev-right, ${DEFAULT_W}px)` }}
    >
      <EdgeResizeHandle edge="left" {...resize} />
      <div className="selectable min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <ReviewBriefSection pr={pr} />
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
        <Conversation pr={pr} comments={detail?.comments ?? []} />
      </div>
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
