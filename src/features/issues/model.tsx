/**
 * Issues-tab state model.
 *
 * Everything ephemeral to the Issues tab lives here: which tickets are selected,
 * the agent/model chosen in the launch tray, the focused ticket, the right-panel
 * tab, and the simulated agent sessions (with their progress timer). It's exposed
 * via context so the sidebar, graph, and inspector stay in sync without prop
 * drilling.
 *
 * The seed data (tasks, worktrees, stages, agents) comes from the backend via
 * queries; this model only layers interaction on top.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { AgentKind, Task } from "../../bindings";
import { branchFor } from "../../lib/format";
import {
  useAgents,
  useResolvedSetting,
  useStageMeta,
  useTasks,
  useWorktrees,
  WORK_AGENT_KEY,
  WORK_MODEL_KEY,
} from "../../lib/queries";
import { useApp } from "../../state/AppContext";
import { accentVar, colorForProject, successColor } from "../../theme/colors";

const TICK_MS = 640;
/** Stage index at which a session is considered finished (PR opened). */
export const MAX_STAGE = 4;
const FIRST_PR = 482;

/**
 * Collapse a session into its high-level run state. A session is "running" until
 * it reaches the final stage, then "done"; no session at all is `null`. This is
 * the single source of truth for the running/done split everywhere it's needed.
 */
export function sessionState(session: Session | undefined): "running" | "done" | null {
  if (!session) return null;
  return session.stage < MAX_STAGE ? "running" : "done";
}

/**
 * The shared visual state for a ticket, derived once from its task + session.
 * The sidebar row and the graph node both build their view-models on top of this
 * so the running/done/ready/chainable/blocked/selected rules can't drift apart
 * (they used to be computed independently in each view).
 */
export interface IssueVisualState {
  session: Session | undefined;
  running: boolean;
  done: boolean;
  /** Queued for launch — only when there's no live session yet. */
  selected: boolean;
  /** The ticket this one would stack on (a blocker with a worktree), or null. */
  chainBase: string | null;
  chainable: boolean;
  /** Ready to start (no open blockers, not already running). */
  ready: boolean;
  /** Blocked and not chainable — can't be started. */
  blocked: boolean;
  /** Spinner/progress color: green once done, else the accent. */
  runColor: string;
}

export function deriveIssueState(
  task: Task,
  session: Session | undefined,
  opts: { selected: boolean; baseFor: (t: Task) => string | null },
): IssueVisualState {
  const state = sessionState(session);
  const running = state === "running";
  const done = state === "done";
  const chainBase = task.ready ? null : opts.baseFor(task);
  const chainable = chainBase !== null && !session;
  return {
    session,
    running,
    done,
    selected: opts.selected && !session,
    chainBase,
    chainable,
    ready: task.ready && !session,
    blocked: !task.ready && !chainable && !session,
    runColor: done ? successColor : accentVar,
  };
}

export interface Session {
  taskId: string;
  agent: AgentKind;
  model: string;
  stage: number;
  ticks: number;
  speed: number;
  pr: number;
  add: number;
  del: number;
  /** Branch this session stacks on (`main` if not chained). */
  base: string;
  /** Ticket id this session stacks on, or "" if not chained. */
  baseId: string;
}

interface IssuesModel {
  tasks: Task[];
  /** Tasks indexed by id — shared so consumers don't each rebuild the map. */
  byId: Map<string, Task>;
  /** Per-project color + icon (live from Linear, else the per-name fallback),
   *  keyed by project name. The sidebar headers and graph bands read this. */
  projectMeta: Map<string, { color: string; icon: string | null }>;
  sessionByTask: Map<string, Session>;
  /** Ids that have a real worktree or a running session (used for chaining). */
  worktreeIds: Set<string>;
  selected: Record<string, boolean>;
  focusId: string;
  /** Ephemeral highlight (row/graph) while hovering — never pans or changes the
   *  right panel; only a click commits `focusId`. */
  hoverId: string | null;
  focusProject: string | null;
  launchAgent: AgentKind;
  launchModel: string;
  /** The configured default model (from Settings → Actions → Issues) for the launch agent. */
  defaultModel: string;
  sessions: Session[];

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
  setHover: (id: string | null) => void;
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
}

const IssuesContext = createContext<IssuesModel | null>(null);

