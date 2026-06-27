/**
 * Typed data layer. Every backend read is a TanStack Query hook wrapping a
 * generated command from `bindings.ts`. Components never call `commands.*`
 * directly — they consume these hooks, so caching and loading states are
 * uniform and the data source (mocked today, real later) stays swappable.
 */
import {
  type QueryClient,
  type QueryKey,
  useIsFetching,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import type { AgentKind, Settings, TriageDetail, TriageTicket } from "../bindings";
import { commands } from "../bindings";
import { toast } from "../state/toast";

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
  options: { enabled?: boolean; staleTime?: number; gcTime?: number } = {},
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
function useOptimisticMutation<TVars, TData>(opts: {
  mutationFn: (v: TVars) => Promise<TData>;
  /** Patch the cache optimistically; return a rollback closure (or nothing). */
  optimistic?: (qc: QueryClient, v: TVars) => (() => void) | undefined;
  /** Keys to refetch on settle (and to cancel before patching). */
  invalidate?: (qc: QueryClient, v: TVars) => QueryKey[];
}) {
  const qc = useQueryClient();
  return useMutation<TData, Error, TVars, { rollback?: () => void }>({
    mutationFn: opts.mutationFn,
    onMutate: async (vars) => {
      const keys = opts.invalidate?.(qc, vars) ?? [];
      await Promise.all(keys.map((queryKey) => qc.cancelQueries({ queryKey })));
      const rollback = opts.optimistic?.(qc, vars) ?? undefined;
      return { rollback };
    },
    onError: (_err, _vars, ctx) => ctx?.rollback?.(),
    onSettled: (_data, _err, vars) => {
      for (const queryKey of opts.invalidate?.(qc, vars) ?? []) {
        qc.invalidateQueries({ queryKey });
      }
    },
  });
}

/** Setting reads change only on explicit writes (which invalidate them), so
 *  they never need a background refetch — newly-mounted consumers reuse cache. */
const SETTING_STALE_TIME = Number.POSITIVE_INFINITY;

export const queryKeys = {
  repos: ["repos"] as const,
  agents: ["agents"] as const,
  tasks: ["tasks"] as const,
  worktrees: ["worktrees"] as const,
  worktreeDiff: (id: string) => ["worktree-diff", id] as const,
  worktreeTerminal: (id: string) => ["worktree-terminal", id] as const,
  commitSuggestion: (id: string) => ["commit-suggestion", id] as const,
  fileTree: ["file-tree"] as const,
  stageMeta: ["stage-meta"] as const,
  taskNote: (repo: string, id: string) => ["task-note", repo, id] as const,
  triageTickets: (repo: string) => ["triage-tickets", repo] as const,
  triageDetail: (repo: string, id: string) => ["triage-detail", repo, id] as const,
  triageSchedule: (repo: string) => ["triage-schedule", repo] as const,
  settings: ["settings"] as const,
  claudeCommands: (repo: string | null) => ["claude-commands", repo] as const,
  setting: (scope: string, key: string) => ["setting", scope, key] as const,
  resolvedSetting: (repo: string, key: string) => ["resolved-setting", repo, key] as const,
  linearStatus: ["linear-status"] as const,
  linearOrgs: ["linear-orgs"] as const,
};

/** Setting keys for the Triage Investigation action (agent · skill · model). */
export const INVESTIGATE_AGENT_KEY = "investigate_agent";
export const INVESTIGATE_COMMAND_KEY = "investigate_command";
export const INVESTIGATE_MODEL_KEY = "investigate_model";

/** Setting keys for the Issues "Work" action (agent · model) used by the launch
 *  tray. Unlike triage, this action is always on — there's no enable switch. */
export const WORK_AGENT_KEY = "work_agent";
export const WORK_MODEL_KEY = "work_model";

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

/** Read an app-scoped boolean setting (defaults to false until loaded). */
export const useBoolSetting = (scope: string, key: string) => {
  const q = useSetting(scope, key);
  return { value: q.data === "true", loading: q.isLoading };
};

/** Linear connection status for a repo (which org it uses, if any). */
export const useLinearStatus = (repo: string) =>
  useUnwrappedQuery([...queryKeys.linearStatus, repo], () => commands.linearAuthStatus(repo), {
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
export const useAddRepo = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => unwrap(commands.addRepo(path)),
    onSuccess: (repo) => {
      qc.invalidateQueries({ queryKey: queryKeys.repos });
      toast.success(`Added ${repo.name}.`);
    },
  });
};

