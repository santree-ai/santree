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
  useRef,
  useState,
} from "react";

import type { AgentKind, Task, Worktree, WorktreePr } from "../../bindings";
import { ConfirmDialog, Segmented, Toggle } from "../../components/primitives";
import {
  type BatchSetup,
  parseBatchSetup,
  TREES_BATCH_SETUP_KEY,
  TREES_RUN_SETUP_KEY,
  useBaseWorktree,
  useBoolSetting,
  useCreateWorktree,
  useInitScript,
  useResolvedBoolSetting,
  useResolvedSetting,
  useSetting,
  useTasks,
  useWorktreePrs,
  useWorktrees,
  WORK_AGENT_KEY,
  WORK_ASK_BASE_KEY,
  WORK_QUEUE_KEY,
} from "../../lib/queries";
import { useAgentRuns } from "../../state/AgentRuns";
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

/**
 * The blocker `task` would stack on — its first dependency that already has a
 * worktree — as both the ticket id (what the ⛓ chip shows) and that worktree's
 * git branch (what a launch branches from). Null when there's nothing to stack on.
 *
 * This is the *only* place the chain base is chosen: `baseFor` in the provider is
 * this function's ticket half, so what the graph advertises with "⛓ AK-274" and
 * what `createWorktree` is actually given as its base can't drift apart. A ticket
 * whose blocker is already being worked on is only launchable *because* it can
 * stack on it — branching it off master instead would build on code that isn't
 * there yet. `ready` tickets never stack: their blockers are all done.
 */
export function stackBase(
  task: Task,
  worktreeById: Map<string, Worktree>,
): { ticket: string; branch: string } | null {
  if (task.ready) return null;
  for (const ticket of task.blockedBy) {
    const branch = worktreeById.get(ticket)?.branch;
    if (branch) return { ticket, branch };
  }
  return null;
}

/** A launch waiting on the options dialog: what it would start, which questions
 *  it has to ask first, and how to actually run it once they're answered. One
 *  shape for both paths — a queued batch and a single "Run" — so the two can't
 *  answer the same questions differently. */
interface PendingLaunch {
  targets: Task[];
  /** The targets that would stack, each with the blocker it resolved to. That's
   *  the blocker `stackBase` picked — not `blockedBy[0]`, which is a different
   *  ticket whenever the first blocker has no worktree. */
  stacking: { id: string; base: string }[];
  askSetup: boolean;
  askStack: boolean;
  /** The setup answer to use when the dialog doesn't ask for one — the batch
   *  setting's own always/never, or null for a single launch (which lets
   *  `beginRun` read the plain preference). */
  setup: boolean | null;
  start: (setup: boolean | null, stack: boolean) => void;
}

/**
 * What a launch has to ask before it can start, and the answers it already has.
 *
 * Both questions are resolved here so the queued-batch and single-"Run" paths
 * can't diverge, and so a launch with nothing to ask never opens a dialog at all
 * (the common case: a ready ticket, or stacking with the preference off).
 */
