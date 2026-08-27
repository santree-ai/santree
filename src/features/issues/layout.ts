/**
 * Dependency-graph layout for the Issues canvas.
 *
 * Projects form the outer vertical bands. Each Linear milestone gets a nested
 * band and its own left-to-right Dagre layout, so planning groups never overlap
 * or interleave. Dependencies across milestones/projects are still drawn, but
 * do not pull nodes out of their planning boundary.
 */
import Dagre from "@dagrejs/dagre";

import type { Task } from "../../bindings";
import { groupByMilestone, showMilestoneGroups } from "../../components/WorkSignals";

export const NODE_W = 212;
export const NODE_H = 96;

const PROJECT_PAD = 14;
const PROJECT_LABEL = 28;
const PROJECT_GAP = 40;
const MILESTONE_PAD = 16;
const MILESTONE_LABEL = 24;
const MILESTONE_GAP = 12;
const MARGIN = 28;

export interface LaidBox {
  project: string;
  x: number;
  y: number;
  width: number;
  height: number;
  count: number;
}

export interface LaidMilestoneBox {
  project: string;
  key: string;
  label: string;
  targetDate: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  count: number;
}

export interface LaidGraph {
  pos: Map<string, { x: number; y: number }>;
  boxes: LaidBox[];
  milestoneBoxes: LaidMilestoneBox[];
}

interface LocalLayout {
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

function layoutMilestone(tasks: Task[]): LocalLayout {
  const graph = new Dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "LR", nodesep: 22, ranksep: 70, marginx: 0, marginy: 0 });
  graph.setDefaultEdgeLabel(() => ({}));

  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) graph.setNode(task.id, { width: NODE_W, height: NODE_H });
  for (const task of tasks) {
    for (const blocker of task.blockedBy) {
      if (ids.has(blocker)) graph.setEdge(blocker, task.id);
    }
  }
  Dagre.layout(graph);

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const raw = new Map<string, { x: number; y: number }>();
  for (const task of tasks) {
    const node = graph.node(task.id);
    const x = node.x - node.width / 2;
    const y = node.y - node.height / 2;
    raw.set(task.id, { x, y });
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + node.width);
    maxY = Math.max(maxY, y + node.height);
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const [id, point] of raw) {
    positions.set(id, { x: point.x - minX, y: point.y - minY });
  }
  return { positions, width: maxX - minX, height: maxY - minY };
}

export function layoutGraph(tasks: Task[]): LaidGraph {
  const pos = new Map<string, { x: number; y: number }>();
  const boxes: LaidBox[] = [];
  const milestoneBoxes: LaidMilestoneBox[] = [];
  if (tasks.length === 0) return { pos, boxes, milestoneBoxes };

  const projects = new Map<string, Task[]>();
  for (const task of tasks) {
    projects.set(task.project, [...(projects.get(task.project) ?? []), task]);
  }

  let projectTop = MARGIN;
  for (const [project, projectTasks] of projects) {
    const groups = groupByMilestone(projectTasks, (task) => task.projectMilestone);
    const layouts = groups.map((group) => ({ group, layout: layoutMilestone(group.items) }));
    if (!showMilestoneGroups(groups)) {
      const layout = layouts[0].layout;
      for (const [id, point] of layout.positions) {
        pos.set(id, {
          x: MARGIN + PROJECT_PAD + point.x,
          y: projectTop + PROJECT_LABEL + PROJECT_PAD + point.y,
        });
      }
      const projectHeight = layout.height + PROJECT_LABEL + PROJECT_PAD * 2;
      boxes.push({
        project,
        x: MARGIN,
        y: projectTop,
        width: layout.width + PROJECT_PAD * 2,
        height: projectHeight,
        count: projectTasks.length,
      });
      projectTop += projectHeight + PROJECT_GAP;
      continue;
    }
    const milestoneWidths = layouts.map(({ layout }) => layout.width + MILESTONE_PAD * 2);
    const projectWidth = Math.max(...milestoneWidths) + PROJECT_PAD * 2;

    let milestoneTop = projectTop + PROJECT_LABEL + PROJECT_PAD;
    for (const [index, { group, layout }] of layouts.entries()) {
      const milestoneX = MARGIN + PROJECT_PAD;
      const width = milestoneWidths[index];
      const height = layout.height + MILESTONE_PAD * 2 + MILESTONE_LABEL;
      milestoneBoxes.push({
        project,
        key: group.key,
        label: group.label,
        targetDate: group.targetDate,
        x: milestoneX,
        y: milestoneTop,
        width,
        height,
        count: group.items.length,
      });

      for (const [id, point] of layout.positions) {
        pos.set(id, {
          x: milestoneX + MILESTONE_PAD + point.x,
          y: milestoneTop + MILESTONE_LABEL + MILESTONE_PAD + point.y,
        });
      }
      milestoneTop += height + MILESTONE_GAP;
    }

    const projectHeight = milestoneTop - projectTop - MILESTONE_GAP + PROJECT_PAD;
    boxes.push({
      project,
      x: MARGIN,
      y: projectTop,
      width: projectWidth,
      height: projectHeight,
      count: projectTasks.length,
    });
    projectTop += projectHeight + PROJECT_GAP;
  }

  return { pos, boxes, milestoneBoxes };
}
