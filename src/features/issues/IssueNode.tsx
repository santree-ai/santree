/**
 * A ticket card rendered as a React Flow node. Purely presentational — the
 * canvas computes the view-model (`IssueNodeData`) and wires click/hover at the
 * flow level; this just paints the card and exposes left/right handles for the
 * dependency edges to dock onto.
 */
import { Handle, type NodeProps, Position } from "@xyflow/react";
import type { CSSProperties } from "react";
import { memo } from "react";

import { PrChips } from "../../components/PrChip";
import { Badge, Dot } from "../../components/primitives";
import { accentVar as accent, alpha, successColor } from "../../theme/colors";
import { useIssues } from "./model";

export interface IssueNodeData {
  title: string;
  statusColor: string;
  statusLabel: string;
  /** Stable primitive flags describing the node's state — the card's actual
   *  border/background/shadow is derived from these in `cardStyleFor` below.
   *  Keeping these primitive (not a pre-baked style object) is what lets this
   *  component's `memo` hold for unchanged nodes when the array is rebuilt. */
  selected: boolean;
  chainable: boolean;
  ready: boolean;
  chainBase: string | null;
  blocked: boolean;
  dim: boolean;
  /** Non-actionable context node (not assigned to the viewer, or done). */
  grayed: boolean;
  [key: string]: unknown;
}

/** Derive the card's border/background/shadow from the node's primitive flags.
 *  Later conditions win, matching the design (running/done override selection).
 *  `working` (a real worktree exists) is read from context, NOT node data — see
 *  the component — so a worktrees refetch never rebuilds the React Flow nodes
 *  array (which, mid-fitView, blanks the canvas). */
function cardStyleFor(data: IssueNodeData, working: boolean): CSSProperties {
  const style: CSSProperties = {
    background: "var(--color-hover)",
    border: "1px solid var(--color-line-3)",
    boxShadow: "0 1px 2px rgba(0,0,0,.4)",
  };
  if (data.grayed) {
    // Non-actionable context node: no fill/shadow, so the border alone has to
    // carry it — use a real muted *gray* (not the near-invisible line tone) so it
    // reads as a grayed-but-clearly-outlined ghost card in both themes.
    style.background = "transparent";
    style.border = "1.5px dashed var(--color-muted-3)";
    style.boxShadow = "none";
  }
  if (data.chainable) style.border = `1px solid ${alpha(40)}`;
  if (working) {
    // Being worked on (a worktree exists): a soft amber edge + faint tint, kept
    // subtle so it doesn't fight the accent focus ring (the WIP badge is the loud
    // signal). No extra ring — keep the default card shadow.
    const amber = "var(--color-status-amber)";
    style.border = `1px solid ${alpha(55, amber)}`;
    style.background = alpha(7, amber);
  }
  if (data.selected) {
    // Queued for launch: a clearly accent-FILLED card (not just a ring), so it
    // reads differently from a focus/hover ring.
    style.border = `1px solid ${accent}`;
    style.background = alpha(15);
    style.boxShadow = `0 0 0 1px ${alpha(50)}, 0 8px 26px -8px ${alpha(33)}`;
  }
  return style;
}

const handleStyle: CSSProperties = {
  opacity: 0,
  width: 1,
  height: 1,
  border: "none",
  background: "transparent",
  pointerEvents: "none",
};

// The canvas rebuilds the whole nodes array whenever selection/focus/worktrees
// change, handing each node a fresh `data` object even when nothing about it
// changed. A reference compare would therefore re-render every node; this
// value-compares the (all-primitive) data fields so unchanged nodes are skipped.
function dataEqual(a: IssueNodeData, b: IssueNodeData): boolean {
  return (
    a.title === b.title &&
    a.statusColor === b.statusColor &&
    a.statusLabel === b.statusLabel &&
    a.selected === b.selected &&
    a.chainable === b.chainable &&
    a.ready === b.ready &&
    a.chainBase === b.chainBase &&
    a.blocked === b.blocked &&
    a.dim === b.dim &&
    a.grayed === b.grayed
  );
}

