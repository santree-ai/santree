import type { NodeProps } from "@xyflow/react";
import { memo } from "react";

import { MilestoneDueDate } from "../../components/WorkSignals";
import { alpha } from "../../theme/colors";

export interface MilestoneNodeData {
  label: string;
  targetDate: string | null;
  width: number;
  height: number;
  color: string;
  count: number;
  dim: boolean;
  [key: string]: unknown;
}

/** A non-owning visual band: issue coordinates stay absolute, so dependency
 * edges can cross milestone boundaries without React Flow parent-node rules. */
export const MilestoneNode = memo(
  function MilestoneNode({ data }: NodeProps & { data: MilestoneNodeData }) {
    return (
      <div
        className="rounded-[10px]"
        style={{
          width: data.width,
          height: data.height,
          border: `1px solid ${alpha(data.dim ? 8 : 18, data.color)}`,
          background: alpha(data.dim ? 1 : 3, data.color),
          opacity: data.dim ? 0.45 : 1,
        }}
      >
        <div
          className="absolute top-[7px] left-[11px] flex items-center gap-1.5 font-mono text-[9px] tracking-[.04em] uppercase"
          style={{
            color: data.dim ? "var(--color-muted-4)" : data.color,
            maxWidth: data.width - 22,
          }}
        >
          <span
            aria-hidden
            className="h-1.5 w-1.5 flex-none rotate-45 rounded-[1px] border border-current"
          />
          <span className="truncate">{data.label}</span>
          <span className="flex-none text-muted-4">{data.count}</span>
          <MilestoneDueDate date={data.targetDate} />
        </div>
      </div>
    );
  },
  (prev, next) =>
    prev.data.label === next.data.label &&
    prev.data.targetDate === next.data.targetDate &&
    prev.data.width === next.data.width &&
    prev.data.height === next.data.height &&
    prev.data.color === next.data.color &&
    prev.data.count === next.data.count &&
    prev.data.dim === next.data.dim,
);
