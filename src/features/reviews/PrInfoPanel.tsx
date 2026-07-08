/**
 * The Reviews tab's full-height right rail: the selected PR's description and
 * top-level conversation (issue comments + review summaries), plus any inline
 * threads whose file isn't in the diff. It spans the whole detail area — header,
 * tabs, and body — so the description stays readable while you move between the
 * Pull request / Checks / Issue tabs. Collapsible + resizable (drag its left edge
 * or ⌘L); when collapsed it renders nothing (the header's panel button / ⌘L bring
 * it back). Reuses the already-cached `usePrDetail` fetch, so it's free here.
 */
import type { PrComment, ReviewPr } from "../../bindings";
import { Avatar } from "../../components/Avatar";
import { Markdown } from "../../components/Markdown";
import { EdgeResizeHandle } from "../../components/primitives";
import { usePrDetail } from "../../lib/queries";
import { useEdgeResize } from "../../lib/useEdgeResize";
import { useReviewsModel } from "./model";
import { PrThreadCard } from "./PrThreadCard";

const DEFAULT_W = 400;
const MIN_W = 300;
const MAX_W = 760;

function splitRepo(slug: string): [string, string] {
  const [owner, ...rest] = slug.split("/");
  return [owner, rest.join("/")];
}

export function PrInfoPanel({ pr }: { pr: ReviewPr }) {
  const { infoCollapsed, toggleInfo, infoWidth, setInfoWidth } = useReviewsModel();
  const [owner, name] = splitRepo(pr.repo);
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
        <SidebarLabel>Description</SidebarLabel>
        <Markdown>{detail?.body?.trim() || "_No description._"}</Markdown>
        {orphanThreads.length > 0 && (
          <div className="mt-6 border-t border-hairline pt-4">
            <SidebarLabel>Comments on other files</SidebarLabel>
            <div className="overflow-hidden rounded-lg border border-line-2">
              {orphanThreads.map((t, i) => (
                <PrThreadCard key={`${t.path}:${t.line}:${i}`} thread={t} />
              ))}
            </div>
          </div>
        )}
        <Conversation comments={detail?.comments ?? []} />
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
 *  review threads render in the diff, not here). */
function Conversation({ comments }: { comments: PrComment[] }) {
  if (comments.length === 0) return null;
  return (
    <div className="mt-6 border-t border-hairline pt-4">
      <SidebarLabel>Conversation</SidebarLabel>
      <div className="flex flex-col gap-3">
        {comments.map((c, i) => (
          <div key={`${c.author}-${c.createdAt}-${i}`} className="flex gap-2">
            <Avatar name={c.author} src={c.authorAvatarUrl} size={20} />
            <div className="min-w-0 flex-1 rounded-lg border border-line-2 bg-raised px-3 py-2">
              <div className="mb-1 flex items-center gap-2 text-[11px]">
                <span className="font-medium text-fg-2">{c.author}</span>
                {c.kind === "Review" && <span className="text-muted-4">reviewed</span>}
              </div>
              <Markdown>{c.body}</Markdown>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
