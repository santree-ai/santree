/**
 * Typed data layer. Every backend read is a TanStack Query hook wrapping a
 * generated command from `bindings.ts`. Components never call `commands.*`
 * directly — they consume these hooks, so caching and loading states are
 * uniform and the live/empty data source stays swappable.
 */
import {
  type QueryClient,
  type QueryKey,
  type UseQueryOptions,
  useIsFetching,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  AgentKind,
  ChangedFile,
  ScriptInfo,
  Settings,
  TriageComment,
  TriageDetail,
  TriageTicket,
  WorktreeTab,
} from "../bindings";
import { commands, events } from "../bindings";
// `useViewCounts` needs live PTY presence for its "N running" badge — the one
// place this data layer reaches into a feature, since TerminalsContext is
// mounted at the app root and is the single source of live-session state.
import { useTerminals } from "../features/terminal/TerminalsContext";
import { type ToastOptions, toast } from "../state/toast";

/** The shape of a generated `Result`-typed command's promise. */
type CommandResult<T> = Promise<{ status: "ok"; data: T } | { status: "error"; error: string }>;

/** Unwrap a generated `Result` command into a value-or-throw promise. */
async function unwrap<T>(promise: CommandResult<T>): Promise<T> {
  const result = await promise;
  if (result.status === "error") throw new Error(result.error);
  return result.data;
}

/**
 * `useQuery` for a `Result`-typed command: unwraps the result so the hook body
 * is just (key, command, options). Hooks that call this are visibly the ones
 * backed by a fallible `Result` command; plain `useQuery` hooks (e.g.
 * `listAgents`, `listWorktrees`) return raw values and need no unwrap — so the
 * two conventions are no longer indistinguishable.
 */
function useUnwrappedQuery<T>(
  queryKey: QueryKey,
  command: () => CommandResult<T>,
  options: {
    enabled?: boolean;
    staleTime?: number;
    gcTime?: number;
    // For "live status" reads only: poll on an interval (or a predicate of the
    // cached data) while a condition holds. Off everywhere else — we lean on
    // staleTime + the cache, and only hit the network when data is actually old.
    refetchInterval?: UseQueryOptions<T>["refetchInterval"];
  } = {},
) {
  return useQuery({ queryKey, queryFn: () => unwrap(command()), ...options });
}

/**
 * Wire an optimistic mutation correctly-by-default: cancel in-flight reads,
 * apply the optimistic cache patch (which returns its own rollback), roll back
 * on error, and reconcile with the server by invalidating on settle.
 *
 * `optimistic` owns the snapshot/restore — it patches the cache and returns a
 * closure that undoes exactly that patch (or nothing if there's no patch). This
 * keeps each mutation's optimistic logic colocated and type-safe.
 *
 * Reads must be cancelled *before* patching (otherwise an in-flight refetch can
 * land after our patch and clobber it); we cancel the keys `invalidate` names.
 */
export function useOptimisticMutation<TVars, TData>(opts: {
  mutationFn: (v: TVars) => Promise<TData>;
  /** Patch the cache optimistically; return a rollback closure (or nothing). */
  optimistic?: (qc: QueryClient, v: TVars) => (() => void) | undefined;
  /** Keys to refetch on settle (and to cancel before patching). Takes the vars
   *  first, matching `useActionMutation` so the two factories read the same. */
  invalidate?: (v: TVars) => QueryKey[];
  /**
   * Identifies this mutation *site* (stable across `.mutate()` calls, not
   * per-vars) so overlapping calls can be told apart from unrelated ones. When
   * set, `onSettled` only reconciles once no sibling mutation with the same
   * key is still in flight — otherwise a fast first call's settle-refetch can
   * resolve mid-flight and clobber a second, still-optimistic call's patch
   * (e.g. rapid stage → unstage clicks). Omit when the mutation is never
   * fired twice in quick succession from the same hook instance.
   */
  mutationKey?: QueryKey;
}) {
  const qc = useQueryClient();
  return useMutation<TData, Error, TVars, { rollback?: () => void }>({
    mutationKey: opts.mutationKey,
    mutationFn: opts.mutationFn,
    onMutate: async (vars) => {
      const keys = opts.invalidate?.(vars) ?? [];
      await Promise.all(keys.map((queryKey) => qc.cancelQueries({ queryKey })));
      const rollback = opts.optimistic?.(qc, vars) ?? undefined;
      return { rollback };
    },
    onError: (_err, _vars, ctx) => ctx?.rollback?.(),
    onSettled: (_data, _err, vars) => {
      // A sibling mutation sharing this key is still running — it will
      // reconcile when *it* settles, last-write-wins. `isMutating` still
      // counts this call itself (its status flips to settled only after this
      // callback returns), so `> 1` means "someone else is still in flight".
      if (opts.mutationKey && qc.isMutating({ mutationKey: opts.mutationKey }) > 1) return;
      for (const queryKey of opts.invalidate?.(vars) ?? []) {
        qc.invalidateQueries({ queryKey });
      }
    },
  });
}

/**
 * A non-optimistic "fire → invalidate + confirm" mutation: run the command, then
 * refetch the affected keys and (optionally) raise a success toast. Centralizes
 * the boilerplate the worktree/repo/settings action hooks each repeated. Use
 * `useOptimisticMutation` instead when the UI should patch before the round-trip.
 */
function useActionMutation<TVars = void, TData = unknown>(opts: {
  mutationFn: (v: TVars) => Promise<TData>;
  invalidate?: (v: TVars, data: TData) => QueryKey[];
  success?: (data: TData, v: TVars) => string | ({ message: string } & ToastOptions) | null;
  /** Opt out of the global error→toast handler when the caller owns its own
   *  failure UI (e.g. a `ConfirmDialog` that shows the error inline). */
  silent?: boolean;
}) {
  const qc = useQueryClient();
  return useMutation<TData, Error, TVars>({
    mutationFn: opts.mutationFn,
    meta: opts.silent ? { silent: true } : undefined,
    onSuccess: (data, vars) => {
      for (const queryKey of opts.invalidate?.(vars, data) ?? [])
        qc.invalidateQueries({ queryKey });
      const s = opts.success?.(data, vars);
      if (s) typeof s === "string" ? toast.success(s) : toast.success(s.message, s);
    },
  });
}

/** Setting reads change only on explicit writes (which invalidate them), so
 *  they never need a background refetch — newly-mounted consumers reuse cache. */
const SETTING_STALE_TIME = Number.POSITIVE_INFINITY;

/** The Linear issue graph is heavy and changes infrequently; mutations invalidate
 *  `tasksPrefix` explicitly, so a stale window keeps re-entering the Issues tab
 *  from re-fetching the whole graph on every mount. */
const TASKS_STALE_TIME = 3 * 60_000;

export const queryKeys = {
  repos: ["repos"] as const,
  agents: ["agents"] as const,
  claudeModels: ["claude-models"] as const,
  agentAuth: (kind: AgentKind) => ["agent-auth", kind] as const,
  githubStatus: ["github-status"] as const,
  claudeHookSettings: ["claude-hook-settings"] as const,
  sessionStates: ["session-states"] as const,
  sessionUsageLive: ["session-usage-live"] as const,
  /** Prefix for every repo's task graph — invalidate this (not `tasks(repo)`)
   *  when a change (e.g. a fresh Linear connection) should refetch all repos'
   *  graphs at once. */
  tasksPrefix: ["tasks"] as const,
  tasks: (repo: string) => ["tasks", repo] as const,
  worktrees: (repo: string) => ["worktrees", repo] as const,
  baseWorktree: (repo: string) => ["base-worktree", repo] as const,
  worktreeStatus: (repo: string, id: string) => ["worktree-status", repo, id] as const,
  worktreeFiles: (repo: string, id: string) => ["worktree-files", repo, id] as const,
  worktreeFileDiff: (repo: string, id: string, path: string) =>
    ["worktree-file-diff", repo, id, path] as const,
  worktreeFileSource: (repo: string, id: string, path: string) =>
    ["worktree-file-source", repo, id, path] as const,
  workPrompt: (repo: string, id: string) => ["work-prompt", repo, id] as const,
  agentSession: (repo: string, termKey: string, allowFresh: boolean) =>
    ["agent-session", repo, termKey, allowFresh] as const,
  startedInvestigations: (repo: string) => ["started-investigations", repo] as const,
  worktreeTabs: (repo: string) => ["worktree-tabs", repo] as const,
  commitDraft: (repo: string, id: string) => ["commit-draft", repo, id] as const,
  worktreePrs: (repo: string) => ["worktree-prs", repo] as const,
  prReviewers: (repo: string, id: string) => ["pr-reviewers", repo, id] as const,
  reviews: (repo: string) => ["reviews", repo] as const,
  mergeQueue: (repo: string) => ["merge-queue", repo] as const,
  prDetail: (owner: string, name: string, number: number) =>
    ["pr-detail", owner, name, number] as const,
  openers: ["openers"] as const,
  initScript: (repo: string) => ["init-script", repo] as const,
  taskNote: (repo: string, id: string) => ["task-note", repo, id] as const,
  triageTickets: (repo: string) => ["triage-tickets", repo] as const,
  triageDetail: (repo: string, id: string) => ["triage-detail", repo, id] as const,
  triageSchedule: (repo: string) => ["triage-schedule", repo] as const,
  settings: ["settings"] as const,
  claudeCommands: (repo: string | null) => ["claude-commands", repo] as const,
  setting: (scope: string, key: string) => ["setting", scope, key] as const,
  resolvedSetting: (repo: string, key: string) => ["resolved-setting", repo, key] as const,
  /** Prefix for every repo's Linear connection status — invalidate this (not
   *  `linearStatus(repo)`) when a change (e.g. connect/disconnect) should
   *  refetch all repos' status at once. */
  linearStatusPrefix: ["linear-status"] as const,
  linearStatus: (repo: string) => ["linear-status", repo] as const,
  linearOrgs: ["linear-orgs"] as const,
  claudeUsage: ["claude-usage"] as const,
};

