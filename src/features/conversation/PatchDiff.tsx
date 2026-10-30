/** One file's change from an agent's edit, drawn the way a pull request's file
 *  is: its hunks through the PR diff's own header synthesis, in the same viewer
 *  and highlighting — read-only, since nothing here is a review. Memoized: the
 *  viewer lays out again on every render. */
import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import { memo, useMemo } from "react";

import type { FileOp } from "../../bindings";
import { useResolvedTheme } from "../../theme/useResolvedTheme";
import { toUnifiedDiff } from "../reviews/patchLines";

/** GitHub's file statuses, which the header synthesis speaks. */
const STATUS: Record<FileOp, string> = { Add: "added", Update: "modified", Delete: "removed" };

export const PatchDiff = memo(function PatchDiff({
  path,
  op,
  patch,
}: {
  path: string;
  op: FileOp;
  /** Unified-diff hunks, `@@` headers first. */
  patch: string;
}) {
  const theme = useResolvedTheme();
  const data = useMemo(
    () => ({
      oldFile: { fileName: path },
      newFile: { fileName: path },
      hunks: [toUnifiedDiff(path, null, STATUS[op], patch)],
    }),
    [path, op, patch],
  );
  return (
    <div className="diff-viewer selectable min-w-0 overflow-hidden rounded-md border border-line-2 text-[12px]">
      <DiffView
        data={data}
        diffViewMode={DiffModeEnum.Unified}
        diffViewTheme={theme}
        diffViewHighlight
        diffViewWrap
      />
    </div>
  );
});
