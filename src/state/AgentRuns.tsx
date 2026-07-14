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
 * Split into two contexts, for the same reason `AppContext` is:
 *  - {@link useAgentRuns} — the run *flags*, which change only when a run starts or
 *    finishes.
 *  - {@link useSetupLines} — the streamed setup output, which changes once per
 *    output line (a chatty `npm install` emits thousands). Only `SetupLogsView`
 *    subscribes, so the sidebar / tab bar / file picker don't re-render per line.
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

import { commands, type SetupEvent } from "../bindings";
import {
  ensureResolvedSetting,
  queryKeys,
  TREES_RUN_SETUP_KEY,
  useResolvedBoolSetting,
} from "../lib/queries";
import { useApp } from "./AppContext";

/** A setup script running for one worktree. */
interface SetupRun {
  /** The repo the run belongs to — captured at start, because the active repo can
   *  change while `init.sh` is still streaming. */
  repo: string;
  /** Whether the agent launches once the script finishes. True when setup is part
   *  of *starting a task*; false for a manual "Run setup" re-run, which must not
   *  disturb the already-running terminal. */
  thenLaunch: boolean;
}

interface AgentRuns {
  /** Worktree ids whose main terminal should launch the agent when it next mounts.
   *  Set when a task is started (or resumed), cleared once a terminal has consumed
   *  the seed. Survives navigation — that's the point of this provider. */
  launchAgents: Set<string>;
  /** Per-launch model overrides from the Issues tray, keyed by worktree id (absent
   *  ⇒ the configured Work model). Read once by the fresh-launch seed, then dropped
   *  with the launch flag. Never persisted: the created session carries `--model`
   *  itself, so a resume needs nothing stored. */
  launchModels: Record<string, string>;
  /** Whether starting a task runs `.santree/init.sh` first (the user's preference,
   *  resolved through any per-repo override). Presentational only — it tells Trees
   *  which tab to open a start on. The run itself never reads it: {@link beginRun}
   *  resolves the preference imperatively, because a false-while-loading read here
   *  would skip the setup script outright. */
  runSetupOnStart: boolean;

  /** Whether a setup script is running for this worktree right now. */
  isSettingUp: (id: string) => boolean;
  /** Whether the *initial* setup — the one that precedes the agent launch — is
   *  running. That's the case where the terminal must be withheld: the PTY would
   *  otherwise capture the pre-setup env, and the agent seed only applies at session
   *  creation. A manual re-run must not disturb an existing terminal. */
  isInitialSetup: (id: string) => boolean;

  /** Begin a task in this worktree: run setup first (launching the agent when it
   *  finishes) or launch the agent straight away, per the preference — or per the
   *  batch's {@link planSetup} answer, when the run is part of one. Placement —
   *  which worktree is focused, which tab opens — is the caller's business. */
  beginRun: (id: string) => void;
  /** Answer "run setup?" once for a whole multi-task launch (Settings → Trees →
   *  "When starting several tasks at once"). Each worktree's run consumes the
   *  answer when it actually begins — which is later, and elsewhere: the creates
   *  are still in flight when the batch is planned. */
  planSetup: (ids: string[], runSetup: boolean) => void;
  /** Run the setup script on its own (the manual "Run setup" action). */
  runSetup: (id: string) => void;
  requestAgentLaunch: (id: string) => void;
  clearAgentLaunch: (id: string) => void;
  setLaunchModel: (id: string, model: string) => void;

  /** The worktree Trees currently has selected, or null when it isn't showing one
   *  (another tab, or the all-agents overview). The off-screen launcher skips it:
   *  its visible pane already hosts that terminal, and two hosts for one session
   *  would fight over the single xterm overlay. */
  visibleWorktree: string | null;
  setVisibleWorktree: (id: string | null) => void;
}

const AgentRunsContext = createContext<AgentRuns | null>(null);
const SetupLinesContext = createContext<ReadonlyMap<string, string[]>>(new Map());

const NO_LINES: string[] = [];

/** Append a streamed setup line, collapsing consecutive `progress` events onto the
 *  same line (a progress bar rewrites itself instead of scrolling). Exported for
 *  testing — see AgentRuns.test.ts. */
export function appendSetupLine(lines: string[], text: string, lastWasProgress: boolean): string[] {
  if (lastWasProgress && lines.length) {
    const next = lines.slice();
    next[next.length - 1] = text;
    return next;
  }
  return [...lines, text];
}