/** Setting keys for the Triage Investigation action (agent · skill · model ·
 *  effort). `effort` maps to the agent's `--effort` flag (Claude only). */
export const INVESTIGATE_AGENT_KEY = "investigate_agent";
export const INVESTIGATE_COMMAND_KEY = "investigate_command";
export const INVESTIGATE_MODEL_KEY = "investigate_model";
export const INVESTIGATE_EFFORT_KEY = "investigate_effort";
/** Whether an Investigate launch passes Claude's `--remote-control` flag
 *  (names the session for Remote Control web). Defaults to on — missing/unset
 *  means enabled, only the literal `"false"` turns it off — so a build of
 *  `claude` old enough to predate the flag has an escape hatch (CLAUDE.md's
 *  "verify vendor flags" gotcha). */
export const INVESTIGATE_REMOTE_CONTROL_KEY = "investigate_remote_control";

/** Setting keys for the Issues "Work" action (agent · model · effort) used by the
 *  launch tray. Unlike triage, this action is always on — there's no enable switch. */
export const WORK_AGENT_KEY = "work_agent";
export const WORK_MODEL_KEY = "work_model";
export const WORK_EFFORT_KEY = "work_effort";
/** Start mode for a worktree's Claude launch — the value passed to Claude's
 *  `--permission-mode` (see {@link PERMISSION_MODES}). Empty leaves the flag off
 *  ("Default" — Claude's own normal mode). Applied on both start and restart. */
export const WORK_PERMISSION_MODE_KEY = "work_permission_mode";

/** The agent effort levels (Claude's `--effort`), in ascending order. Empty means
 *  "leave on the CLI default" — don't pass the flag. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Selectable Claude start modes (`--permission-mode <value>`) — the full set the
 *  CLI accepts. The empty "Default" option (no flag) is rendered separately by the
 *  picker; these are the explicit overrides. Values are Claude's exact flag values
 *  — do not translate (`manual` is Claude's own alias for `default`). */
export const PERMISSION_MODES = [
  { value: "plan", label: "Plan" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "auto", label: "Auto" },
  { value: "dontAsk", label: "Don't ask" },
  { value: "bypassPermissions", label: "Bypass permissions" },
  { value: "manual", label: "Manual" },
] as const;
/** When on, starting a worktree moves the Linear issue to its "started" (In
 *  Progress) state so Linear reflects what's actually being worked on. */
export const WORK_MOVE_IN_PROGRESS_KEY = "work_move_in_progress";

/** When on, launching work goes through the multi-select queue (the "Add to
 *  queue" button + launch tray). Off (default) drops the queue: the button reads
 *  "Run" and starts the single focused ticket immediately — ⌘-click runs it in
 *  the background without leaving the current view. App-scoped, defaults off. */
export const WORK_QUEUE_KEY = "work_queue";

/**
 * Triage queue preference keys (app-scoped, string "true"/"false").
 * - good_citizen: when off-duty or your queue is empty, show the team's issues.
 * - show_snoozed: include snoozed issues instead of hiding them.
 */
export const TRIAGE_GOOD_CITIZEN_KEY = "triage_good_citizen";
export const TRIAGE_SNOOZED_KEY = "triage_show_snoozed";

/**
 * How people's names are shown across the app (issues, triage, comments, the
 * schedule). "full" → real name ("Felipe Perdomo"); "username" → the @handle.
 * Mirrors Linear's own "Display names" preference. App-scoped, defaults to full.
 */
export const DISPLAY_NAMES_KEY = "display_names";

/** Whether to confirm before quitting the app. App-scoped; defaults to ON (a
 *  missing value means confirm), so read it as `data !== "false"`. */
export const CONFIRM_ON_QUIT_KEY = "confirm_on_quit";

/** Show santree's inline context-usage bar in the app (Trees, above the bottom
 *  bar). App-scoped, defaults to OFF (`data === "true"` = on). Display-only: the
 *  usage itself is *always* captured (the `--settings` statusLine is injected
 *  unconditionally — see {@link useClaudeHookSettings}), so flipping this lights
 *  up already-running tabs at runtime without relaunching. */
export const CLAUDE_STATUS_LINE_KEY = "claude_status_line";

/** Launch Claude with the `--chrome` flag (browser control). App-scoped, defaults
 *  to OFF (`data === "true"` means on). Threaded into the agent seed as
 *  `opts.chrome` at every Claude launch site. */
export const CLAUDE_START_WITH_CHROME_KEY = "claude_start_with_chrome";

/**
 * Trees (worktree) preference keys (string-valued settings):
 * - run_setup: run `.santree/init.sh` automatically when creating a worktree.
 * - stage_all: stage everything before committing (skip the confirmation).
 * - auto_pr: open a PR automatically on the first commit (wired in Phase 2).
 * - batch_setup: how to handle setup when starting several tasks at once —
 *   "always" run · "never" run · "ask" once.
 */
export const TREES_RUN_SETUP_KEY = "trees_run_setup";
export const TREES_STAGE_ALL_KEY = "trees_stage_all";
export const TREES_AUTO_PR_KEY = "trees_auto_pr";
/** Push the branch to origin automatically after each commit (default off). */
export const TREES_AUTO_PUSH_KEY = "trees_auto_push";
export const TREES_BATCH_SETUP_KEY = "trees_batch_setup";
/** Diff layout for the Trees diff panel: "split" | "unified" (default split). */
export const TREES_DIFF_MODE_KEY = "trees_diff_mode";
/** Changes browser layout: "list" | "tree" (default list). */
export const TREES_CHANGES_VIEW_KEY = "trees_changes_view";
/** Default "open in" target (an opener key, e.g. "cursor") for the split button. */
export const TREES_DEFAULT_EDITOR_KEY = "trees_default_editor";

/** How the start-multiple flow treats the setup script. */
export type BatchSetup = "always" | "never" | "ask";

/**
 * Environment settings — variables (and `.env` file references) santree injects
 * into every terminal it spawns. Stored as JSON in the generic settings table,
 * scope `"app"` or `"repo:<name>"` (both merge at spawn, repo wins). The backend
 * (`env.rs`) resolves + applies them; these hooks drive the settings editor.
 */
export const ENV_VARS_KEY = "env_vars";
export const ENV_FILES_KEY = "env_files";

export interface EnvVar {
  name: string;
  value: string;
}

