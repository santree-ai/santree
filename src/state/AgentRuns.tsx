/**
 * Agent-run state: which worktrees have a setup script running, and which have an
 * agent launch queued.
 *
 * Mounted at the app shell (`__root.tsx`, beside `<TerminalLayer/>`), *not* in the
 * Trees route — because a run outlives the view that started it. Two things broke
 * while this lived in the route-scoped `TreesProvider`:
 *  - "Run in background" (⌘-click Run in Issues) never navigates to Trees, so the
 *    launch machinery was simply never mounted: the worktree got created and no
 *    agent ever started, while a success toast said otherwise.
 *  - Navigating away mid-setup unmounted the provider, cancelling the stream
 *    handler; `init.sh` kept running server-side but the queued setup→agent chain
 *    was gone, and reopening the Terminal tab resolved to a bare shell.
 *
 * This context carries only the run *flags*, which change when a run starts or
 * finishes. The script's actual output goes to `streamRuns` — a chatty
 * `npm install` emits thousands of chunks, and only `SetupLogsView` should
 * re-render for them, not every consumer of this context.
 */
import { useQueryClient } from "@tanstack/react-query";
import { Channel } from "@tauri-apps/api/core";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

import { commands, type StreamEvent } from "../bindings";
import { ensureResolvedSetting, queryKeys, TREES_RUN_SETUP_KEY } from "../lib/queries";
import { setupRunKey, startRun } from "./streamRuns";

/** A setup script running for one worktree. */
interface SetupRun {
  /** The project the run belongs to, named by whoever started it. Runs outlive
   *  the view that began them, so this can never be read back off the screen. */
  repo: string;
  /** The tab the agent launches into once the script finishes, or null for a
   *  manual "Run setup" re-run, which launches nothing and must not disturb the
   *  tab already running. */
  launchTab: string | null;
}

interface AgentRuns {
  /** Which tab each worktree has a pending agent launch for — the tab that opens
   *  with the *work prompt* rather than an empty conversation. Keyed by worktree
   *  because that is what a start, a setup run and the off-screen launcher all
   *  name; valued by tab because a worktree can have several agent tabs open and
   *  only the one the start minted may consume the prompt. Set when a task is
   *  started, cleared once that tab's terminal has consumed the seed. Survives
   *  navigation — that's the point of this provider. */
  launchAgents: ReadonlyMap<string, QueuedLaunch>;

  /** Whether a setup script is running for this worktree right now. */
  isSettingUp: (id: string) => boolean;
  /** Whether the *initial* setup — the one that precedes the agent launch — is
   *  running. That's the case where the terminal must be withheld: the PTY would
   *  otherwise capture the pre-setup env, and the agent seed only applies at session
   *  creation. A manual re-run must not disturb an existing terminal. */
  isInitialSetup: (id: string) => boolean;

  /** Begin a task in this worktree: run setup first (launching the agent when it
   *  finishes) or launch the agent straight away, per the preference — or per the
   *  batch's {@link planSetup} answer, when the run is part of one. The caller
   *  mints and persists `tabId` first — every agent runs in a tab, and the row has
   *  to exist before the launch can name it. Placement — which worktree is
   *  focused, which tab is shown — is the caller's business too. */
  beginRun: (repo: string, id: string, tabId: string) => void;
  /** Answer "run setup?" once for a whole multi-task launch (Settings → Trees →
   *  "When starting several tasks at once"). Each worktree's run consumes the
   *  answer when it actually begins — which is later, and elsewhere: the creates
   *  are still in flight when the batch is planned. */
  planSetup: (ids: string[], runSetup: boolean) => void;
  /** Run the setup script on its own (the manual "Run setup" action). */
  runSetup: (repo: string, id: string) => void;
  requestAgentLaunch: (repo: string, id: string, tabId: string) => void;
  clearAgentLaunch: (id: string) => void;

  /** The worktree Trees currently has selected, or null when it isn't showing one
   *  (another tab, or the all-agents overview). The off-screen launcher skips it:
   *  its visible pane already hosts that terminal, and two hosts for one session
   *  would fight over the single xterm overlay. */
  visibleWorktree: VisibleWorktree | null;
  setVisibleWorktree: (open: VisibleWorktree | null) => void;
}

/** A queued agent launch: the tab it opens in, and the project whose worktree
 *  that tab belongs to. The project is carried rather than read off the screen
 *  because the whole point of the queue is that it runs wherever the user is —
 *  including in a project they are not looking at. */
export interface QueuedLaunch {
  repo: string;
  tabId: string;
}

/** The worktree a view has on screen, qualified by its project: the sidebar
 *  spans every project, and two of them can hold the same ticket id. */
export interface VisibleWorktree {
  repo: string;
  id: string;
}

