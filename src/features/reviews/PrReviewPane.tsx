/**
 * The "Pull request" tab body: a wide, scrollable column of per-file diffs — each
 * a collapsible card with a GitHub-style "Viewed" checkbox — with review comments
 * anchored inline. The PR description and conversation are the
 * {@link PrConversationPane} tab beside this one, not here.
 *
 * Comments are written here too: every diff line carries GitHub's `+` button, and
 * anything left as a draft is held in the viewer's pending review until the
 * {@link ReviewSubmitBar} at the foot of the pane sends it. The AI review's own
 * drafts sit inline beside them, in santree rather than on GitHub, until the
 * {@link ReviewDraftsBar} adds the ones the user keeps to that same review.
 *
 * A marked file collapses and stays marked across sessions, but re-expands the
 * moment a new commit changes it — so you always re-review what actually changed.
 * Which store holds the mark is a setting: this machine's table (where the rule is
 * enforced here, by comparing the file's blob SHA against the one the mark was made
 * at) or GitHub's own per-viewer state (the same checkbox as the github.com Files
 * tab, where GitHub enforces the rule for us). The toggle mutation lives here (a
 * stable parent) rather than in the card, which unmounts when collapsed.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PrFile, PrThread, ReviewDraft, ReviewPr } from "../../bindings";
import { AgentIcon, ChevronDownIcon, MessageSquareIcon, WarningIcon } from "../../components/icons";
import { EmptyState, Skeleton } from "../../components/primitives";
import { BULK_TOGGLE_HINT, isBulkToggle } from "../../lib/disclosure";
import {
  usePrDetail,
  usePrFileSource,
  useReviewDrafts,
  useReviewedFiles,
  useSetFileReviewed,
} from "../../lib/queries";
import { splitRepoSlug } from "../../lib/repo";
import { palette } from "../../theme/colors";
import type { CommentTarget } from "./commentTarget";
import type { FileFocus } from "./model";
import { PrFileBody, UnplaceableDrafts } from "./PrFileBody";
import { splitDrafts } from "./prFilePlacement";
import { ReviewDraftsBar } from "./ReviewDraftsBar";
import { draftCount, ReviewSubmitBar } from "./ReviewSubmitBar";

/** GitHub's lowercase file-status strings → a status letter + tint. */
const STATUS_META: Record<string, { letter: string; color: string }> = {
  added: { letter: "A", color: "var(--color-status-green)" },
  modified: { letter: "M", color: "var(--color-status-amber)" },
  changed: { letter: "M", color: "var(--color-status-amber)" },
  removed: { letter: "D", color: "var(--color-status-red)" },
  renamed: { letter: "R", color: "var(--color-status-blue)" },
  copied: { letter: "C", color: "var(--color-status-blue)" },
};

/** One shared empty array for thread-less files — a fresh `[]` literal per render
 *  would be a new reference and defeat {@link PrFileCard}'s memo. */
const NO_THREADS: PrThread[] = [];
const NO_DRAFTS: ReviewDraft[] = [];

