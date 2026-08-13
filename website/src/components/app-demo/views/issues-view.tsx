import { GRAPH_EDGES, GRAPH_NODES, type GraphNode, type NodeStatus } from "../data";
import { AsciiSpinner } from "../widgets";

/** Issues: the dependency DAG, simplified — hardcoded node coordinates with
 * one SVG layer of bézier edges underneath DOM cards. No React Flow; the
 * canvas is a fixed 1280×800 design surface, so coordinates are just data. */

const NODE_W = 240;
const NODE_H = 64;
const PANE_X = 60; // graph pane inset inside the view
const PANE_Y = 40;

const STATUS_COLOR: Record<NodeStatus, string> = {
  done: "var(--color-status-purple)",
  started: "var(--color-status-green)",
  todo: "var(--color-muted-2)",
  blocked: "var(--color-status-red)",
};

const STATUS_LABEL: Record<NodeStatus, string> = {
  done: "Done",
  started: "In progress",
  todo: "Todo",
  blocked: "Blocked",
};

function edgePath(from: GraphNode, to: GraphNode): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  const dx = Math.max((x2 - x1) / 2, 40);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function NodeCard({ node, live }: { node: GraphNode; live: boolean }) {
  const color = STATUS_COLOR[node.status];
  return (
    <div
      className={`absolute rounded-lg border px-3 py-2 ${
        node.launching ? "border-accent/60 bg-accent/6" : "border-hairline bg-white/3"
      }`}
      style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
    >
      <div className="flex items-center gap-1.5">
        <span className="size-1.5 rounded-full" style={{ background: color }} aria-hidden />
        <span className="font-mono text-[9px] text-muted-4">{node.id}</span>
        <span className="ml-auto font-mono text-[8px] uppercase tracking-wide text-muted-4">
          {STATUS_LABEL[node.status]}
        </span>
      </div>
      <div className="mt-1 truncate text-[10.5px] text-fg/90">{node.title}</div>
      {node.launching && (
        <div className="mt-0.5 flex items-center gap-1 text-[9px] text-accent">
          {live && <AsciiSpinner className="text-[9px]" />}
          launching agent…
        </div>
      )}
    </div>
  );
}

export function IssuesView({ live }: { live: boolean }) {
  const byId = new Map(GRAPH_NODES.map((n) => [n.id, n]));
  return (
    <div className="relative size-full overflow-hidden">
      {/* Faint dot grid, like the real graph pane */}
      <div
        className="absolute inset-0 opacity-40"
        style={{
          backgroundImage: "radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px)",
          backgroundSize: "26px 26px",
        }}
        aria-hidden
      />
      <div className="absolute" style={{ left: PANE_X, top: PANE_Y, right: 0, bottom: 0 }}>
        <svg className="absolute inset-0 size-full" aria-hidden>
          {GRAPH_EDGES.map((edge) => {
            const from = byId.get(edge.from);
            const to = byId.get(edge.to);
            if (!from || !to) return null;
            return (
              <path
                key={`${edge.from}-${edge.to}`}
                d={edgePath(from, to)}
                fill="none"
                stroke={
                  to.launching || from.launching ? "rgba(45,212,167,0.4)" : "rgba(255,255,255,0.12)"
                }
                strokeWidth={1.25}
              />
            );
          })}
        </svg>
        {GRAPH_NODES.map((node) => (
          <NodeCard key={node.id} node={node} live={live} />
        ))}
      </div>
    </div>
  );
}
