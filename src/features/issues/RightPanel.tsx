/** Right column of the Issues tab: a single pane showing the focused issue
 *  (header · add-to-queue · dependencies · description). Resizable (drag the
 *  left edge) and collapsible (the header chevron or ⌘L). */
import { type CSSProperties, useRef } from "react";

import { ChevronDownIcon } from "../../components/icons";
import { EdgeResizeHandle } from "../../components/primitives";
import { useEdgeResize } from "../../lib/useEdgeResize";
import { IssuePanel } from "./IssuePanel";
import { useIssues } from "./model";

const MIN_W = 264;
const MAX_W = 560;
/** Must match the `var(--issues-right, …)` fallback below and the model default. */
const DEFAULT_W = 304;

export function RightPanel() {
  const resizeTarget = useRef<HTMLDivElement>(null);
  const { rightCollapsed, rightWidth, setRightWidth, toggleRightPanel } = useIssues();

  // Drag the left edge to resize. The width is committed to state only on
  // pointer-up; during the drag the hook writes `--issues-right` directly so the
  // heavy markdown pane doesn't re-render on every move.
  const resize = useEdgeResize({
    cssVar: "--issues-right",
    target: resizeTarget,
    width: rightWidth,
    min: MIN_W,
    max: MAX_W,
    edge: "left",
    onCommit: setRightWidth,
  });

  if (rightCollapsed) {
    return (
      <div className="flex w-9 flex-none flex-col items-center border-l border-line bg-panel pt-2.5 max-[1500px]:absolute max-[1500px]:inset-y-0 max-[1500px]:right-0 max-[1500px]:z-20">
        <button
          type="button"
          onClick={toggleRightPanel}
          title="Expand panel (⌘L)"
          className="flex cursor-pointer items-center justify-center rounded-md p-1.5 text-muted-3 hover:bg-hover hover:text-fg-2"
          aria-label="Expand panel"
        >
          <span className="inline-block rotate-90">
            <ChevronDownIcon size={13} />
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      ref={resizeTarget}
      className="relative flex flex-none flex-col border-l border-line bg-panel max-[1500px]:absolute max-[1500px]:inset-y-0 max-[1500px]:right-0 max-[1500px]:z-20 max-[1500px]:max-w-[min(78vw,560px)] max-[1500px]:shadow-2xl"
      style={
        {
          "--issues-right": `${rightWidth}px`,
          width: `var(--issues-right, ${DEFAULT_W}px)`,
        } as CSSProperties
      }
    >
      <EdgeResizeHandle edge="left" {...resize} />
      <div className="flex min-h-0 flex-1 flex-col">
        <IssuePanel />
      </div>
    </div>
  );
}