export function IssuesProvider({ children }: { children: ReactNode }) {
  const { settings, activeRepo } = useApp();
  const { data: tasks = [] } = useTasks(activeRepo);
  const { data: worktrees = [] } = useWorktrees();
  const { data: agents = [] } = useAgents();

  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [sessions, setSessions] = useState<Session[]>([]);
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
  const [prCounter, setPrCounter] = useState(0);

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
          color: t.projectColor ?? colorForProject(t.project),
          icon: t.projectIcon ?? null,
        });
      }
    }
    return meta;
  }, [tasks]);

  const sessionByTask = useMemo(() => {
    const map = new Map<string, Session>();
    for (const s of sessions) map.set(s.taskId, s);
    return map;
  }, [sessions]);

  // Once tasks load, default the focused ticket to the first one (so the right
  // panel isn't empty). Only fires while focus is unset — a real click sticks.
  useEffect(() => {
    if (focusId === "" && tasks.length > 0) setFocusId(tasks[0].id);
  }, [focusId, tasks]);

  // A ticket has a "worktree" if it has a real worktree or a running session.
  const worktreeIds = useMemo(() => {
    const set = new Set(worktrees.map((w) => w.id));
    for (const s of sessions) set.add(s.taskId);
    return set;
  }, [worktrees, sessions]);

  const baseFor = useCallback(
    (task: Task) => task.blockedBy.find((id) => worktreeIds.has(id)) ?? null,
    [worktreeIds],
  );

  const isEligible = useCallback(
    (task: Task) => {
      if (!task.actionable) return false;
      if (sessionByTask.has(task.id)) return false;
      return task.ready || baseFor(task) !== null;
    },
    [sessionByTask, baseFor],
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

  const launch = useCallback(() => {
    if (selectedEligible.length === 0) return;
    const base = FIRST_PR + prCounter;
    const created: Session[] = selectedEligible.map((task, i) => {
      const chainId = task.ready ? "" : (baseFor(task) ?? "");
      return {
        taskId: task.id,
        agent: launchAgent,
        model: launchModel,
        stage: 0,
        ticks: 0,
        speed: 2 + Math.floor(Math.random() * 3),
        pr: base + i,
        add: task.addLines,
        del: task.delLines,
        base: chainId ? branchFor(chainId) : "main",
        baseId: chainId,
      };
    });
    setSessions((prev) => [...prev, ...created]);
    setSelected({});
    setPrCounter((n) => n + created.length);
  }, [selectedEligible, prCounter, launchAgent, launchModel, baseFor]);

  // Advance running sessions on a fixed tick until all reach the final stage.
  const timer = useRef<number | null>(null);
  const hasRunning = sessions.some((s) => s.stage < MAX_STAGE);
  useEffect(() => {
    if (!hasRunning) return;
    timer.current = window.setInterval(() => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.stage >= MAX_STAGE) return s;
          const ticks = s.ticks + 1;
          const stage = ticks % s.speed === 0 ? Math.min(MAX_STAGE, s.stage + 1) : s.stage;
          return { ...s, ticks, stage };
        }),
      );
    }, TICK_MS);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [hasRunning]);

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
      sessionByTask,
      worktreeIds,
      selected,
      focusId,
      hoverId,
      focusProject,
      launchAgent,
      launchModel,
      defaultModel,
      sessions,
      actionableOnly,
      reveal,
      projectReveal,
      rightCollapsed,
      rightWidth,
      baseFor,
      isEligible,
      selectedEligible,
      toggle,
      setFocus: focusTask,
      setHover: setHoverId,
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
      sessionByTask,
      worktreeIds,
      selected,
      focusId,
      hoverId,
      focusProject,
      launchAgent,
      launchModel,
      defaultModel,
      sessions,
      actionableOnly,
      reveal,
      projectReveal,
      rightCollapsed,
      rightWidth,
      baseFor,
      isEligible,
      selectedEligible,
      toggle,
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

  return <IssuesContext.Provider value={value}>{children}</IssuesContext.Provider>;
}

export function useIssues(): IssuesModel {
  const ctx = useContext(IssuesContext);
  if (!ctx) throw new Error("useIssues must be used within <IssuesProvider>");
  return ctx;
}

/** Shared stage helpers, parameterized by the backend stage metadata. */
export function useStageHelpers() {
  const { data: stages = [] } = useStageMeta();
  return {
    pctFor: (stage: number) => stages[Math.min(stage, stages.length - 1)]?.pct ?? 0,
    labelFor: (stage: number) => stages[Math.min(stage, stages.length - 1)]?.label ?? "",
  };
}
