/** A single ticket row in the Issues sidebar list. Presentational. */

import type { CSSProperties } from "react";
import { memo } from "react";

import { Badge, Dot } from "../../components/primitives";
import { successColor } from "../../theme/colors";

export interface IssueRowVM {
  id: string;
  title: string;
  statusColor: string;
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
  a.background === b.background && a.border === b.border && a.opacity === b.opacity;

export const IssueRow = memo(
  function IssueRow({ vm }: { vm: IssueRowVM }) {
    return (
      // A styled container (not a button) holding two separate click targets: the
      // checkbox queues for launch, the card focuses + reveals in the graph. The
      // shared row background lives here so there's no seam between them.
      // biome-ignore lint/a11y/noStaticElementInteractions: decorative hover only
      <div
        data-issue-id={vm.id}
        onMouseEnter={vm.onHover}
        className="mb-0.5 flex w-full items-stretch rounded-md transition-colors"
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
          title="Click to reveal · ⌘-click to add to queue"
          className="flex min-w-0 flex-1 cursor-pointer gap-2 rounded-r-md rounded-l-none py-[7px] pr-2 pl-1 text-left"
        >
          <span className="mt-[5px] flex-none">
            <Dot color={vm.statusColor} size={7} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="flex-none font-mono text-[10px] text-muted-2">{vm.id}</span>
              <span className="ml-auto flex items-center gap-1">
                {vm.showWorking && <Badge color="var(--color-status-amber)">WIP</Badge>}
                {vm.showRdy && <Badge color={successColor}>RDY</Badge>}
                {vm.showChain && (
                  <span
                    className="font-mono text-[8px] font-semibold"
                    style={{ color: "var(--accent)" }}
                  >
                    ⛓ {vm.chainBase}
                  </span>
                )}
                {vm.showBlocked && <span className="font-mono text-[10px] text-muted-4">⊘</span>}
              </span>
            </div>
            <div className="mt-0.5 overflow-hidden text-[11.5px] leading-[1.3] text-ellipsis whitespace-nowrap text-fg-3">
              {vm.title}
            </div>
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
