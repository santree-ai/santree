import { ViewShell } from "../chrome";
import {
  GRAPH_EDGES,
  GRAPH_NODES,
  type GraphNode,
  ISSUE_STATUS_META,
  LAUNCH_TRAY,
  PROJECT_BANDS,
} from "../data";
import { AsciiSpinner, Badge, ChevronDownGlyph, Dot, PrChip, SelectBox } from "../widgets";

/** Issues: the real three-part layout, simplified — the grouped ticket list
 * with its launch tray in the sidebar, and the dependency graph (project
 * bands + status-dotted cards) as one SVG edge layer under DOM cards. No
 * React Flow; the canvas is a fixed design surface, so coordinates are data. */

const NODE_W = 212;
const NODE_H = 92;
const PANE_X = 24; // graph pane inset inside the view
const PANE_Y = 16;

function edgePath(from: GraphNode, to: GraphNode): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  const dx = Math.max((x2 - x1) / 2, 40);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function nodeCardStyle(node: GraphNode): React.CSSProperties {
  // Later conditions win, like the real cardStyleFor: default → WIP amber →
  // queued-for-launch accent fill.
  const style: React.CSSProperties = {
    background: "rgba(255,255,255,0.04)",
    border: "1px solid var(--color-line-2)",
  };
  if (node.working) {
    style.border = "1px solid color-mix(in srgb, var(--color-status-amber) 55%, transparent)";
    style.background = "color-mix(in srgb, var(--color-status-amber) 7%, transparent)";
  }
  if (node.launching) {
    style.border = "1px solid var(--color-accent)";
    style.background = "color-mix(in srgb, var(--color-accent) 15%, transparent)";
    style.boxShadow =
      "0 0 0 1px color-mix(in srgb, var(--color-accent) 50%, transparent), 0 8px 26px -8px color-mix(in srgb, var(--color-accent) 33%, transparent)";
  }
  return style;
}

function NodeCard({ node, live }: { node: GraphNode; live: boolean }) {
  const status = ISSUE_STATUS_META[node.status];
  return (
    <div
      className="absolute rounded-[11px] px-3 py-2.5"
      style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H, ...nodeCardStyle(node) }}
    >
      <div className="mb-1.5 flex items-center gap-[7px]">
        <Dot color={status.color} size={8} />
        <span className="font-mono text-[11px] text-muted-2">{node.id}</span>
        <span className="ml-auto flex items-center gap-1">
          {node.working && <Badge color="var(--color-status-amber)">WIP</Badge>}
          {node.ready && !node.working && <Badge color="var(--color-status-green)">RDY</Badge>}
          {node.status === "blocked" && (
            <span className="font-mono text-[10px] text-muted-2">⊘</span>
          )}
          {node.pr && <PrChip num={node.pr.num} state={node.pr.state} />}
        </span>
      </div>
      <div className="line-clamp-2 min-h-[30px] text-[12px] leading-[1.32] text-fg/85">
        {node.title}
      </div>
      <div className="mt-1 flex items-center gap-[7px] text-[10.5px] font-medium">
        <span style={{ color: status.color }}>{status.label}</span>
        {node.launching && (
          <span className="ml-auto flex items-center gap-1 font-normal text-accent">
            {live && <AsciiSpinner className="text-[9px]" />}
            launching agent…
          </span>
        )}
      </div>
    </div>
  );
}

function IssueRow({ node }: { node: GraphNode }) {
  const status = ISSUE_STATUS_META[node.status];
  return (
    <div
      className="flex items-start gap-2 rounded-md px-2 py-[7px]"
      style={
        node.launching
          ? { background: "color-mix(in srgb, var(--color-accent) 6%, transparent)" }
          : undefined
      }
    >
      <span className="mt-0.5">
        <SelectBox selected={node.launching} />
      </span>
      <span className="mt-[5px]">
        <Dot color={status.color} size={7} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[10px] text-muted-2">{node.id}</span>
          <span className="ml-auto flex items-center gap-1">
            {node.working && <Badge color="var(--color-status-amber)">WIP</Badge>}
            {node.ready && !node.working && <Badge color="var(--color-status-green)">RDY</Badge>}
          </span>
        </div>
        <div className="truncate text-[11.5px] leading-[1.35] text-fg/85">{node.title}</div>
      </div>
    </div>
  );
}

function Sidebar() {
  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hairline px-[15px]">
        <span className="text-[12px] font-semibold text-fg/90">Issues</span>
        <span className="font-mono text-[10.5px] text-muted-4">{GRAPH_NODES.length}</span>
        <span className="ml-auto rounded-md border border-line-2 bg-white/3 px-2 py-1 text-[10px] text-muted">
          Select Ready 2
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-1.5">
        {PROJECT_BANDS.map((band) => (
          <div key={band.name} className="mb-1.5">
            <div className="flex items-center gap-[7px] px-2 pb-1 pt-1.5">
              <Dot color={band.color} size={7} />
              <span className="text-[11px] font-semibold text-fg/90">{band.name}</span>
              <span className="ml-auto font-mono text-[9.5px] text-muted-4">{band.count}</span>
            </div>
            {GRAPH_NODES.filter((n) => n.band === band.name).map((n) => (
              <IssueRow key={n.id} node={n} />
            ))}
          </div>
        ))}
      </div>
      {/* Launch tray */}
      <div className="shrink-0 border-t border-hairline p-2.5">
        <div className="mb-2 flex items-center gap-1.5 px-0.5 font-mono text-[10px] text-muted-2">
          {LAUNCH_TRAY.agent} · {LAUNCH_TRAY.model}
          <ChevronDownGlyph size={10} className="text-muted-4" />
        </div>
        <span className="flex w-full items-center justify-center rounded-lg bg-accent py-1.5 text-[11px] font-semibold text-on-accent">
          Launch {LAUNCH_TRAY.count} agent
        </span>
      </div>
    </>
  );
}

export function IssuesView({ live }: { live: boolean }) {
  const byId = new Map(GRAPH_NODES.map((n) => [n.id, n]));
  return (
    <ViewShell
      sidebar={<Sidebar />}
      main={
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
            {/* Translucent project bands behind their nodes */}
            {PROJECT_BANDS.map((band) => (
              <div
                key={band.name}
                className="absolute rounded-[14px]"
                style={{
                  left: band.x,
                  top: band.y,
                  width: band.w,
                  height: band.h,
                  border: `1px solid color-mix(in srgb, ${band.color} 20%, transparent)`,
                  background: `color-mix(in srgb, ${band.color} 4%, transparent)`,
                }}
              >
                <div
                  className="absolute left-[13px] top-[9px] flex items-center gap-[7px] text-[11px] font-semibold"
                  style={{ color: band.color }}
                >
                  <Dot color={band.color} size={7} />
                  {band.name}
                  <span className="font-mono text-[9.5px] text-muted-4">{band.count}</span>
                </div>
              </div>
            ))}
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
                      to.launching || from.launching
                        ? "rgba(45,212,167,0.4)"
                        : "rgba(255,255,255,0.12)"
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
      }
    />
  );
}
