/**
 * A PR file's unified diff with inline review comments anchored to their lines —
 * the GitHub PR feel. Wraps `@git-diff-view/react` directly (rather than the
 * Trees {@link DiffViewer}) because it needs the library's `extendData` /
 * `renderExtendLine` API to render {@link PrThreadCard}s pinned to diff lines,
 * and its `renderWidgetLine` / gutter `+` to open the {@link InlineCommentBox} on
 * one — the same affordance as GitHub's Files tab.
 *
 * Threads are placed on the new (right) side for added/context lines and the old
 * (left) side for removed lines. Outdated / unplaceable threads (no line) are the
 * caller's job — they're listed below the diff, not anchored here.
 *
 * PR diffs carry only the patch hunk (no full file source), so — unlike the Trees
 * diff — there's no expand-unchanged-context. Memoized: `DiffView` re-lays-out on
 * every render, and the host re-renders on unrelated Reviews-context changes.
 */
import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import { memo, useMemo } from "react";

import type { PrThread } from "../../bindings";
import { useResolvedTheme } from "../../theme/useResolvedTheme";
import type { DiffMode } from "../trees/DiffViewer";
import { bucketThreads } from "./bucketThreads";
import { type CommentTarget, isRightSide } from "./commentTarget";
import { InlineCommentBox } from "./InlineCommentBox";
import { PrThreadCard } from "./PrThreadCard";

/**
 * GitHub's REST `patch` is only the hunk body (it starts at `@@`) — it omits the
 * `diff --git` / `---` / `+++` header that `@git-diff-view` needs to locate the
 * file and its hunks ("No hunks found" without it). Synthesize a minimal header,
 * with `/dev/null` on the missing side for added/removed files.
 */
function toUnifiedDiff(path: string, status: string, patch: string): string {
  const oldPath = status === "added" ? "/dev/null" : `a/${path}`;
  const newPath = status === "removed" ? "/dev/null" : `b/${path}`;
  return `diff --git a/${path} b/${path}\n--- ${oldPath}\n+++ ${newPath}\n${patch}`;
}

export const PrFileDiff = memo(function PrFileDiff({
  path,
  status,
  patch,
  threads,
  target,
  oldText,
  newText,
  mode = "unified",
}: {
  path: string;
  /** GitHub's file status ("added" | "modified" | "removed" | "renamed"). */
  status: string;
  /** The file's unified diff patch body (`PrFile.patch`). */
  patch: string;
  /** Review threads on this file — placed inline by line, or skipped if outdated. */
  threads: PrThread[];
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

  // The patch hunks stay authoritative for what's shown; `content` (once fetched)
  // only lets the viewer fill unchanged context on expand. Omitted until then, so
  // the diff renders immediately from the hunks alone.
  const data = useMemo(
    () => ({
      oldFile: { fileName: path, content: oldText },
      newFile: { fileName: path, content: newText },
      hunks: [toUnifiedDiff(path, status, patch)],
    }),
    [path, status, patch, oldText, newText],
  );

  const extendData = useMemo(() => bucketThreads(threads), [threads]);

  if (!patch.trim()) return null;

  return (
    <div className="diff-viewer selectable min-w-0 text-[12.5px]">
      <DiffView<PrThread[]>
        data={data}
        extendData={extendData}
        renderExtendLine={({ data }) => (
          <div className="border-y border-hairline">
            {data.map((t, i) => (
              <PrThreadCard
                key={`${t.path}:${t.line}:${i}`}
                thread={t}
                prRepo={target.prRepo}
                number={target.number}
              />
            ))}
          </div>
        )}
        diffViewAddWidget={!!target.headSha}
        renderWidgetLine={({ lineNumber, side, onClose }) => (
          <InlineCommentBox
            target={target}
            path={path}
            line={lineNumber}
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