export const IssueNode = memo(
  function IssueNode({ id, data, selected }: NodeProps & { data: IssueNodeData }) {
    // Highlight + worktree state come from context (NOT node data) so neither a
    // hover/selection nor a worktrees refetch rebuilds the React Flow nodes array
    // — that churn resets node measurement and blanks the canvas when a fitView
    // lands mid-rebuild.
    const { focusId, hoverId, worktreeIds, prByTask } = useIssues();
    const focused = focusId === id;
    const hovered = hoverId === id && !focused;
    const working = worktreeIds.has(id);
    // Real PR status (from context, not node data — keeps the nodes array stable).
    const prs = prByTask.get(id) ?? [];
    const hasPr = prs.length > 0;
    return (
      <div
        // Only paint properties are transitioned. Animating opacity/transform here
        // promotes each node to its own GPU layer which the viewport's scale()
        // then rasterizes at 1× and magnifies — WebKit keeps the layer around, so
        // the whole graph stays blurry after a focus toggle. Dim is applied
        // instantly instead.
        className="relative w-[212px] cursor-pointer rounded-[11px] px-3 py-2.5 text-left transition-[border-color,box-shadow] duration-200"
        style={{
          opacity: data.dim ? 0.32 : data.grayed ? 0.75 : 1,
          ...cardStyleFor(data, working),
        }}
        data-selected={selected || undefined}
      >
        <Handle type="target" position={Position.Left} style={handleStyle} isConnectable={false} />
        <Handle type="source" position={Position.Right} style={handleStyle} isConnectable={false} />

        {/* Selection / hover rings live in their own overlay so they're independent
          of the card's own border + shadow state (running, done, selected…). */}
        {focused ? (
          <span
            aria-hidden
            className="pointer-events-none absolute -inset-px rounded-[12px]"
            style={{ animation: "nodeSelected 1.6s ease-out infinite" }}
          />
        ) : hovered ? (
          <span
            aria-hidden
            className="pointer-events-none absolute -inset-px rounded-[12px]"
            // Neutral ring for a transient hover — visually distinct from the
            // accent ring used for the focused (open-in-panel) node.
            style={{ boxShadow: "0 0 0 2px var(--color-line-strong)" }}
          />
        ) : null}

        <div className="mb-1.5 flex items-center gap-[7px]">
          <Dot color={data.statusColor} size={8} />
          <span className="font-mono text-[11px] text-muted-2">{id}</span>
          <div className="ml-auto flex items-center gap-1">
            {working && <Badge color="var(--color-status-amber)">WIP</Badge>}
            {data.ready && !working && <Badge color={successColor}>RDY</Badge>}
            {data.chainBase && <Badge>⛓ {data.chainBase}</Badge>}
            {/* "Blocked" is contradictory once a node is being worked on or has a
                PR — suppress it so the cluster stays clean. */}
            {data.blocked && !working && !hasPr && (
              <span className="font-mono text-[10px] text-muted-3">⊘</span>
            )}
            {hasPr && <PrChips prs={prs} />}
          </div>
        </div>

        <div
          className="min-h-[33px] overflow-hidden text-[12.5px] leading-[1.32] font-normal text-fg-3"
          style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}
        >
          {data.title}
        </div>

        <div className="mt-[7px] flex min-h-[14px] items-center gap-[7px]">
          <span className="text-[10.5px] font-medium" style={{ color: data.statusColor }}>
            {data.statusLabel}
          </span>
        </div>
      </div>
    );
  },
  // React Flow also passes other NodeProps (selectable, positionAbsolute, …) but
  // none of them drive this card's output, so comparing id + selected + data is
  // sufficient to skip an unchanged node.
  (prev, next) =>
    prev.id === next.id && prev.selected === next.selected && dataEqual(prev.data, next.data),
);
