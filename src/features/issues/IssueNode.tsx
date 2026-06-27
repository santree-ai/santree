/**
 * A ticket card rendered as a React Flow node. Purely presentational — the
 * canvas computes the view-model (`IssueNodeData`) and wires click/hover at the
 * flow level; this just paints the card and exposes left/right handles for the
 * dependency edges to dock onto.
 */
import { Handle, type NodeProps, Position } from "@xyflow/react";
import type { CSSProperties } from "react";
import { memo } from "react";

import { Badge, Dot, Spinner } from "../../components/primitives";
import { accentVar as accent, alpha, successColor } from "../../theme/colors";
import { useIssues } from "./model";

export interface IssueNodeData {
  title: string;
  statusColor: string;
  statusLabel: string;
  /** Stable primitive flags describing the node's state — the card's actual
   *  border/background/shadow is derived from these in `cardStyleFor` below.
   *  Keeping these primitive (not a pre-baked style object) is what lets this
   *  component's `memo` hold across session ticks for unchanged nodes. */
  selected: boolean;
  chainable: boolean;
  ready: boolean;
  chainBase: string | null;
  blocked: boolean;
  running: boolean;
  done: boolean;
  dim: boolean;
  /** Non-actionable context node (not assigned to the viewer, or done). */
  grayed: boolean;
  pct: number;
  runColor: string;
  stageLabel: string;
  prLabel: string;
  diffLabel: string;
  [key: string]: unknown;
}

/** Derive the card's border/background/shadow from the node's primitive flags.
 *  Later conditions win, matching the design (running/done override selection). */
function cardStyleFor(data: IssueNodeData): CSSProperties {
  const style: CSSProperties = {
    background: "var(--color-hover)",
    border: "1px solid var(--color-line-3)",
    boxShadow: "0 1px 2px rgba(0,0,0,.4)",
  };
  if (data.grayed) {
    // Non-actionable context node: quiet, dashed, no shadow.
    style.background = "transparent";
    style.border = "1px dashed var(--color-line-3)";
    style.boxShadow = "none";
  }
  if (data.chainable) style.border = `1px solid ${alpha(40)}`;
  if (data.selected) {
    style.border = `1px solid ${accent}`;
    style.background = "var(--color-node-sel)";
    style.boxShadow = `0 0 0 1px ${accent}, 0 8px 26px -8px ${alpha(33)}`;
  }
  if (data.running) {
    style.border = `1px solid ${accent}`;
    style.background = "var(--color-node-run)";
    style.boxShadow = `0 0 0 1px ${alpha(40)}, 0 10px 32px -10px ${alpha(47)}`;
  }
  if (data.done) {
    style.border = "1px solid #2f6f4f";
    style.background = "var(--color-node-done)";
    style.boxShadow = "0 0 0 1px #2f6f4f55, 0 1px 2px rgba(0,0,0,.4)";
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

// The canvas rebuilds the whole nodes array on every session tick, so each node
// gets a fresh `data` object even when nothing about it changed. A reference
// compare would therefore re-render every node ~1.5×/sec; this value-compares the
// (all-primitive) data fields so unchanged nodes are genuinely skipped.
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
    a.running === b.running &&
    a.done === b.done &&
    a.dim === b.dim &&
    a.grayed === b.grayed &&
    a.pct === b.pct &&
    a.runColor === b.runColor &&
    a.stageLabel === b.stageLabel &&
    a.prLabel === b.prLabel &&
    a.diffLabel === b.diffLabel
  );
}

export const IssueNode = memo(
  function IssueNode({ id, data, selected }: NodeProps & { data: IssueNodeData }) {
    // Read the highlight state from context (not node data) so hover/selection
    // never rebuilds the React Flow nodes array — that churn was resetting node
    // measurement and blanking the canvas when a fitView landed mid-rebuild.
    const { focusId, hoverId } = useIssues();
    const focused = focusId === id;
    const hovered = hoverId === id && !focused;
    return (
      <div
        // Only paint properties are transitioned. Animating opacity/transform here
        // promotes each node to its own GPU layer which the viewport's scale()
        // then rasterizes at 1× and magnifies — WebKit keeps the layer around, so
        // the whole graph stays blurry after a focus toggle. Dim is applied
        // instantly instead.
        className="relative w-[212px] cursor-pointer rounded-[11px] px-3 py-2.5 text-left transition-[border-color,box-shadow] duration-200"
        style={{ opacity: data.dim ? 0.32 : data.grayed ? 0.62 : 1, ...cardStyleFor(data) }}
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
            style={{
              boxShadow: "0 0 0 2px color-mix(in srgb, var(--accent-text) 70%, transparent)",
            }}
          />
        ) : null}

        <div className="mb-1.5 flex items-center gap-[7px]">
          <Dot color={data.statusColor} size={8} />
          <span className="font-mono text-[11px] text-muted-2">{id}</span>
          <div className="ml-auto flex items-center gap-1">
            {data.ready && <Badge color={successColor}>RDY</Badge>}
            {data.chainBase && <Badge>⛓ {data.chainBase}</Badge>}
            {data.blocked && <span className="font-mono text-[10px] text-muted-3">⊘</span>}
            {data.done && (
              <span className="font-mono text-[9.5px] font-medium text-status-green">
                {data.prLabel}
              </span>
            )}
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
          {data.done && (
            <span className="ml-auto font-mono text-[10px] text-muted-4">{data.diffLabel}</span>
          )}
        </div>

        {data.running && (
          <>
            <div className="mt-[9px] h-[3px] overflow-hidden rounded-sm bg-line-2">
              <div
                className="h-full transition-[width] duration-500"
                style={{
                  width: `${data.pct}%`,
                  background: data.runColor,
                  boxShadow: `0 0 8px ${data.runColor}`,
                }}
              />
            </div>
            <div className="mt-[7px] flex items-center gap-1.5">
              <Spinner size={11} color={data.runColor} />
              <span className="font-mono text-[10px]" style={{ color: data.runColor }}>
                {data.stageLabel}
              </span>
            </div>
          </>
        )}
      </div>
    );
  },
  // React Flow also passes other NodeProps (selectable, positionAbsolute, …) but
  // none of them drive this card's output, so comparing id + selected + data is
  // sufficient to skip an unchanged node.
  (prev, next) =>
    prev.id === next.id && prev.selected === next.selected && dataEqual(prev.data, next.data),
);
