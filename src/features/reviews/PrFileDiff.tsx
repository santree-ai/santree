/**
 * A PR file's unified diff with inline review comments anchored to their lines —
 * the GitHub PR feel. Wraps `@git-diff-view/react` directly (rather than the
 * Trees {@link DiffViewer}) because it needs the library's `extendData` /
 * `renderExtendLine` API to render {@link PrThreadCard}s pinned to diff lines,
 * and its `renderWidgetLine` / gutter `+` to open the {@link InlineCommentBox} on
 * one — the same affordance as GitHub's Files tab.
 *
 * Uses the `WithMultiSelect` variant so a comment can cover a **line range**, as
 * on github.com: drag down the line-number gutter, then click the `+` on the last
 * line of the selection (the library drops the range if the `+` is clicked
 * anywhere else, which is the same rule GitHub's UI enforces by only offering the
 * button there). `renderWidgetLine` then reports both ends of the range.
 *
 * Threads and the AI review's drafts are placed on the new (right) side for
 * added/context lines and the old (left) side for removed lines. Outdated /
 * unplaceable ones are the caller's job — they're listed below the diff, not
 * anchored here.
 *
 * PR diffs carry only the patch hunk (no full file source), so — unlike the Trees
 * diff — there's no expand-unchanged-context. Memoized: `DiffView` re-lays-out on
 * every render, and the host re-renders on unrelated Reviews-context changes.
 */
import { DiffModeEnum, DiffViewWithMultiSelect } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import { memo, useMemo, useRef } from "react";

import type { PrThread, ReviewDraft } from "../../bindings";
import { useResolvedTheme } from "../../theme/useResolvedTheme";
import type { DiffMode } from "../trees/DiffViewer";
import { bucketAnnotations, type DiffAnnotation } from "./bucketThreads";
import { type CommentTarget, isRightSide } from "./commentTarget";
import { InlineCommentBox } from "./InlineCommentBox";
import { PrThreadCard } from "./PrThreadCard";
import { clampToHunk } from "./patchLines";
import { ReviewDraftCard } from "./ReviewDraftCard";
import { useGutterDrag } from "./useGutterDrag";

/**
 * GitHub's REST `patch` is only the hunk body (it starts at `@@`) — it omits the
 * `diff --git` / `---` / `+++` header that `@git-diff-view` needs to locate the
 * file and its hunks ("No hunks found" without it). Synthesize a minimal header,
 * with `/dev/null` on the missing side for added/removed files.
 */
function toUnifiedDiff(
  path: string,
  previousPath: string | null | undefined,
  status: string,
  patch: string,
): string {
  const oldPath = status === "added" ? "/dev/null" : `a/${previousPath ?? path}`;
  const newPath = status === "removed" ? "/dev/null" : `b/${path}`;
  return `diff --git a/${path} b/${path}\n--- ${oldPath}\n+++ ${newPath}\n${patch}`;
}

/**
 * Confirm that full-file content and GitHub's patch describe the same snapshots.
 * A branch can move between the two API reads, and a stale pair makes the diff
 * library emit warnings and expand context from the wrong revision. The patch is
 * still authoritative, so callers can safely omit incompatible full content.
 */
function contentMatchesPatch(patch: string, oldText: string, newText: string): boolean {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let sawHunk = false;

  for (const line of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      sawHunk = true;
      continue;
    }
    if (!inHunk || line === "\\ No newline at end of file") continue;

    const marker = line[0];
    const text = line.slice(1);
    if (marker === " " || marker === "-") {
      if (oldLines[oldLine - 1] !== text) return false;
      oldLine += 1;
    }
    if (marker === " " || marker === "+") {
      if (newLines[newLine - 1] !== text) return false;
      newLine += 1;
    }
  }
  return sawHunk;
}

