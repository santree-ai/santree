/**
 * The dependency graph, rendered with React Flow. Tickets are laid out by dagre
 * (blockers left → right, one band per project — see `layout.ts`), drawn as
 * custom nodes, and connected by blocked-by edges. The canvas owns the
 * derivation of node/edge view-models; the node components stay presentational.
 */
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  MarkerType,
  MiniMap,
  type Node,
  type NodeMouseHandler,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useRef } from "react";

import type { Task } from "../../bindings";
import { usePrefetchOnHover } from "../../lib/queries";
import { useApp } from "../../state/AppContext";
import { alpha, PROJECT_FALLBACK, palette, statusColor, statusLabel } from "../../theme/colors";
import { IssueNode, type IssueNodeData } from "./IssueNode";
import { layoutGraph } from "./layout";
import { deriveIssueState, useIssueHover, useIssues } from "./model";
import { ProjectNode, type ProjectNodeData } from "./ProjectNode";

const nodeTypes = { issue: IssueNode, project: ProjectNode };

type IssueRFNode = Node<IssueNodeData, "issue">;
type ProjectRFNode = Node<ProjectNodeData, "project">;

function Flow() {
  const {
    tasks,
    byId,
    projectMeta,
    worktreeIds,
    selected,
    focusProject,
    actionableOnly,
    reveal,
    projectReveal,
    baseFor,
    toggle,
    setFocus,
    toggleProjectFocus,
    toggleActionableOnly,
  } = useIssues();
  const { setHover } = useIssueHover();
  const { activeRepo, theme } = useApp();
  const prefetchOnHover = usePrefetchOnHover(activeRepo);
  const { fitView } = useReactFlow();

  // Grayed context blockers are hidden when "Actionable only" is on.
  const hiddenCount = useMemo(() => tasks.filter((t) => !t.actionable).length, [tasks]);
  const visibleTasks = useMemo(
    () => (actionableOnly ? tasks.filter((t) => t.actionable) : tasks),
    [tasks, actionableOnly],
  );
  const visibleIds = useMemo(() => new Set(visibleTasks.map((t) => t.id)), [visibleTasks]);

  const { pos, boxes } = useMemo(() => layoutGraph(visibleTasks), [visibleTasks]);

  const nodes = useMemo<(IssueRFNode | ProjectRFNode)[]>(() => {
    const projectNodes: ProjectRFNode[] = boxes.map((b) => {
      const meta = projectMeta.get(b.project);
      return {
        id: `project:${b.project}`,
        type: "project",
        position: { x: b.x, y: b.y },
        draggable: false,
        selectable: false,
        focusable: false,
        zIndex: 0,
        data: {
          project: b.project,
          width: b.width,
          height: b.height,
          color: meta?.color ?? PROJECT_FALLBACK,
          icon: meta?.icon ?? null,
          count: b.count,
          dim: focusProject !== null && focusProject !== b.project,
          focused: focusProject === b.project,
        },
      };
    });

    const issueNodes: IssueRFNode[] = visibleTasks.map((t) => {
      const grayed = !t.actionable;
      // NB: `hasWorktree` is intentionally NOT passed here — the graph reads
      // worktree state from context inside IssueNode so a worktrees refetch never
      // rebuilds this nodes array (which blanks the canvas mid-fitView). The
      // sidebar still passes it (no React Flow, no such constraint).
      const st = deriveIssueState(t, { selected: !!selected[t.id], baseFor });
      const dim = focusProject !== null && t.project !== focusProject;

      // The card's actual border/background/shadow is derived from these stable
      // PRIMITIVE flags inside IssueNode — passing a fresh `cardStyle` object
      // here would defeat IssueNode's memo, so `data` stays value-comparable
      // primitives only.
      const p = pos.get(t.id) ?? { x: 0, y: 0 };
      return {
        id: t.id,
        type: "issue",
        position: p,
        draggable: false,
        zIndex: 1,
        data: {
          title: t.title,
          statusColor: statusColor[t.status],
          statusLabel: statusLabel[t.status],
          selected: st.selected,
          chainable: st.chainable && !st.selected,
          dim,
          grayed,
          ready: st.ready,
          chainBase: st.chainable ? st.chainBase : null,
          blocked: st.blocked,
        },
      };
    });

    return [...projectNodes, ...issueNodes];
  }, [visibleTasks, boxes, projectMeta, pos, selected, focusProject, baseFor]);

  const edges = useMemo<Edge[]>(() => {
    const list: Edge[] = [];
    for (const t of visibleTasks) {
      for (const depId of t.blockedBy) {
        if (!visibleIds.has(depId)) continue;
        const a = byId.get(depId);
        if (!a) continue;
        // A blocker with a worktree is being worked on — draw its edge as the
        // active/"chained" dependency (accent-tinted, heavier).
        const chained = worktreeIds.has(depId);
        const crossProject = a.project !== t.project;

        let stroke = chained ? alpha(67) : "var(--color-line-strong)";
        let width = chained ? 1.8 : 1.5;
        let dash: string | undefined;
        let opacity = chained ? 0.85 : 0.6;
        if (crossProject) {
          stroke = palette.cross;
          dash = "4 5";
          opacity = 0.85;
          width = 1.6;
        }

        list.push({
          id: `${depId}->${t.id}`,
          source: depId,
          target: t.id,
          type: "smoothstep",
          style: { stroke, strokeWidth: width, opacity, strokeDasharray: dash },
          markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 16, height: 16 },
          // Softer corners than the smoothstep default.
          pathOptions: { borderRadius: 14 },
        } as Edge);
      }
    }
    return list;
  }, [visibleTasks, visibleIds, byId, worktreeIds]);

  // Fit once the nodes have been measured (and re-fit when the task set changes —
  // e.g. switching repos). Keying on the `tasks` reference itself (stable until a
  // refetch returns a new array) avoids allocating a big id string every render.
  const initialized = useNodesInitialized();
  const fittedTasks = useRef<Task[] | null>(null);
  useEffect(() => {
    if (!initialized || tasks.length === 0) return;
    if (fittedTasks.current === tasks) return;
    fittedTasks.current = tasks;
    fitView({ padding: 0.18, duration: 320, maxZoom: 1 });
  }, [initialized, tasks, fitView]);

  // "Open in graph" from the inspector: pan/zoom to a single node (the nonce
  // lets the same node be revealed twice in a row).
  useEffect(() => {
    if (!reveal || !pos.has(reveal.id)) return;
    fitView({ nodes: [{ id: reveal.id }], duration: 420, maxZoom: 1.1, padding: 0.6 });
  }, [reveal, pos, fitView]);

  // Clicking a project header in the sidebar pans the graph onto that band. Keyed
  // on the reveal request (nonce) only — NOT `nodes`, which rebuilds constantly;
  // depending on it re-fired fitView on every rebuild (a storm that blanks the
  // canvas). The band node always exists by the time a user can click its header.
  useEffect(() => {
    if (!projectReveal) return;
    fitView({
      nodes: [{ id: `project:${projectReveal.project}` }],
      duration: 420,
      maxZoom: 1,
      padding: 0.22,
    });
  }, [projectReveal, fitView]);

  const onNodeClick = useMemo<NodeMouseHandler>(
    () => (e, node) => {
      if (node.type === "project") {
        toggleProjectFocus((node.data as ProjectNodeData).project);
      } else if (e.metaKey || e.ctrlKey) {
        // ⌘/Ctrl-click adds the ticket to the launch queue (same as the sidebar
        // checkbox / the pane's "Add to queue" button).
        toggle(node.id);
      } else {
        // A plain click commits focus (right panel) without queuing.
        setFocus(node.id);
      }
    },
    [setFocus, toggle, toggleProjectFocus],
  );

  // Hover only previews: highlight the node, prewarm its detail. It never changes
  // the selected issue (the right panel) or pans the canvas.
  const onNodeMouseEnter = useMemo<NodeMouseHandler>(
    () => (_e, node) => {
      if (node.type === "project") return;
      setHover(node.id);
      prefetchOnHover(node.id);
    },
    [setHover, prefetchOnHover],
  );
  const onNodeMouseLeave = useMemo<NodeMouseHandler>(() => () => setHover(null), [setHover]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={onNodeClick}
      onNodeMouseEnter={onNodeMouseEnter}
      onNodeMouseLeave={onNodeMouseLeave}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      proOptions={{ hideAttribution: true }}
      colorMode={theme === "auto" ? "system" : theme}
      minZoom={0.25}
      maxZoom={1.6}
      fitView
      fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
      className="bg-app"
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} className="opacity-60" />
      <Panel position="top-left">
        <button
          type="button"
          onClick={toggleActionableOnly}
          title={
            actionableOnly
              ? "Showing only tickets you can act on — click to reveal blockers owned by others or already done"
              : "Showing all related tickets — click to hide non-actionable ones"
          }
          className="flex items-center gap-1.5 rounded-lg border border-line-2 bg-panel px-2.5 py-1.5 text-[11.5px] font-medium text-fg-2 shadow-lg transition-colors hover:border-line-strong"
        >
          <span
            className="flex h-3 w-5 flex-none items-center rounded-full p-[2px] transition-colors"
            style={{ background: actionableOnly ? "var(--accent)" : "var(--color-line-3)" }}
          >
            <span
              className="h-2 w-2 rounded-full bg-white transition-transform"
              style={{ transform: actionableOnly ? "translateX(8px)" : "translateX(0)" }}
            />
          </span>
          Actionable only
          {actionableOnly && hiddenCount > 0 && (
            <span className="font-mono text-[10px] text-muted-3">+{hiddenCount}</span>
          )}
        </button>
      </Panel>
      <Controls
        showInteractive={false}
        className="!rounded-lg !border !border-line-2 !bg-panel !shadow-lg [&>button:hover]:!bg-hover [&>button]:!border-line [&>button]:!bg-panel [&>button]:!text-fg-2 [&_svg]:!fill-current"
      />
      <MiniMap
        pannable
        zoomable
        className="!rounded-lg !border !border-line-2 !shadow-lg"
        style={{ width: 148, height: 104, background: "var(--color-panel)" }}
        maskColor={alpha(58, "var(--color-app)")}
        maskStrokeColor="var(--color-line-strong)"
        maskStrokeWidth={2}
        nodeBorderRadius={3}
        nodeStrokeWidth={0}
        nodeColor={(n) =>
          n.type === "project"
            ? alpha(14, (n.data as ProjectNodeData).color)
            : (((n.data as IssueNodeData)?.statusColor as string) ?? "var(--color-line-3)")
        }
      />
    </ReactFlow>
  );
}

export function GraphCanvas() {
  return (
    <ReactFlowProvider>
      <Flow />
    </ReactFlowProvider>
  );
}