export function AgentRunsProvider({ children }: { children: ReactNode }) {
  const { activeRepo } = useApp();
  const runSetupOnStart = useResolvedBoolSetting(activeRepo, TREES_RUN_SETUP_KEY).value;
  const qc = useQueryClient();

  const [launchAgents, setLaunchAgents] = useState<Set<string>>(new Set());
  const [launchModels, setLaunchModels] = useState<Record<string, string>>({});
  const [setupRuns, setSetupRuns] = useState<Record<string, SetupRun>>({});
  const [setupLines, setSetupLines] = useState<ReadonlyMap<string, string[]>>(new Map());
  const [visibleWorktree, setVisibleWorktree] = useState<string | null>(null);

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

  const requestAgentLaunch = useCallback((id: string) => {
    setLaunchAgents((s) => (s.has(id) ? s : new Set(s).add(id)));
  }, []);

  const clearAgentLaunch = useCallback((id: string) => {
    setLaunchAgents((s) => {
      if (!s.has(id)) return s;
      const next = new Set(s);
      next.delete(id);
      return next;
    });
    // The seed has been consumed — drop the one-shot model override with it.
    setLaunchModels((m) => {
      if (!(id in m)) return m;
      const { [id]: _, ...rest } = m;
      return rest;
    });
  }, []);

  const setLaunchModel = useCallback((id: string, model: string) => {
    setLaunchModels((m) => (m[id] === model ? m : { ...m, [id]: model }));
  }, []);

  // A run finished (the script exited, or the command itself failed). Hand off to
  // the agent if this run was part of starting a task, and refresh the worktree —
  // setup writes files, .env, sometimes the branch state.
  const finishSetup = useCallback(
    (id: string) => {
      const run = runsRef.current[id];
      if (!run) return;
      qc.invalidateQueries({ queryKey: queryKeys.worktrees(run.repo) });
      if (run.thenLaunch) requestAgentLaunch(id);
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
    (id: string, thenLaunch: boolean) => {
      if (runsRef.current[id]) return;
      const repo = activeRepo;
      const run: SetupRun = { repo, thenLaunch };
      runsRef.current = { ...runsRef.current, [id]: run };
      setSetupRuns((r) => ({ ...r, [id]: run }));
      setSetupLines((m) => new Map(m).set(id, []));

      let lastWasProgress = false;
      const channel = new Channel<SetupEvent>();
      channel.onmessage = (e) => {
        if (e.type !== "progress" && e.type !== "line") {
          finishSetup(id);
          return;
        }
        // Read the flag now, not inside the updater: React runs state updaters at
        // *render* time, so a burst of lines delivered in one tick would all see the
        // flag's final value and overwrite each other instead of appending.
        const overwriteLast = lastWasProgress;
        lastWasProgress = e.type === "progress";
        setSetupLines((m) =>
          new Map(m).set(id, appendSetupLine(m.get(id) ?? [], e.text, overwriteLast)),
        );
      };
      commands.runWorktreeSetupStreamed(repo, id, channel).then((r) => {
        if (r.status !== "error") return;
        setSetupLines((m) => new Map(m).set(id, [...(m.get(id) ?? []), `Error: ${r.error}`]));
        finishSetup(id);
      });
    },
    [activeRepo, finishSetup],
  );

  // Never decide from the *hook's* view of the preference: `useResolvedBoolSetting`
  // reads false while the query is still in flight (its value is `data === "true"`,
  // which can't express "unknown"), and that window is real — it reopens on every
  // repo switch, since the resolved read is keyed by repo. Deciding inside it skips
  // the setup script entirely and launches the agent into an unprepared worktree.
  // So resolve it imperatively: cache-first (the common case, synchronous enough to
  // land in the same frame), fetching only when it truly isn't loaded yet.
  const beginRun = useCallback(
    (id: string) => {
      const start = (setup: boolean) => (setup ? startSetup(id, true) : requestAgentLaunch(id));
      const planned = setupPlanRef.current[id];
      if (planned !== undefined) {
        delete setupPlanRef.current[id];
        start(planned);
        return;
      }
      ensureResolvedSetting(qc, activeRepo, TREES_RUN_SETUP_KEY).then(
        (value) => start(value === "true"),
        // A failed settings read must never swallow the launch — start the agent.
        () => start(false),
      );
    },
    [qc, activeRepo, startSetup, requestAgentLaunch],
  );

  const runSetup = useCallback((id: string) => startSetup(id, false), [startSetup]);

  const value = useMemo<AgentRuns>(
    () => ({
      launchAgents,
      launchModels,
      runSetupOnStart,
      isSettingUp: (id) => id in setupRuns,
      isInitialSetup: (id) => setupRuns[id]?.thenLaunch === true,
      beginRun,
      planSetup,
      runSetup,
      requestAgentLaunch,
      clearAgentLaunch,
      setLaunchModel,
      visibleWorktree,
      setVisibleWorktree,
    }),
    [
      launchAgents,
      launchModels,
      runSetupOnStart,
      setupRuns,
      beginRun,
      planSetup,
      runSetup,
      requestAgentLaunch,
      clearAgentLaunch,
      setLaunchModel,
      visibleWorktree,
    ],
  );

  return (
    <AgentRunsContext.Provider value={value}>
      <SetupLinesContext.Provider value={setupLines}>{children}</SetupLinesContext.Provider>
    </AgentRunsContext.Provider>
  );
}

export function useAgentRuns(): AgentRuns {
  const ctx = useContext(AgentRunsContext);
  if (!ctx) throw new Error("useAgentRuns must be used within <AgentRunsProvider>");
  return ctx;
}

/** The streamed setup output for one worktree. Subscribing re-renders on every
 *  output line — only the Setup log view should. */
export function useSetupLines(id: string): string[] {
  return useContext(SetupLinesContext).get(id) ?? NO_LINES;
}
