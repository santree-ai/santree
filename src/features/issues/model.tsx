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
// useStageMeta is consumed by useStageHelpers below.
import { branchFor } from "../../lib/format";
import { useAgents, useStageMeta, useTasks, useWorktrees } from "../../lib/queries";
import { useApp } from "../../state/AppContext";

const TICK_MS = 640;
const MAX_STAGE = 4;
const FIRST_PR = 482;

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
  sessionByTask: Map<string, Session>;
  selected: Record<string, boolean>;
  focusId: string;
  rightTab: "inspector" | "sessions";
  focusProject: string | null;
  readyFilter: boolean;
  launchAgent: AgentKind;
  launchModel: string;
  sessions: Session[];

  /** The chain base ticket for a blocked task (first dependency with a worktree), or null. */
  baseFor: (task: Task) => string | null;
  /** A task can be launched: ready or chainable, and not already running. */
  isEligible: (task: Task) => boolean;
  selectedEligible: Task[];

  toggle: (id: string) => void;
  setFocus: (id: string) => void;
  clearSelection: () => void;
  setRightTab: (tab: "inspector" | "sessions") => void;
  setLaunchAgent: (agent: AgentKind) => void;
  setLaunchModel: (model: string) => void;
  toggleReadyFilter: () => void;
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
  const [focusId, setFocusId] = useState("AK-159");
  const [rightTab, setRightTab] = useState<"inspector" | "sessions">("inspector");
  const [focusProject, setFocusProject] = useState<string | null>(null);
  const [readyFilter, setReadyFilter] = useState(false);
  const [prCounter, setPrCounter] = useState(0);

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

  const launchAgent = agentOverride ?? settings?.defaultAgent ?? "Claude";
  const launchModel = modelOverride ?? modelFor(launchAgent);

  const sessionByTask = useMemo(() => {
    const map = new Map<string, Session>();
    for (const s of sessions) map.set(s.taskId, s);
    return map;
  }, [sessions]);

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
      setFocusId(id);
      if (isEligible(task)) {
        setSelected((s) => ({ ...s, [id]: !s[id] }));
      }
    },
    [tasks, isEligible],
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
    setRightTab("sessions");
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

  const value = useMemo<IssuesModel>(
    () => ({
      tasks,
      sessionByTask,
      selected,
      focusId,
      rightTab,
      focusProject,
      readyFilter,
      launchAgent,
      launchModel,
      sessions,
      baseFor,
      isEligible,
      selectedEligible,
      toggle,
      setFocus: setFocusId,
      clearSelection: () => setSelected({}),
      setRightTab,
      setLaunchAgent: (agent) => {
        setAgentOverride(agent);
        setModelOverride(modelFor(agent));
      },
      setLaunchModel: (model) => setModelOverride(model),
      toggleReadyFilter: () => setReadyFilter((f) => !f),
      toggleProjectFocus: (project) => setFocusProject((p) => (p === project ? null : project)),
      launch,
    }),
    [
      tasks,
      sessionByTask,
      selected,
      focusId,
      rightTab,
      focusProject,
      readyFilter,
      launchAgent,
      launchModel,
      sessions,
      baseFor,
      isEligible,
      selectedEligible,
      toggle,
      launch,
      modelFor,
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
