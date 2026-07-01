/**
 * Issues-tab state model.
 *
 * Everything ephemeral to the Issues tab lives here: which tickets are selected,
 * the agent/model chosen in the launch tray, the focused ticket, and the
 * right-panel layout. It's exposed via context so the sidebar, graph, and
 * inspector stay in sync without prop drilling.
 *
 * The data (tasks, worktrees, PRs, agents) comes from the backend via queries;
 * this model only layers interaction on top.
 */

import { useNavigate } from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { AgentKind, Task, Worktree, WorktreePr } from "../../bindings";
import {
  useAgents,
  useCreateWorktree,
  useResolvedSetting,
  useTasks,
  useWorktreePrs,
  useWorktrees,
  WORK_AGENT_KEY,
  WORK_MODEL_KEY,
} from "../../lib/queries";
import { useApp, useAppUi } from "../../state/AppContext";
import { toast } from "../../state/toast";
import { PROJECT_FALLBACK } from "../../theme/colors";
import { NO_PROJECT } from "../trees/model";

/**
 * The shared visual state for a ticket, derived once from its task + real
 * worktree. The sidebar row and the graph node both build their view-models on
 * top of this so the started/ready/chainable/blocked/selected rules can't drift
 * apart (they used to be computed independently in each view).
 */
export interface IssueVisualState {
  /** A real worktree exists — the ticket is being worked on. */
  started: boolean;
  /** Queued for launch — only when not already started. */
  selected: boolean;
  /** The ticket this one would stack on (a blocker with a worktree), or null. */
  chainBase: string | null;
  chainable: boolean;
  /** Ready to start (no open blockers, not already started). */
  ready: boolean;
  /** Blocked and not chainable — can't be started. */
  blocked: boolean;
}

export function deriveIssueState(
  task: Task,
  opts: { selected: boolean; baseFor: (t: Task) => string | null; hasWorktree?: boolean },
): IssueVisualState {
  const started = !!opts.hasWorktree;
  const chainBase = task.ready ? null : opts.baseFor(task);
  const chainable = chainBase !== null && !started;
  return {
    started,
    selected: opts.selected && !started,
    chainBase,
    chainable,
    ready: task.ready && !started,
    blocked: !task.ready && !chainable && !started,
  };
}

interface IssuesModel {
  tasks: Task[];
  /** Tasks indexed by id — shared so consumers don't each rebuild the map. */
  byId: Map<string, Task>;
  /** Per-project color + icon (live from Linear, else the per-name fallback),
   *  keyed by project name. The sidebar headers and graph bands read this. */
  projectMeta: Map<string, { color: string; icon: string | null }>;
  /** Ids that have a real worktree (used for chaining). */
  worktreeIds: Set<string>;
  /** Real worktrees keyed by issue id — for the right panel's status + PR. */
  worktreeById: Map<string, Worktree>;
  /** Live PR status keyed by issue id — for the graph node's PR badge. */
  prByTask: Map<string, WorktreePr[]>;
  selected: Record<string, boolean>;
  focusId: string;
  focusProject: string | null;
  launchAgent: AgentKind;
  launchModel: string;
  /** The configured default model (from Settings → Actions → Issues) for the launch agent. */
  defaultModel: string;

  /** The chain base ticket for a blocked task (first dependency with a worktree), or null. */
  baseFor: (task: Task) => string | null;
  /** A task can be launched: ready or chainable, and not already running. */
  isEligible: (task: Task) => boolean;
  selectedEligible: Task[];

  /** When true, the graph hides grayed (non-actionable) context nodes. */
  actionableOnly: boolean;
  /** A request to recenter the graph on a node (nonce retriggers same-id reveals). */
  reveal: { id: string; nonce: number } | null;
  /** A request to focus + pan the graph to a whole project band. */
  projectReveal: { project: string; nonce: number } | null;

  /** Right panel (single focused-issue pane) collapse + resizable width. */
  rightCollapsed: boolean;
  rightWidth: number;

