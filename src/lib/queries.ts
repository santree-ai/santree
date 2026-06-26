/**
 * Typed data layer. Every backend read is a TanStack Query hook wrapping a
 * generated command from `bindings.ts`. Components never call `commands.*`
 * directly — they consume these hooks, so caching and loading states are
 * uniform and the data source (mocked today, real later) stays swappable.
 */
import { useIsFetching, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import type { AgentKind } from "../bindings";
import { commands } from "../bindings";

/** Unwrap a generated `Result` command into a value-or-throw promise. */
async function unwrap<T>(
  promise: Promise<{ status: "ok"; data: T } | { status: "error"; error: string }>,
): Promise<T> {
  const result = await promise;
  if (result.status === "error") throw new Error(result.error);
  return result.data;
}

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
  triageTickets: (repo: string) => ["triage-tickets", repo] as const,
  triageDetail: (repo: string, id: string) => ["triage-detail", repo, id] as const,
  triageSchedule: (repo: string) => ["triage-schedule", repo] as const,
  triageThread: (id: string) => ["triage-thread", id] as const,
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

/** Linear connection status for a repo (which org it uses, if any). */
export const useLinearStatus = (repo: string) =>
  useQuery({
    queryKey: [...queryKeys.linearStatus, repo],
    queryFn: () => unwrap(commands.linearAuthStatus(repo)),
  });

/** Every connected Linear org. */
export const useLinearOrgs = () =>
  useQuery({ queryKey: queryKeys.linearOrgs, queryFn: () => unwrap(commands.linearOrgs()) });

export const useRepos = () =>
  useQuery({ queryKey: queryKeys.repos, queryFn: () => unwrap(commands.listRepos()) });

/** Register a repository from a local folder (validated as a git repo in Rust). */
export const useAddRepo = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => unwrap(commands.addRepo(path)),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.repos }),
  });
};

export const useAgents = () =>
  useQuery({ queryKey: queryKeys.agents, queryFn: commands.listAgents });

/** An agent harness's authentication / subscription status. */
export const useAgentAuth = (kind: AgentKind) =>
  useQuery({ queryKey: ["agent-auth", kind], queryFn: () => commands.agentAuth(kind) });

/**
 * Graph tickets for a repo. When a Linear org is connected they come from the
 * live account; otherwise we fall back to the built-in mock so the UI is never
 * empty. The cache key includes repo + source so changes refetch.
 */
export const useTasks = (repo: string) => {
  const { data: status } = useLinearStatus(repo);
  const useLinear = !!status?.authenticated;
  return useQuery({
    queryKey: [...queryKeys.tasks, repo, useLinear ? "linear" : "mock"],
    queryFn: () => (useLinear ? unwrap(commands.linearListIssues(repo)) : commands.listTasks()),
    enabled: status !== undefined,
  });
};

/** Run the Linear OAuth connect flow, refreshing status + orgs + tickets. */
export const useLinearConnect = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(commands.linearConnect()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.linearStatus });
      qc.invalidateQueries({ queryKey: queryKeys.linearOrgs });
      qc.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
};

/** Bind (or clear) the Linear org a repo uses. */
export const useSetRepoLinearOrg = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { repo: string; slug: string | null }) =>
      unwrap(commands.setRepoLinearOrg(args.repo, args.slug)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.linearStatus });
      qc.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
};

export const useWorktrees = () =>
  useQuery({ queryKey: queryKeys.worktrees, queryFn: commands.listWorktrees });

export const useWorktreeDiff = (id: string) =>
  useQuery({
    queryKey: queryKeys.worktreeDiff(id),
    queryFn: () => commands.worktreeDiff(id),
  });

export const useWorktreeTerminal = (id: string) =>
  useQuery({
    queryKey: queryKeys.worktreeTerminal(id),
    queryFn: () => commands.worktreeTerminal(id),
  });

export const useCommitSuggestion = (id: string) =>
  useQuery({
    queryKey: queryKeys.commitSuggestion(id),
    queryFn: () => commands.commitSuggestion(id),
  });