export function launchPlan(
  targets: Task[],
  opts: {
    batchSetup: BatchSetup;
    /** The "ask which branch to start from" preference (WORK_ASK_BASE_KEY). */
    askBase: boolean;
    stackOn: (t: Task) => { ticket: string; branch: string } | null;
  },
): Omit<PendingLaunch, "targets" | "start"> {
  const bulk = targets.length > 1;
  const stacking = targets.flatMap((t) => {
    const base = opts.stackOn(t);
    return base ? [{ id: t.id, base: base.ticket }] : [];
  });
  return {
    // Only a real batch asks about setup — a single launch lets `beginRun` read
    // the plain preference (null), which is why `setup` isn't just a boolean.
    askSetup: bulk && opts.batchSetup === "ask",
    setup: bulk ? opts.batchSetup === "always" : null,
    askStack: opts.askBase && stacking.length > 0,
    stacking,
  };
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

/** Counts genuinely-successful creates out of a bulk launch's settled results.
 *  A failed `createWorktree` is caught in `launch()` and turned into a
 *  *fulfilled* `null` (so one bad create doesn't reject the whole batch) — so
 *  `status === "fulfilled"` alone can't tell success from failure. Must also
 *  check the value itself is non-null. */
export function countLaunchSuccesses<T>(results: PromiseSettledResult<T | null>[]): number {
  return results.filter((r) => r.status === "fulfilled" && r.value !== null).length;
}

interface IssuesModel {
  tasks: Task[];
  /** Tasks indexed by id — shared so consumers don't each rebuild the map. */
  byId: Map<string, Task>;
  /** Per-project color + icon (live from Linear, else the per-name fallback),
   *  keyed by project name. The sidebar headers and graph bands read this. */
  projectMeta: Map<string, { color: string; icon: string | null; targetDate: string | null }>;
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
  toggleProjectFocus: (project: string) => void;
  launch: () => void;
  /** Whether the multi-select launch queue is enabled (Settings → Actions → Work).
   *  Off (default) → the panel offers "Run" instead of "Add to queue". */
  queueEnabled: boolean;
  /** Run the focused ticket now: create its worktree and open it on Trees. */
  run: (id: string) => void;
  /** Run the focused ticket in the background — no view switch (⌘-click "Run"). */
  runBackground: (id: string) => void;
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

/** The subset of `IssuesModel` that `IssueNode` actually paints from — split
 *  into its own context (same reasoning as `IssuesHoverContext` above) so
 *  unrelated `IssuesModel` churn (selection toggles, every keystroke in the
 *  launch tray's model combobox, …) doesn't re-render every graph node. Each
 *  field is independently memoized in the provider, so this value only gets a
 *  new reference when one of these three actually changes. */
interface IssueNodeContextValue {
  focusId: string;
  worktreeIds: Set<string>;
  prByTask: Map<string, WorktreePr[]>;
}

const IssueNodeDataContext = createContext<IssueNodeContextValue | null>(null);

export function IssuesProvider({ children }: { children: ReactNode }) {
  const { settings, activeRepo } = useApp();
  const {
    requestTreeLaunch,
    requestTreeFocus,
    issueFocus,
    consumeIssueFocus,
    requestBackgroundLaunch,
    clearBackgroundLaunch,
    addPendingLaunches,
    removePendingLaunch,
  } = useAppUi();
  const navigate = useNavigate();
  const { data: tasks = [] } = useTasks(activeRepo);
  const { data: worktrees = [] } = useWorktrees(activeRepo);
  // Only for naming the "don't stack" option in the launch dialog — the create
  // itself resolves the default branch backend-side from a null base.
  const { data: baseWorktree } = useBaseWorktree(activeRepo);
  const { data: worktreePrs = [] } = useWorktreePrs(activeRepo);
  const { mutateAsync: createWorktree } = useCreateWorktree(activeRepo);
  const { planSetup } = useAgentRuns();
  // When off (default), the launch queue is bypassed: the panel shows a "Run"
  // button that starts the single focused ticket immediately (⌘-click → background).
  const queueEnabled = useBoolSetting("app", WORK_QUEUE_KEY).value;

  // How a *multi*-task launch treats the setup script (Settings → Trees): run it
  // in every new worktree, in none, or ask once for the whole batch. A single
  // launch ignores this and follows the plain "run setup on new worktrees"
  // preference — which is also what the ask-once dialog defaults to.
  const { data: batchSetting } = useResolvedSetting(activeRepo, TREES_BATCH_SETUP_KEY);
  const runSetupPref = useResolvedBoolSetting(activeRepo, TREES_RUN_SETUP_KEY).value;
  const { data: initScript, isFetched: initScriptFetched } = useInitScript(activeRepo);
  // Nothing to run ⇒ nothing to ask: a repo with no executable `.santree/init.sh`
  // never prompts, whatever the preference says. Until that read lands we fall
  // back to the setting, so a slow read can't silently skip a real setup script.
  const batchSetup =
    initScriptFetched && !(initScript?.exists && initScript.executable)
      ? "never"
      : parseBatchSetup(batchSetting);
  // When on (the default), launching a ticket that would stack asks which branch
  // to start from rather than stacking silently. Unset means ask.
  const askBase = useSetting("app", WORK_ASK_BASE_KEY).data !== "false";

  /** The launch parked behind the options dialog, and the answers being edited. */
  const [pending, setPending] = useState<PendingLaunch | null>(null);
  const [askRunSetup, setAskRunSetup] = useState(false);
  const [askStack, setAskStack] = useState(true);

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

  // Compact layouts preserve the graph as the primary workspace. The inspector
  // starts as a slim right-edge handle and opens over the graph on demand.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const compact = window.matchMedia("(max-width: 1500px)");
    const collapse = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches) setRightCollapsed(true);
    };
    collapse(compact);
    compact.addEventListener("change", collapse);
    return () => compact.removeEventListener("change", collapse);
  }, []);

  // Focus a project band (toggle) and, when focusing, pan the graph onto it.
  const revealProject = useCallback(
    (project: string) => {
      const willFocus = focusProject !== project;
      setFocusProject(willFocus ? project : null);
      if (willFocus) setProjectReveal((r) => ({ project, nonce: (r?.nonce ?? 0) + 1 }));
    },
    [focusProject],
  );

  // Built once here (not per lookup) so consumers don't each rebuild the map.
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  // Focus a task (selects it for the right panel). Clicking a task in a different
  // project than the focused band clears the band focus — dimming one project
  // while viewing another's task makes no sense. The single entry point for every
  // task click (graph node, sidebar row, blocker row), so the rule can't be missed.
  const focusTask = useCallback(
    (id: string) => {
      setFocusId(id);
      setFocusProject((p) => {
        if (p === null) return p;
        const t = byId.get(id);
        return t && t.project !== p ? null : p;
      });
    },
    [byId],
  );

  const revealInGraph = useCallback(
    (id: string) => {
      focusTask(id);
      // If the target is a grayed context node hidden by the filter, reveal the
      // grayed layer so the pan lands on something visible.
      const t = byId.get(id);
      if (t && !t.actionable) setActionableOnly(false);
      setReveal((r) => ({ id, nonce: (r?.nonce ?? 0) + 1 }));
    },
    [focusTask, byId],
  );

  // Launch agent: the configured Work agent (Settings → Actions → Work, resolved
  // through any per-repo override), with a per-launch override from the tray. The
  // model is deliberately NOT chosen here — every launch runs the model configured
  // for its agent in Settings, resolved at launch by the Trees seed (useAgentTab).
  // A second, tray-side model source drifted from Settings once the agent was
  // switched (a Codex launch showed Claude's model), so there isn't one.
  const [agentOverride, setAgentOverride] = useState<AgentKind | null>(null);
  const { data: workAgent } = useResolvedSetting(activeRepo, WORK_AGENT_KEY);
  const configuredAgent = (workAgent as AgentKind | null) ?? settings?.defaultAgent ?? "Claude";
  const launchAgent = agentOverride ?? configuredAgent;

  // Resolve each project's color/icon once (first task wins). Live Linear values
  // take precedence; otherwise fall back to the per-name color map.
  const projectMeta = useMemo(() => {
    const meta = new Map<
      string,
      { color: string; icon: string | null; targetDate: string | null }
    >();
    for (const t of tasks) {
      if (!meta.has(t.project)) {
        meta.set(t.project, {
          color: t.projectColor ?? PROJECT_FALLBACK,
          icon: t.projectIcon ?? null,
          targetDate: t.projectTargetDate ?? null,
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

  // Cross-view navigation, such as the command palette, hands us a concrete
  // ticket. Commit both inspector focus and a graph reveal once the task exists.
  useEffect(() => {
    if (!issueFocus || !tasks.some((task) => task.id === issueFocus)) return;
    setFocusId(issueFocus);
    setReveal((current) => ({ id: issueFocus, nonce: (current?.nonce ?? 0) + 1 }));
    consumeIssueFocus();
  }, [consumeIssueFocus, issueFocus, tasks]);

  // Ticket ids belong to the repo they came from: carrying focus/selection across
  // a repo switch leaves the panel on a ticket the graph and sidebar don't show,
  // and a stale selection would silently pre-queue tickets in the new repo. Reset
  // to "nothing focused" and let the default-focus effect above pick the new
  // repo's first task once its tasks land.
  const loadedRepo = useRef(activeRepo);
  useEffect(() => {
    if (loadedRepo.current === activeRepo) return;
    loadedRepo.current = activeRepo;
    setFocusId("");
    setFocusProject(null);
    setSelected({});
  }, [activeRepo]);

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

  /** What a launch of `task` branches from (see `stackBase`). */
  const stackOn = useCallback((task: Task) => stackBase(task, worktreeById), [worktreeById]);

  // `deriveIssueState`'s view of the chain is the ticket half of the very base the
  // launch will use — so the ⛓ chip can never promise a stack the launch doesn't
  // make. `stackBase` re-applies the `ready` gate that `deriveIssueState` also
  // applies here; both are cheap and neither may be dropped on its own.
  const baseFor = useCallback((task: Task) => stackOn(task)?.ticket ?? null, [stackOn]);

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
      const task = byId.get(id);
      if (!task) return;
      focusTask(id);
      if (isEligible(task)) {
        setSelected((s) => ({ ...s, [id]: !s[id] }));
      }
    },
    [byId, isEligible, focusTask],
  );

  // Start every queued ticket: jump to the Trees tab immediately and create a real
  // worktree per ticket *concurrently* in the background — never blocking the view
  // switch on the git round-trips. Each task is registered as a pending launch so
  // Trees shows a "Creating workspace…" placeholder at once (dropped there once the
  // real worktree lands). A failed create drops its placeholder (the global mutation
  // cache still surfaces the error as a toast).
  //
  // How each ticket's agent starts differs by size, and it has to:
  //  - one ticket → Trees opens it and starts the agent in the visible pane;
  //  - several → every ticket goes through the off-screen launcher, because Trees
  //    can only show one worktree and the visible pane is the *only* host that's
  //    skipped by `AgentRunHost`. Handing it the first one and leaving the rest to
  //    the (never-mounted) panes of unopened worktrees is what left "Launch 5
  //    agents" creating five worktrees and starting exactly one agent. With none of
  //    them selected, Trees lands on the all-agents overview — all five, running.
  //
  // `setup` is the batch's one answer to "run `.santree/init.sh` first?" (null for a
  // single launch, which just follows the preference inside `beginRun`). `stack` is
  // the answer to "branch off the blocker's work?" — false forks off the repo's
  // default branch instead, for every target in the launch.
  const startLaunch = useCallback(
    (targets: Task[], setup: boolean | null, stack: boolean) => {
      setSelected({});
      setPending(null);
      const projectOf = (task: Task) => (task.project === NO_PROJECT ? null : task.project);
      // A bulk launch suppresses the per-worktree toast and raises one summary once
      // every create settles; a single launch keeps its specific "Created … for X".
      const bulk = targets.length > 1;
      if (setup !== null)
        planSetup(
          targets.map((t) => t.id),
          setup,
        );
      // One expression decides the base for both the placeholder and the create, so
      // the sidebar can't indent a launch under a parent the create won't branch off
      // — the same "can't drift apart" rule `stackBase` documents.
      const baseOf = (task: Task) => (stack ? stackOn(task) : null);
      addPendingLaunches(
        targets.map((task) => ({
          id: task.id,
          title: task.title,
          project: projectOf(task),
          agent: launchAgent,
          // Nest the placeholder under its blocker right away, rather than leaving a
          // sub-task looking like a root until the worktree finishes creating.
          baseBranch: baseOf(task)?.branch,
        })),
      );
      if (bulk) for (const task of targets) requestBackgroundLaunch(task.id);
      else requestTreeLaunch(targets[0].id);
      navigate({ to: "/trees" });
      void Promise.allSettled(
        targets.map((task) =>
          createWorktree({
            issueId: task.id,
            title: task.title,
            project: projectOf(task),
            stackOn: baseOf(task),
            agent: launchAgent,
            quiet: bulk,
          }).catch(() => {
            removePendingLaunch(task.id);
            clearBackgroundLaunch(task.id);
            return null;
          }),
        ),
      ).then((results) => {
        if (!bulk) return;
        const created = countLaunchSuccesses(results);
        if (created > 0) toast.success(`Launched ${created} agents.`);
      });
    },
    [
      launchAgent,
      planSetup,
      createWorktree,
      stackOn,
      requestTreeLaunch,
      requestBackgroundLaunch,
      clearBackgroundLaunch,
      addPendingLaunches,
      removePendingLaunch,
      navigate,
    ],
  );

  // The single-ticket create-worktree core shared by `run` and `runBackground`:
  // register the placeholder + kick off the git create, dropping both on failure.
  // `onCreated` wires up how the launch is consumed on the Trees side (focus +
  // navigate, or background) before the async create resolves.
  const startOne = useCallback(
    (id: string, onCreated: (task: Task) => void, quiet: boolean, stack: boolean) => {
      const task = byId.get(id);
      if (!task || !isEligible(task)) return;
      setPending(null);
      const project = task.project === NO_PROJECT ? null : task.project;
      // Decided once, for the placeholder and the create alike — see `launch`.
      const base = stack ? stackOn(task) : null;
      addPendingLaunches([
        {
          id: task.id,
          title: task.title,
          project,
          agent: launchAgent,
          baseBranch: base?.branch,
        },
      ]);
      onCreated(task);
      void createWorktree({
        issueId: task.id,
        title: task.title,
        project,
        stackOn: base,
        agent: launchAgent,
        quiet,
      }).catch(() => {
        removePendingLaunch(task.id);
        clearBackgroundLaunch(task.id);
      });
    },
    [
      byId,
      isEligible,
      launchAgent,
      addPendingLaunches,
      removePendingLaunch,
      clearBackgroundLaunch,
      createWorktree,
      stackOn,
    ],
  );

  /** Run the launch now, or park it behind the options dialog when there's a
   *  question to answer first. `setup` is only ever asked for a real batch; the
   *  base is asked whenever any target would stack and the preference says so —
   *  both land in one dialog rather than two in a row. */
  const beginLaunch = useCallback(
    (targets: Task[], start: (setup: boolean | null, stack: boolean) => void) => {
      if (targets.length === 0) return;
      const plan = launchPlan(targets, { batchSetup, askBase, stackOn });
      if (!plan.askSetup && !plan.askStack) {
        start(plan.setup, true);
        return;
      }
      setAskRunSetup(runSetupPref);
      setAskStack(true);
      setPending({ targets, ...plan, start });
    },
    [askBase, batchSetup, runSetupPref, stackOn],
  );

  const launch = useCallback(() => {
    beginLaunch(selectedEligible, (setup, stack) => startLaunch(selectedEligible, setup, stack));
  }, [selectedEligible, beginLaunch, startLaunch]);

  // Run a single ticket now: create its worktree and jump to Trees, starting the
  // agent there — the queue-off equivalent of selecting one ticket and launching.
  const run = useCallback(
    (id: string) => {
      const task = byId.get(id);
      if (!task) return;
      beginLaunch([task], (_setup, stack) =>
        startOne(
          id,
          (t) => {
            requestTreeLaunch(t.id);
            navigate({ to: "/trees" });
          },
          false,
          stack,
        ),
      );
    },
    [byId, beginLaunch, startOne, requestTreeLaunch, navigate],
  );

  // Run a single ticket in the background: create its worktree and start the agent
  // without leaving the current view or switching the active worktree (Trees mounts
  // it off-screen — see BackgroundLaunch). The ⌘-click path of the "Run" button.
  const runBackground = useCallback(
    (id: string) => {
      const task = byId.get(id);
      if (!task) return;
      beginLaunch([task], (_setup, stack) =>
        startOne(
          id,
          (t) => {
            requestBackgroundLaunch(t.id);
            toast.success(`Running ${t.id} in the background…`);
          },
          true,
          stack,
        ),
      );
    },
    [byId, beginLaunch, startOne, requestBackgroundLaunch],
  );

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
  const setLaunchAgent = useCallback((agent: AgentKind) => setAgentOverride(agent), []);
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
      toggleProjectFocus,
      launch,
      queueEnabled,
      run,
      runBackground,
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
      toggleProjectFocus,
      launch,
      queueEnabled,
      run,
      runBackground,
    ],
  );

  // Its own value object so a hover change re-renders only hover subscribers; the
  // `value` above keeps its identity across hovers (hoverId isn't one of its deps).
  const hover = useMemo<IssuesHover>(() => ({ hoverId, setHover: setHoverId }), [hoverId]);

  // Same split for the graph node's paint-relevant fields — its identity only
  // changes when focus/worktrees/PRs actually change, not on every selection
  // toggle or launch-tray edit that rebuilds `value` above.
  const nodeData = useMemo<IssueNodeContextValue>(
    () => ({ focusId, worktreeIds, prByTask }),
    [focusId, worktreeIds, prByTask],
  );

  return (
    <IssuesContext.Provider value={value}>
      <IssuesHoverContext.Provider value={hover}>
        <IssueNodeDataContext.Provider value={nodeData}>{children}</IssueNodeDataContext.Provider>
      </IssuesHoverContext.Provider>
      {/* The launch's open questions, asked once for the whole launch instead of
          per worktree. Lives here, not in the launch tray, because the answers
          belong to the launch — the tray unmounts the moment the selection
          clears, and the single-ticket "Run" path has no tray at all. */}
      <LaunchOptionsDialog
        pending={pending}
        defaultBranch={baseWorktree?.baseBranch ?? null}
        runSetup={askRunSetup}
        setRunSetup={setAskRunSetup}
        stack={askStack}
        setStack={setAskStack}
        onCancel={() => setPending(null)}
      />
    </IssuesContext.Provider>
  );
}

/** The ask-once confirmation for a launch. Cancel abandons it (the selection is
 *  still there); confirming starts every ticket with the answers given — the setup
 *  script in each new worktree or in none, and each stacking ticket branched off
 *  its blocker's work or off the repo's default branch. Only the questions the
 *  launch actually has are rendered, so a single stacking ticket gets one line and
 *  a plain batch gets the setup toggle it always had. */
function LaunchOptionsDialog({
  pending,
  defaultBranch,
  runSetup,
  setRunSetup,
  stack,
  setStack,
  onCancel,
}: {
  pending: PendingLaunch | null;
  /** The repo's default branch, for naming the "don't stack" option. */
  defaultBranch: string | null;
  runSetup: boolean;
  setRunSetup: (on: boolean) => void;
  stack: boolean;
  setStack: (on: boolean) => void;
  onCancel: () => void;
}) {
  const count = pending?.targets.length ?? 0;
  const stacking = pending?.stacking ?? [];
  const label = count === 1 ? `Start ${pending?.targets[0].id}` : `Start ${count} tasks`;
  return (
    <ConfirmDialog
      open={pending !== null}
      title={label}
      confirmLabel={label}
      message={
        count === 1
          ? "A worktree is created for the ticket and its agent starts there."
          : "A worktree is created for each ticket and its agent starts in the background."
      }
      extra={
        <div className="space-y-3">
          {pending?.askStack && (
            <div className="space-y-1.5">
              <div id="launch-base-label" className="text-[12px] text-fg-2">
                {stacking.length === 1 ? (
                  <>
                    <span className="font-mono text-[11.5px]">{stacking[0].id}</span> is blocked by{" "}
                    <span className="font-mono text-[11.5px]">{stacking[0].base}</span>, which is
                    already in a worktree. Start from:
                  </>
                ) : (
                  <>
                    {stacking.length} of these are blocked by tickets already in a worktree. Start
                    them from:
                  </>
                )}
              </div>
              <Segmented
                value={stack ? "stack" : "default"}
                onChange={(v) => setStack(v === "stack")}
                options={[
                  {
                    value: "stack",
                    label: stacking.length === 1 ? stacking[0].base : "Their blockers",
                  },
                  { value: "default", label: defaultBranch ?? "Default branch" },
                ]}
              />
            </div>
          )}
          {pending?.askSetup && (
            <div className="flex items-center gap-3">
              <span id="batch-setup-label" className="min-w-0 flex-1 text-[12px] text-fg-2">
                Run <span className="font-mono text-[11.5px]">.santree/init.sh</span> in each new
                worktree
              </span>
              <Toggle
                on={runSetup}
                onClick={() => setRunSetup(!runSetup)}
                ariaLabelledBy="batch-setup-label"
              />
            </div>
          )}
        </div>
      }
      // Fire-and-close: the creates run in the background (each rolls back its own
      // placeholder and toasts on failure), so there's nothing to await here.
      onConfirm={() => {
        // A toggle that wasn't rendered can't be the answer — fall back to the one
        // the launch already resolved (see `PendingLaunch.setup`).
        pending?.start(pending.askSetup ? runSetup : pending.setup, stack);
        return Promise.resolve();
      }}
      onClose={onCancel}
    />
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

export function useIssueNodeData(): IssueNodeContextValue {
  const ctx = useContext(IssueNodeDataContext);
  if (!ctx) throw new Error("useIssueNodeData must be used within <IssuesProvider>");
  return ctx;
}
