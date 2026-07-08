/**
 * The "Pull request" tab body: a wide, scrollable column of per-file diffs — each
 * a collapsible card with a GitHub-style "Viewed" checkbox — with review comments
 * anchored inline. The PR description and conversation live in the full-height
 * {@link PrInfoPanel} rail beside the whole detail area, not here.
 *
 * "Viewed" is persisted per (PR, file) against the file's blob SHA: a marked file
 * collapses and stays marked across sessions, but the moment a new commit changes
 * the file (its SHA differs) the mark auto-clears and the file re-expands — so you
 * always re-review what actually changed. The toggle mutation lives here (a stable
 * parent) rather than in the card, which unmounts when collapsed.
 */
import { memo, useEffect, useMemo, useState } from "react";

import type { PrFile, PrThread, ReviewPr } from "../../bindings";
import { ChevronDownIcon, EyeIcon } from "../../components/icons";
import { EmptyState, Skeleton } from "../../components/primitives";
import {
  usePrDetail,
  usePrFileSource,
  useReviewedFiles,
  useSetFileReviewed,
} from "../../lib/queries";
import { PrFileDiff } from "./PrFileDiff";
import { PrThreadCard } from "./PrThreadCard";

/** GitHub's lowercase file-status strings → a status letter + tint. */
const STATUS_META: Record<string, { letter: string; color: string }> = {
  added: { letter: "A", color: "var(--color-status-green)" },
  modified: { letter: "M", color: "var(--color-status-amber)" },
  changed: { letter: "M", color: "var(--color-status-amber)" },
  removed: { letter: "D", color: "var(--color-status-red)" },
  renamed: { letter: "R", color: "var(--color-status-blue)" },
  copied: { letter: "C", color: "var(--color-status-blue)" },
};

function splitRepo(slug: string): [string, string] {
  const [owner, ...rest] = slug.split("/");
  return [owner, rest.join("/")];
}

export function PrReviewPane({ pr }: { pr: ReviewPr }) {
  const [owner, name] = splitRepo(pr.repo);
  const { data: detail, isLoading } = usePrDetail(owner, name, pr.number);
  const { data: reviewed = [] } = useReviewedFiles(pr.repo, pr.number);
  const setReviewed = useSetFileReviewed(pr.repo, pr.number);

  // A file counts as reviewed only while its current head SHA still matches the
  // one we stored the mark against.
  const reviewedSha = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of reviewed) m.set(r.path, r.sha);
    return m;
  }, [reviewed]);

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

  const reviewedCount = files.filter((f) => reviewedSha.get(f.path) === f.sha).length;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {isLoading ? (
        <div className="px-4 py-4">
          <PaneSkeleton />
        </div>
      ) : files.length > 0 ? (
        <>
          <div className="flex items-center gap-2 border-b border-hairline px-4 py-2 font-mono text-[10.5px] text-muted-3">
            <span className="tracking-[.04em] uppercase">
              {reviewedCount} / {files.length} files viewed
            </span>
          </div>
          {files.map((f) => (
            <PrFileCard
              key={f.path}
              owner={owner}
              name={name}
              base={detail?.baseSha ?? ""}
              head={detail?.headSha ?? ""}
              file={f}
              threads={threadsByPath.get(f.path) ?? []}
              reviewed={reviewedSha.get(f.path) === f.sha}
              onToggle={(rev) => setReviewed.mutate({ path: f.path, sha: f.sha, reviewed: rev })}
            />
          ))}
        </>
      ) : (
        <EmptyState title="No file changes" />
      )}
    </div>
  );
}

function PaneSkeleton() {
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
  reviewed,
  onToggle,
}: {
  owner: string;
  name: string;
  base: string;
  head: string;
  file: PrFile;
  threads: PrThread[];
  reviewed: boolean;
  onToggle: (reviewed: boolean) => void;
}) {
  // Collapse follows the reviewed mark, but the chevron can override it. The
  // effect re-syncs only when `reviewed` actually flips (e.g. a new commit clears
  // the mark → the file re-expands), not on manual chevron toggles.
  const [collapsed, setCollapsed] = useState(reviewed);
  useEffect(() => setCollapsed(reviewed), [reviewed]);

  // Full file source powers context expansion — fetched only once the card is
  // expanded (and only for a text file), so collapsed/binary files cost nothing.
  const { data: source } = usePrFileSource(
    owner,
    name,
    base,
    head,
    file.path,
    !collapsed && !!file.patch,
  );

  const meta = STATUS_META[file.status] ?? STATUS_META.modified;
  const outdated = threads.filter((t) => t.line == null || t.isOutdated);

  return (
    <div className="border-b border-line-2">
      <div className="sticky top-0 z-[5] flex items-center gap-2 border-b border-line-2 bg-raised px-3 py-1.5">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? "Expand file" : "Collapse file"}
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
          <span className="flex-none font-mono text-[10px] text-muted-4">💬 {threads.length}</span>
        )}
        <span className="flex-none font-mono text-[10.5px]">
          <span className="text-status-green">+{file.additions}</span>{" "}
          <span className="text-status-red">−{file.deletions}</span>
        </span>
        <label
          className="flex flex-none cursor-pointer items-center gap-1.5 rounded-md border border-line-2 bg-input px-2 py-1 text-[10.5px] text-muted-2 select-none hover:border-line-strong"
          title="Mark this file as reviewed. It re-opens automatically when a new commit changes it."
          style={reviewed ? { color: "var(--fg-2)" } : undefined}
        >
          <input
            type="checkbox"
            checked={reviewed}
            onChange={(e) => onToggle(e.target.checked)}
            className="h-3 w-3 cursor-pointer accent-[var(--accent)]"
          />
          <EyeIcon size={12} />
          Viewed
        </label>
      </div>

      {!collapsed &&
        (file.patch ? (
          <>
            <PrFileDiff
              path={file.path}
              status={file.status}
              patch={file.patch}
              threads={threads}
              oldText={source?.oldText}
              newText={source?.newText}
              mode="unified"
            />
            {outdated.length > 0 && (
              <div className="border-t border-line-2 px-3 py-2">
                <div className="mb-1.5 font-mono text-[9.5px] tracking-[.06em] text-muted-4 uppercase">
                  Outdated comments
                </div>
                <div className="overflow-hidden rounded-md border border-line-2">
                  {outdated.map((t, i) => (
                    <PrThreadCard key={`${t.path}:${t.line}:${i}`} thread={t} />
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="px-3 py-3 text-[11.5px] text-muted-3">Binary file — no preview.</div>
        ))}
    </div>
  );
});