const parseJsonSetting = <T>(raw: string | null | undefined, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

/** The explicit env variables stored for a scope (app or `repo:<name>`). */
export const useEnvVars = (scope: string) => {
  const q = useSetting(scope, ENV_VARS_KEY);
  return { vars: parseJsonSetting<EnvVar[]>(q.data, []), loading: q.isLoading };
};

/** The `.env` file paths referenced by a scope. */
export const useEnvFiles = (scope: string) => {
  const q = useSetting(scope, ENV_FILES_KEY);
  return { files: parseJsonSetting<string[]>(q.data, []), loading: q.isLoading };
};

/** The variable names a referenced `.env` file defines (for the "N loaded" count). */
export const useEnvFileVars = (path: string) =>
  useQuery({
    queryKey: ["env-file-vars", path],
    queryFn: () => commands.envFileVars(path),
    enabled: !!path,
    staleTime: SETTING_STALE_TIME,
  });

/** The running app's real version (single-sourced from `tauri.conf.json`), for
 * the sidebar footer and help menu. Fixed for the process lifetime. */
export const useAppVersion = () =>
  useQuery({ queryKey: ["app-version"], queryFn: getVersion, staleTime: Infinity });

/** Read an app-scoped boolean setting (defaults to false until loaded). */
export const useBoolSetting = (scope: string, key: string) => {
  const q = useSetting(scope, key);
  return { value: q.data === "true", loading: q.isLoading };
};

/** Linear connection status for a repo (which org it uses, if any). */
export const useLinearStatus = (repo: string) =>
  useUnwrappedQuery(queryKeys.linearStatus(repo), () => commands.linearAuthStatus(repo), {
    staleTime: SETTING_STALE_TIME,
  });

/** Every connected Linear org. */
export const useLinearOrgs = () =>
  useUnwrappedQuery(queryKeys.linearOrgs, () => commands.linearOrgs(), {
    staleTime: SETTING_STALE_TIME,
  });

export const useRepos = () =>
  useUnwrappedQuery(queryKeys.repos, () => commands.listRepos(), {
    staleTime: SETTING_STALE_TIME,
  });

/** Register a repository from a local folder (validated as a git repo in Rust). */
export const useAddRepo = () =>
  useActionMutation({
    mutationFn: (path: string) => unwrap(commands.addRepo(path)),
    invalidate: () => [queryKeys.repos],
    success: (repo) => `Added ${repo.name}.`,
  });

export const useAgents = () =>
  useQuery({ queryKey: queryKeys.agents, queryFn: commands.listAgents });

/** The Claude model-picker options — the CLI's tier aliases (`opus`/`sonnet`/
 *  `haiku`, which auto-resolve to the current model) plus any extra models Claude
 *  Code has cached (e.g. Fable), read live from `~/.claude.json` so the list tracks
 *  the vendor's lineup instead of a hardcoded one. Cached briefly; it changes only
 *  when Claude Code's own picker cache does. */
export const useClaudeModels = () =>
  useUnwrappedQuery(queryKeys.claudeModels, () => commands.claudeModels(), {
    staleTime: 5 * 60 * 1000,
  });

/** An agent harness's authentication / subscription status. */
export const useAgentAuth = (kind: AgentKind) =>
  useQuery({ queryKey: queryKeys.agentAuth(kind), queryFn: () => commands.agentAuth(kind) });

/** The `gh` CLI integration status (installed? authenticated? which account?). */
export const useGithubStatus = () =>
  useQuery({ queryKey: queryKeys.githubStatus, queryFn: () => commands.githubStatus() });

/**
 * Path to the settings file to pass as `claude --settings <path>` — carries the
 * session-state hooks and santree's own `statusLine` (`null` when the hook binary
 * can't be resolved). A file path — not inline JSON — because the config is too
 * large to inline into the PTY seed command without breaking its shell quoting.
 *
 * The content is setting-independent (the statusLine is *always* injected so
 * usage is always captured), so this is cached forever. Whether the app renders
 * the inline usage bar is gated separately at the render site via
 * {@link CLAUDE_STATUS_LINE_KEY} — a runtime decision, so it works for
 * already-running tabs.
 */
export const useClaudeHookSettings = () =>
  useQuery({
    queryKey: queryKeys.claudeHookSettings,
    queryFn: () => commands.claudeHookSettings(),
    staleTime: Infinity,
  });

/** Current state of every santree-launched Claude session (active/waiting/idle/
 *  exited), recorded live by the injected hooks. Kept fresh in realtime by
 *  `useSessionStateWatcher`.
 *
 *  The realtime signal covers every state change a hook *observes*, but the hooks
 *  can't reliably *clear* a state: a manually-answered prompt (accept/reject, or a
 *  typed reply) fires nothing, and a turn can end with no `Stop`. The backend
 *  reconciles the live state against the session transcript (the ground truth) on
 *  every read; this short poll guarantees a read actually happens so those
 *  transitions surface within ~10s even when no hook fires. We poll while any
 *  session is unsettled — a pending prompt (to catch resolution) or `running` (to
 *  catch it going idle without a `Stop`). Zero polling once everything is idle/
 *  exited. */
/** States that can still change without a hook firing, so a read (and thus the
 *  backend's transcript reconciliation) must keep happening: a pending prompt (to
 *  catch resolution) and any working state (to catch it going idle without a
 *  `Stop`). Settled states — idle / exited — don't need polling. */
const UNSETTLED_STATES = new Set(["permission", "waiting", "active", "delegating"]);

export const useSessionStates = () =>
  useUnwrappedQuery(queryKeys.sessionStates, () => commands.sessionStates(), {
    refetchInterval: (query) =>
      query.state.data?.some((s) => UNSETTLED_STATES.has(s.state)) ? 10_000 : false,
  });

/**
 * Keep `useSessionStates` fresh in realtime. The `santree-hook` binary bumps a
 * tick file after each write; the Rust watcher (started at app setup) emits
 * `sessionStateChanged`, and we invalidate the query so it refetches — no
 * polling. Mount once at the app root so it stays live across tab switches; the
 * query's on-mount fetch covers the "poll latest on restart" case.
 */
export const useSessionStateWatcher = () => {
  const qc = useQueryClient();
  useEffect(() => {
    const unlisten = events.sessionStateChanged.listen(() => {
      qc.invalidateQueries({ queryKey: queryKeys.sessionStates });
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [qc]);
};

/** Live per-session token/context usage, captured by santree's status line (the
 *  authoritative source, matching the terminal bar). Keyed by session id. */
export const useSessionUsageLive = () =>
  useUnwrappedQuery(queryKeys.sessionUsageLive, () => commands.sessionUsageLive());

/** Realtime refresh for {@link useSessionUsageLive}: the status-line capture pings
 *  the signal socket (tagged `u`), the Rust listener emits `sessionUsageChanged`,
 *  and we invalidate. Mount once at the app root (mirrors the state watcher). */
export const useSessionUsageWatcher = () => {
  const qc = useQueryClient();
  useEffect(() => {
    const unlisten = events.sessionUsageChanged.listen(() => {
      qc.invalidateQueries({ queryKey: queryKeys.sessionUsageLive });
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [qc]);
};

/**
 * Aggregated Claude token usage across all local session transcripts (Settings →
 * Usage). A short staleTime avoids re-parsing on every panel revisit; the watcher
 * below pushes live updates while a session is active, so it's rarely stale.
 */
export const useClaudeUsage = () =>
  useUnwrappedQuery(queryKeys.claudeUsage, () => commands.claudeUsage(), {
    staleTime: 60_000,
  });

/**
 * Keep `useClaudeUsage` live: the Rust watcher (started at app setup) emits
 * `usageChanged` whenever a transcript grows, and we invalidate the query so the
 * Usage panel refetches without polling. Mounted once at the app root; the
 * invalidation is a no-op when the panel (and thus the query) isn't observed.
 */
export const useUsageWatcher = () => {
  const qc = useQueryClient();
  useEffect(() => {
    const unlisten = events.usageChanged.listen(() => {
      qc.invalidateQueries({ queryKey: queryKeys.claudeUsage });
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [qc]);
};

/**
 * File-count progress of the cold transcript parse, for a determinate loading bar
 * on first open. `null` until the first event arrives; a warm reload returns
 * instantly (nothing to show). Mounted by the Usage panel while it's loading.
 */
export const useUsageProgress = () => {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    const unlisten = events.usageProgress.listen(({ payload }) => setProgress(payload));
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);
  return progress;
};

/**
 * Graph tickets for a repo. The backend returns the live Linear graph when an
 * org is connected and an empty list otherwise, so this is a single fetch with
 * no "is connected?" round-trip gating it (the old waterfall blocked the graph
 * behind a serial status read).
 */
export const useTasks = (repo: string) =>
  useUnwrappedQuery(queryKeys.tasks(repo), () => commands.linearListIssues(repo), {
    enabled: !!repo,
    staleTime: TASKS_STALE_TIME,
  });

/**
 * The user's local note for a task (extra context, stored only on this machine).
 * Notes change only on explicit save, so they never need a background refetch.
 */
export const useTaskNote = (repo: string, taskId: string | null) =>
  useUnwrappedQuery(
    queryKeys.taskNote(repo, taskId ?? ""),
    () => commands.taskNote(repo, taskId ?? ""),
    {
      enabled: !!repo && !!taskId,
      staleTime: SETTING_STALE_TIME,
    },
  );

/** Save (or clear, when blank) a task's local note, optimistically. */
export const useSetTaskNote = (repo: string) =>
  useOptimisticMutation({
    mutationKey: ["set-task-note", repo],
    mutationFn: (a: { taskId: string; body: string }) =>
      unwrap(commands.setTaskNote(repo, a.taskId, a.body)),
    optimistic: (qc, a) => {
      const key = queryKeys.taskNote(repo, a.taskId);
      const prev = qc.getQueryData<string | null>(key);
      qc.setQueryData(key, a.body.trim() === "" ? null : a.body);
      return () => qc.setQueryData(key, prev);
    },
    // Reconcile with what the backend actually stored (e.g. trimmed body) instead
    // of leaving the optimistic value to diverge until the next cold mount.
    invalidate: (a) => [queryKeys.taskNote(repo, a.taskId)],
  });

/** Run the Linear OAuth connect flow, refreshing status + orgs + tickets. */
export const useLinearConnect = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(commands.linearConnect()),
    onSuccess: (orgs) => {
      qc.invalidateQueries({ queryKey: queryKeys.linearStatusPrefix });
      qc.invalidateQueries({ queryKey: queryKeys.linearOrgs });
      qc.invalidateQueries({ queryKey: queryKeys.tasksPrefix });
      // Triage is Linear-derived too; refresh it (all repos) so a freshly
      // connected workspace's queue/schedule appears without the 3-min wait.
      qc.invalidateQueries({ queryKey: ["triage-tickets"] });
      qc.invalidateQueries({ queryKey: ["triage-schedule"] });
      // `connect` returns the full (name-sorted) org list, so we can't single out
      // the one just added — a generic confirmation avoids naming the wrong org.
      toast.success("Linear connected.", {
        title: orgs.length > 1 ? "Linear workspace added" : "Connected",
      });
    },
  });
};

/** Bind (or clear) the Linear org a repo uses. */
export const useSetRepoLinearOrg = () =>
  useOptimisticMutation({
    mutationKey: ["set-repo-linear-org"],
    mutationFn: (args: { repo: string; slug: string | null }) =>
      unwrap(commands.setRepoLinearOrg(args.repo, args.slug)),
    optimistic: (qc, args) => {
      // Reflect the new org binding in the status read so the picker updates at
      // once; full status (auth flags, names) reconciles on settle.
      const key = queryKeys.linearStatus(args.repo);
      const prev = qc.getQueryData<{ orgSlug: string | null }>(key);
      if (prev === undefined) return;
      qc.setQueryData(key, { ...prev, orgSlug: args.slug });
      return () => qc.setQueryData(key, prev);
    },
    invalidate: (args) => [
      queryKeys.linearStatusPrefix,
      queryKeys.tasksPrefix,
      queryKeys.triageTickets(args.repo),
      queryKeys.triageSchedule(args.repo),
    ],
  });

// Worktree data changes only on agent/git activity, so cache it briefly:
// switching away from a worktree and back serves instantly instead of refetching
// on every remount.
const WORKTREE_STALE_TIME = 60_000;

/** The repo's live agent worktrees (real git when the repo has a local path,
 *  else empty). */
export const useWorktrees = (repo: string) =>
  useUnwrappedQuery(queryKeys.worktrees(repo), () => commands.worktrees(repo), {
    enabled: !!repo,
    staleTime: WORKTREE_STALE_TIME,
  });

/** The repo's base branch as a worktree-like entry (repo root on main/master) —
 *  the Trees "main" entry. `null` when the repo has no local path. */
export const useBaseWorktree = (repo: string) =>
  useUnwrappedQuery(queryKeys.baseWorktree(repo), () => commands.baseWorktree(repo), {
    enabled: !!repo,
    staleTime: WORKTREE_STALE_TIME,
  });

/** A worktree's changed files (the commit-box model). `staleTime: 0` so every
 *  mount (e.g. returning to the Trees tab) refetches `git status` — the watcher
 *  keeps it live while visible, this covers the gap on re-entry. */
export const useWorktreeStatus = (repo: string, id: string) =>
  useUnwrappedQuery(queryKeys.worktreeStatus(repo, id), () => commands.worktreeStatus(repo, id), {
    enabled: !!repo && !!id,
    staleTime: 0,
  });

/** Every browsable file in the worktree (tracked + untracked, gitignore-aware). */
export const useWorktreeFiles = (repo: string, id: string) =>
  useUnwrappedQuery(queryKeys.worktreeFiles(repo, id), () => commands.worktreeFiles(repo, id), {
    enabled: !!repo && !!id,
    staleTime: WORKTREE_STALE_TIME,
  });

/** The unified diff for one changed file (staged + unstaged vs HEAD). Cached: the
 *  filesystem watcher invalidates it on real change, so re-clicking a file it
 *  already loaded shouldn't re-run `git diff`. `enabled` lets callers withhold
 *  the fetch until `untracked` is known for sure (e.g. while `useWorktreeStatus`
 *  is still loading) — firing early with a guessed `untracked=false` returns an
 *  empty diff for what's actually an untracked file, flashing "No changes". */
export const useWorktreeFileDiff = (
  repo: string,
  id: string,
  path: string,
  untracked: boolean,
  enabled = true,
) =>
  useUnwrappedQuery(
    queryKeys.worktreeFileDiff(repo, id, path),
    () => commands.worktreeFileDiff(repo, id, path, untracked),
    { enabled: enabled && !!repo && !!id && !!path, staleTime: WORKTREE_STALE_TIME },
  );

/** The old/new full file contents, for the diff viewer's context expansion.
 *  Cached like the diff (watcher-invalidated) so revisiting a file is instant. */
export const useWorktreeFileSource = (repo: string, id: string, path: string) =>
  useUnwrappedQuery(
    queryKeys.worktreeFileSource(repo, id, path),
    () => commands.worktreeFileSource(repo, id, path),
    { enabled: !!repo && !!id && !!path, staleTime: WORKTREE_STALE_TIME },
  );

/**
 * Keep the worktree views in sync with on-disk changes. Points the Rust
 * filesystem watcher at `repo`'s worktrees and, on each debounced
 * `worktreeChanged` event, invalidates that worktree's status/files/diffs *and*
 * the worktrees list (its `+/-` line stats) — so an agent editing files in the
 * terminal updates the Changes/All-files panes and the sidebar card with no
 * polling or refresh button.
 *
 * Mounted once at the app root (not in the Trees view) so invalidation happens
 * even while another tab is showing: returning to Trees then sees fresh data
 * instead of a stale cache.
 */
export const useWorktreeWatcher = (repo: string) => {
  const qc = useQueryClient();
  useEffect(() => {
    if (!repo) return;
    // Idempotent on the Rust side; re-points if the repo changed. The binding
    // resolves (never rejects) on failure, so surface a `Result` error
    // explicitly — otherwise a watcher that fails to start leaves every
    // live-update surface silently stale with nothing in santree.log to debug
    // from. `console.warn` is forwarded to the on-disk log by `forwardConsoleToLog`.
    commands.watchWorktrees(repo).then((r) => {
      if (r.status === "error") console.warn("watchWorktrees failed:", r.error);
    });

    const unlisten = events.worktreeChanged.listen(({ payload: { issueId } }) => {
      qc.invalidateQueries({ queryKey: queryKeys.worktreeStatus(repo, issueId) });
      qc.invalidateQueries({ queryKey: queryKeys.worktreeFiles(repo, issueId) });
      // Prefix key — every cached per-file diff for this worktree.
      qc.invalidateQueries({ queryKey: ["worktree-file-diff", repo, issueId] });
      // Prefix key — every cached full-file source for this worktree. DiffPane
      // pairs this with the diff above for the diff viewer's context expansion;
      // without it, an agent editing a file mid-view leaves expanded context
      // lines stale for up to `WORKTREE_STALE_TIME`.
      qc.invalidateQueries({ queryKey: ["worktree-file-source", repo, issueId] });
      // The list carries each worktree's add/del line counts, shown on the
      // sidebar card and the Issues-panel worktree card.
      qc.invalidateQueries({ queryKey: queryKeys.worktrees(repo) });
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [repo, qc]);
};

/** The PATH of the on-disk work prompt for a freshly-started worktree. The backend
 *  renders the `work` template from the *live* ticket, writes it to a file, and
 *  returns that file's path; the terminal seeds `claude 'Read <path> …'` (see
 *  {@link agentSessionSeed} callers). `enabled` gates the fetch to the launch flow;
 *  the terminal seed waits on this so the file exists before the agent starts.
 *  `staleTime: 0` so every fresh launch re-renders from current Linear state
 *  (new comments, edits) and overwrites the file. */
export const useWorkPrompt = (repo: string, id: string, enabled: boolean) =>
  useUnwrappedQuery(queryKeys.workPrompt(repo, id), () => commands.workPrompt(repo, id), {
    enabled: enabled && !!repo && !!id,
    staleTime: 0,
  });

/**
 * Resolve how a terminal that auto-launches `claude` should (re)launch it —
 * resume an on-disk session, start fresh with a reserved id, or a plain shell
 * (see {@link agentSessionSeed}). `allowFresh` mints a new session when none is
 * resumable (set on an explicit launch; `false` on a passive reopen, which then
 * only resumes or stays a shell).
 *
 * Callers should only `enable` this when there's no live PTY to attach to (a new
 * shell is about to be created), so the resume decision is always against current
 * on-disk state. A fresh launch caches forever (mint exactly once); a resume
 * re-checks each time it runs (the transcript may have appeared since).
 */
export const useAgentSession = (
  repo: string,
  termKey: string,
  cwd: string,
  allowFresh: boolean,
  enabled: boolean,
) =>
  useUnwrappedQuery(
    queryKeys.agentSession(repo, termKey, allowFresh),
    () => commands.agentSession(repo, termKey, cwd, allowFresh),
    {
      enabled: enabled && !!repo && !!termKey && !!cwd,
      staleTime: allowFresh ? Number.POSITIVE_INFINITY : 0,
    },
  );

/** Ticket ids of triage investigations that have a stored (resumable) session —
 *  i.e. one was started for them at some point. Drives the Triage view's tab +
 *  resume affordance for past investigations (across restarts), mirroring how a
 *  worktree row makes the Trees work terminal resumable. Cached briefly; a new
 *  investigation invalidates it, and it refetches on Triage revisit / focus. */
export const useStartedInvestigations = (repo: string) =>
  useUnwrappedQuery(
    queryKeys.startedInvestigations(repo),
    () => commands.startedInvestigations(repo),
    { enabled: !!repo, staleTime: 30_000 },
  );

/** Persisted extra main-area tabs (Claude / terminal) for the repo's worktrees,
 *  loaded once so they survive app restarts. Tabs only change through the
 *  mutations below (which invalidate), so the cache never goes stale on its own. */
export const useWorktreeTabs = (repo: string) =>
  useUnwrappedQuery(queryKeys.worktreeTabs(repo), () => commands.listWorktreeTabs(repo), {
    enabled: !!repo,
    staleTime: SETTING_STALE_TIME,
  });

/** Persist a new extra tab. The caller mints the id/title (see the Trees model),
 *  so the cache patch is the exact row the backend will store. */
export const useAddWorktreeTab = (repo: string) =>
  useOptimisticMutation<WorktreeTab, null>({
    mutationFn: (tab) =>
      unwrap(commands.addWorktreeTab(repo, tab.worktreeId, tab.id, tab.kind, tab.title)),
    optimistic: (qc, tab) => {
      const key = queryKeys.worktreeTabs(repo);
      const prev = qc.getQueryData<WorktreeTab[]>(key);
      qc.setQueryData<WorktreeTab[]>(key, (cur = []) => [...cur, tab]);
      return () => qc.setQueryData(key, prev);
    },
    invalidate: () => [queryKeys.worktreeTabs(repo)],
  });

/** Rename an extra tab (optimistic — the tab bar re-labels instantly). */
export const useRenameWorktreeTab = (repo: string) =>
  useOptimisticMutation<{ id: string; title: string }, null>({
    mutationFn: ({ id, title }) => unwrap(commands.renameWorktreeTab(repo, id, title)),
    optimistic: (qc, { id, title }) => {
      const key = queryKeys.worktreeTabs(repo);
      const prev = qc.getQueryData<WorktreeTab[]>(key);
      qc.setQueryData<WorktreeTab[]>(key, (cur = []) =>
        cur.map((t) => (t.id === id ? { ...t, title } : t)),
      );
      return () => qc.setQueryData(key, prev);
    },
    invalidate: () => [queryKeys.worktreeTabs(repo)],
  });

/** Remove an extra tab (optimistic); a Claude tab's stored session goes with it. */
export const useRemoveWorktreeTab = (repo: string) =>
  useOptimisticMutation<string, null>({
    mutationFn: (id) => unwrap(commands.removeWorktreeTab(repo, id)),
    optimistic: (qc, id) => {
      const key = queryKeys.worktreeTabs(repo);
      const prev = qc.getQueryData<WorktreeTab[]>(key);
      qc.setQueryData<WorktreeTab[]>(key, (cur = []) => cur.filter((t) => t.id !== id));
      return () => qc.setQueryData(key, prev);
    },
    invalidate: () => [queryKeys.worktreeTabs(repo)],
  });

/** Live PR status (number/url/state) for the repo's worktrees, from GitHub. Empty
 *  when `gh` isn't authenticated. Cached a minute — merge state changes server-side
 *  and the user can refetch by revisiting. */
export const useWorktreePrs = (repo: string) =>
  useUnwrappedQuery(queryKeys.worktreePrs(repo), () => commands.worktreePrs(repo), {
    enabled: !!repo,
    staleTime: 60_000,
  });

/** The Reviews dashboard inbox (my PRs / review requests / per-team), scoped to
 *  the org of the active repo. Empty when `gh` isn't authenticated. Cached a
 *  minute — PR state changes server-side and the user can refetch by revisiting. */
export const useReviews = (repo: string) =>
  useUnwrappedQuery(queryKeys.reviews(repo), () => commands.reviews(repo), {
    enabled: !!repo,
    staleTime: 60_000,
  });

/** The active repo's merge queue (its default branch's queue) — the ordered PRs
 *  waiting to merge, for the Reviews tab's merge-queue panel. `null` when GitHub
 *  isn't connected or the repo has no merge queue. Positions shift as PRs merge,
 *  so it's cached only briefly and refetches on revisit. */
export const useMergeQueue = (repo: string) =>
  useUnwrappedQuery(queryKeys.mergeQueue(repo), () => commands.mergeQueue(repo), {
    enabled: !!repo,
    staleTime: 20_000,
  });

/** Full detail (body + conversation + diff + checks) for one PR. Gated on a
 *  selection. While any CI check is still running we poll every 30s so the Checks
 *  tab goes live; once everything is terminal we stop and rely on the cache (no
 *  background churn). Nothing else here polls — reads refresh only when stale. */
export const usePrDetail = (owner: string, name: string, number: number, enabled = true) =>
  useUnwrappedQuery(
    queryKeys.prDetail(owner, name, number),
    () => commands.prDetail(owner, name, number),
    {
      enabled: enabled && !!owner && !!name && number > 0,
      refetchInterval: (query) =>
        (query.state.data?.checks ?? []).some((c) => c.status === "Pending") ? 30_000 : false,
    },
  );

/** The "open in app" targets (Finder, editors, terminals) for a worktree. */
export const useOpeners = () =>
  useQuery({
    queryKey: queryKeys.openers,
    queryFn: commands.listOpeners,
    staleTime: SETTING_STALE_TIME,
  });

/** Open a path in an external app (by opener key). */
export const useOpenInApp = () =>
  useMutation({
    mutationFn: (a: { path: string; opener: string }) =>
      unwrap(commands.openInApp(a.path, a.opener)),
  });

/**
 * Start a task: create a worktree for an issue, then refresh the list. The
 * immediate "Creating workspace…" feedback is owned by `pendingLaunches` in
 * AppContext (merged into the Trees list at display time) rather than a cache
 * patch — a patch here gets clobbered by the refetch the Trees mount triggers.
 */
export const useCreateWorktree = (repo: string) =>
  useActionMutation({
    mutationFn: (a: {
      issueId: string;
      title: string;
      project: string | null;
      base: string | null;
      agent: AgentKind;
      // Suppress the per-worktree toast — a bulk launch raises one summary toast
      // for the whole batch instead of N near-identical ones.
      quiet?: boolean;
    }) => unwrap(commands.createWorktree(repo, a.issueId, a.title, a.project, a.base, a.agent)),
    // Only the worktree list — NOT tasks. The graph relies on the `tasks` query
    // reference staying stable (re-firing fitView mid-rebuild blanks the canvas),
    // and a full graph refetch on every launch is heavy. The WIP badge already
    // signals "being worked on"; a moved Linear status refreshes on the next
    // natural tasks refetch.
    invalidate: () => [queryKeys.worktrees(repo)],
    success: (wt, a) => (a.quiet ? null : `Created worktree for ${wt.id}.`),
  });

/**
 * Remove a worktree (and its branch) — background + non-blocking. The Trees model
 * hides it instantly via `pendingDeletes` (NOT a cache patch, which a mid-delete
 * refetch from the filesystem watcher would clobber — re-adding the worktree with
 * garbage stats read off the half-deleted dir). On settle we reconcile with a
 * refetch; on failure the model drops it from `pendingDeletes` so it reappears,
 * and the error surfaces as a red toast.
 */
export const useRemoveWorktree = (repo: string) =>
  useOptimisticMutation({
    mutationKey: ["remove-worktree", repo],
    mutationFn: (issueId: string) => unwrap(commands.removeWorktree(repo, issueId)),
    // Tabs too: the backend drops the worktree's persisted extra tabs with it.
    invalidate: () => [
      queryKeys.worktrees(repo),
      queryKeys.worktreePrs(repo),
      queryKeys.worktreeTabs(repo),
    ],
  });

/** Remove several worktrees at once (e.g. all merged ones) — background, in
 *  parallel. Hiding/reappear is driven by the model's `pendingDeletes`. Throws
 *  (→ red toast) naming any that failed; the settling refetch reconciles. */
export const useRemoveWorktrees = (repo: string) =>
  useOptimisticMutation({
    mutationKey: ["remove-worktrees", repo],
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((id) => unwrap(commands.removeWorktree(repo, id))),
      );
      const failed = ids.filter((_, i) => results[i].status === "rejected");
      if (failed.length) throw new Error(`Couldn't delete ${failed.join(", ")}.`);
    },
    invalidate: () => [
      queryKeys.worktrees(repo),
      queryKeys.worktreePrs(repo),
      queryKeys.worktreeTabs(repo),
    ],
  });

/** Merge the base branch (main/master) into the worktree. Errors on conflicts. */
export const usePullWorktree = (repo: string) =>
  useActionMutation({
    mutationFn: (issueId: string) => unwrap(commands.pullWorktree(repo, issueId)),
    invalidate: (issueId) => [queryKeys.worktrees(repo), queryKeys.worktreeStatus(repo, issueId)],
    success: (base) => `Pulled ${base}.`,
  });

/** Push the worktree's branch to origin (sets upstream). The Trees "Push" button
 *  and the post-commit auto-push both use this. Refreshes the worktree list (its
 *  unpushed count) and PR badges. */
export const usePushWorktree = (repo: string) =>
  useActionMutation({
    mutationFn: (issueId: string) => unwrap(commands.pushWorktree(repo, issueId)),
    invalidate: () => [queryKeys.worktrees(repo), queryKeys.worktreePrs(repo)],
    success: () => "Pushed to origin.",
  });

/** Integrate origin/<branch> into the worktree's own branch — pulls commits added
 *  to the branch remotely (PR-UI suggestions, "Update branch", a teammate's push).
 *  Fast-forwards when possible, else merges; refuses up front (nothing touched)
 *  when the merge would conflict. */
export const usePullRemoteWorktree = (repo: string) =>
  useActionMutation({
    mutationFn: (issueId: string) => unwrap(commands.pullRemoteWorktree(repo, issueId)),
    invalidate: (issueId) => [queryKeys.worktrees(repo), queryKeys.worktreeStatus(repo, issueId)],
    success: () => "Pulled from origin.",
  });

/** Fast-forward the repo's local base branch (main/master) to origin. */
export const useUpdateBaseBranch = (repo: string) =>
  useActionMutation({
    mutationFn: (issueId: string) => unwrap(commands.updateBaseBranch(repo, issueId)),
    invalidate: () => [queryKeys.worktrees(repo)],
    success: (base) => `Updated ${base} from origin.`,
  });

/** Draft a commit message from the staged diff (headless `claude -p`). */
export const useCommitMessage = (repo: string) =>
  useMutation({
    mutationFn: (id: string) => unwrap(commands.commitMessage(repo, id)),
  });

/** Commit a worktree (optionally staging everything first). */
export const useCommitWorktree = (repo: string) =>
  useActionMutation({
    mutationFn: (a: { id: string; message: string; stageAll: boolean }) =>
      unwrap(commands.commitWorktree(repo, a.id, a.message, a.stageAll)),
    invalidate: (a) => [queryKeys.worktreeStatus(repo, a.id), queryKeys.worktrees(repo)],
    success: () => "Committed.",
  });

/** Draft a PR title + body for the create-PR dialog. `fill` runs the AI draft;
 *  otherwise it returns the raw PR template + first-commit-subject title. */
export const usePrDraft = (repo: string) =>
  useMutation({
    mutationFn: (a: { id: string; fill: boolean }) => unwrap(commands.prDraft(repo, a.id, a.fill)),
    // The dialog shows draft errors inline; don't double-surface as a toast.
    meta: { silent: true },
  });

/** Candidate reviewers (repo collaborators) for the create-PR dialog's picker.
 *  Empty when GitHub isn't connected. Cached a few minutes — collaborators rarely
 *  change within a session. */
export const usePrReviewers = (repo: string, id: string) =>
  useUnwrappedQuery(queryKeys.prReviewers(repo, id), () => commands.prReviewers(repo, id), {
    enabled: !!repo && !!id,
    staleTime: 5 * 60_000,
  });

/** Push the branch and open a PR via the GitHub API. The dialog handles success
 *  (opens the URL) and shows errors inline, so it's silent here. */
export const useCreatePr = (repo: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: {
      id: string;
      title: string;
      body: string;
      draft: boolean;
      reviewers: string[];
    }) => unwrap(commands.createPullRequest(repo, a.id, a.title, a.body, a.draft, a.reviewers)),
    meta: { silent: true },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.worktrees(repo) });
      // The graph/sidebar PR badges read worktreePrs — refresh it so a freshly
      // opened PR shows immediately instead of after its staleTime lapses.
      qc.invalidateQueries({ queryKey: queryKeys.worktreePrs(repo) });
    },
  });
};

/** Refresh a worktree's stored title (self-healing). Silent — it's a background
 *  reconcile triggered when the Issue tab sees a newer Linear title; invalidating
 *  the worktrees list updates the sidebar card. */
export const useSetWorktreeTitle = (repo: string) =>
  useActionMutation({
    mutationFn: (a: { id: string; title: string }) =>
      unwrap(commands.setWorktreeTitle(repo, a.id, a.title)),
    invalidate: () => [queryKeys.worktrees(repo)],
    silent: true,
  });

/** A worktree's persisted commit-message draft (survives tab switches / restarts
 *  until committed). `null` when none is saved. */
export const useCommitDraft = (repo: string, id: string) =>
  useUnwrappedQuery(queryKeys.commitDraft(repo, id), () => commands.commitDraft(repo, id), {
    enabled: !!repo && !!id,
    staleTime: SETTING_STALE_TIME,
  });

/** Save (or clear, when blank) a worktree's commit-message draft, optimistically. */
export const useSetCommitDraft = (repo: string) =>
  useOptimisticMutation({
    mutationKey: ["set-commit-draft", repo],
    mutationFn: (a: { id: string; message: string }) =>
      unwrap(commands.setCommitDraft(repo, a.id, a.message)),
    optimistic: (qc, a) => {
      const key = queryKeys.commitDraft(repo, a.id);
      const prev = qc.getQueryData<string | null>(key);
      qc.setQueryData(key, a.message.trim() === "" ? null : a.message);
      return () => qc.setQueryData(key, prev);
    },
    invalidate: (a) => [queryKeys.commitDraft(repo, a.id)],
  });

/** A staging action on one file (or all). One mutation, discriminated by `action`,
 *  so the commit box doesn't juggle five separate hooks. Refreshes the status +
 *  the affected file's diff afterward. */
export type StageAction = "stage" | "unstage" | "discard" | "stageAll" | "unstageAll";
interface StageVars {
  action: StageAction;
  path?: string;
  untracked?: boolean;
}

/** Apply a staging action to the cached file list so the checkbox/row updates
 *  before the git round-trip lands: flip `staged`, or drop a discarded file. */
export function applyStage(files: ChangedFile[], a: StageVars): ChangedFile[] {
  switch (a.action) {
    case "stage":
      return files.map((f) => (f.path === a.path ? { ...f, staged: true } : f));
    case "unstage":
      return files.map((f) => (f.path === a.path ? { ...f, staged: false } : f));
    case "discard":
      return files.filter((f) => f.path !== a.path);
    case "stageAll":
      return files.map((f) => ({ ...f, staged: true }));
    case "unstageAll":
      return files.map((f) => ({ ...f, staged: false }));
  }
}

export const useStageAction = (repo: string, id: string) =>
  useOptimisticMutation({
    // Rapid stage/unstage clicks on the same worktree all patch (and would
    // otherwise reconcile) the same `worktreeStatus` key — see #72.
    mutationKey: ["stage-action", repo, id],
    mutationFn: (a: StageVars) => {
      switch (a.action) {
        case "stage":
          return unwrap(commands.stagePath(repo, id, a.path ?? ""));
        case "unstage":
          return unwrap(commands.unstagePath(repo, id, a.path ?? ""));
        case "discard":
          return unwrap(commands.discardPath(repo, id, a.path ?? "", a.untracked ?? false));
        case "stageAll":
          return unwrap(commands.stageAllPaths(repo, id));
        case "unstageAll":
          return unwrap(commands.unstageAllPaths(repo, id));
      }
    },
    optimistic: (qc, a) => {
      const key = queryKeys.worktreeStatus(repo, id);
      const prev = qc.getQueryData<ChangedFile[]>(key);
      if (prev === undefined) return;
      qc.setQueryData<ChangedFile[]>(key, applyStage(prev, a));
      return () => qc.setQueryData(key, prev);
    },
    invalidate: (a) => {
      const keys: QueryKey[] = [queryKeys.worktreeStatus(repo, id)];
      // Prefix key — matches every cached per-file diff for this worktree.
      const diffPrefix = ["worktree-file-diff", repo, id] as const;
      switch (a.action) {
        case "stage":
        case "unstage":
          if (a.path) keys.push(queryKeys.worktreeFileDiff(repo, id, a.path));
          break;
        case "discard":
          // Discard reverts/removes the file on disk, so its diff, its full
          // source, and the file list can all change.
          keys.push(diffPrefix, queryKeys.worktreeFiles(repo, id));
          if (a.path) keys.push(queryKeys.worktreeFileSource(repo, id, a.path));
          break;
        case "stageAll":
        case "unstageAll":
          keys.push(diffPrefix);
          break;
      }
      return keys;
    },
  });

/**
 * The repo's `.santree/init.sh` setup script (content + executable bit), for the
 * Settings → Trees editor. Changes only on explicit writes, so it never needs a
 * background refetch.
 */
export const useInitScript = (repo: string) =>
  useUnwrappedQuery(queryKeys.initScript(repo), () => commands.worktreeInitScript(repo), {
    enabled: !!repo,
    staleTime: SETTING_STALE_TIME,
  });

/** Save the repo's setup script, optimistically patching the cached content. */
export const useSetInitScript = (repo: string) =>
  useOptimisticMutation({
    mutationKey: ["set-init-script", repo],
    mutationFn: (content: string) => unwrap(commands.setWorktreeInitScript(repo, content)),
    optimistic: (qc, content) => {
      const key = queryKeys.initScript(repo);
      const prev = qc.getQueryData<ScriptInfo>(key);
      if (prev) qc.setQueryData<ScriptInfo>(key, { ...prev, content, exists: true });
      return () => qc.setQueryData(key, prev);
    },
    invalidate: () => [queryKeys.initScript(repo)],
  });

/** Mark the repo's setup script executable; refreshes the script read. */
export const useMakeInitExecutable = (repo: string) =>
  useActionMutation({
    mutationFn: () => unwrap(commands.makeInitScriptExecutable(repo)),
    invalidate: () => [queryKeys.initScript(repo)],
    success: () => "Marked init.sh executable.",
  });

export interface ViewCounts {
  tasks: number;
  tasksReady: number;
  worktrees: number;
  worktreesRunning: number;
  /** Worktrees with an open PR — the Reviews count. */
  reviews: number;
}

/**
 * The per-tab counts shown in the nav tabs and the header summary. Centralized so
 * both surfaces report the same numbers (they previously re-derived these filters
 * independently and could drift). Backed by the shared task/worktree query cache,
 * so calling it from two places doesn't double-fetch.
 */
export const useViewCounts = (repo: string): ViewCounts => {
  const { data: tasks = [] } = useTasks(repo);
  const { data: worktrees = [] } = useWorktrees(repo);
  const { data: reviews } = useReviews(repo);
  // `Worktree.activity` from the backend is a constant (no session-signal source
  // yet — see `worktree.rs`'s `build_worktree`), so "running" is derived here from
  // an actual live PTY session instead, the same signal Trees uses for its own
  // activity dots.
  const { tabs: terminalTabs } = useTerminals();
  return useMemo(() => {
    const liveTermRefIds = new Set(
      terminalTabs.filter((t) => t.source === "issue").map((t) => t.refId),
    );
    return {
      tasks: tasks.length,
      tasksReady: tasks.filter((t) => t.ready).length,
      worktrees: worktrees.length,
      worktreesRunning: worktrees.filter((w) => liveTermRefIds.has(`tree:${w.id}`)).length,
      // The Reviews badge counts PRs awaiting *my* review (individual + team),
      // not my own authored PRs.
      reviews:
        (reviews?.requested.length ?? 0) +
        (reviews?.teams.reduce((n, t) => n + t.prs.length, 0) ?? 0),
    };
  }, [tasks, worktrees, reviews, terminalTabs]);
};

// Triage data (queue, issue detail, schedule) changes slowly, so cache it and
// serve it instantly when revisiting a ticket; refetch in the background only
// once it's older than STALE. Kept in memory well past that so navigating around
// the queue never re-fetches or re-shows skeletons. Mutations (status changes)
// invalidate explicitly, and the header's Refresh button forces a fetch on
// demand — so the stale window can be generous without data feeling outdated.
const TRIAGE_STALE_TIME = 3 * 60_000;
const TRIAGE_GC_TIME = 30 * 60_000;

/** The triage queue for a repo — live from Linear when connected, else empty. */
export const useTriageTickets = (repo: string) =>
  useUnwrappedQuery(queryKeys.triageTickets(repo), () => commands.listTriageTickets(repo), {
    enabled: !!repo,
    staleTime: TRIAGE_STALE_TIME,
    gcTime: TRIAGE_GC_TIME,
  });

/** The full triage issue (description + comments) for the discussion pane. */
export const useTriageDetail = (repo: string, id: string | null) =>
  useUnwrappedQuery(
    queryKeys.triageDetail(repo, id ?? ""),
    () => commands.triageDetail(repo, id ?? ""),
    {
      enabled: !!id,
      staleTime: TRIAGE_STALE_TIME,
      gcTime: TRIAGE_GC_TIME,
    },
  );

/** Warm the cache for a triage issue (call on hover so the click feels instant). */
export const useTriageDetailPrefetch = () => {
  const qc = useQueryClient();
  return useCallback(
    (repo: string, id: string) =>
      qc.prefetchQuery({
        queryKey: queryKeys.triageDetail(repo, id),
        queryFn: () => unwrap(commands.triageDetail(repo, id)),
        staleTime: TRIAGE_STALE_TIME,
        // Match the live read's retention so a hovered-but-unclicked prefetch
        // isn't GC'd at the 5-min default before the click.
        gcTime: TRIAGE_GC_TIME,
      }),
    [qc],
  );
};

/**
 * Force-refetch the active triage issue and the queue — backs the header's
 * Refresh button. `fetching` reflects whether either is in flight (for a spinner).
 */
export const useRefreshTriage = (repo: string, id: string | null) => {
  const qc = useQueryClient();
  const fetchingDetail = useIsFetching({ queryKey: queryKeys.triageDetail(repo, id ?? "") });
  const fetchingQueue = useIsFetching({ queryKey: queryKeys.triageTickets(repo) });
  const fetchingSchedule = useIsFetching({ queryKey: queryKeys.triageSchedule(repo) });
  const refresh = useCallback(() => {
    if (id) qc.invalidateQueries({ queryKey: queryKeys.triageDetail(repo, id) });
    qc.invalidateQueries({ queryKey: queryKeys.triageTickets(repo) });
    qc.invalidateQueries({ queryKey: queryKeys.triageSchedule(repo) });
  }, [qc, repo, id]);
  // Spin while any of the three refetches the button kicked off are in flight.
  return { refresh, fetching: fetchingDetail + fetchingQueue + fetchingSchedule > 0 };
};

/**
 * Move a triage issue to a different workflow state. On success the issue may
 * leave the triage queue (if moved out of the triage state), so we refetch the
 * queue and the issue detail.
 */
export const useTriageSetState = (repo: string) =>
  useOptimisticMutation({
    mutationKey: ["triage-set-state", repo],
    mutationFn: (args: { ticketId: string; stateId: string }) =>
      unwrap(commands.triageSetState(repo, args.ticketId, args.stateId)),
    optimistic: (qc, args) => {
      const detailKey = queryKeys.triageDetail(repo, args.ticketId);
      const queueKey = queryKeys.triageTickets(repo);
      const prevDetail = qc.getQueryData<TriageDetail>(detailKey);
      const prevQueue = qc.getQueryData<TriageTicket[]>(queueKey);

      // The target state's category (triage | backlog | …) comes from the
      // detail's own state list; moving out of `triage` promotes the item out
      // of the inbox, so we drop it from the queue.
      const target = prevDetail?.states.find((s) => s.id === args.stateId);
      const leavesQueue = target ? target.type !== "triage" : false;

      if (prevDetail) {
        qc.setQueryData<TriageDetail>(detailKey, {
          ...prevDetail,
          stateId: args.stateId,
          state: target?.name ?? prevDetail.state,
        });
      }
      if (prevQueue && leavesQueue) {
        qc.setQueryData<TriageTicket[]>(
          queueKey,
          prevQueue.filter((t) => t.id !== args.ticketId),
        );
      }

      if (prevDetail === undefined && prevQueue === undefined) return;
      return () => {
        if (prevDetail !== undefined) qc.setQueryData(detailKey, prevDetail);
        if (prevQueue !== undefined) qc.setQueryData(queueKey, prevQueue);
      };
    },
    invalidate: (args) => [
      queryKeys.triageTickets(repo),
      queryKeys.triageDetail(repo, args.ticketId),
    ],
  });

/**
 * Post a comment (or a reply, when `parentId` is set) on an issue. Optimistically
 * appends a pending comment to the cached detail so the thread updates instantly,
 * then reconciles with the real thread on settle. Backs every issue-discussion
 * surface (Triage, Issues, Trees, Reviews) since they all read `triageDetail`.
 */
export const useAddComment = (repo: string) =>
  useOptimisticMutation({
    mutationKey: ["triage-add-comment", repo],
    mutationFn: (args: { ticketId: string; parentId: string | null; body: string }) =>
      unwrap(commands.triageAddComment(repo, args.ticketId, args.parentId, args.body)),
    optimistic: (qc, args) => {
      const detailKey = queryKeys.triageDetail(repo, args.ticketId);
      const prev = qc.getQueryData<TriageDetail>(detailKey);
      if (!prev) return;

      // Author is unknown client-side (no viewer-identity query); "You" is a
      // placeholder that the settle-time refetch replaces with the real author.
      const pending: TriageComment = {
        id: `pending-${crypto.randomUUID()}`,
        author: "You",
        avatarUrl: null,
        createdAtMs: Date.now(),
        body: args.body,
        children: [],
      };

      const comments = args.parentId
        ? prev.comments.map((c) =>
            c.id === args.parentId ? { ...c, children: [...c.children, pending] } : c,
          )
        : [...prev.comments, pending];

      qc.setQueryData<TriageDetail>(detailKey, { ...prev, comments });
      return () => qc.setQueryData(detailKey, prev);
    },
    invalidate: (args) => [queryKeys.triageDetail(repo, args.ticketId)],
  });

/** The team triage rotations — one per team the viewer is on. */
export const useTriageSchedule = (repo: string) =>
  useUnwrappedQuery(queryKeys.triageSchedule(repo), () => commands.triageSchedule(repo), {
    enabled: !!repo,
    staleTime: TRIAGE_STALE_TIME,
    gcTime: TRIAGE_GC_TIME,
  });

/**
 * A hover handler that warms the triage-detail cache for the active repo, so the
 * subsequent click renders instantly (no skeleton flash). Centralizes the
 * `if (repo) prefetch(repo, id)` guard that the sidebar, graph, and queue rows
 * each repeated.
 */
export const usePrefetchOnHover = (repo: string) => {
  const prefetch = useTriageDetailPrefetch();
  return useCallback(
    (id: string) => {
      if (repo) prefetch(repo, id);
    },
    [prefetch, repo],
  );
};

export interface TriageQueue {
  /** The issues actually shown, after the mine / good-citizen / snoozed filters. */
  visible: TriageTicket[];
  /** Others' active issues sitting in the team inbox (for the empty-state nudge). */
  teamWaiting: number;
  goodCitizen: boolean;
  showSnoozed: boolean;
  onDuty: boolean;
}

/**
 * Pure mine/good-citizen/on-duty/snoozed filter matrix for the triage queue.
 * Extracted out of `useTriageQueue` so it's testable without mounting the
 * hook (no QueryClient / settings reads needed) — see queries.test.ts.
 */
export function filterTriageQueue(
  tickets: TriageTicket[],
  opts: { goodCitizen: boolean; showSnoozed: boolean; onDuty: boolean },
): Pick<TriageQueue, "visible" | "teamWaiting"> {
  const { goodCitizen, showSnoozed, onDuty } = opts;
  const mine = tickets.filter((t) => t.mine);
  const mineActive = mine.filter((t) => t.snoozedUntilMs == null);
  const showTeam = goodCitizen && (!onDuty || mineActive.length === 0);
  const base = showTeam ? tickets : mine;
  return {
    visible: showSnoozed ? base : base.filter((t) => t.snoozedUntilMs == null),
    teamWaiting: tickets.filter((t) => !t.mine && t.snoozedUntilMs == null).length,
  };
}

/**
 * The resolved triage queue for a repo — the single source of truth for what's
 * shown and the tab count. Defaults to the viewer's own issues; "be a good
 * citizen" widens to the team inbox when off-duty or your queue is empty.
 */
export const useTriageQueue = (repo: string): TriageQueue => {
  const { data: tickets = [] } = useTriageTickets(repo);
  const { data: schedules = [] } = useTriageSchedule(repo);
  const goodCitizen = useBoolSetting("app", TRIAGE_GOOD_CITIZEN_KEY).value;
  const showSnoozed = useBoolSetting("app", TRIAGE_SNOOZED_KEY).value;
  const onDuty = schedules.some((s) => s.currentIsMe);

  return useMemo(() => {
    const { visible, teamWaiting } = filterTriageQueue(tickets, {
      goodCitizen,
      showSnoozed,
      onDuty,
    });
    return { visible, teamWaiting, goodCitizen, showSnoozed, onDuty };
  }, [tickets, goodCitizen, showSnoozed, onDuty]);
};

/** The persisted user settings (seeded from defaults on first run). */
export const useSettings = () =>
  useUnwrappedQuery(queryKeys.settings, () => commands.getSettings(), {
    staleTime: SETTING_STALE_TIME,
  });

/**
 * Persist the full settings blob. Edits are applied optimistically (the
 * `["settings"]` cache is patched immediately, with rollback on failure) so the
 * UI stays snappy while the write goes to disk — settings now survive restarts.
 */
export const useSaveSettings = () =>
  useOptimisticMutation({
    mutationKey: ["save-settings"],
    mutationFn: (next: Settings) => unwrap(commands.setSettings(next)),
    optimistic: (qc, next) => {
      const prev = qc.getQueryData<Settings>(queryKeys.settings);
      qc.setQueryData(queryKeys.settings, next);
      return () => qc.setQueryData(queryKeys.settings, prev);
    },
    invalidate: () => [queryKeys.settings],
  });

/**
 * Claude slash-commands available to a scope. Pass `null` for the app scope
 * (global commands only); pass a repo name to also include that repo's own.
 */
export const useClaudeCommands = (repo: string | null) =>
  useUnwrappedQuery(queryKeys.claudeCommands(repo), () => commands.listClaudeCommands(repo));

/** A single setting value for an exact scope (`"app"` or `"repo:<name>"`). */
export const useSetting = (scope: string, key: string) =>
  useUnwrappedQuery(queryKeys.setting(scope, key), () => commands.getSetting(scope, key), {
    staleTime: SETTING_STALE_TIME,
  });

/** A repo-scoped setting resolved through its app-default fallback. */
export const useResolvedSetting = (repo: string, key: string) =>
  useUnwrappedQuery(
    queryKeys.resolvedSetting(repo, key),
    () => commands.resolveSetting(repo, key),
    {
      enabled: !!repo,
      staleTime: SETTING_STALE_TIME,
    },
  );

/** Read a repo-resolved boolean setting: the repo's override, else the app
 *  value (defaults to false until loaded). */
export const useResolvedBoolSetting = (repo: string, key: string) => {
  const q = useResolvedSetting(repo, key);
  return { value: q.data === "true", loading: q.isLoading };
};

interface SetSettingVars {
  scope: string;
  key: string;
  value: string | null;
}

/**
 * Optimistically patch the exact-scope read and any resolved-setting read for
 * the same key, so settings dropdowns reflect the new value before the write
 * lands. Returns the rollback. Shared by every setting writer (see
 * `useSetSetting` / `useDisplayNames`) so there's one optimistic write path.
 */
export function patchSettingCache(
  qc: QueryClient,
  { scope, key, value }: SetSettingVars,
): () => void {
  const settingKey = queryKeys.setting(scope, key);
  const prevSetting = qc.getQueryData(settingKey);
  qc.setQueryData(settingKey, value);

  // App-scoped writes are the default that resolved-setting reads fall back to;
  // patch any cached resolved entry for this key (across repos) to match.
  const prevResolved: [QueryKey, unknown][] = qc.getQueriesData({
    queryKey: ["resolved-setting"],
  });
  if (scope === "app") {
    for (const [k] of prevResolved) {
      if (k[2] === key) qc.setQueryData(k, value);
    }
  }

  return () => {
    qc.setQueryData(settingKey, prevSetting);
    for (const [k, v] of prevResolved) qc.setQueryData(k, v);
  };
}

/** Write (value) or clear (null) a setting; refreshes both reads and resolves. */
export const useSetSetting = () =>
  useOptimisticMutation({
    mutationKey: ["set-setting"],
    mutationFn: (a: SetSettingVars) => unwrap(commands.setSetting(a.scope, a.key, a.value)),
    optimistic: (qc, a) => patchSettingCache(qc, a),
    // Reconcile only this key's exact read; resolved reads (few, and a per-repo
    // override changes its resolved value) refetch via the prefix. Invalidating
    // the whole `["setting"]` prefix would refetch every cached setting on any
    // single write.
    invalidate: (a) => [queryKeys.setting(a.scope, a.key), ["resolved-setting"]],
  });

export type DisplayNames = "full" | "username";

/**
 * The global display-names preference and a setter. Changing it refetches every
 * Linear surface that renders a person's name (triage queue + detail/comments,
 * the on-call schedule, and blocker hover cards) so the new style applies at
 * once — names are resolved server-side, so the cached results must refresh.
 */
export const useDisplayNames = () => {
  const { data } = useSetting("app", DISPLAY_NAMES_KEY);
  const value: DisplayNames = data === "username" ? "username" : "full";
  // Built on the shared optimistic setting-write path; the only extra is that
  // every Linear surface resolves names server-side, so those reads must refetch
  // to pick up the new style.
  const { mutate } = useOptimisticMutation({
    mutationKey: ["set-display-names"],
    mutationFn: (v: DisplayNames) => unwrap(commands.setSetting("app", DISPLAY_NAMES_KEY, v)),
    optimistic: (qc, v) =>
      patchSettingCache(qc, { scope: "app", key: DISPLAY_NAMES_KEY, value: v }),
    invalidate: () => [
      queryKeys.setting("app", DISPLAY_NAMES_KEY),
      ["triage-tickets"],
      ["triage-detail"],
      ["triage-schedule"],
      // The Issues task graph (and its blocker hover cards) resolve names
      // server-side too; `tasksPrefix` matches every repo's graph.
      queryKeys.tasksPrefix,
    ],
  });
  return { value, setValue: mutate };
};
