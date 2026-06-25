/** A single ticket card in the dependency graph. Purely presentational. */
import type { CSSProperties } from "react";

import { Badge, Dot, Spinner } from "../../components/primitives";

export interface NodeVM {
  id: string;
  title: string;
  left: number;
  top: number;
  statusColor: string;
  statusLabel: string;
  style: CSSProperties;
  ready: boolean;
  chainBase: string | null;
  blocked: boolean;
  running: boolean;
  done: boolean;
  pct: number;
  runColor: string;
  stageLabel: string;
  prLabel: string;
  diffLabel: string;
  onClick: () => void;
  onHover: () => void;
}

export function GraphNode({ vm }: { vm: NodeVM }) {
  return (
    <button
      type="button"
      onClick={vm.onClick}
      onMouseEnter={vm.onHover}
      className="absolute w-[212px] cursor-pointer rounded-[11px] px-3 py-2.5 text-left transition-[border-color,box-shadow,transform] duration-200"
      style={{ left: vm.left, top: vm.top, ...vm.style }}
    >
      <div className="mb-1.5 flex items-center gap-[7px]">
        <Dot color={vm.statusColor} size={8} />
        <span className="font-mono text-[11px] text-muted-2">{vm.id}</span>
        <div className="ml-auto flex items-center">
          {vm.ready && <Badge color="#3fb950">RDY</Badge>}
          {vm.chainBase && <Badge>⛓ {vm.chainBase}</Badge>}
          {vm.blocked && <span className="font-mono text-[10px] text-muted-3">⊘</span>}
          {vm.done && (
            <span className="font-mono text-[9.5px] font-medium text-status-green">
              {vm.prLabel}
            </span>
          )}
        </div>
      </div>

      <div
        className="min-h-[33px] overflow-hidden text-[12.5px] leading-[1.32] font-normal text-fg-3"
        style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}
      >
        {vm.title}
      </div>

      <div className="mt-[7px] flex min-h-[14px] items-center gap-[7px]">
        <span className="text-[10.5px] font-medium" style={{ color: vm.statusColor }}>
          {vm.statusLabel}
        </span>
        {vm.done && (
          <span className="ml-auto font-mono text-[10px] text-muted-4">{vm.diffLabel}</span>
        )}
      </div>

      {vm.running && (
        <>
          <div className="mt-[9px] h-[3px] overflow-hidden rounded-sm bg-line-2">
            <div
              className="h-full transition-[width] duration-500"
              style={{
                width: `${vm.pct}%`,
                background: vm.runColor,
                boxShadow: `0 0 8px ${vm.runColor}`,
              }}
            />
          </div>
          <div className="mt-[7px] flex items-center gap-1.5">
            <Spinner size={11} color={vm.runColor} />
            <span className="font-mono text-[10px]" style={{ color: vm.runColor }}>
              {vm.stageLabel}
            </span>
          </div>
        </>
      )}
    </button>
  );
}
