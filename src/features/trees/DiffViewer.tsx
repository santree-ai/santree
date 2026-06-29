/**
 * A single file's diff, rendered with `@git-diff-view/react`:
 *  - syntax highlighting (language inferred from the path),
 *  - split / unified toggle,
 *  - GitHub-style expand-unchanged-context (top/bottom/between) — enabled because
 *    we hand it the full old/new file source, so it can fill the gaps on demand.
 *
 * The backend supplies a standard unified diff (`worktree_file_diff`) plus the
 * old/new contents (`worktree_file_source`); binary files are filtered out
 * upstream. Theme follows the app's resolved light/dark.
 */
import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import { memo, useMemo } from "react";

import { EmptyState } from "../../components/primitives";
import { useResolvedTheme } from "../../theme/useResolvedTheme";

export type DiffMode = "split" | "unified";

// `DiffView` re-runs syntax highlighting + diff layout on every render, and its
// host (`DiffPane`) re-renders on unrelated Trees-context changes. Memoize the
// component (props are all primitive) and the `data` object so it only re-lays-out
// when the file content actually changes.
export const DiffViewer = memo(function DiffViewer({
  path,
  diff,
  oldText,
  newText,
  mode = "split",
}: {
  path: string;
  /** The file's unified diff (from `worktree_file_diff`). */
  diff: string;
  /** HEAD content; empty for added/untracked files. */
  oldText: string;
  /** Working-tree content; empty for deleted files. */
  newText: string;
  mode?: DiffMode;
}) {
  const theme = useResolvedTheme();
  const data = useMemo(
    () => ({
      oldFile: { fileName: path, content: oldText },
      newFile: { fileName: path, content: newText },
      hunks: [diff],
    }),
    [path, oldText, newText, diff],
  );

  if (!diff.trim()) {
    return <EmptyState title="No changes in this file" />;
  }

  return (
    <div className="diff-viewer selectable min-w-0 text-[12.5px]">
      <DiffView
        data={data}
        diffViewMode={mode === "split" ? DiffModeEnum.Split : DiffModeEnum.Unified}
        diffViewTheme={theme}
        diffViewHighlight
        diffViewWrap
      />
    </div>
  );
});
