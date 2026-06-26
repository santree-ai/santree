/** SVG dependency edges between graph nodes. */
export interface EdgeVM {
  id: string;
  d: string;
  stroke: string;
  width: number;
  dash: string;
  marker: string;
  opacity: number;
  animated: boolean;
}

export function GraphEdges({
  edges,
  width,
  height,
}: {
  edges: EdgeVM[];
  width: number;
  height: number;
}) {
  return (
    <svg
      width={width}
      height={height}
      className="pointer-events-none absolute top-0 left-0 overflow-visible"
      aria-hidden
    >
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3.5" orient="auto">
          <path d="M0,0 L7,3.5 L0,7 z" fill="var(--color-line-strong)" />
        </marker>
        <marker id="arrowA" markerWidth="9" markerHeight="9" refX="6.5" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill="#2dd4a7" />
        </marker>
        <marker id="arrowX" markerWidth="9" markerHeight="9" refX="6.5" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill="#c98a4a" />
        </marker>
      </defs>
      {edges.map((e) => (
        <path
          key={e.id}
          d={e.d}
          fill="none"
          stroke={e.stroke}
          strokeWidth={e.width}
          strokeDasharray={e.dash}
          markerEnd={e.marker}
          className={e.animated ? "animate-dashflow" : undefined}
          style={{ opacity: e.opacity }}
        />
      ))}
    </svg>
  );
}
