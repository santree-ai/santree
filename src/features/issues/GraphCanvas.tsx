/**
 * The dependency graph: project grouping boxes, blocked-by edges, and ticket
 * nodes. This module owns the geometry/derivation; the pieces it renders
 * (ProjectBox, GraphEdges, GraphNode) are presentational.
 */

import type { CSSProperties } from "react";
import { useMemo } from "react";

import type { Task } from "../../bindings";
import { useWorktrees } from "../../lib/queries";
import { agentSlug, colorForProject, statusColor, statusLabel } from "../../theme/colors";
import { type EdgeVM, GraphEdges } from "./GraphEdges";
import { GraphNode, type NodeVM } from "./GraphNode";
import { useIssues, useStageHelpers } from "./model";
import { ProjectBox, type ProjectBoxVM } from "./ProjectBox";

const NODE_W = 212;
const NODE_H = 64;
const CANVAS_MIN_W = 760;
const CANVAS_MIN_H = 690;

const accent = "var(--accent)";
const alpha = (pct: number) => `color-mix(in srgb, var(--accent) ${pct}%, transparent)`;

export function GraphCanvas() {
  const {
    tasks,
    sessionByTask,
    selected,
    focusId,
    focusProject,
    baseFor,
    toggle,
    setFocus,
    toggleProjectFocus,
  } = useIssues();
  const { data: worktrees = [] } = useWorktrees();
  const { pctFor, labelFor } = useStageHelpers();

  const worktreeIds = useMemo(() => {
    const set = new Set(worktrees.map((w) => w.id));
    for (const id of sessionByTask.keys()) set.add(id);
    return set;
  }, [worktrees, sessionByTask]);

  const posById = useMemo(() => {
    const map = new Map<string, Task>();
    for (const t of tasks) map.set(t.id, t);
    return map;
  }, [tasks]);

  const nodes = useMemo<NodeVM[]>(() => {
    return tasks.map((t) => {
      const session = sessionByTask.get(t.id);
      const running = !!session && session.stage < 4;
      const done = !!session && session.stage >= 4;
      const isSelected = !!selected[t.id] && !session;
      const focused = focusId === t.id;
      const chainBase = t.ready ? null : baseFor(t);
      const chainable = chainBase !== null && !session;
      const dim = focusProject !== null && t.project !== focusProject;

      // Layered styling — later conditions win, matching the design.
      const style: CSSProperties = {
        background: "var(--color-hover)",
        border: "1px solid var(--color-line-3)",
        boxShadow: "0 1px 2px rgba(0,0,0,.4)",
        opacity: dim ? 0.32 : 1,
      };
      if (focused) style.border = "1px solid var(--color-dot)";
      if (chainable && !isSelected) style.border = `1px solid ${alpha(40)}`;
      if (isSelected) {
        style.border = `1px solid ${accent}`;
        style.background = "var(--color-node-sel)";
        style.boxShadow = `0 0 0 1px ${accent}, 0 8px 26px -8px ${alpha(33)}`;
      }
      if (running) {
        style.border = `1px solid ${accent}`;
        style.background = "var(--color-node-run)";
        style.boxShadow = `0 0 0 1px ${alpha(40)}, 0 10px 32px -10px ${alpha(47)}`;
      }
      if (done) {
        style.border = "1px solid #2f6f4f";
        style.background = "var(--color-node-done)";
        style.boxShadow = "0 0 0 1px #2f6f4f55, 0 1px 2px rgba(0,0,0,.4)";
      }

      const stage = session ? Math.min(session.stage, 4) : 0;
      return {
        id: t.id,
        title: t.title,
        left: t.x,
        top: t.y,
        statusColor: statusColor[t.status],
        statusLabel: statusLabel[t.status],
        style,
        ready: t.ready && !session,
        chainBase: chainable ? chainBase : null,
        blocked: !t.ready && !chainable && !session,
        running,
        done,
        pct: session ? pctFor(stage) : 0,
        runColor: done ? "#3fb950" : accent,
        stageLabel: session
          ? session.stage === 2
            ? `${agentSlug(session.agent)} working`
            : labelFor(stage)
          : "",
        prLabel: done && session ? `PR #${session.pr}` : "",
        diffLabel: done && session ? `+${session.add} −${session.del}` : "",
        onClick: () => toggle(t.id),
        onHover: () => {
          if (focusId !== t.id) setFocus(t.id);
        },
      };
    });
  }, [
    tasks,
    sessionByTask,
    selected,
    focusId,
    focusProject,
    baseFor,
    pctFor,
    labelFor,
    toggle,
    setFocus,
  ]);

  const edges = useMemo<EdgeVM[]>(() => {
    const list: EdgeVM[] = [];
    for (const t of tasks) {
      for (const depId of t.blockedBy) {
        const a = posById.get(depId);
        if (!a) continue;
        const sx = a.x + NODE_W;
        const sy = a.y + NODE_H / 2;
        const tx = t.x;
        const ty = t.y + NODE_H / 2;
        const dx = Math.max(44, (tx - sx) * 0.5);
        const dep = sessionByTask.get(depId);
        const active = !!dep && dep.stage >= 1;
        const chained = worktreeIds.has(depId);
        const crossProject = a.project !== t.project;

        let stroke = active ? accent : chained ? alpha(67) : "var(--color-line-strong)";
        let width = active ? 2 : chained ? 1.8 : 1.5;
        let dash = active ? "5 7" : "0";
        let marker = active || chained ? "url(#arrowA)" : "url(#arrow)";
        let opacity = active ? 0.95 : chained ? 0.85 : 0.6;
        if (crossProject && !active) {
          stroke = "#c98a4a";
          dash = "4 5";
          marker = "url(#arrowX)";
          opacity = 0.85;
          width = 1.6;
        }
        list.push({
          id: `${depId}->${t.id}`,
          d: `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`,
          stroke,
          width,
          dash,
          marker,
          opacity,
          animated: active,
        });
      }
    }
    return list;
  }, [tasks, posById, sessionByTask, worktreeIds]);

  const boxes = useMemo<ProjectBoxVM[]>(() => {
    const order: string[] = [];
    for (const t of tasks) if (!order.includes(t.project)) order.push(t.project);
    const heightOf = (t: Task) => {
      const s = sessionByTask.get(t.id);
      return s && s.stage < 4 ? 136 : 100;
    };
    return order.map((project) => {
      const inProject = tasks.filter((t) => t.project === project);
      const minX = Math.min(...inProject.map((t) => t.x));
      const minY = Math.min(...inProject.map((t) => t.y));
      const maxX = Math.max(...inProject.map((t) => t.x + NODE_W));
      const maxY = Math.max(...inProject.map((t) => t.y + heightOf(t)));
      const color = colorForProject(project);
      const dim = focusProject !== null && focusProject !== project;
      return {
        project,
        left: minX - 16,
        top: minY - 32,
        width: maxX - minX + 32,
        height: maxY - minY + 48,
        color,
        border: `${color}${dim ? "18" : "33"}`,
        bg: `${color}${dim ? "04" : "0b"}`,
        labelColor: dim ? "var(--color-muted-4)" : color,
        opacity: dim ? 0.5 : 1,
        count: inProject.length,
        onClick: () => toggleProjectFocus(project),
      };
    });
  }, [tasks, sessionByTask, focusProject, toggleProjectFocus]);

  // Size the canvas to the content so large real graphs scroll.
  const { canvasW, canvasH } = useMemo(() => {
    let w = CANVAS_MIN_W;
    let h = CANVAS_MIN_H;
    for (const t of tasks) {
      w = Math.max(w, t.x + NODE_W + 40);
      h = Math.max(h, t.y + 160);
    }
    return { canvasW: w, canvasH: h };
  }, [tasks]);

  return (
    <div className="relative flex-1 overflow-auto">
      <div className="relative mx-auto my-2" style={{ width: canvasW, height: canvasH }}>
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage: "radial-gradient(circle, rgba(255,255,255,.05) 1px, transparent 1px)",
            backgroundSize: "24px 24px",
          }}
        />
        {boxes.map((vm) => (
          <ProjectBox key={vm.project} vm={vm} />
        ))}
        <GraphEdges edges={edges} width={canvasW} height={canvasH} />
        {nodes.map((vm) => (
          <GraphNode key={vm.id} vm={vm} />
        ))}
      </div>
    </div>
  );
}