const AgentRunsContext = createContext<AgentRuns | null>(null);
export function AgentRunsProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();

  const [launchAgents, setLaunchAgents] = useState<ReadonlyMap<string, QueuedLaunch>>(new Map());
  const [setupRuns, setSetupRuns] = useState<Record<string, SetupRun>>({});
  const [visibleWorktree, setVisibleWorktree] = useState<VisibleWorktree | null>(null);

  // Read from the stream callbacks, which outlive the render that created them (a
  // run keeps streaming across re-renders and route changes).
  const runsRef = useRef(setupRuns);
  runsRef.current = setupRuns;

  // A batch's setup answer, keyed by worktree id and consumed by the run that
  // begins for it. A ref, not state: nothing renders from it, and the run that
  // reads it can begin several seconds later, from another view.
  const setupPlanRef = useRef<Record<string, boolean>>({});
  const planSetup = useCallback((ids: string[], runSetup: boolean) => {
    for (const id of ids) setupPlanRef.current[id] = runSetup;
  }, []);

  const requestAgentLaunch = useCallback((repo: string, id: string, tabId: string) => {
    setLaunchAgents((m) => {
      const current = m.get(id);
      if (current?.tabId === tabId && current.repo === repo) return m;
      return new Map(m).set(id, { repo, tabId });
    });
  }, []);

  const clearAgentLaunch = useCallback((id: string) => {
    setLaunchAgents((m) => {
      if (!m.has(id)) return m;
      const next = new Map(m);
      next.delete(id);
      return next;
    });
  }, []);

  // A run finished (the script exited, or the command itself failed). Hand off to
  // the agent if this run was part of starting a task, and refresh the worktree —
  // setup writes files, .env, sometimes the branch state.
  const finishSetup = useCallback(
    (id: string) => {
      const run = runsRef.current[id];
      if (!run) return;
      qc.invalidateQueries({ queryKey: queryKeys.worktrees(run.repo) });
      if (run.launchTab) requestAgentLaunch(run.repo, id, run.launchTab);
      setSetupRuns((r) => {
        const { [id]: _, ...rest } = r;
        return rest;
      });
    },
    [qc, requestAgentLaunch],
  );

  // Start `init.sh` under a PTY and stream its output. Imperative (driven by a
  // click or a launch), never an effect: spawning a process isn't idempotent, and
  // an effect would re-fire it on remount. Runs are keyed by worktree id rather
  // than sharing one slot, because concurrent runs for different worktrees now
  // genuinely happen — two background launches start together.
  const startSetup = useCallback(
    (repo: string, id: string, launchTab: string | null) => {
      if (runsRef.current[id]) return;
      const run: SetupRun = { repo, launchTab };
      runsRef.current = { ...runsRef.current, [id]: run };
      setSetupRuns((r) => ({ ...r, [id]: run }));

      // The transcript (and the Stop/running state the log pane reads) lives in
      // `streamRuns`; this context only tracks that a run is in flight so the
      // setup→agent hand-off survives navigating away.
      startRun(
        setupRunKey(id),
        () => new Channel<StreamEvent>(),
        (channel) => commands.runWorktreeSetupStreamed(repo, id, channel as Channel<StreamEvent>),
        Date.now(),
        () => finishSetup(id),
      );
    },
    [finishSetup],
  );

  // Never decide from the *hook's* view of the preference: `useResolvedBoolSetting`
  // reads false while the query is still in flight (its value is `data === "true"`,
  // which can't express "unknown"), and that window is real — it reopens on every
  // repo switch, since the resolved read is keyed by repo. Deciding inside it skips
  // the setup script entirely and launches the agent into an unprepared worktree.
  // So resolve it imperatively: cache-first (the common case, synchronous enough to
  // land in the same frame), fetching only when it truly isn't loaded yet.
  const beginRun = useCallback(
    (repo: string, id: string, tabId: string) => {
      const start = (setup: boolean) =>
        setup ? startSetup(repo, id, tabId) : requestAgentLaunch(repo, id, tabId);
      const planned = setupPlanRef.current[id];
      if (planned !== undefined) {
        delete setupPlanRef.current[id];
        start(planned);
        return;
      }
      ensureResolvedSetting(qc, repo, TREES_RUN_SETUP_KEY).then(
        (value) => start(value === "true"),
        // A failed settings read must never swallow the launch — start the agent.
        () => start(false),
      );
    },
    [qc, startSetup, requestAgentLaunch],
  );

  const runSetup = useCallback(
    (repo: string, id: string) => startSetup(repo, id, null),
    [startSetup],
  );

  const value = useMemo<AgentRuns>(
    () => ({
      launchAgents,
      isSettingUp: (id) => id in setupRuns,
      isInitialSetup: (id) => setupRuns[id]?.launchTab != null,
      beginRun,
      planSetup,
      runSetup,
      requestAgentLaunch,
      clearAgentLaunch,
      visibleWorktree,
      setVisibleWorktree,
    }),
    [
      launchAgents,
      setupRuns,
      beginRun,
      planSetup,
      runSetup,
      requestAgentLaunch,
      clearAgentLaunch,
      visibleWorktree,
    ],
  );

  return <AgentRunsContext.Provider value={value}>{children}</AgentRunsContext.Provider>;
}

/** The runs context when there is one, `null` otherwise.
 *
 *  For a surface that *offers* a run rather than depending on one — Reviews'
 *  worktree dialog, whose setup toggle is one option among several. The provider
 *  is mounted at the app root, so in the running app this is never null; it is
 *  the strict {@link useAgentRuns} that guarantees that, and this exists so a
 *  component rendered without the whole root (a test, a story) still renders
 *  instead of throwing over an optional extra. */
export function useOptionalAgentRuns(): AgentRuns | null {
  return useContext(AgentRunsContext) ?? null;
}

export function useAgentRuns(): AgentRuns {
  const ctx = useContext(AgentRunsContext);
  if (!ctx) throw new Error("useAgentRuns must be used within <AgentRunsProvider>");
  return ctx;
}