  toggle: (id: string) => void;
  setFocus: (id: string) => void;
  /** Focus a ticket and pan/zoom the graph to it (from the inspector's "Open in graph"). */
  revealInGraph: (id: string) => void;
  /** Focus a project and pan the graph to its band (from the sidebar project header). */
  revealProject: (project: string) => void;
  toggleActionableOnly: () => void;
  toggleRightPanel: () => void;
  setRightWidth: (w: number) => void;
  clearSelection: () => void;
  /** Add every ready (launchable) ticket to the selection — or clear them if
   *  they're all already selected (toggle). */
  selectReady: () => void;
  setLaunchAgent: (agent: AgentKind) => void;
  setLaunchModel: (model: string) => void;
  toggleProjectFocus: (project: string) => void;
  launch: () => void;
  /** Open the focused ticket's existing worktree on the Trees tab. */
  goToWorktree: (id: string) => void;
}

const IssuesContext = createContext<IssuesModel | null>(null);

/** Hover highlight, split into its own context so moving the pointer between rows
 *  / graph nodes only re-renders hover-sensitive views (the nodes and sidebar
 *  rows) — not every `useIssues` consumer (the inspector's Markdown, the launch
 *  tray, the project bands), which is what made hover janky. */
interface IssuesHover {
  /** Ephemeral highlight (row/graph) while hovering — never pans or changes the
   *  right panel; only a click commits `focusId`. */
  hoverId: string | null;
  setHover: (id: string | null) => void;
}

const IssuesHoverContext = createContext<IssuesHover | null>(null);

