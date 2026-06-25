/**
 * Typed data layer. Every backend read is a TanStack Query hook wrapping a
 * generated command from `bindings.ts`. Components never call `commands.*`
 * directly — they consume these hooks, so caching and loading states are
 * uniform and the data source (mocked today, real later) stays swappable.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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
  triageTickets: ["triage-tickets"] as const,
  triageThread: (id: string) => ["triage-thread", id] as const,
  settings: ["settings"] as const,
  linearStatus: ["linear-status"] as const,
  linearOrgs: ["linear-orgs"] as const,
};

/** Linear connection status for a repo (which org it uses, if any). */
export const useLinearStatus = (repo: string) =>
  useQuery({
    queryKey: [...queryKeys.linearStatus, repo],
    queryFn: () => unwrap(commands.linearAuthStatus(repo)),
  });

/** Every connected Linear org. */
export const useLinearOrgs = () =>
  useQuery({ queryKey: queryKeys.linearOrgs, queryFn: () => unwrap(commands.linearOrgs()) });

export const useRepos = () => useQuery({ queryKey: queryKeys.repos, queryFn: commands.listRepos });

export const useAgents = () =>
  useQuery({ queryKey: queryKeys.agents, queryFn: commands.listAgents });

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

export const useTriageTickets = () =>
  useQuery({ queryKey: queryKeys.triageTickets, queryFn: commands.listTriageTickets });

export const useTriageThread = (id: string) =>
  useQuery({
    queryKey: queryKeys.triageThread(id),
    queryFn: () => commands.triageThread(id),
  });

export const useSettings = () =>
  useQuery({ queryKey: queryKeys.settings, queryFn: commands.getSettings });

/** Ask the triage agent a free-text question; returns its answer. */
export const useTriageAsk = () =>
  useMutation({ mutationFn: (question: string) => commands.triageAsk(question) });
