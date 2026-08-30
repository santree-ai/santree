/**
 * One PR file's diff with everything anchored to it — the inline threads and AI
 * drafts that fit the current hunks, then the ones that don't, listed below.
 *
 * Split out of the Reviews file card so the Trees diff renders an identical body:
 * the placement rule ({@link splitDrafts}) and the "listed, never dropped"
 * treatment of what can't be placed are the parts that must not diverge between
 * the two hosts. The chrome around it differs — Reviews wraps it in a collapsible
 * card with a Viewed checkbox, Trees shows one file at a time — so that stays with
 * each host.
 */
import type { PrFile, PrThread, ReviewDraft } from "../../bindings";
import { palette } from "../../theme/colors";
import type { DiffMode } from "../trees/DiffViewer";
import type { CommentTarget } from "./commentTarget";
import { PrFileDiff } from "./PrFileDiff";
import { PrThreadCard } from "./PrThreadCard";
import { outdatedThreads, splitDrafts } from "./prFilePlacement";
import { ReviewDraftCard } from "./ReviewDraftCard";

export function PrFileBody({
  file,
  threads,
  drafts,
  target,
  oldText,
  newText,
  mode = "unified",
  draftMode,
}: {
  file: PrFile;
  threads: PrThread[];
  drafts: ReviewDraft[];
  target: CommentTarget;
  /** Full base/head file content, when fetched — enables context expansion. */
  oldText?: string;
  newText?: string;
  mode?: DiffMode;
  /** Passed through to every draft card: what its primary action does. */
  draftMode?: "publish" | "queue";
}) {
  if (!file.patch) {
    return <div className="px-3 py-3 text-[11.5px] text-muted-3">Binary file. No preview.</div>;
  }

  const outdated = outdatedThreads(threads);
  const { placeable, unplaceable } = splitDrafts(drafts, target.headSha, file.patch);

  return (
    <>
      <PrFileDiff
        path={file.path}
        previousPath={file.previousPath}
        status={file.status}
        patch={file.patch}
        threads={threads}
        drafts={placeable}
        target={target}
        oldText={oldText}
        newText={newText}
        mode={mode}
        draftMode={draftMode}
      />
      {outdated.length > 0 && (
        <div className="border-t border-line-2 px-3 py-2">
          <div className="mb-1.5 font-mono text-[9.5px] tracking-[.06em] text-muted-4 uppercase">
            Outdated comments
          </div>
          <div className="overflow-hidden rounded-md border border-line-2">
            {outdated.map((t, i) => (
              <PrThreadCard
                key={`${t.path}:${t.line}:${i}`}
                thread={t}
                prRepo={target.prRepo}
                number={target.number}
              />
            ))}
          </div>
        </div>
      )}
      {unplaceable.length > 0 && (
        <UnplaceableDrafts drafts={unplaceable} target={target} draftMode={draftMode} />
      )}
    </>
  );
}

/** Drafts that can't be pinned: written against an earlier head, or aimed at a
 *  line the current diff doesn't contain. Listed rather than dropped — the user
 *  hasn't read them yet, and deciding they're worthless is their call. */
export function UnplaceableDrafts({
  drafts,
  target,
  draftMode,
}: {
  drafts: ReviewDraft[];
  target: CommentTarget;
  draftMode?: "publish" | "queue";
}) {
  return (
    <div className="border-t border-line-2 px-3 py-2">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="font-mono text-[9.5px] tracking-[.06em] text-muted-4 uppercase">
          AI drafts on older code
        </span>
        <span className="text-[10px]" style={{ color: palette.amber }}>
          Check the line before you send these.
        </span>
      </div>
      <div className="overflow-hidden rounded-md border border-line-2">
        {drafts.map((d) => (
          <ReviewDraftCard key={d.id} draft={d} target={target} stale mode={draftMode} />
        ))}
      </div>
    </div>
  );
}