export const useAgents = () =>
  useQuery({ queryKey: queryKeys.agents, queryFn: commands.listAgents });

/** An agent harness's authentication / subscription status. */
export const useAgentAuth = (kind: AgentKind) =>
  useQuery({ queryKey: ["agent-auth", kind], queryFn: () => commands.agentAuth(kind) });

/**
 * Graph tickets for a repo. The backend returns the live Linear graph when an
 * org is connected and the built-in sample otherwise, so this is a single fetch
 * with no "is connected?" round-trip gating it (the old waterfall blocked the
 * graph behind a serial status read).
 */
export const useTasks = (repo: string) =>
  useUnwrappedQuery([...queryKeys.tasks, repo], () => commands.linearListIssues(repo));

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
    mutationFn: (a: { taskId: string; body: string }) =>
      unwrap(commands.setTaskNote(repo, a.taskId, a.body)),
    optimistic: (qc, a) => {
      const key = queryKeys.taskNote(repo, a.taskId);
      const prev = qc.getQueryData<string | null>(key);
      qc.setQueryData(key, a.body.trim() === "" ? null : a.body);
      return () => qc.setQueryData(key, prev);
    },
  });

/** Run the Linear OAuth connect flow, refreshing status + orgs + tickets. */
export const useLinearConnect = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(commands.linearConnect()),
    onSuccess: (orgs) => {
      qc.invalidateQueries({ queryKey: queryKeys.linearStatus });
      qc.invalidateQueries({ queryKey: queryKeys.linearOrgs });
      qc.invalidateQueries({ queryKey: queryKeys.tasks });
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
    mutationFn: (args: { repo: string; slug: string | null }) =>
      unwrap(commands.setRepoLinearOrg(args.repo, args.slug)),
    optimistic: (qc, args) => {
      // Reflect the new org binding in the status read so the picker updates at
      // once; full status (auth flags, names) reconciles on settle.
      const key = [...queryKeys.linearStatus, args.repo];
      const prev = qc.getQueryData<{ orgSlug: string | null }>(key);
      if (prev === undefined) return;
      qc.setQueryData(key, { ...prev, orgSlug: args.slug });
      return () => qc.setQueryData(key, prev);
    },
    invalidate: () => [queryKeys.linearStatus, queryKeys.tasks],
  });

// Worktree data changes only on agent activity, so cache it briefly: switching
// away from a worktree's diff/terminal and back serves instantly instead of
// refetching on every remount. (stageMeta is static config, so it never goes stale.)
const WORKTREE_STALE_TIME = 60_000;

export const useWorktrees = () =>
  useQuery({
    queryKey: queryKeys.worktrees,
    queryFn: commands.listWorktrees,
    staleTime: WORKTREE_STALE_TIME,
  });

export const useWorktreeDiff = (id: string) =>
  useQuery({
    queryKey: queryKeys.worktreeDiff(id),
    queryFn: () => commands.worktreeDiff(id),
    staleTime: WORKTREE_STALE_TIME,
  });

export const useWorktreeTerminal = (id: string) =>
  useQuery({
    queryKey: queryKeys.worktreeTerminal(id),
    queryFn: () => commands.worktreeTerminal(id),
    staleTime: WORKTREE_STALE_TIME,
  });