export function PrReviewPane({
  pr,
  fileFocus = null,
}: {
  pr: ReviewPr;
  /** A jump request from the review brief. Passed in rather than read from the
   *  model so this pane stays renderable on its own (as its tests do). */
  fileFocus?: FileFocus | null;
}) {
  const [owner, name] = splitRepoSlug(pr.repo);
  const { data: detail, isLoading } = usePrDetail(owner, name, pr.number);
  const { data: marks } = useReviewedFiles(pr.repo, pr.number);
  const { data: aiDrafts } = useReviewDrafts(pr.repo, pr.number);
  const { mutate: setReviewed } = useSetFileReviewed(pr.repo, pr.number, pr.id);

  // Which staleness rule applies depends on where the marks came from, so it can't
  // be decided here — the backend says. Local marks are stored against a blob SHA
  // and expire when the file changes; GitHub's own marks already did that work
  // (a changed file comes back DISMISSED, so it isn't in `paths` at all) and would
  // be wrongly cleared by a second SHA check, since no SHA is carried.
  const isViewed = useMemo(() => {
    if (!marks) return () => false;
    if (marks.source === "synced") {
      const paths = new Set(marks.paths);
      return (f: PrFile) => paths.has(f.path);
    }
    const sha = new Map(marks.files.map((r) => [r.path, r.sha]));
    return (f: PrFile) => sha.get(f.path) === f.sha;
  }, [marks]);

  const files = detail?.files ?? [];
  const threadsByPath = useMemo(() => {
    const m = new Map<string, PrThread[]>();
    for (const t of detail?.threads ?? []) {
      const arr = m.get(t.path);
      if (arr) arr.push(t);
      else m.set(t.path, [t]);
    }
    return m;
  }, [detail?.threads]);

  const draftsByPath = useMemo(() => {
    const m = new Map<string, ReviewDraft[]>();
    for (const d of aiDrafts ?? []) {
      const arr = m.get(d.path);
      if (arr) arr.push(d);
      else m.set(d.path, [d]);
    }
    return m;
  }, [aiDrafts]);

  const reviewedCount = files.filter(isViewed).length;

  // Every file card takes this, and every card is memoized — so it's built from
  // the *fields* rather than from `pr`/`detail` themselves. `useReviews` hands
  // back a fresh ReviewPr object on each 30s poll, and keying on that identity
  // would mint a new target and re-lay-out every diff in the list.
  const { repo: prRepo, number: prNumber, id: prId } = pr;
  const headSha = detail?.headSha ?? "";
  const pendingReviewId = detail?.pendingReviewId ?? null;
  const target = useMemo<CommentTarget>(
    () => ({ prRepo, number: prNumber, prId, headSha, pendingReviewId }),
    [prRepo, prNumber, prId, headSha, pendingReviewId],
  );
  const drafts = draftCount(detail);

  // Takes the file rather than closing over it, so every card gets the same handler
  // reference — a per-file closure would re-render (and re-lay-out) the whole list
  // on any toggle or check-poll.
  const onToggle = useCallback(
    (file: PrFile, rev: boolean) => setReviewed({ path: file.path, sha: file.sha, reviewed: rev }),
    [setReviewed],
  );

  // Whose chevron has been clicked, and to what. A card's default is its viewed
  // mark; this is only the *overrides*, so a file that gets marked viewed later
  // still folds on its own. Lifted out of the cards because ⌘-click has to reach
  // all of them at once, which local state can't do (see `lib/disclosure`).
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  // What a ⌘-click on any chevron reaches. Read at call time so `onFold` keeps
  // one identity — the cards are memoized on it.
  const filesRef = useRef(files);
  filesRef.current = files;
  const onFold = useCallback((path: string, next: boolean, bulk: boolean) => {
    setFolded((current) => {
      const out = { ...current, [path]: next };
      if (bulk) for (const f of filesRef.current) out[f.path] = next;
      return out;
    });
  }, []);

  // A jump from the review brief: scroll that file's card into view and force it
  // open, even if it's marked viewed. `nonce` (not the path) is the dependency, so
  // clicking the same entry twice re-scrolls instead of being a silent no-op.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [forcedOpen, setForcedOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!fileFocus) return;
    setForcedOpen(fileFocus.path);
    // Wait a frame: the card may have been collapsed until this render, so its
    // final height (and therefore its offset) isn't settled yet.
    const id = requestAnimationFrame(() => {
      scrollRef.current
        ?.querySelector(`[data-path="${CSS.escape(fileFocus.path)}"]`)
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(id);
  }, [fileFocus]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The one pane that does NOT take the page's reading column. The others
          hold prose, which is unreadable run wide; this is a file list and a
          diff, which are unreadable run narrow — an 880px cap on a maximised
          window left a third of it empty beside code that was wrapping and
          scrolling sideways to fit.
          Full-bleed, with no page inset either: every row is a raised band, so
          any margin around the stack draws two vertical edges the file list
          then reads as a framed card floating in the pane. The rows keep their
          own padding, so it is only the bands that reach the edges — the same
          way the rule under the tab strip is the page's and spans it. */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <FilesSkeleton />
        ) : files.length > 0 ? (
          <>
            <div className="flex items-center gap-2 border-b border-hairline px-4 py-2 font-mono text-[10.5px] text-muted-3">
              <span className="tracking-[.04em] uppercase">
                {reviewedCount} / {files.length} files viewed
              </span>
              <span
                role="progressbar"
                aria-label={`${reviewedCount} of ${files.length} files viewed`}
                aria-valuemin={0}
                aria-valuemax={files.length}
                aria-valuenow={reviewedCount}
                className="h-[3px] w-16 overflow-hidden rounded-full bg-line-2"
              >
                <span
                  className="block h-full rounded-full bg-accent transition-[width]"
                  style={{ width: `${files.length ? (reviewedCount / files.length) * 100 : 0}%` }}
                />
              </span>
              {/* The file list is capped. Say so — marking every *listed* file viewed
                  on a truncated list means approving a diff you never saw. */}
              {detail?.filesTruncated && (
                <span
                  className="ml-auto flex items-center gap-1 normal-case"
                  style={{ color: palette.amber }}
                >
                  <WarningIcon size={11} />
                  Showing the first {files.length} files. This PR has more.
                </span>
              )}
            </div>
            {files.map((f) => (
              <PrFileCard
                key={f.path}
                owner={owner}
                name={name}
                base={detail?.baseSha ?? ""}
                head={detail?.headSha ?? ""}
                file={f}
                threads={threadsByPath.get(f.path) ?? NO_THREADS}
                drafts={draftsByPath.get(f.path) ?? NO_DRAFTS}
                target={target}
                reviewed={isViewed(f)}
                folded={folded[f.path]}
                forceOpen={forcedOpen === f.path}
                onFold={onFold}
                onToggle={onToggle}
              />
            ))}
          </>
        ) : (
          <EmptyState title="No file changes" />
        )}
      </div>
      {!!aiDrafts?.length && <ReviewDraftsBar target={target} drafts={aiDrafts} />}
      {detail?.pendingReviewId && (
        <ReviewSubmitBar
          prRepo={pr.repo}
          number={pr.number}
          reviewId={detail.pendingReviewId}
          drafts={drafts}
        />
      )}
    </div>
  );
}

