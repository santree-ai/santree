/**
 * A translucent grouping band drawn behind the ticket nodes of one project.
 * Rendered as a non-interactive React Flow node sized to the band's bounding
 * box; clicking its label toggles the project focus filter.
 */
import type { NodeProps } from "@xyflow/react";
import { memo } from "react";

import { ProjectGlyph } from "../../components/primitives";

export interface ProjectNodeData {
  project: string;
  width: number;
  height: number;
  color: string;
  /** Project icon (emoji) when Linear has one, else null → colored dot. */
  icon: string | null;
  count: number;
  dim: boolean;
  [key: string]: unknown;
}

export const ProjectNode = memo(
  function ProjectNode({ data }: NodeProps & { data: ProjectNodeData }) {
    return (
      <div
        // No opacity transition — see IssueNode: animating it in WebKit promotes a
        // scaled GPU layer and leaves the canvas blurry. Dim applies instantly.
        className="rounded-[14px] transition-colors duration-200"
        style={{
          width: data.width,
          height: data.height,
          border: `1px solid ${data.color}${data.dim ? "18" : "33"}`,
          background: `${data.color}${data.dim ? "04" : "0b"}`,
          opacity: data.dim ? 0.5 : 1,
        }}
      >
        <div
          className="absolute top-[9px] left-[13px] flex items-center gap-[7px] text-[11px] font-semibold"
          style={{
            color: data.dim ? "var(--color-muted-4)" : data.color,
            maxWidth: data.width - 26,
          }}
        >
          <ProjectGlyph color={data.color} icon={data.icon} size={7} />
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
            {data.project}
          </span>
          <span className="flex-none font-mono text-[9.5px] text-muted-4">{data.count}</span>
        </div>
      </div>
    );
  },
  // The canvas rebuilds the nodes array (and so each `data` object) whenever the
  // layout recomputes — e.g. on every session tick that resizes a running node.
  // Value-compare the primitive fields so unchanged bands aren't re-rendered.
  (prev, next) =>
    prev.data.project === next.data.project &&
    prev.data.width === next.data.width &&
    prev.data.height === next.data.height &&
    prev.data.color === next.data.color &&
    prev.data.icon === next.data.icon &&
    prev.data.count === next.data.count &&
    prev.data.dim === next.data.dim,
);