export function IssuesProvider({ children }: { children: ReactNode }) {
  const { settings, activeRepo } = useApp();
  const { requestTreeLaunch, requestTreeFocus, addPendingLaunches, removePendingLaunch } =
    useAppUi();
  const navigate = useNavigate();
  const { data: tasks = [] } = useTasks(activeRepo);
  const { data: worktrees = [] } = useWorktrees(activeRepo);
  const { data: worktreePrs = [] } = useWorktreePrs(activeRepo);
  const { data: agents = [] } = useAgents();
  const { mutateAsync: createWorktree } = useCreateWorktree(activeRepo);

  const [selected, setSelected] = useState<Record<string, boolean>>({});
  // No hardcoded default — the first task becomes the focus once tasks load (see
  // the effect below), and IssuePanel falls back to tasks[0] until then.
  const [focusId, setFocusId] = useState("");
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [focusProject, setFocusProject] = useState<string | null>(null);
  const [actionableOnly, setActionableOnly] = useState(true);
  const [reveal, setReveal] = useState<{ id: string; nonce: number } | null>(null);
  const [projectReveal, setProjectReveal] = useState<{ project: string; nonce: number } | null>(
    null,
  );
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [rightWidth, setRightWidth] = useState(304);

  // Focus a project band (toggle) and, when focusing, pan the graph onto it.
  const revealProject = useCallback(
    (project: string) => {
      const willFocus = focusProject !== project;
      setFocusProject(willFocus ? project : null);
      if (willFocus) setProjectReveal((r) => ({ project, nonce: (r?.nonce ?? 0) + 1 }));
    },
    [focusProject],
  );

  // Focus a task (selects it for the right panel). Clicking a task in a different
  // project than the focused band clears the band focus — dimming one project
  // while viewing another's task makes no sense. The single entry point for every
  // task click (graph node, sidebar row, blocker row), so the rule can't be missed.
  const focusTask = useCallback(
    (id: string) => {
      setFocusId(id);
      setFocusProject((p) => {
        if (p === null) return p;
        const t = tasks.find((x) => x.id === id);
        return t && t.project !== p ? null : p;
      });
    },
    [tasks],
  );

  const revealInGraph = useCallback(
    (id: string) => {
      focusTask(id);
      // If the target is a grayed context node hidden by the filter, reveal the
      // grayed layer so the pan lands on something visible.
      const t = tasks.find((x) => x.id === id);
      if (t && !t.actionable) setActionableOnly(false);
      setReveal((r) => ({ id, nonce: (r?.nonce ?? 0) + 1 }));
    },
    [focusTask, tasks],
  );

  // Launch agent/model: default from settings, with user overrides.
  const [agentOverride, setAgentOverride] = useState<AgentKind | null>(null);
  const [modelOverride, setModelOverride] = useState<string | null>(null);

  const modelFor = useCallback(
    (agent: AgentKind) =>
      settings?.agents.find((a) => a.key === agent)?.model ??
      agents.find((a) => a.key === agent)?.models[0] ??
      "",
    [settings, agents],
  );

  // The configured Work action (Settings → Actions → Issues), resolved through
  // any per-repo override, is the launch tray's default agent + model.
  const { data: workAgent } = useResolvedSetting(activeRepo, WORK_AGENT_KEY);
  const { data: workModel } = useResolvedSetting(activeRepo, WORK_MODEL_KEY);
  const configuredAgent = (workAgent as AgentKind | null) ?? settings?.defaultAgent ?? "Claude";
  const defaultModel = workModel || modelFor(configuredAgent);

  const launchAgent = agentOverride ?? configuredAgent;
  const launchModel = modelOverride ?? defaultModel;

  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  // Resolve each project's color/icon once (first task wins). Live Linear values
  // take precedence; otherwise fall back to the per-name color map.
  const projectMeta = useMemo(() => {
    const meta = new Map<string, { color: string; icon: string | null }>();
    for (const t of tasks) {
      if (!meta.has(t.project)) {
        meta.set(t.project, {
          color: t.projectColor ?? PROJECT_FALLBACK,
          icon: t.projectIcon ?? null,
        });
      }
    }
    return meta;
  }, [tasks]);

  // Once tasks load, default the focused ticket to the first one (so the right
  // panel isn't empty). Only fires while focus is unset — a real click sticks.
  useEffect(() => {
    if (focusId === "" && tasks.length > 0) setFocusId(tasks[0].id);
  }, [focusId, tasks]);

  const worktreeIds = useMemo(() => new Set(worktrees.map((w) => w.id)), [worktrees]);

  // The real worktree (status/PR/changes) for a ticket, keyed by issue id — read
  // by the right panel to show live worktree state and the "Open in Trees" link.
  const worktreeById = useMemo(() => new Map(worktrees.map((w) => [w.id, w])), [worktrees]);

  // Live PR status keyed by issue id — read inside the graph node (from context,
  // not node data, so a PR refetch never rebuilds the React Flow nodes array).
  const prByTask = useMemo(() => {
    const map = new Map<string, WorktreePr[]>();
    for (const p of worktreePrs) {
      const list = map.get(p.issueId) ?? [];
      list.push(p);
      map.set(p.issueId, list);
    }
    return map;
  }, [worktreePrs]);

  // Jump to the Trees tab and open this ticket's existing worktree (no agent
  // start — the work is already there).
  const goToWorktree = useCallback(
    (id: string) => {
      requestTreeFocus(id);
      navigate({ to: "/trees" });
    },
    [requestTreeFocus, navigate],
  );

  const baseFor = useCallback(
    (task: Task) => task.blockedBy.find((id) => worktreeIds.has(id)) ?? null,
    [worktreeIds],
  );

  const isEligible = useCallback(
    (task: Task) => {
      if (!task.actionable) return false;
      // Already started — has a real worktree.
      if (worktreeIds.has(task.id)) return false;
      return task.ready || baseFor(task) !== null;
    },
    [worktreeIds, baseFor],
  );

  const selectedEligible = useMemo(
    () => tasks.filter((t) => selected[t.id] && isEligible(t)),
    [tasks, selected, isEligible],
  );

  const toggle = useCallback(
    (id: string) => {
      const task = tasks.find((t) => t.id === id);
      if (!task) return;
      focusTask(id);
      if (isEligible(task)) {
        setSelected((s) => ({ ...s, [id]: !s[id] }));
      }
    },
    [tasks, isEligible, focusTask],
  );

  // Launch: jump to the Trees tab immediately and create a real worktree per
  // selected ticket *concurrently* in the background — never blocking the view
  // switch on the git round-trips. Each task is registered as a pending launch so
  // Trees shows a "Creating workspace…" placeholder at once (dropped there once
  // the real worktree lands); we also ask Trees to open the first one and start
  // its agent once it's real. A failed create drops its placeholder (the global
  // mutation cache still surfaces the error as a toast).
  const launch = useCallback(() => {
    if (selectedEligible.length === 0) return;
    const targets = selectedEligible;
    setSelected({});
    const projectOf = (task: Task) => (task.project === NO_PROJECT ? null : task.project);
    addPendingLaunches(
      targets.map((task) => ({
        id: task.id,
        title: task.title,
        project: projectOf(task),
        agent: launchAgent,
        // Carry the tray's per-launch model to the Trees fresh-launch seed.
        model: launchModel,
      })),
    );
    requestTreeLaunch(targets[0].id);
    navigate({ to: "/trees" });
    // A bulk launch suppresses the per-worktree toast and raises one summary once
    // every create settles; a single launch keeps its specific "Created … for X".
    const bulk = targets.length > 1;
    void Promise.allSettled(
      targets.map((task) =>
        createWorktree({
          issueId: task.id,
          title: task.title,
          project: projectOf(task),
          base: null,
          runSetup: false,
          agent: launchAgent,
          quiet: bulk,
        }).catch(() => removePendingLaunch(task.id)),
      ),
    ).then((results) => {
      if (!bulk) return;
      const created = results.filter((r) => r.status === "fulfilled").length;
      if (created > 0) toast.success(`Created ${created} worktrees.`);
    });
  }, [
    selectedEligible,
    launchAgent,
    launchModel,
    createWorktree,
    requestTreeLaunch,
    addPendingLaunches,
    removePendingLaunch,
    navigate,
  ]);

  // Trivial setter handlers — stable across renders so the context value below
  // doesn't churn (kept symmetric with the useCallback'd handlers above).
  const toggleActionableOnly = useCallback(() => setActionableOnly((v) => !v), []);
  const toggleRightPanel = useCallback(() => setRightCollapsed((v) => !v), []);
  const clearSelection = useCallback(() => setSelected({}), []);
  // Select every ready (launchable) ticket; if they're all already selected,
  // clear them instead, so the button toggles.
  const selectReady = useCallback(() => {
    const readyIds = tasks.filter((t) => t.ready && isEligible(t)).map((t) => t.id);
    if (readyIds.length === 0) return;
    setSelected((s) => {
      const allSelected = readyIds.every((id) => s[id]);
      const next = { ...s };
      for (const id of readyIds) next[id] = !allSelected;
      return next;
    });
  }, [tasks, isEligible]);
  const setLaunchAgent = useCallback(
    (agent: AgentKind) => {
      setAgentOverride(agent);
      setModelOverride(modelFor(agent));
    },
    [modelFor],
  );
  const setLaunchModel = useCallback((model: string) => setModelOverride(model), []);
  const toggleProjectFocus = useCallback(
    (project: string) => setFocusProject((p) => (p === project ? null : project)),
    [],
  );

  const value = useMemo<IssuesModel>(
    () => ({
      tasks,
      byId,
      projectMeta,
      worktreeIds,
      worktreeById,
      prByTask,
      selected,
      focusId,
      focusProject,
      launchAgent,
      launchModel,
      defaultModel,
      actionableOnly,
      reveal,
      projectReveal,
      rightCollapsed,
      rightWidth,
      baseFor,
      isEligible,
      selectedEligible,
      toggle,
      goToWorktree,
      setFocus: focusTask,
      revealInGraph,
      revealProject,
      toggleActionableOnly,
      toggleRightPanel,
      setRightWidth,
      clearSelection,
      selectReady,
      setLaunchAgent,
      setLaunchModel,
      toggleProjectFocus,
      launch,
    }),
    [
      tasks,
      byId,
      projectMeta,
      worktreeIds,
      worktreeById,
      prByTask,
      selected,
      focusId,
      focusProject,
      launchAgent,
      launchModel,
      defaultModel,
      actionableOnly,
      reveal,
      projectReveal,
      rightCollapsed,
      rightWidth,
      baseFor,
      isEligible,
      selectedEligible,
      toggle,
      goToWorktree,
      focusTask,
      revealInGraph,
      revealProject,
      toggleActionableOnly,
      toggleRightPanel,
      clearSelection,
      selectReady,
      setLaunchAgent,
      setLaunchModel,
      toggleProjectFocus,
      launch,
    ],
  );

  // Its own value object so a hover change re-renders only hover subscribers; the
  // `value` above keeps its identity across hovers (hoverId isn't one of its deps).
  const hover = useMemo<IssuesHover>(() => ({ hoverId, setHover: setHoverId }), [hoverId]);

  return (
    <IssuesContext.Provider value={value}>
      <IssuesHoverContext.Provider value={hover}>{children}</IssuesHoverContext.Provider>
    </IssuesContext.Provider>
  );
}

export function useIssues(): IssuesModel {
  const ctx = useContext(IssuesContext);
  if (!ctx) throw new Error("useIssues must be used within <IssuesProvider>");
  return ctx;
}

export function useIssueHover(): IssuesHover {
  const ctx = useContext(IssuesHoverContext);
  if (!ctx) throw new Error("useIssueHover must be used within <IssuesProvider>");
  return ctx;
}