/**
 * The file list in the shape a file list arrives in: the viewed counter with its
 * progress track, then collapsed file rows — status letter, path, diffstat, the
 * Viewed toggle.
 *
 * It used to be four paragraph bars over a tall grey block, which is what a
 * *document* looks like loading. This pane has never held one, so the page
 * rearranged itself the instant the read landed. Full-bleed like the rows it
 * stands in for, or the placeholder would sit in a column the real list does
 * not have.
 */
const FILE_ROWS = ["w-72", "w-96", "w-64", "w-80", "w-56", "w-40"];

function FilesSkeleton() {
  return (
    <div aria-hidden>
      <div className="flex items-center gap-2 border-b border-hairline px-4 py-2">
        <Skeleton className="h-2.5 w-28" />
        <Skeleton className="h-[3px] w-16 rounded-full" />
      </div>
      {FILE_ROWS.map((width) => (
        <div
          key={width}
          className="flex items-center gap-2 border-b border-line-2 bg-raised px-3 py-2"
        >
          {/* Chevron, status letter, path — then the diffstat and Viewed, which
              sit at the row's trailing edge whatever the path's length. */}
          <Skeleton className="h-3 w-3 flex-none rounded-sm" />
          <Skeleton className="h-2.5 w-1.5 flex-none" />
          <Skeleton className={`h-3 ${width} min-w-0`} />
          <Skeleton className="ml-auto h-2.5 w-12 flex-none" />
          <Skeleton className="h-2.5 w-14 flex-none" />
        </div>
      ))}
    </div>
  );
}

/** One changed file: a sticky header (status · path · counts · Viewed toggle) over
 *  its diff with inline comments. Marking it viewed collapses the diff; a chevron
 *  overrides the collapse either way. Memoized so toggling one file doesn't
 *  re-render the whole list. */
