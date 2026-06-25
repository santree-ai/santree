/** A single ticket row in the Issues sidebar list. Presentational. */
import type { CSSProperties } from "react";

import { Dot, Spinner } from "../../components/primitives";

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
  showRun: boolean;
  runColor: string;
  showDone: boolean;
  prMini: string;
  rowStyle: CSSProperties;
  boxStyle: CSSProperties;
  onClick: () => void;
}

export function IssueRow({ vm }: { vm: IssueRowVM }) {
  return (
    <button
      type="button"
      onClick={vm.onClick}
      className="mb-0.5 flex w-full gap-2 rounded-md px-2 py-[7px] text-left transition-colors hover:bg-[#15161a]"
      style={vm.rowStyle}
    >
      {vm.selectable && (
        <div
          className="mt-0.5 flex h-3.5 w-3.5 flex-none items-center justify-center rounded text-[9px] font-bold text-[#06231a]"
          style={vm.boxStyle}
        >
          {vm.selected ? "✓" : ""}
        </div>
      )}
      <span className="mt-[5px] flex-none">
        <Dot color={vm.statusColor} size={7} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="flex-none font-mono text-[10px] text-muted-2">{vm.id}</span>
          <span className="ml-auto flex items-center gap-1">
            {vm.showRdy && (
              <span className="rounded-[3px] border border-status-green/30 bg-status-green/10 px-1 py-px font-mono text-[8px] font-semibold tracking-wider text-status-green">
                RDY
              </span>
            )}
            {vm.showChain && (
              <span
                className="font-mono text-[8px] font-semibold"
                style={{ color: "var(--accent)" }}
              >
                ⛓ {vm.chainBase}
              </span>
            )}
            {vm.showBlocked && <span className="font-mono text-[10px] text-muted-4">⊘</span>}
            {vm.showRun && <Spinner size={9} color={vm.runColor} />}
            {vm.showDone && (
              <span className="font-mono text-[9px] text-status-green">{vm.prMini}</span>
            )}
          </span>
        </div>
        <div className="mt-0.5 overflow-hidden text-[11.5px] leading-[1.3] text-ellipsis whitespace-nowrap text-fg-3">
          {vm.title}
        </div>
      </div>
    </button>
  );
}