export const useCommitSuggestion = (id: string) =>
  useQuery({
    queryKey: queryKeys.commitSuggestion(id),
    queryFn: () => commands.commitSuggestion(id),
    staleTime: WORKTREE_STALE_TIME,
  });

export const useFileTree = () =>
  useQuery({
    queryKey: queryKeys.fileTree,
    queryFn: commands.fileTree,
    staleTime: WORKTREE_STALE_TIME,
  });

export const useStageMeta = () =>
  useQuery({
    queryKey: queryKeys.stageMeta,
    queryFn: commands.stageMeta,
    staleTime: SETTING_STALE_TIME,
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
  const { data: worktrees = [] } = useWorktrees();
  return useMemo(
    () => ({
      tasks: tasks.length,
      tasksReady: tasks.filter((t) => t.ready).length,
      worktrees: worktrees.length,
      worktreesRunning: worktrees.filter((w) => w.activity === "Running").length,
      reviews: worktrees.filter((w) => w.pr).length,
    }),
    [tasks, worktrees],
  );
};

// Triage data (queue, issue detail, schedule) changes slowly, so cache it and
// serve it instantly when revisiting a ticket; refetch in the background only
// once it's older than STALE. Kept in memory well past that so navigating around
// the queue never re-fetches or re-shows skeletons. Mutations (status changes)
// invalidate explicitly, and the header's Refresh button forces a fetch on
// demand — so the stale window can be generous without data feeling outdated.
const TRIAGE_STALE_TIME = 3 * 60_000;
const TRIAGE_GC_TIME = 30 * 60_000;

/** The triage queue for a repo — live from Linear when connected, else sample. */
export const useTriageTickets = (repo: string) =>
  useUnwrappedQuery(queryKeys.triageTickets(repo), () => commands.listTriageTickets(repo), {
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
    invalidate: (_qc, args) => [
      queryKeys.triageTickets(repo),
      queryKeys.triageDetail(repo, args.ticketId),
    ],
  });

/** The team triage rotations — one per team the viewer is on. */
export const useTriageSchedule = (repo: string) =>
  useQuery({
    queryKey: queryKeys.triageSchedule(repo),
    queryFn: () => unwrap(commands.triageSchedule(repo)),
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
    const mine = tickets.filter((t) => t.mine);
    const mineActive = mine.filter((t) => !t.snoozedUntil);
    const showTeam = goodCitizen && (!onDuty || mineActive.length === 0);
    const base = showTeam ? tickets : mine;
    return {
      visible: showSnoozed ? base : base.filter((t) => !t.snoozedUntil),
      teamWaiting: tickets.filter((t) => !t.mine && !t.snoozedUntil).length,
      goodCitizen,
      showSnoozed,
      onDuty,
    };
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
    mutationFn: (next: Settings) => unwrap(commands.setSettings(next)),
    optimistic: (qc, next) => {
      const prev = qc.getQueryData<Settings>(queryKeys.settings);
      qc.setQueryData(queryKeys.settings, next);
      return () => qc.setQueryData(queryKeys.settings, prev);
    },
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
function patchSettingCache(qc: QueryClient, { scope, key, value }: SetSettingVars): () => void {
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
    mutationFn: (a: SetSettingVars) => unwrap(commands.setSetting(a.scope, a.key, a.value)),
    optimistic: (qc, a) => patchSettingCache(qc, a),
    invalidate: () => [["setting"], ["resolved-setting"]],
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
    mutationFn: (v: DisplayNames) => unwrap(commands.setSetting("app", DISPLAY_NAMES_KEY, v)),
    optimistic: (qc, v) =>
      patchSettingCache(qc, { scope: "app", key: DISPLAY_NAMES_KEY, value: v }),
    invalidate: () => [
      queryKeys.setting("app", DISPLAY_NAMES_KEY),
      ["triage-tickets"],
      ["triage-detail"],
      ["triage-schedule"],
      ["issue-ref"],
    ],
  });
  return { value, setValue: mutate };
};