const PrFileCard = memo(function PrFileCard({
  owner,
  name,
  base,
  head,
  file,
  threads,
  drafts,
  target,
  reviewed,
  folded,
  forceOpen,
  onFold,
  onToggle,
}: {
  owner: string;
  name: string;
  base: string;
  head: string;
  file: PrFile;
  threads: PrThread[];
  drafts: ReviewDraft[];
  target: CommentTarget;
  reviewed: boolean;
  /** This card's chevron has been clicked, and to what — `undefined` while it is
   *  still following the viewed mark. Held by the pane so ⌘-click can move every
   *  card at once. */
  folded: boolean | undefined;
  /** The review brief jumped here — open regardless of the viewed mark, since
   *  landing on a collapsed card would defeat the jump. */
  forceOpen: boolean;
  onFold: (path: string, collapsed: boolean, bulk: boolean) => void;
  onToggle: (file: PrFile, reviewed: boolean) => void;
}) {
  // Collapse follows the reviewed mark until the chevron says otherwise, and a
  // jump from the brief beats both — landing on a collapsed card would defeat it.
  const collapsed = forceOpen ? false : (folded ?? reviewed);

  // Full file source powers context expansion — fetched only once the card is
  // expanded (and only for a text file), so collapsed/binary files cost nothing.
  const { data: source } = usePrFileSource(
    owner,
    name,
    base,
    head,
    file.previousPath ?? file.path,
    file.path,
    !collapsed && !!file.patch,
  );

  const meta = STATUS_META[file.status] ?? STATUS_META.modified;
  // Only needed for the collapsed case below — the expanded body splits them
  // itself (see PrFileBody, which owns the placement rule for both hosts).
  const { unplaceable } = splitDrafts(drafts, head, file.patch);

  return (
    // `data-path` is the anchor the review brief's jumps scroll to.
    <div data-path={file.path} className="border-b border-line-2">
      <div className="sticky top-0 z-[5] flex items-center gap-2 border-b border-line-2 bg-raised px-3 py-1.5">
        <button
          type="button"
          onClick={(e) => onFold(file.path, !collapsed, isBulkToggle(e))}
          title={`${collapsed ? "Expand file" : "Collapse file"}\n${BULK_TOGGLE_HINT}`}
          className="flex-none cursor-pointer text-muted-3 hover:text-fg-2"
        >
          <ChevronDownIcon
            size={12}
            className={`transition-transform ${collapsed ? "-rotate-90" : ""}`}
          />
        </button>
        <span
          className="flex-none font-mono text-[10px] font-semibold"
          style={{ color: meta.color }}
          title={file.status}
        >
          {meta.letter}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-2">
          {file.path}
        </span>
        {threads.length > 0 && (
          <span
            className="flex flex-none items-center gap-1 font-mono text-[10px] text-muted-4"
            title={`${threads.length} review comment${threads.length === 1 ? "" : "s"}`}
          >
            <MessageSquareIcon size={10} />
            {threads.length}
          </span>
        )}
        {drafts.length > 0 && (
          <span
            className="flex flex-none items-center gap-0.5 font-mono text-[10px]"
            style={{ color: palette.purple }}
            title={`${drafts.length} AI draft${drafts.length === 1 ? "" : "s"} on this file`}
          >
            {[...new Set(drafts.map((draft) => draft.agentKind))].map((agent) => (
              <AgentIcon key={agent} kind={agent} size={9} />
            ))}
            {drafts.length}
          </span>
        )}
        <span className="flex-none font-mono text-[10.5px]">
          <span className="text-status-green">+{file.additions}</span>{" "}
          <span className="text-status-red">−{file.deletions}</span>
        </span>
        <label
          className="flex flex-none cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-[10.5px] text-muted-3 select-none hover:bg-hover hover:text-fg-2"
          title="Mark this file as reviewed. It re-opens automatically when a new commit changes it."
          style={reviewed ? { color: "var(--accent)" } : undefined}
        >
          <input
            type="checkbox"
            checked={reviewed}
            onChange={(e) => onToggle(file, e.target.checked)}
            className="h-3 w-3 cursor-pointer accent-[var(--accent)]"
          />
          Viewed
        </label>
      </div>

      {!collapsed && (
        <PrFileBody
          file={file}
          threads={threads}
          drafts={drafts}
          target={target}
          oldText={source?.oldText}
          newText={source?.newText}
        />
      )}
      {/* A collapsed card still surfaces what couldn't be pinned: those drafts
          have never been read, and collapsing a file is not a decision about them. */}
      {collapsed && unplaceable.length > 0 && (
        <UnplaceableDrafts drafts={unplaceable} target={target} />
      )}
    </div>
  );
});