export const PrFileDiff = memo(function PrFileDiff({
  path,
  previousPath,
  status,
  patch,
  threads,
  drafts,
  target,
  oldText,
  newText,
  mode = "unified",
}: {
  path: string;
  /** Base-side path for a rename/copy. */
  previousPath?: string | null;
  /** GitHub's file status ("added" | "modified" | "removed" | "renamed"). */
  status: string;
  /** The file's unified diff patch body (`PrFile.patch`). */
  patch: string;
  /** Review threads on this file — placed inline by line, or skipped if outdated. */
  threads: PrThread[];
  /** The AI review's drafts for this file, already filtered to the ones that can
   *  be pinned to the current diff — the caller lists the rest below it. */
  drafts: ReviewDraft[];
  /** Where a new comment would go. The gutter `+` is offered only once this
   *  carries a head commit — until the detail loads there's no commit to anchor
   *  a comment to, and GitHub rejects one without it. */
  target: CommentTarget;
  /** Full base-side file content; when present (with `newText`), enables
   *  GitHub-style expand-unchanged-context. Undefined until fetched on demand. */
  oldText?: string;
  /** Full head-side file content — the other half of context expansion. */
  newText?: string;
  mode?: DiffMode;
}) {
  const theme = useResolvedTheme();
  // The gutter `+` is press-and-drag, like github.com's — see useGutterDrag for
  // why that needs a listener of our own rather than a prop.
  const rootRef = useRef<HTMLDivElement>(null);
  const { bindWidgetStore, onSelection } = useGutterDrag(rootRef);

  const compatibleContent = useMemo(
    () =>
      oldText !== undefined &&
      newText !== undefined &&
      contentMatchesPatch(patch, oldText, newText),
    [patch, oldText, newText],
  );

  // The patch hunks stay authoritative for what's shown; `content` (once fetched)
  // only lets the viewer fill unchanged context on expand. Omitted until then, so
  // the diff renders immediately from the hunks alone.
  const data = useMemo(
    () => ({
      oldFile: { fileName: previousPath ?? path, content: compatibleContent ? oldText : undefined },
      newFile: { fileName: path, content: compatibleContent ? newText : undefined },
      hunks: [toUnifiedDiff(path, previousPath, status, patch)],
    }),
    [path, previousPath, status, patch, compatibleContent, oldText, newText],
  );

  const extendData = useMemo(() => bucketAnnotations(threads, drafts), [threads, drafts]);

  if (!patch.trim()) return null;

  return (
    <div ref={rootRef} className="diff-viewer selectable min-w-0 text-[12.5px]">
      <DiffViewWithMultiSelect<DiffAnnotation[]>
        data={data}
        extendData={extendData}
        renderExtendLine={({ data }) => (
          <div className="border-y border-hairline">
            {data.map((item, i) =>
              item.kind === "thread" ? (
                <PrThreadCard
                  key={`${item.thread.path}:${item.thread.line}:${i}`}
                  thread={item.thread}
                  prRepo={target.prRepo}
                  number={target.number}
                  patch={patch}
                />
              ) : (
                <ReviewDraftCard
                  key={item.draft.id}
                  draft={item.draft}
                  target={target}
                  patch={patch}
                />
              ),
            )}
          </div>
        )}
        // A range that crosses a hunk boundary is a comment GitHub refuses, so the
        // drag stops at the end of the hunk it started in rather than being posted
        // and 422'd back.
        scopeMultiSelectToHunk={(range) => {
          const clamped = clampToHunk(
            patch,
            range.side === "new",
            range.startLineNumber,
            range.endLineNumber,
          );
          if (!clamped) return null;
          return { ...range, startLineNumber: clamped[0], endLineNumber: clamped[1] };
        }}
        onMultiSelectComplete={({ range }) =>
          onSelection({
            side: range.side,
            from: range.startLineNumber,
            to: range.endLineNumber,
          })
        }
        onCreateUseWidgetHook={(hook) => bindWidgetStore(hook.getReadonlyState().setWidget)}
        diffViewAddWidget={!!target.headSha}
        renderWidgetLine={({ lineNumber, fromLineNumber, side, onClose }) => (
          <InlineCommentBox
            target={target}
            path={path}
            patch={patch}
            line={lineNumber}
            startLine={fromLineNumber}
            onRight={isRightSide(side)}
            onClose={onClose}
          />
        )}
        diffViewMode={mode === "split" ? DiffModeEnum.Split : DiffModeEnum.Unified}
        diffViewTheme={theme}
        diffViewHighlight
        diffViewWrap
      />
    </div>
  );
});
