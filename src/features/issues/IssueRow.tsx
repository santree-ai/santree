/** A single ticket row in the Issues sidebar list. Presentational. */

import type { CSSProperties } from "react";
import { memo } from "react";

import type { Priority } from "../../bindings";
import { MarkdownTitle } from "../../components/Markdown";
import { Badge, Dot } from "../../components/primitives";
import { EstimateBars, PriorityBars } from "../../components/WorkSignals";

export interface IssueRowVM {
  id: string;
  title: string;
  statusColor: string;
  priority: Priority;
  estimate: number | null;
  /** This ticket is the current destination shown in the detail panel. */
  active: boolean;
  selectable: boolean;
  selected: boolean;
  showRdy: boolean;
  showChain: boolean;
  chainBase: string | null;
  showBlocked: boolean;
  /** A real worktree exists for this issue — it's being worked on. */
  showWorking: boolean;
  rowStyle: CSSProperties;
  boxStyle: CSSProperties;
  /** Card click: focus the ticket and reveal it in the graph. */
  onReveal: () => void;
  /** Checkbox click: toggle the launch selection (distinct from the card). */
  onToggleSelect: () => void;
  /** Row hover: highlight the ticket in the graph (no pan, no right-panel change). */
  onHover: () => void;
}

// The sidebar rebuilds every row's VM (fresh style objects + closures) whenever
// selection/focus/hover changes, so a plain component would re-render all rows.
// Compare by value instead — the callbacks are id-stable in behavior, so only the
// rendered fields (incl. the derived style objects) matter. Mirrors IssueNode.
const styleEq = (a: CSSProperties, b: CSSProperties) =>
  a.background === b.background &&
  a.border === b.border &&
  a.borderColor === b.borderColor &&
  a.opacity === b.opacity;

export const IssueRow = memo(
  function IssueRow({ vm }: { vm: IssueRowVM }) {
    return (
      // A styled container (not a button) holding two separate click targets: the
      // checkbox queues for launch, the card focuses + reveals in the graph. The
      // shared row background lives here so there's no seam between them.
      // biome-ignore lint/a11y/noStaticElementInteractions: decorative hover only
      <div
        data-issue-id={vm.id}
        data-active={vm.active}
        onMouseEnter={vm.onHover}
        className="entity-card mb-[5px] flex w-full items-stretch overflow-hidden transition-colors"
        style={vm.rowStyle}
      >
        {/* The checkbox column is always present (disabled + faint when the row
          can't be launched) so every row aligns the same. */}
        <button
          type="button"
          onClick={vm.selectable ? vm.onToggleSelect : undefined}
          disabled={!vm.selectable}
          aria-label={vm.selected ? "Remove from launch selection" : "Add to launch selection"}
          aria-pressed={vm.selectable ? vm.selected : undefined}
          className={`flex flex-none items-start rounded-l-md py-[7px] pr-1 pl-2 ${
            vm.selectable ? "cursor-pointer" : "cursor-default"
          }`}
        >
          <span
            className={`mt-0.5 flex h-3.5 w-3.5 items-center justify-center rounded text-[9px] font-bold text-[color:var(--on-accent)] transition-colors ${
              vm.selectable ? "" : "opacity-45"
            }`}
            style={vm.boxStyle}
          >
            {vm.selected ? "✓" : ""}
          </span>
        </button>
        <button
          type="button"
          // ⌘/Ctrl-click adds the ticket to the launch queue (same as the checkbox);
          // a plain click reveals it in the graph.
          onClick={(e) => (e.metaKey || e.ctrlKey ? vm.onToggleSelect() : vm.onReveal())}
          title="Click to reveal. ⌘-click to add to queue."
          className="flex min-w-0 flex-1 cursor-pointer gap-2 rounded-r-md rounded-l-none py-[7px] pr-2 pl-1 text-left"
        >
          <span className="mt-[5px] flex-none">
            <Dot color={vm.statusColor} size={7} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="flex-none font-mono text-[10px] text-muted-2">{vm.id}</span>
              {vm.priority !== "None" && <PriorityBars priority={vm.priority} />}
              {vm.estimate != null && vm.estimate > 0 && <EstimateBars estimate={vm.estimate} />}
              <span className="ml-auto flex items-center gap-1">
                {vm.showWorking && <Badge color="var(--color-status-amber)">In progress</Badge>}
                {vm.showRdy && <Badge color="var(--color-status-green)">Ready</Badge>}
                {vm.showChain && <Badge color="var(--accent)">After {vm.chainBase}</Badge>}
                {vm.showBlocked && <Badge color="var(--color-muted-3)">Blocked</Badge>}
              </span>
            </div>
            <MarkdownTitle className="mt-0.5 block max-h-[2.6em] line-clamp-2 overflow-hidden text-[11.5px] leading-[1.3] text-fg-3">
              {vm.title}
            </MarkdownTitle>
          </div>
        </button>
      </div>
    );
  },
  (a, b) => {
    const x = a.vm;
    const y = b.vm;
    return (
      x.id === y.id &&
      x.title === y.title &&
      x.statusColor === y.statusColor &&
      x.priority === y.priority &&
      x.estimate === y.estimate &&
      x.active === y.active &&
      x.selectable === y.selectable &&
      x.selected === y.selected &&
      x.showRdy === y.showRdy &&
      x.showChain === y.showChain &&
      x.chainBase === y.chainBase &&
      x.showBlocked === y.showBlocked &&
      x.showWorking === y.showWorking &&
      styleEq(x.rowStyle, y.rowStyle) &&
      styleEq(x.boxStyle, y.boxStyle)
    );
  },
);
