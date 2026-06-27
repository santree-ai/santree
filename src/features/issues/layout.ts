/**
 * Dependency-graph layout for the Issues canvas.
 *
 * Linear gives us issues and their blocking relations but no coordinates, so we
 * lay the graph out ourselves with dagre: blockers flow left → right (a task
 * sits in a column right of its blockers) and each project is its own vertical
 * band. Layout runs per-project so bands never interleave; cross-project edges
 * are still returned and drawn between bands.
 *
 * Pure and deterministic — the React Flow layer just consumes the positions.
 */
import Dagre from "@dagrejs/dagre";

import type { Task } from "../../bindings";

export const NODE_W = 212;
/** Resting card height; running cards are taller (progress bar + log row). */
export const NODE_H = 96;
export const NODE_H_RUNNING = 142;

// Inner padding of a project band, and extra headroom for its label.
const BAND_PAD = 18;
const BAND_LABEL = 26;
const BAND_GAP = 40;
const MARGIN = 28;

export interface LaidBox {
  project: string;
  x: number;
  y: number;
  width: number;
  height: number;
  count: number;
}

export interface LaidGraph {
  /** Top-left position for every task id. */
  pos: Map<string, { x: number; y: number }>;
  boxes: LaidBox[];
}

/**
 * Lay out `tasks` into per-project bands. `heightOf` lets running nodes claim
 * more vertical space so their taller cards don't overlap their neighbours.
 */
export function layoutGraph(tasks: Task[], heightOf: (t: Task) => number): LaidGraph {
  const pos = new Map<string, { x: number; y: number }>();
  const boxes: LaidBox[] = [];
  if (tasks.length === 0) return { pos, boxes };

  const ids = new Set(tasks.map((t) => t.id));

  // Projects as vertical bands, in first-seen order.
  const order: string[] = [];
  for (const t of tasks) if (!order.includes(t.project)) order.push(t.project);

  let bandTop = MARGIN;
  for (const project of order) {
    const members = tasks.filter((t) => t.project === project);

    const g = new Dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", nodesep: 22, ranksep: 70, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));

    for (const t of members) g.setNode(t.id, { width: NODE_W, height: heightOf(t) });
    // Only intra-project blockers shape this band's layout; cross-project links
    // are drawn as edges but must not pull a foreign node into the band.
    for (const t of members) {
      for (const dep of t.blockedBy) {
        if (ids.has(dep) && members.some((m) => m.id === dep)) g.setEdge(dep, t.id);
      }
    }

    Dagre.layout(g);

    // dagre positions are centers; shift so the band's own min corner is (0,0),
    // then offset into the band (inside its padding + label headroom).
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    const local = new Map<string, { x: number; y: number; h: number }>();
    for (const t of members) {
      const n = g.node(t.id);
      const x = n.x - n.width / 2;
      const y = n.y - n.height / 2;
      local.set(t.id, { x, y, h: n.height });
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + n.width);
      maxY = Math.max(maxY, y + n.height);
    }

    const offX = MARGIN + BAND_PAD - minX;
    const offY = bandTop + BAND_PAD + BAND_LABEL - minY;
    for (const [id, n] of local) pos.set(id, { x: n.x + offX, y: n.y + offY });

    const bandW = maxX - minX + BAND_PAD * 2;
    const bandH = maxY - minY + BAND_PAD * 2 + BAND_LABEL;
    boxes.push({
      project,
      x: MARGIN,
      y: bandTop,
      width: bandW,
      height: bandH,
      count: members.length,
    });

    bandTop += bandH + BAND_GAP;
  }

  return { pos, boxes };
}