export const useFileTree = () =>
  useQuery({ queryKey: queryKeys.fileTree, queryFn: commands.fileTree });

export const useStageMeta = () =>
  useQuery({ queryKey: queryKeys.stageMeta, queryFn: commands.stageMeta });

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
  useQuery({
    queryKey: queryKeys.triageTickets(repo),
    queryFn: () => unwrap(commands.listTriageTickets(repo)),
    staleTime: TRIAGE_STALE_TIME,
    gcTime: TRIAGE_GC_TIME,
  });

/** The full triage issue (description + comments) for the discussion pane. */
export const useTriageDetail = (repo: string, id: string | null) =>
  useQuery({
    queryKey: queryKeys.triageDetail(repo, id ?? ""),
    queryFn: () => unwrap(commands.triageDetail(repo, id ?? "")),
    enabled: !!id,
    staleTime: TRIAGE_STALE_TIME,
    gcTime: TRIAGE_GC_TIME,
  });

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
  const refresh = useCallback(() => {
    if (id) qc.invalidateQueries({ queryKey: queryKeys.triageDetail(repo, id) });
    qc.invalidateQueries({ queryKey: queryKeys.triageTickets(repo) });
    qc.invalidateQueries({ queryKey: queryKeys.triageSchedule(repo) });
  }, [qc, repo, id]);
  return { refresh, fetching: fetchingDetail + fetchingQueue > 0 };
};

/**
 * Move a triage issue to a different workflow state. On success the issue may
 * leave the triage queue (if moved out of the triage state), so we refetch the
 * queue and the issue detail.
 */
export const useTriageSetState = (repo: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { ticketId: string; stateId: string }) =>
      unwrap(commands.triageSetState(repo, args.ticketId, args.stateId)),
    onSuccess: (_data, args) => {
      qc.invalidateQueries({ queryKey: queryKeys.triageTickets(repo) });
      qc.invalidateQueries({ queryKey: queryKeys.triageDetail(repo, args.ticketId) });
    },
  });
};

/** The team triage rotations — one per team the viewer is on. */
export const useTriageSchedule = (repo: string) =>
  useQuery({
    queryKey: queryKeys.triageSchedule(repo),
    queryFn: () => unwrap(commands.triageSchedule(repo)),
    staleTime: TRIAGE_STALE_TIME,
    gcTime: TRIAGE_GC_TIME,
  });

export const useTriageThread = (id: string) =>
  useQuery({
    queryKey: queryKeys.triageThread(id),
    queryFn: () => commands.triageThread(id),
  });

export const useSettings = () =>
  useQuery({ queryKey: queryKeys.settings, queryFn: commands.getSettings });

/**
 * Claude slash-commands available to a scope. Pass `null` for the app scope
 * (global commands only); pass a repo name to also include that repo's own.
 */
export const useClaudeCommands = (repo: string | null) =>
  useQuery({
    queryKey: queryKeys.claudeCommands(repo),
    queryFn: () => unwrap(commands.listClaudeCommands(repo)),
  });

/** A single setting value for an exact scope (`"app"` or `"repo:<name>"`). */
export const useSetting = (scope: string, key: string) =>
  useQuery({
    queryKey: queryKeys.setting(scope, key),
    queryFn: () => unwrap(commands.getSetting(scope, key)),
  });

/** A repo-scoped setting resolved through its app-default fallback. */
export const useResolvedSetting = (repo: string, key: string) =>
  useQuery({
    queryKey: queryKeys.resolvedSetting(repo, key),
    queryFn: () => unwrap(commands.resolveSetting(repo, key)),
    enabled: !!repo,
  });

/** Write (value) or clear (null) a setting; refreshes both reads and resolves. */
export const useSetSetting = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { scope: string; key: string; value: string | null }) =>
      unwrap(commands.setSetting(a.scope, a.key, a.value)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["setting"] });
      qc.invalidateQueries({ queryKey: ["resolved-setting"] });
    },
  });
};

/** Ask the triage agent a free-text question; returns its answer. */
export const useTriageAsk = () =>
  useMutation({ mutationFn: (question: string) => commands.triageAsk(question) });
