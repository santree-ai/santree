/**
 * Typed data layer. Every backend read is a TanStack Query hook wrapping a
 * generated command from `bindings.ts`. Components never call `commands.*`
 * directly — they consume these hooks, so caching and loading states are
 * uniform and the live/empty data source stays swappable.
 *
 * **This file is deliberately not split by feature.** It is long, and splitting it
 * into `lib/queries/<domain>.ts` has been proposed and rejected: the one property
 * worth more than the line count is that "what does this app read, and what
 * invalidates it?" is answerable by opening a single file, with a single key
 * factory and a single optimistic-update primitive. Data layers that fan out per
 * feature lose exactly that — they grow parallel caches, competing optimistic
 * conventions, and inline keys that no factory knows about. Navigate by the
 * section banners below, and add a new hook to the section it belongs to.
 */
import {
  keepPreviousData,
  type QueryClient,
  type QueryKey,
  type UseQueryOptions,
  useIsFetching,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AgentKind,
  AnalysisScope,
  ChangedFile,
  ClaudeGlobalCapture,
  KeepAwakeStatus,
  NewInlineComment,
  PrDetail,
  PrLabel,
  PromptInfo,
  PromptWorkItemSample,
  Repo,
  ReviewCheckout,
  ReviewDraft,
  ReviewEvent,
  ReviewInbox,
  ReviewPr,
  ReviewPublishOutcome,
  ReviewTarget,
  ReviewWorkItem,
  ReviewWorkItemSource,
  ScriptInfo,
  Settings,
  TicketRef,
  TriageComment,
  TriageDetail,
  TriageSession,
  TriageTicket,
  UpdateProgress,
  ViewedMarks,
  Worktree,
  WorktreeLaunch,
  WorktreeSession,
  WorktreeTab,
} from "../bindings";
import { commands, events } from "../bindings";
import { type ToastOptions, toast } from "../state/toast";
import { splitRepoSlug } from "./repo";

// ── Shared primitives ────────────────────────────────────────────────────────
// The machinery every hook below is built from: unwrapping a generated `Result`
// command, the two mutation wrappers, and the one cache policy they all share.

/** The shape of a generated `Result`-typed command's promise. */
type CommandResult<T> = Promise<{ status: "ok"; data: T } | { status: "error"; error: string }>;

/** Unwrap a generated `Result` command into a value-or-throw promise. Exported for
 *  the rare multi-step imperative orchestration (e.g. Reviews "Fix CI with AI")
 *  that chains several commands rather than fitting one read/mutation hook. */
export async function unwrap<T>(promise: CommandResult<T>): Promise<T> {
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
    // Keep the last successful data visible while the next fetch is in flight —
    // e.g. `keepPreviousData` so a re-keyed read doesn't flash empty.
    placeholderData?: UseQueryOptions<T>["placeholderData"];
    // `{ silent: true }` opts out of the global query-error→toast handler (see
    // `main.tsx`), for a read that renders its own failure UI.
    meta?: UseQueryOptions<T>["meta"];
  } = {},
) {
  return useQuery({ queryKey, queryFn: () => unwrap(command()), ...options });
}

/**
 * Vars whose settle-time invalidation was deferred because a sibling mutation
 * with the same `mutationKey` was still in flight. `invalidate` is a function
 * *of the vars*, so the last settler only knows its own keys — it has to replay
 * the skipped ones too (discard `a.ts`, then stage `b.ts`, and `a.ts`'s diff
 * cache would otherwise never be invalidated). Keyed by the serialized
 * mutationKey, not held in a ref, because the same key can be mounted by more
 * than one hook instance and any of them may be the one that settles last.
 */
const deferredSettles = new Map<string, unknown[]>();

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
  /** Serialize against every other mutation sharing this id — see
   *  {@link gitIndexScope}. The optimistic patch still lands immediately (React
   *  Query runs `onMutate` before the scope gate); only `mutationFn` queues. */
  scope?: { id: string };
}) {
  const qc = useQueryClient();
  return useMutation<TData, Error, TVars, { rollback?: () => void }>({
    mutationKey: opts.mutationKey,
    scope: opts.scope,
    mutationFn: opts.mutationFn,
    onMutate: async (vars) => {
      const keys = opts.invalidate?.(vars) ?? [];
      await Promise.all(keys.map((queryKey) => qc.cancelQueries({ queryKey })));
      const rollback = opts.optimistic?.(qc, vars) ?? undefined;
      return { rollback };
    },
    onError: (_err, _vars, ctx) => {
      // Rollback is a snapshot-restore, and our snapshot predates a *sibling*
      // call's patch as much as our own — restoring it while that sibling is
      // still in flight would undo the user's second click. Leave the cache to
      // the settle-time refetch (deferred to whoever settles last, which
      // replays our keys too); the failure still red-toasts. `isMutating` counts
      // this call itself here, same as in `onSettled`.
      if (opts.mutationKey && qc.isMutating({ mutationKey: opts.mutationKey }) > 1) return;
      ctx?.rollback?.();
    },
    onSettled: (_data, _err, vars) => {
      const siblingKey = opts.mutationKey ? JSON.stringify(opts.mutationKey) : null;
      // A sibling mutation sharing this key is still running — it will
      // reconcile when *it* settles, last-write-wins. `isMutating` still
      // counts this call itself (its status flips to settled only after this
      // callback returns), so `> 1` means "someone else is still in flight".
      // Park our vars for that final settler to replay.
      if (siblingKey && qc.isMutating({ mutationKey: opts.mutationKey }) > 1) {
        deferredSettles.set(siblingKey, [...(deferredSettles.get(siblingKey) ?? []), vars]);
        return;
      }
      const deferred = (siblingKey ? deferredSettles.get(siblingKey) : undefined) as
        | TVars[]
        | undefined;
      if (siblingKey) deferredSettles.delete(siblingKey);

      const seen = new Set<string>();
      for (const v of [...(deferred ?? []), vars]) {
        for (const queryKey of opts.invalidate?.(v) ?? []) {
          const id = JSON.stringify(queryKey);
          if (seen.has(id)) continue;
          seen.add(id);
          qc.invalidateQueries({ queryKey });
        }
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
  /** Serialize against every other mutation sharing this id — see
   *  {@link gitIndexScope}. */
  scope?: { id: string };
}) {
  const qc = useQueryClient();
  return useMutation<TData, Error, TVars>({
    mutationFn: opts.mutationFn,
    scope: opts.scope,
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

// ── Query keys ───────────────────────────────────────────────────────────────
// The cache's index. Every key this app caches under is minted here, so "what
// invalidates what" is answerable by reading one object.

export const queryKeys = {
  appVersion: ["app-version"] as const,
  keepAwake: ["keep-awake"] as const,
  envFileVars: (path: string) => ["env-file-vars", path] as const,
  repos: ["repos"] as const,
  agents: ["agents"] as const,
  claudeModels: ["claude-models"] as const,
  agentAuth: (kind: AgentKind) => ["agent-auth", kind] as const,
  agentVersionStatus: (kind: AgentKind) => ["agent-version-status", kind] as const,
  codexHealth: ["codex-health"] as const,
  codexAccount: ["codex-account"] as const,
  codexModels: ["codex-models"] as const,
  codexRateLimits: ["codex-rate-limits"] as const,
  githubStatus: ["github-status"] as const,
  githubApiBudget: ["github-api-budget"] as const,
  binaryStatus: (name: string) => ["binary-status", name] as const,
  claudeHookSettings: ["claude-hook-settings"] as const,
  codexHookFlags: ["codex-hook-flags"] as const,
  claudeHookSettingsNoGit: ["claude-hook-settings-no-git"] as const,
  englishLog: ["english-log"] as const,
  englishAnalysis: ["english-analysis"] as const,
  sessionStates: ["session-states"] as const,
  agentProcesses: ["agent-processes"] as const,
  claudeRateLimits: ["claude-rate-limits"] as const,
  claudeAccountUsage: ["claude-account-usage"] as const,
  claudeGlobalCapture: ["claude-global-capture"] as const,
  resourceUsage: ["resource-usage"] as const,
  terminalSessions: ["terminal-sessions"] as const,
  sessionUsageLive: ["session-usage-live"] as const,
  /** Prefix for every repo's task graph — invalidate this (not `tasks(repo)`)
   *  when a change (e.g. a fresh Linear connection) should refetch all repos'
   *  graphs at once. */
  tasksPrefix: ["tasks"] as const,
  tasks: (repo: string) => ["tasks", repo] as const,
  worktrees: (repo: string) => ["worktrees", repo] as const,
  repoBranches: (repo: string) => ["repo-branches", repo] as const,
  baseWorktree: (repo: string) => ["base-worktree", repo] as const,
  worktreeStatus: (repo: string, id: string) => ["worktree-status", repo, id] as const,
  worktreeFiles: (repo: string, id: string) => ["worktree-files", repo, id] as const,
  worktreeFileDiff: (repo: string, id: string, path: string) =>
    ["worktree-file-diff", repo, id, path] as const,
  /** Prefix for every cached per-file diff of one worktree. */
  worktreeFileDiffPrefix: (repo: string, id: string) => ["worktree-file-diff", repo, id] as const,
  worktreeBranchChanges: (repo: string, id: string) =>
    ["worktree-branch-changes", repo, id] as const,
  worktreeBranchFileDiff: (repo: string, id: string, path: string) =>
    ["worktree-branch-file-diff", repo, id, path] as const,
  worktreeBranchFileDiffPrefix: (repo: string, id: string) =>
    ["worktree-branch-file-diff", repo, id] as const,
  worktreeSessions: (repo: string, id: string) => ["worktree-sessions", repo, id] as const,
  worktreeSessionDetail: (repo: string, id: string, sessionId: string) =>
    ["worktree-session-detail", repo, id, sessionId] as const,
  worktreeSessionSubagents: (repo: string, id: string, sessionId: string) =>
    ["worktree-session-subagents", repo, id, sessionId] as const,
  worktreeFileSource: (repo: string, id: string, path: string) =>
    ["worktree-file-source", repo, id, path] as const,
  /** Prefix for every cached full-file source of one worktree. */
  worktreeFileSourcePrefix: (repo: string, id: string) =>
    ["worktree-file-source", repo, id] as const,
  workPrompt: (repo: string, id: string) => ["work-prompt", repo, id] as const,
  investigatePrompt: (repo: string, id: string) => ["investigate-prompt", repo, id] as const,
  agentSession: (repo: string, termKey: string, agent: AgentKind, allowFresh: boolean) =>
    ["agent-session", repo, termKey, agent, allowFresh] as const,
  /** Both `allowFresh` variants of one terminal's session resolution — what a
   *  launch/exit drops, since either may hold a decision that's now stale. */
  agentSessionPrefix: (repo: string, termKey: string, agent?: AgentKind) =>
    agent
      ? (["agent-session", repo, termKey, agent] as const)
      : (["agent-session", repo, termKey] as const),
  startedInvestigations: (repo: string) => ["started-investigations", repo] as const,
  sessionProviders: (repo: string, termKey: string) =>
    ["session-providers", repo, termKey] as const,
  worktreeTabs: (repo: string) => ["worktree-tabs", repo] as const,
  worktreeTabLaunch: (repo: string, id: string) => ["worktree-tab-launch", repo, id] as const,
  worktreeTabLaunchPrefix: ["worktree-tab-launch"] as const,
  commitDraft: (repo: string, id: string) => ["commit-draft", repo, id] as const,
  worktreePrs: (repo: string) => ["worktree-prs", repo] as const,
  prReviewers: (repo: string, id: string) => ["pr-reviewers", repo, id] as const,
  worktreeHasTranscripts: (repo: string, id: string) =>
    ["worktree-has-transcripts", repo, id] as const,
  reviews: () => ["reviews"] as const,
  githubViewer: () => ["github-viewer"] as const,
  prTickets: (repo: string, ids: string[]) => ["pr-tickets", repo, ids] as const,
  /** Keyed on the head SHA: a PR that gains commits needs a fresh checkout, not
   *  the one an agent already read. */
  reviewWorkspace: (repo: string, prRepo: string, number: number, headSha: string) =>
    ["review-workspace", repo, prRepo, number, headSha] as const,
  /** Not keyed on the head SHA, unlike the checkout's *creation*: this read asks
   *  which commit the checkout is actually at, so keying it on the expected
   *  answer would hide every case where the two disagree. */
  reviewCheckout: (repo: string, prRepo: string, number: number) =>
    ["review-checkout", repo, prRepo, number] as const,
  prReviewBrief: (prRepo: string, number: number) => ["pr-review-brief", prRepo, number] as const,
  prReviewBriefPrefix: ["pr-review-brief"] as const,
  aiReviewLaunch: (repo: string, prRepo: string, number: number) =>
    ["ai-review-launch", repo, prRepo, number] as const,
  reviewDrafts: (prRepo: string, number: number) => ["review-drafts", prRepo, number] as const,
  reviewDraftsPrefix: ["review-drafts"] as const,
  reviewWorkItems: (prRepo: string, number: number) =>
    ["review-work-items", prRepo, number] as const,
  reviewWorkItemsPrefix: ["review-work-items"] as const,
  mergeQueue: (repo: string) => ["merge-queue", repo] as const,
  prDetail: (owner: string, name: string, number: number) =>
    ["pr-detail", owner, name, number] as const,
  prSummary: (prRepo: string, number: number) => ["pr-summary", prRepo, number] as const,
  /** Prefixes for the reads that come from an external service (Linear, GitHub)
   *  rather than local disk — the set {@link useRefreshExternal} re-pulls. They
   *  can't be scoped by repo from one place (`pr-detail` is keyed by owner/name/
   *  number, `pr-tickets` by a ticket-id list), and don't need to be: see the
   *  hook for why a prefix costs the same as a repo-scoped key. */
  reviewsPrefix: ["reviews"] as const,
  worktreePrsPrefix: ["worktree-prs"] as const,
  mergeQueuePrefix: ["merge-queue"] as const,
  prDetailPrefix: ["pr-detail"] as const,
  prSummaryPrefix: ["pr-summary"] as const,
  prTicketsPrefix: ["pr-tickets"] as const,
  prRepoLabels: (owner: string, name: string) => ["pr-repo-labels", owner, name] as const,
  reviewedFiles: (prRepo: string, number: number) => ["reviewed-files", prRepo, number] as const,
  /** Every PR's marks — invalidated when the local/synced source itself changes. */
  reviewedFilesPrefix: ["reviewed-files"] as const,
  prFileSource: (
    owner: string,
    name: string,
    base: string,
    head: string,
    oldPath: string,
    newPath: string,
  ) => ["pr-file-source", owner, name, base, head, oldPath, newPath] as const,
  prCheckLog: (owner: string, name: string, jobId: number) =>
    ["pr-check-log", owner, name, jobId] as const,
  openers: ["openers"] as const,
  initScript: (repo: string) => ["init-script", repo] as const,
  taskNote: (repo: string, id: string) => ["task-note", repo, id] as const,
  /** Prefixes for every repo's triage reads — invalidate these (not the
   *  per-repo keys) when a change affects all repos at once (a fresh Linear
   *  connection, a display-name switch). */
  triageTicketsPrefix: ["triage-tickets"] as const,
  triageDetailPrefix: ["triage-detail"] as const,
  triageSchedulePrefix: ["triage-schedule"] as const,
  triageTickets: (repo: string) => ["triage-tickets", repo] as const,
  triageDetail: (repo: string, id: string) => ["triage-detail", repo, id] as const,
  triageSchedule: (repo: string) => ["triage-schedule", repo] as const,
  settings: ["settings"] as const,
  setting: (scope: string, key: string) => ["setting", scope, key] as const,
  resolvedSetting: (repo: string, key: string) => ["resolved-setting", repo, key] as const,
  /** Prefix for every repo's resolved read of any key — a repo-scoped override
   *  changes what one resolves to, so a write reconciles through this. */
  resolvedSettingPrefix: ["resolved-setting"] as const,
  /** Editable AI prompts (with per-scope overrides) for the Prompts editor. */
  prompts: (scope: string) => ["prompts", scope] as const,
  /** Prefix for every scope's prompt list — a shared block is visible in all. */
  promptsPrefix: ["prompts"] as const,
  /** Preview renders are keyed by *hashes* of the draft + sample issue, never the
   *  text itself — see {@link promptPreviewKey}. */
  promptPreview: (
    name: string,
    draftHash: string,
    repo: string,
    issueId: string,
    issueHash: string,
    queueHash: string,
  ) => ["prompt-preview", name, draftHash, repo, issueId, issueHash, queueHash] as const,
  /** Prefix for every repo's Linear connection status — invalidate this (not
   *  `linearStatus(repo)`) when a change (e.g. connect/disconnect) should
   *  refetch all repos' status at once. */
  linearStatusPrefix: ["linear-status"] as const,
  linearStatus: (repo: string) => ["linear-status", repo] as const,
  linearOrgs: ["linear-orgs"] as const,
  linearApiBudget: ["linear-api-budget"] as const,
  claudeUsage: ["claude-usage"] as const,
};

// ── Setting keys and stored-value parsers ────────────────────────────────────
// The other half of the vocabulary: the string keys settings are stored under, and
// the parsers that turn a stored string back into a typed value. Kept together (and
// not next to the feature that reads them) so a key is never invented twice. The
// hooks that read and write them are in "Settings reads and writes" below.

/** Setting keys for the Triage Investigation action (agent · model · effort).
 *  `effort` maps to the agent's `--effort` flag (Claude only). The investigation
 *  prompt itself is the editable `triage` prompt (Settings → Prompts). */
export const INVESTIGATE_AGENT_KEY = "investigate_agent";
export const INVESTIGATE_MODEL_KEY = "investigate_model";
export const INVESTIGATE_EFFORT_KEY = "investigate_effort";
export const INVESTIGATE_PERMISSION_MODE_KEY = "investigate_permission_mode";
/** Whether Claude launches pass `--remote-control`. The storage key predates
 *  the provider settings panel; retaining it preserves existing choices while
 *  the UI correctly presents this as a Claude capability, not a Triage action. */
export const CLAUDE_REMOTE_CONTROL_KEY = "investigate_remote_control";

/** Setting keys for the Reviews tab's AI-review sessions. */
export const REVIEW_AGENT_KEY = "review_agent";
export const REVIEW_MODEL_KEY = "review_model";
export const REVIEW_EFFORT_KEY = "review_effort";
export const REVIEW_PERMISSION_MODE_KEY = "review_permission_mode";

/** Models for the two headless writing helpers, mirroring `worktree.rs`'s
 *  `COMMIT_MODEL_KEY` and `pr.rs`'s `BODY_MODEL_KEY`. Both default to the cheap
 *  tier (a subject line from a capped diff really is a small text task), but a PR
 *  body drawn from session transcripts often isn't — hence the override. */
export const COMMIT_MESSAGE_AGENT_KEY = "commit_message_agent";
export const COMMIT_MESSAGE_MODEL_KEY = "commit_message_model";
export const PR_BODY_AGENT_KEY = "pr_body_agent";
export const PR_BODY_MODEL_KEY = "pr_body_model";
/** Claude's compatibility default for a helper profile that has never been set.
 *  Codex has no equivalent: its catalog publishes no default, so an unset Codex
 *  helper simply omits `--model` and takes the CLI's own. */
export const DEFAULT_HELPER_MODEL = "haiku";

/** Setting keys for the Issues "Work" action (agent · model · effort) used by the
 *  launch tray. Unlike triage, this action is always on — there's no enable switch. */
export const WORK_AGENT_KEY = "work_agent";
export const WORK_MODEL_KEY = "work_model";
export const WORK_EFFORT_KEY = "work_effort";
/** Start mode for a worktree's Claude launch — the value passed to Claude's
 *  `--permission-mode` (see {@link PERMISSION_MODES}). Empty leaves the flag off
 *  ("Default" — Claude's own normal mode). Applied on both start and restart. */
export const WORK_PERMISSION_MODE_KEY = "work_permission_mode";

/** Provider-specific workflow profiles. The unsuffixed keys remain a legacy
 * fallback for the provider currently selected as that workflow's default. */
export const providerSettingKey = (key: string, agent: AgentKind) =>
  `${key}__${agent.toLowerCase()}`;

const legacySettingMatchesProvider = (key: string, value: string, agent: AgentKind) => {
  if (!key.endsWith("_model")) return true;
  const claudeModel = value.startsWith("claude-") || ["opus", "sonnet", "haiku"].includes(value);
  return agent === "Claude" ? claudeModel : agent === "Codex" ? !claudeModel : true;
};

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

/** When on, launching a ticket whose blocker is already in a worktree asks which
 *  branch to start from — the blocker's (stacked) or the repo's default — instead
 *  of stacking silently. App-scoped; defaults to ON (a missing value means ask),
 *  so read it as `data !== "false"`. */
export const WORK_ASK_BASE_KEY = "work_ask_base";

/**
 * The triage queue's one preference (app-scoped, string "true"/"false"): show the
 * whole team inbox (issues not assigned to you) too, so you can pitch in on
 * anyone's tickets — on triage duty or not. Off = just yours. Surfaced as the
 * Mine/All toggle. Snoozed issues have no switch: they are always fetched and
 * come back as their own list (see {@link TriageQueue.snoozed}).
 */
export const TRIAGE_GOOD_CITIZEN_KEY = "triage_good_citizen";

/**
 * The project triage runs on unless a ticket picks its own (app-scoped; value =
 * a registered repo name, absent = none). Two things hang off it, and they are
 * the same setting on purpose:
 *
 *  - **Where investigations and terminals run.** An investigation is a real CLI
 *    session on a checkout, so it needs one — and it runs on the project's main
 *    checkout, never on a worktree of its own, because a ticket in triage is
 *    being *read*, not worked.
 *  - **Which Linear org the queue is read from.** The queue is org-scoped, and
 *    "whatever project is on screen" is not a stable answer to "which org": a
 *    section that is always visible must not flicker to another org's empty
 *    queue every time the user opens a worktree elsewhere. See
 *    {@link useTriageOrgRepo}.
 */
export const TRIAGE_DEFAULT_REPO_KEY = "triage_default_repo";

/** The project a ticket is *started* in — and queued for — when more than one
 *  registered project shares its Linear org and so could run it (app-scoped;
 *  value = a registered repo name). Deliberately not
 *  {@link TRIAGE_DEFAULT_REPO_KEY}: triage reads a ticket on a project's main
 *  checkout, work creates a worktree, and the two need not be the same project.
 *  Unset, the first such start asks and offers to remember the answer here; a
 *  ticket only one project carries never asks. See `useWorkRepoGate`. */
export const WORK_DEFAULT_REPO_KEY = "work_default_repo";

/** A ticket's own project, when it has picked one over the default (app-scoped;
 *  value = a registered repo name, absent = use the default). One row per ticket
 *  is cheap — a handful of bytes — and a ticket that leaves triage leaves an
 *  inert row nothing reads, which costs nothing either. */
export const triageRepoKey = (ticketId: string) => `triage_repo:${ticketId}`;

/**
 * How people's names are shown across the app (issues, triage, comments, the
 * schedule). "full" → real name ("Felipe Perdomo"); "username" → the @handle.
 * Mirrors Linear's own "Display names" preference. App-scoped, defaults to full.
 */
export const DISPLAY_NAMES_KEY = "display_names";

export type DisplayNames = "full" | "username";

/**
 * How the sidebar nests a repo's work: not at all, by Linear project, by
 * milestone, or project → milestone. App-scoped, because the sidebar is
 * cross-repo and one tree can only have one shape.
 *
 * One selector rather than two toggles: "project" and "milestone" are levels of
 * the same nesting, and independent switches would let you ask for a milestone
 * inside a project you had turned off.
 */
export const LINEAR_GROUP_BY_KEY = "linear_group_by";

/** The nestings the sidebar tree knows how to build. */
export type LinearGroupBy = "none" | "project" | "milestone" | "project_milestone";

/** The stored `linear_group_by` value, or "milestone" for anything unset or
 *  unknown. Milestone is the default because it is the shape the tree has always
 *  had: an install that never opens Settings sees exactly the sidebar it had
 *  before this setting existed. Exported for testing. */
export const parseLinearGroupBy = (raw: string | null | undefined): LinearGroupBy =>
  raw === "none" || raw === "project" || raw === "project_milestone" ? raw : "milestone";

/**
 * How the sidebar's per-project Reviews section nests the pull requests inside
 * each of its blocks — not at all, by Linear project, by milestone, or
 * project → milestone.
 *
 * The same four shapes as {@link LINEAR_GROUP_BY_KEY} and deliberately its own
 * key: the two rails answer different questions (what am I building, what is
 * waiting on me) and a review inbox is usually short enough that the nesting
 * costs more than it explains. Which is also why this one defaults to **none**
 * while Linear's defaults to milestone — turning it on is a choice, and until
 * you make it the section keeps the flat list it shipped with.
 */
export const GITHUB_GROUP_BY_KEY = "github_group_by";

/** The stored `github_group_by` value, or "none" for anything unset or unknown.
 *  Exported for testing. */
export const parseGithubGroupBy = (raw: string | null | undefined): LinearGroupBy =>
  raw === "project" || raw === "milestone" || raw === "project_milestone" ? raw : "none";

/**
 * Whether a project with nothing waiting still draws its Reviews section.
 *
 * Off by default: the resting state of a quiet project is silence. On, every
 * project with a GitHub remote keeps a folded section and a nought, which is
 * what makes the feature's *absence* legible — one repo showing Reviews while
 * the two beside it show nothing otherwise reads as santree only knowing about
 * the first.
 */
export const REVIEWS_SHOW_EMPTY_KEY = "reviews_show_empty";

/** A stored flag that defaults to **off**: anything but a literal `"true"` is
 *  false, so an unset key and a bad value agree. (The opposite convention to
 *  {@link CONFIRM_ON_QUIT_KEY}, which defaults on and reads `!== "false"` — the
 *  default is the thing being chosen, and it differs per setting.) */
export const isOptedIn = (raw: string | null | undefined): boolean => raw === "true";

/** What santree asks Linear for when connecting: `"read"` or `"read_write"`.
 *  App-scoped, defaults to read-only. Read by Rust (`linear.rs`), so the two
 *  declarations of this key have to agree, same split as
 *  {@link CONFIRM_ON_QUIT_KEY}. */
export const LINEAR_SCOPE_KEY = "linear_scope";

/** The permission levels santree can request from Linear. */
export type LinearScope = "read" | "read_write";

/** The stored `linear_scope`, or read-only for anything unset/unknown —
 *  mirroring the Rust fallback, so a bad value can't quietly request writes. */
export const parseLinearScope = (raw: string | null | undefined): LinearScope =>
  raw === "read_write" ? "read_write" : "read";

/** Said wherever a Linear write is disabled, so the four places that gate on it
 *  can't drift into four different explanations. */
export const LINEAR_READ_ONLY_HINT =
  "santree can't change Linear right now: it is set to read-only, or the workspace was connected without write access. Both live in Settings → Integrations.";

/** Whether to confirm before quitting the app. App-scoped; defaults to ON (a
 *  missing value means confirm), so read it as `data !== "false"`. */
export const CONFIRM_ON_QUIT_KEY = "confirm_on_quit";

/** Which release channel this install follows. App-scoped, defaults to stable.
 *  Read by Rust (`update.rs`) to pick the update manifest, so the string here and
 *  `UPDATE_CHANNEL_KEY` there are one key with two declarations — same split as
 *  {@link CONFIRM_ON_QUIT_KEY}. */
export const UPDATE_CHANNEL_KEY = "update_channel";

/** The release channels the updater knows about. */
export type UpdateChannelSetting = "stable" | "beta";

/** The stored `update_channel` value, or "stable" for anything unset/unknown —
 *  mirroring the same fallback in Rust, so a hand-edited row can't strand an
 *  install on a channel that publishes nothing. Exported for testing. */
export const parseUpdateChannel = (raw: string | null | undefined): UpdateChannelSetting =>
  raw === "beta" ? "beta" : "stable";

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

/** Let model-generated commands in a Codex work / address-review session reach the
 *  network. App-scoped, defaults to OFF (`data === "true"` = on). Read by Rust
 *  (`codex_config.rs` / `provider.rs`), which turns it into
 *  `-c sandbox_workspace_write.network_access=true` on the launch line — so it
 *  applies to sessions started afterwards, not to ones already running. */
export const CODEX_NETWORK_ACCESS_KEY = "codex_sandbox_network_access";

/** Send Reviews "Viewed" marks to GitHub instead of this machine's table, so they
 *  are the same checkbox as the github.com Files tab. App-scoped, defaults to OFF
 *  (`data === "true"` = on) — the local store needs no network. Read by Rust
 *  (`reviewed.rs`), which also requires a `gh` token before honoring it. */
export const SYNC_VIEWED_KEY = "reviews_sync_viewed";

/** Inject the English-tutor correction hook into every Claude session santree
 *  launches. App-scoped, defaults to OFF (`data === "true"` = on).
 *
 *  Unlike {@link CLAUDE_STATUS_LINE_KEY} this is *not* a runtime display toggle:
 *  it's baked into the `--settings` file the session launches with, so flipping it
 *  only affects sessions started afterwards — and `useSetSetting` invalidates the
 *  three cached-forever `--settings` paths when it changes. */
export const ENGLISH_TUTOR_KEY = "english_tutor";

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

/** The stored `trees_batch_setup` value, or "ask" for anything unset/unknown —
 *  the batch launch asks once rather than guessing. Exported for testing. */
export const parseBatchSetup = (raw: string | null | undefined): BatchSetup =>
  raw === "always" || raw === "never" ? raw : "ask";

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

// ── Settings reads and writes ────────────────────────────────────────────────
// One read path with a scope ladder (repo override falls back to the app default)
// and one write path that patches both halves of that ladder in the cache.

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

/** A single setting value for an exact scope (`"app"` or `"repo:<name>"`).
 *  `enabled: false` leaves the read off (for a key derived from something the
 *  caller may not have yet, like a ticket id); `data` is then `undefined`. */
export const useSetting = (scope: string, key: string, enabled = true) =>
  useUnwrappedQuery(queryKeys.setting(scope, key), () => commands.getSetting(scope, key), {
    enabled,
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

/** Read a boolean setting for an exact scope (defaults to false until loaded).
 *  `isFetched` is the *only* way to tell "off" from "not loaded yet" — `value` is
 *  a boolean, so it reads false in both cases. Anything that gates a side effect
 *  on it (a launch flag, the setup script) must wait for `isFetched`. */
export const useBoolSetting = (scope: string, key: string) => {
  const q = useSetting(scope, key);
  return { value: q.data === "true", loading: q.isLoading, isFetched: q.isFetched };
};

/** Read a repo-resolved boolean setting: the repo's override, else the app
 *  value (defaults to false until loaded). Same false-while-loading caveat as
 *  {@link useBoolSetting} — gate side effects on `isFetched`. */
export const useResolvedBoolSetting = (repo: string, key: string) => {
  const q = useResolvedSetting(repo, key);
  return { value: q.data === "true", loading: q.isLoading, isFetched: q.isFetched };
};

const AGENT_KINDS: readonly AgentKind[] = ["Claude", "Codex", "Cursor", "Opencode"];

/** Match the backend's helper-provider fallback: a valid explicit helper
 * assignment wins, then the Work provider, then the app's default provider. */
export function resolveHelperAgent(
  helper: string | null | undefined,
  work: string | null | undefined,
  defaultAgent: AgentKind | null | undefined,
): AgentKind {
  for (const candidate of [helper, work, defaultAgent]) {
    if (AGENT_KINDS.includes(candidate as AgentKind)) return candidate as AgentKind;
  }
  return "Claude";
}

/** The provider that will execute a hidden Work helper (commit message or PR
 * body), resolved identically to `agent::helper_config` in Rust. */
export const useResolvedHelperAgent = (repo: string, helperKey: string): AgentKind => {
  const helper = useResolvedSetting(repo, helperKey).data;
  const work = useResolvedSetting(repo, WORK_AGENT_KEY).data;
  const settings = useSettings().data;
  return resolveHelperAgent(helper, work, settings?.defaultAgent);
};

/** Resolve one workflow profile for a provider. Provider-specific values win;
 * the old unsuffixed key is used only when this provider is still the workflow's
 * selected default, preserving existing installs without leaking (for example)
 * a Codex model into Claude. */
export const useResolvedProviderSetting = (
  repo: string,
  key: string,
  agent: AgentKind,
  agentKey: string,
) => {
  const profile = useResolvedSetting(repo, providerSettingKey(key, agent));
  const legacy = useResolvedSetting(repo, key);
  const selected = useResolvedSetting(repo, agentKey);
  return {
    ...profile,
    data:
      profile.data ??
      (selected.data === agent &&
      legacy.data &&
      legacySettingMatchesProvider(key, legacy.data, agent)
        ? legacy.data
        : null),
    isFetched: profile.isFetched && legacy.isFetched && selected.isFetched,
  };
};

/**
 * Read a repo-resolved setting *imperatively*: from the cache when it's there,
 * fetching once when it isn't. For decisions taken in an event handler — where
 * the hook's false-while-loading value would silently mean "off" and skip the
 * thing the setting gates (see `AgentRuns.beginRun`, which would drop the setup
 * script). Writes through the same key `useResolvedSetting` reads, so the two
 * share one cache entry.
 */
export const ensureResolvedSetting = (qc: QueryClient, repo: string, key: string) =>
  qc.ensureQueryData({
    queryKey: queryKeys.resolvedSetting(repo, key),
    queryFn: () => unwrap(commands.resolveSetting(repo, key)),
    staleTime: SETTING_STALE_TIME,
  });

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
 *
 * The resolved value is `repo override ?? app default`, so every write's effect
 * on it is knowable client-side: an app-scoped write is the fallback for every
 * repo that has no override; a repo-scoped write always wins for that one repo;
 * clearing a repo override falls back to the cached app value.
 */
export function patchSettingCache(
  qc: QueryClient,
  { scope, key, value }: SetSettingVars,
): () => void {
  // Record only the entries we actually write, so the rollback is an undo of
  // *this* patch: replaying a snapshot of every resolved entry would also revert
  // an overlapping write to a different key that landed in between.
  const undo: [QueryKey, unknown][] = [];
  const patch = (k: QueryKey, next: string | null) => {
    undo.push([k, qc.getQueryData(k)]);
    qc.setQueryData(k, next);
  };

  patch(queryKeys.setting(scope, key), value);

  if (scope === "app") {
    const resolved = qc.getQueriesData({ queryKey: queryKeys.resolvedSettingPrefix });
    for (const [k] of resolved) {
      // A repo with its own override still resolves to that override, so an
      // app-scoped write mustn't overwrite it.
      const repo = k[1] as string;
      const override = qc.getQueryData<string | null>(queryKeys.setting(`repo:${repo}`, key));
      if (k[2] === key && override == null) patch(k, value);
    }
  } else if (scope.startsWith("repo:")) {
    const repo = scope.slice("repo:".length);
    const resolvedKey = queryKeys.resolvedSetting(repo, key);
    // Clearing the override (`null`) falls back to the app default — patchable
    // only when that default is itself cached; otherwise leave it to the settle.
    const appValue = qc.getQueryData<string | null>(queryKeys.setting("app", key));
    const known = value != null || appValue !== undefined;
    // Only touch an entry that's already cached: a key minted here has no prior
    // value, so the rollback would have to invent one.
    if (known && qc.getQueryData(resolvedKey) !== undefined) {
      patch(resolvedKey, value ?? appValue ?? null);
    }
  }

  return () => {
    for (const [k, prev] of [...undo].reverse()) {
      // `setQueryData(k, undefined)` is a no-op in TanStack Query, so an entry
      // that didn't exist before the patch has to be *removed*, not restored —
      // otherwise a failed write's optimistic value would survive its rollback.
      if (prev === undefined) qc.removeQueries({ queryKey: k, exact: true });
      else qc.setQueryData(k, prev);
    }
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
    invalidate: (a) => [
      queryKeys.setting(a.scope, a.key),
      queryKeys.resolvedSettingPrefix,
      // The English tutor is the one setting baked into the `--settings` files,
      // which are otherwise cached forever. Refetch them here rather than at the
      // toggle's call site, so any future writer of this key gets it too.
      ...(a.key === ENGLISH_TUTOR_KEY
        ? [
            queryKeys.claudeHookSettings,
            queryKeys.claudeHookSettingsNoGit,
            // A review tab's settings file is written by the same builder, so its
            // resolved launch is cached forever too — invalidate the whole prefix
            // (the key is per tab) so the next resume rewrites the file.
            queryKeys.worktreeTabLaunchPrefix,
          ]
        : []),
      // Read-only mode is folded into what the backend reports as writable, so
      // the status has to be re-read for the write controls to gray out at once
      // — the whole point of the switch is that it applies without reconnecting.
      ...(a.key === LINEAR_SCOPE_KEY ? [queryKeys.linearStatusPrefix, queryKeys.linearOrgs] : []),
    ],
  });

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

/** The variable names a referenced `.env` file defines (for the "N loaded" count).
 *  The file lives outside the app, so no write of ours can invalidate this: it must
 *  re-read on every mount of the Environment panel (and when the window regains
 *  focus, i.e. you come back from editing the file) or an edited `.env` reports a
 *  stale count for the rest of the process's life. */
export const useEnvFileVars = (path: string) =>
  useQuery({
    queryKey: queryKeys.envFileVars(path),
    queryFn: () => commands.envFileVars(path),
    enabled: !!path,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

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
      queryKeys.triageTicketsPrefix,
      queryKeys.triageDetailPrefix,
      queryKeys.triageSchedulePrefix,
      // The Issues task graph (and its blocker hover cards) resolve names
      // server-side too; `tasksPrefix` matches every repo's graph.
      queryKeys.tasksPrefix,
    ],
  });
  return { value, setValue: mutate };
};

// ── App shell and the self-updater ───────────────────────────────────────────
// App-global state with no repo in it. The updater hooks share one mutation scope
// so a check, a download and an install can never overlap.

/** The running app's real version (single-sourced from `tauri.conf.json`), for
 * the sidebar footer and help menu. Fixed for the process lifetime. */
export const useAppVersion = () =>
  useQuery({ queryKey: queryKeys.appVersion, queryFn: getVersion, staleTime: Infinity });

/**
 * The keep-awake hold (macOS `caffeinate` behind `set_keep_awake`): status +
 * optimistic toggle for the chrome's button. `supported` is false off-macOS —
 * the button renders nothing. The hold is remembered: the backend persists it
 * and re-applies it at launch, so it stays on until it is turned off.
 */
export const useKeepAwake = () => {
  const status = useQuery({
    queryKey: queryKeys.keepAwake,
    queryFn: () => commands.keepAwakeStatus(),
    // The child can die outside the app (killed externally); a focus refetch
    // self-corrects the icon without polling.
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const toggle = useOptimisticMutation<boolean, KeepAwakeStatus>({
    mutationFn: (on) => unwrap(commands.setKeepAwake(on)),
    // Flip the icon on click; the settle-refetch reconciles with the backend's
    // actual state (a failed spawn comes back `active: false`).
    optimistic: (qc, on) => {
      const prev = qc.getQueryData<KeepAwakeStatus>(queryKeys.keepAwake);
      qc.setQueryData<KeepAwakeStatus>(queryKeys.keepAwake, { supported: true, active: on });
      return () => qc.setQueryData(queryKeys.keepAwake, prev);
    },
    invalidate: () => [queryKeys.keepAwake],
  });
  return {
    supported: status.data?.supported ?? false,
    active: status.data?.active ?? false,
    toggle: toggle.mutate,
  };
};

/** Shared mutation scope for every updater call — see {@link useCheckForUpdate}. */
const UPDATE_SCOPE = { id: "santree-update" };

/**
 * Ask the release channel whether a newer version exists; the result lives on the
 * mutation (`data`), which is `null` when this install is current.
 *
 * A mutation rather than a query because it's a user-pressed button with a real
 * network round-trip, and because the *answer* is not cacheable state: the
 * backend parks the matching update handle for {@link useInstallUpdate}, so a
 * cached "yes" that React Query replayed would offer an install the backend no
 * longer has.
 */
export const useCheckForUpdate = ({ silent = false }: { silent?: boolean } = {}) =>
  useActionMutation({
    mutationFn: () => unwrap(commands.checkForUpdate()),
    // Every update mutation shares one scope so React Query runs them serially: a
    // background check that landed between a manual check and its install would
    // otherwise clear the parked handle and turn Install into "no update ready".
    scope: UPDATE_SCOPE,
    // The watcher runs unattended — a failed check offline must not raise the
    // global red toast for something nobody asked for.
    silent,
  });
/** Download + install the update the last check found, then relaunch. Never
 *  resolves on success — the process is replaced mid-call. */
export const useInstallUpdate = () =>
  useActionMutation({ mutationFn: () => unwrap(commands.installUpdate()), scope: UPDATE_SCOPE });

/** Bytes downloaded during an install, or `null` before the first chunk lands.
 *  `total` is null when the server sent no content-length. */
export const useUpdateProgress = () => {
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  useEffect(() => {
    const unlisten = events.updateProgress.listen(({ payload }) => setProgress(payload));
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);
  return progress;
};

/** How often santree asks its channel whether something newer exists. Deliberately
 *  long: an app that nags is worse than one that's a few hours late, and the
 *  Updates pane is always there for an answer on demand. */
const UPDATE_POLL_MS = 6 * 60 * 60_000;
/** Delay before the first check, so it never competes with startup — the DB open,
 *  the watchers and the first render all matter more than an update banner. */
const UPDATE_FIRST_CHECK_MS = 15_000;

/**
 * Background update checks. Mounted once by the app shell, because nothing else
 * would ever tell you a release happened: the plugin has no polling of its own,
 * so without this the updater only works for people who think to go looking.
 *
 * Announces through a toast rather than a modal — an update is news, not an
 * interruption — and at most once per version per session, so leaving santree
 * open for a week can't turn into a week of reminders.
 */
export const useUpdateWatcher = () => {
  const { mutate: check } = useCheckForUpdate({ silent: true });
  const announced = useRef<string | null>(null);

  useEffect(() => {
    const run = () =>
      check(undefined, {
        onSuccess: (update) => {
          if (!update || announced.current === update.version) return;
          announced.current = update.version;
          toast.info(
            `santree ${update.version} is available. Install it from Settings → Updates.`,
            {
              title: "Update available",
              duration: 12_000,
            },
          );
        },
      });
    const first = setTimeout(run, UPDATE_FIRST_CHECK_MS);
    const repeat = setInterval(run, UPDATE_POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(repeat);
    };
  }, [check]);
};

// ── Repos, openers and the setup script ──────────────────────────────────────
// The repo registry and the per-repo rig around it: which branches it has, which
// external apps can open a path, and the `.santree/init.sh` a new worktree runs.

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

/**
 * The repo's branches, for the Create-worktree dialog's Branch source. Each row
 * says whether the branch is already checked out, which is what lets the picker
 * disable it rather than let the user click into git's "already used by
 * worktree" error.
 *
 * Read only while the dialog is open (`enabled`), and kept briefly: branches
 * move under us (a fetch, a push from a terminal), so a long stale window would
 * offer a branch that has since been taken.
 */
export const useRepoBranches = (repo: string, enabled = true) =>
  useUnwrappedQuery(queryKeys.repoBranches(repo), () => commands.repoBranches(repo), {
    enabled: enabled && repo.length > 0,
    staleTime: 15_000,
  });

/** The "open in app" targets (Finder, editors, terminals) for a worktree — which
 *  apps are *installed*, probed on disk. External state, so nothing in the app
 *  invalidates it: cache it briefly and re-read when the window regains focus, or
 *  an editor installed while santree is running never appears in the menu. */
export const useOpeners = () =>
  useQuery({
    queryKey: queryKeys.openers,
    queryFn: commands.listOpeners,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });

/** Open a path in an external app (by opener key). */
export const useOpenInApp = () =>
  useMutation({
    mutationFn: (a: { path: string; opener: string }) =>
      unwrap(commands.openInApp(a.path, a.opener)),
  });

/**
 * The repo's `.santree/init.sh` setup script (content + executable bit), for the
 * Settings → Work editor. Changes only on explicit writes, so it never needs a
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

// ── External CLIs and their auth ─────────────────────────────────────────────
// The binaries santree shells out to (agent harnesses and `gh`): where each
// resolves to, what version it is, and whether it is signed in. Identity and
// install state only — what an agent is *doing* lives in `lib/attention.ts`.

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

/** Installed CLI version plus the provider's latest published release. */
export const useAgentVersionStatus = (kind: AgentKind) =>
  useUnwrappedQuery(queryKeys.agentVersionStatus(kind), () => commands.agentVersionStatus(kind), {
    staleTime: 5 * 60 * 1000,
  });

export const useCodexHealth = () =>
  useUnwrappedQuery(queryKeys.codexHealth, () => commands.codexHealth(), {
    staleTime: 30_000,
    meta: { silent: true },
  });

/** Whether the `codex` CLI is signed in, from `codex login status`. Polled while
 *  it is not: signing in happens in the user's own terminal (`codex login`), and
 *  this is how the app notices they came back. */
export const useCodexAccount = (enabled = true) =>
  useUnwrappedQuery(queryKeys.codexAccount, () => commands.codexAccount(), {
    enabled,
    staleTime: 30_000,
    refetchInterval: (query) => (query.state.data?.connected ? false : 10_000),
    meta: { silent: true },
  });

export const useCodexModels = (enabled = true) =>
  useUnwrappedQuery(queryKeys.codexModels, () => commands.codexModels(), {
    enabled,
    staleTime: 5 * 60 * 1000,
    meta: { silent: true },
  });

/** Signing *in* is not here: it was an App Server call, and the CLI's own
 *  `codex login` owns a browser round trip and a local callback. Settings points
 *  the user at their terminal instead of offering a button that can't finish. */
export const useCodexLogout = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(commands.codexLogout()),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.codexAccount }),
  });
};

/**
 * Path to the settings file to pass as `claude --settings <path>` — carries the
 * session-state hooks and santree's own `statusLine` (`null` when the hook binary
 * can't be resolved). A file path — not inline JSON — because the config is too
 * large to inline into the PTY seed command without breaking its shell quoting.
 *
 * Cached until {@link ENGLISH_TUTOR_KEY} flips (the one setting baked into the
 * file — `useSetSetting` invalidates this key when it changes). The statusLine is
 * *always* injected so usage is always captured; whether the app renders the
 * inline usage bar is gated separately at the render site via
 * {@link CLAUDE_STATUS_LINE_KEY} — a runtime decision, so it works for
 * already-running tabs.
 */
export const useClaudeHookSettings = () =>
  useQuery({
    queryKey: queryKeys.claudeHookSettings,
    queryFn: () => commands.claudeHookSettings(),
    staleTime: Infinity,
  });

/**
 * The `-c 'hooks.<Event>=[…]'` flags a santree `codex` launch carries. This is
 * how a Codex session reports the thread id it minted — Codex has no
 * launch-time id flag, so without these the session is unresumable and never
 * reaches the agent registry.
 *
 * `staleTime: Infinity` like Claude's: the content is two resolved paths, and
 * neither moves while the app is running.
 */
export const useCodexHookFlags = () =>
  useQuery({
    queryKey: queryKeys.codexHookFlags,
    queryFn: () => commands.codexHookFlags(),
    staleTime: Infinity,
  });

/** Like {@link useClaudeHookSettings} but the commit/push-denying variant — the
 *  `--settings` path a "Fix CI" session launches with, so the AI fixes + validates
 *  but never commits/pushes. Same caching rule as {@link useClaudeHookSettings}. */
export const useClaudeHookSettingsNoGit = () =>
  useQuery({
    queryKey: queryKeys.claudeHookSettingsNoGit,
    queryFn: () => commands.claudeHookSettingsNoGit(),
    staleTime: Infinity,
  });

/** The `gh` CLI integration status (installed? authenticated? which account?). */
export const useGithubStatus = () =>
  useQuery({ queryKey: queryKeys.githubStatus, queryFn: () => commands.githubStatus() });

/** The signed-in GitHub user's login — who the review composer writes as. Not
 *  repo-scoped and effectively fixed for the session, so it's cached for an hour
 *  rather than re-asked on every PR. `null` when `gh` isn't authenticated. */
export const useGithubViewerLogin = () =>
  useUnwrappedQuery(queryKeys.githubViewer(), () => commands.githubViewerLogin(), {
    staleTime: 60 * 60_000,
  });

/** Where santree resolves a CLI to, plus any user-set override and its
 *  `--version`. Not cached: discovery can spawn a shell, but this is only read by
 *  the settings panels, and a stale "not found" is exactly what it exists to fix. */
export const useBinaryStatus = (name: string) =>
  useUnwrappedQuery(queryKeys.binaryStatus(name), () => commands.binaryStatus(name), {
    staleTime: 0,
  });

/** Set (or clear, with `null`) the path santree uses for a CLI. Errors are shown
 *  inline by the caller — a rejected path needs to be visible next to the field
 *  that produced it, not in a corner toast. */
export const useSetBinaryPath = (name: string) =>
  useActionMutation({
    mutationFn: (path: string | null) => unwrap(commands.setBinaryPath(name, path)),
    silent: true,
    // `githubStatus` and `agentAuth` are the panels that told the user to install
    // something they already had — both have to re-probe, not just this key.
    invalidate: () => [
      queryKeys.binaryStatus(name),
      queryKeys.githubStatus,
      queryKeys.agentAuth("Claude"),
    ],
  });

// ── Linear: connection, orgs and the issue graph ─────────────────────────────
// Everything that talks to Linear except Triage (which has its own cache policy,
// further down): the OAuth connection, the org a repo is bound to, and the issues.

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

/**
 * True only when Linear is connected *and* the grant is read-only.
 *
 * Deliberately not `!canWrite`: "nothing connected" and "connected read-only"
 * want different words, and while the status is still loading nothing should
 * flicker to disabled. The backend refuses the write either way — this is the
 * courtesy, `repo_write_session` is the guarantee.
 */
export const useLinearReadOnly = (repo: string) => {
  const { data } = useLinearStatus(repo);
  return data?.authenticated === true && data.canWrite === false;
};

/**
 * A ticket's page in Linear, from the org the repo is bound to. The org's slug
 * is its url key, so the address is `linear.app/<slug>/issue/<id>` — Linear
 * routes that to the issue without the title slug its own links carry. A builder
 * rather than one url, because a list hands the same repo's builder to every
 * row; it answers `null` until the status read lands, or when no org is bound.
 */
export const useLinearIssueUrl = (repo: string): ((id: string) => string | null) => {
  const { data } = useLinearStatus(repo);
  const slug = data?.orgSlug ?? null;
  return useCallback(
    (id: string) => (slug ? `https://linear.app/${slug}/issue/${id}` : null),
    [slug],
  );
};

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
      qc.invalidateQueries({ queryKey: queryKeys.triageTicketsPrefix });
      qc.invalidateQueries({ queryKey: queryKeys.triageSchedulePrefix });
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

/** santree-CLI config detected in a repo that the app could adopt. Imperative
 *  (called once, right after a repo is added) rather than a query — the answer
 *  is only meaningful at that moment, and must never be cached. */
export const probeLegacyCli = (repo: string) => unwrap(commands.legacyCliProbe(repo));

/** Import the santree CLI's Linear credential for a repo's workspace (moved
 *  into the OS keychain, Rust-side only) and link the repo to it. Silent: the
 *  migration dialog owns the failure UI. */
export const useLegacyCliMigrate = () =>
  useActionMutation({
    mutationFn: (repo: string) => unwrap(commands.legacyCliMigrate(repo)),
    silent: true,
    // Same blast radius as a Linear connect, plus the repo list (its tracker
    // label becomes "Linear · <org>").
    invalidate: () => [
      queryKeys.repos,
      queryKeys.linearStatusPrefix,
      queryKeys.linearOrgs,
      queryKeys.tasksPrefix,
      queryKeys.triageTicketsPrefix,
      queryKeys.triageSchedulePrefix,
    ],
    success: (org) => ({
      message: `Workspace “${org.name}” imported from the santree CLI.`,
      title: "Linear connected",
    }),
  });

/** The Linear issue graph is heavy and changes infrequently; mutations invalidate
 *  `tasksPrefix` explicitly, so a stale window keeps re-entering the Issues tab
 *  from re-fetching the whole graph on every mount. */
const TASKS_STALE_TIME = 3 * 60_000;

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

// ── Agent sessions and live agent state ──────────────────────────────────────
// Which agent is running where, from the ordered arbiter: hook-written session row,
// then the process table, then santree's own launch record. Identity, never status.

/** States that can still change without a hook firing, so a read — and thus the
 *  backend's reconciliation of the live state against the session transcript (the
 *  ground truth) — must keep happening: a pending prompt (a manual accept/reject
 *  or a typed reply fires nothing, so only a read catches its resolution) and any
 *  working state (a turn can end with no `Stop`). Settled states — idle / exited
 *  — don't need polling, so an all-quiet app polls not at all. */
const UNSETTLED_STATES = new Set(["permission", "waiting", "active", "delegating"]);

/** Current state of every santree-launched Claude session (active/waiting/idle/
 *  exited), recorded live by the injected hooks and kept fresh in realtime by
 *  `useSessionStateWatcher`; the short poll below covers the transitions no hook
 *  observes (see {@link UNSETTLED_STATES}). */
export const useSessionStates = () =>
  useUnwrappedQuery(queryKeys.sessionStates, () => commands.sessionStates(), {
    refetchInterval: (query) =>
      query.state.data?.some((s) => UNSETTLED_STATES.has(s.state)) ? 10_000 : false,
  });

/**
 * Which coding agent the process table says is in each pane's foreground —
 * observation, where `useSessionStates` and the launch record are memory.
 *
 * It is what makes an unprompted Codex tab visible (Codex fires `SessionStart`
 * on its first turn, so nothing hook-fed knows the tab exists) and what catches
 * an agent the user started by typing `codex` in a santree shell.
 *
 * **Identity only.** A result never carries a status: the attention ladder still
 * comes from the hook rows, then the terminal title. And an absent pane is *no
 * information*, never "no agent" — `ps` can fail, and the backend answers an
 * unreadable process table with an empty list rather than an error.
 *
 * Two triggers, no fast poller. The bind is event-driven, as Orca's is:
 * {@link useAgentEntries} invalidates this whenever the set of open panes
 * changes, so a new tab is scanned immediately. The interval only has to catch
 * an agent that starts *inside* an existing pane, so it rides the same 10s
 * cadence `useSessionStates` uses, and stops entirely when no pane is open. One
 * `ps` per burst regardless: the backend caches the listing for 500ms and the
 * resource panel reads the same snapshot.
 */
export const useAgentProcesses = (panes: number) =>
  useUnwrappedQuery(queryKeys.agentProcesses, () => commands.agentProcesses(), {
    refetchInterval: panes > 0 ? 10_000 : false,
    staleTime: 2_000,
    meta: { silent: true },
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

/**
 * Resolve how an agent terminal should (re)launch its persisted provider —
 * resume a durable session, start fresh with a reserved id, or a plain shell
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
  agent: AgentKind,
  enabled: boolean,
) =>
  useUnwrappedQuery(
    queryKeys.agentSession(repo, termKey, agent, allowFresh),
    () => commands.agentSession(repo, termKey, cwd, allowFresh, agent),
    {
      enabled: enabled && !!repo && !!termKey && !!cwd,
      staleTime: allowFresh ? Number.POSITIVE_INFINITY : 0,
    },
  );

/** Providers with a durable conversation on one logical surface. */
export const useSessionProviders = (repo: string, termKey: string) =>
  useUnwrappedQuery(
    queryKeys.sessionProviders(repo, termKey),
    () => commands.sessionProviders(repo, termKey),
    { enabled: !!repo && !!termKey, staleTime: 30_000 },
  );

// ── Budget, usage and live processes ─────────────────────────────────────────
// What the running work is costing: token/context usage, each provider's remaining
// rate-limit window, the API budgets, and the CPU/memory of the PTYs santree owns.

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

/** Claude's account rate-limit windows (the 5h session window, the 7d weekly
 *  one, any other the CLI reports), as captured display-only from the
 *  statusline payload by the hook — see COMPLIANCE.md. Empty until a Claude
 *  session has reported once. */
export const useClaudeRateLimits = () =>
  useUnwrappedQuery(queryKeys.claudeRateLimits, () => commands.claudeRateLimits(), {
    staleTime: 60_000,
    meta: { silent: true },
  });

/** The account's usage straight from Anthropic, read with Claude Code's own
 *  credential (see COMPLIANCE.md, "Claude subscription usage"). Unlike the
 *  status-line capture this needs no session to have run, so it is what fills
 *  the meters on a cold start; it also records what it reads, so the two
 *  sources share one store. Polled slowly — the windows move in minutes, and
 *  each read is a request on the user's behalf.
 *
 *  `silent` stays because this POLLS: Anthropic rate-limits the endpoint, and a
 *  toast every five minutes would nag about something the user cannot act on.
 *  That is only safe because the panel renders the failure itself — the reason
 *  reaches the Claude row as `ClaudeUsageFetch.detail`. If that ever stops being
 *  true, this needs a surface again, not a quieter failure. */
export const useClaudeAccountUsage = () =>
  useUnwrappedQuery(queryKeys.claudeAccountUsage, () => commands.claudeFetchUsage(), {
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    meta: { silent: true },
  });

/** Whether the user's global Claude status line is wrapped by santree's
 *  passthrough, so every Claude session — not just the ones santree launches —
 *  feeds the usage meters. Reads `~/.claude/settings.json`. */
export const useClaudeGlobalCapture = () =>
  useUnwrappedQuery(queryKeys.claudeGlobalCapture, () => commands.claudeGlobalCaptureStatus(), {
    staleTime: 60_000,
    meta: { silent: true },
  });

/** Turn the passthrough on (wrap the user's status line, keeping the original
 *  inside the wrapper) or off (restore it). Touches the user's global Claude
 *  settings, so it is only ever called from the explicit toggle. */
export const useSetClaudeGlobalCapture = () =>
  useActionMutation<boolean, ClaudeGlobalCapture>({
    mutationFn: (enabled) => unwrap(commands.setClaudeGlobalCapture(enabled)),
    invalidate: () => [queryKeys.claudeGlobalCapture],
    success: (data) =>
      data.enabled
        ? "Capturing usage from every Claude session. It fills in on the next status-line redraw."
        : "Your Claude status line is back to its original command.",
  });

/** Realtime refresh for {@link useClaudeRateLimits}: the hook pings the signal
 *  socket (tagged `l`), the Rust listener emits `claudeRateLimitsChanged`, and
 *  we invalidate. Mount once at the app root, beside the usage watcher. */
export const useClaudeRateLimitsWatcher = () => {
  const qc = useQueryClient();
  useEffect(() => {
    const unlisten = events.claudeRateLimitsChanged.listen(() => {
      qc.invalidateQueries({ queryKey: queryKeys.claudeRateLimits });
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [qc]);
};

/** Codex's own rate-limit snapshot from its last turn, read back from its rollout
 *  transcript — there is no live source that doesn't need Codex's credentials, so
 *  this is as fresh as the user's last Codex turn. */
export const useCodexRateLimits = (enabled = true) =>
  useUnwrappedQuery(queryKeys.codexRateLimits, () => commands.codexRateLimits(), {
    enabled,
    staleTime: 60_000,
    meta: { silent: true },
  });

/** What is left of the GitHub API budget the `gh` session spends. `null` when
 *  nothing is signed in. Only fetched while `enabled` — this is a settings-screen
 *  read, and there is no reason to ask about a budget nobody is looking at.
 *
 *  A one-minute `staleTime` rather than a poll: GitHub's `/rate_limit` is free,
 *  but the numbers only move when *something else* spends them, so a countdown
 *  the user can refresh by hand beats a meter that ticks on its own. */
export const useGithubApiBudget = (enabled = true) =>
  useQuery({
    queryKey: queryKeys.githubApiBudget,
    queryFn: () => commands.githubApiBudget(),
    enabled,
    staleTime: 60_000,
  });

/** What is left of each connected Linear workspace's hourly budget.
 *
 *  Unlike GitHub's, reading this can cost one request (Linear only reports the
 *  budget in a response — see `linear::api_budget`), so it is gated on `enabled`
 *  and never polls: it refreshes when the screen mounts and when the user asks. */
export const useLinearApiBudget = (enabled = true) =>
  useUnwrappedQuery(queryKeys.linearApiBudget, () => commands.linearApiBudget(), {
    enabled,
    staleTime: 60_000,
  });

/** CPU and memory of every process santree's terminals own, grouped repo →
 *  worktree → terminal. One `ps` sweep per read: sampled slowly at rest, so
 *  the bar's total is never a blank, and every few seconds while the resource
 *  manager is open (`watching`). */
export const useResourceUsage = (watching: boolean) =>
  useUnwrappedQuery(queryKeys.resourceUsage, () => commands.resourceUsage(), {
    staleTime: 2_000,
    refetchInterval: watching ? 4_000 : 30_000,
    meta: { silent: true },
  });

/**
 * Every live PTY session (Settings → Terminal).
 *
 * Polls only while the panel is open — `watching` — because the two facts that
 * make it worth showing, whether a pane is attached and whether the child is
 * still alive, both change without anything invalidating a cache key.
 */
export const useTerminalSessions = (watching: boolean) =>
  useUnwrappedQuery(queryKeys.terminalSessions, () => commands.terminalSessions(), {
    staleTime: 1_000,
    refetchInterval: watching ? 2_000 : false,
    meta: { silent: true },
  });

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

// ── Worktrees: the tree, its files and its diffs ─────────────────────────────
// The reads that describe a worktree as it is on disk. All share one stale time so
// switching away from a tree and back is instant instead of a refetch.

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

/** The files the branch has committed relative to its base (merge-base diff),
 *  for the git panel's "Committed on branch" section. */
export const useWorktreeBranchChanges = (repo: string, id: string) =>
  useUnwrappedQuery(
    queryKeys.worktreeBranchChanges(repo, id),
    () => commands.worktreeBranchChanges(repo, id),
    { enabled: !!repo && !!id, staleTime: WORKTREE_STALE_TIME },
  );

/** One committed file's diff against the branch's base. */
export const useWorktreeBranchFileDiff = (repo: string, id: string, path: string) =>
  useUnwrappedQuery(
    queryKeys.worktreeBranchFileDiff(repo, id, path),
    () => commands.worktreeBranchFileDiff(repo, id, path),
    { enabled: !!repo && !!id && !!path, staleTime: WORKTREE_STALE_TIME },
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
 *
 * Refetches are single-flight per worktree. `invalidateQueries`' default
 * (`cancelRefetch: true`) cancels the in-flight fetch and fires a new one — but
 * cancelling the JS promise doesn't kill the git subprocesses behind the IPC
 * call, so sustained churn (events every debounce window, fetches slower than
 * that) piles up abandoned `git status` scans until the disk saturates. With
 * `cancelRefetch: false` an event landing mid-fetch piggybacks on it instead;
 * the drain loop then runs one trailing pass so the final on-disk state is
 * never left stale-at-rest.
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

    let disposed = false;
    const draining = new Set<string>();
    const dirty = new Set<string>();

    const invalidate = (issueId: string) =>
      Promise.all([
        qc.invalidateQueries(
          { queryKey: queryKeys.worktreeStatus(repo, issueId) },
          { cancelRefetch: false },
        ),
        qc.invalidateQueries(
          { queryKey: queryKeys.worktreeFiles(repo, issueId) },
          { cancelRefetch: false },
        ),
        qc.invalidateQueries(
          { queryKey: queryKeys.worktreeFileDiffPrefix(repo, issueId) },
          { cancelRefetch: false },
        ),
        // DiffPane pairs the full-file source with the diff above for the diff
        // viewer's context expansion; without it, an agent editing a file mid-view
        // leaves expanded context lines stale for up to `WORKTREE_STALE_TIME`.
        qc.invalidateQueries(
          { queryKey: queryKeys.worktreeFileSourcePrefix(repo, issueId) },
          { cancelRefetch: false },
        ),
        // The list carries each worktree's add/del line counts, shown on the
        // sidebar card and the Issues-panel worktree card.
        qc.invalidateQueries({ queryKey: queryKeys.worktrees(repo) }, { cancelRefetch: false }),
        // The base entry is a *separate* read (it isn't in the list above) showing
        // the same live git state — dirty/ahead/behind/unpushed for the repo root.
        // Refreshed for any worktree's event rather than only the BASE_ID one: the
        // sentinel lives in the Trees feature, and importing it here would point
        // the data layer back at a module that imports from it.
        qc.invalidateQueries({ queryKey: queryKeys.baseWorktree(repo) }, { cancelRefetch: false }),
      ]);

    const drain = async (issueId: string) => {
      if (draining.has(issueId)) {
        // A pass is running for this worktree — remember that more changed and
        // let that pass's trailing loop pick it up.
        dirty.add(issueId);
        return;
      }
      draining.add(issueId);
      try {
        do {
          dirty.delete(issueId);
          await invalidate(issueId);
        } while (dirty.has(issueId) && !disposed);
      } finally {
        draining.delete(issueId);
      }
    };

    const unlisten = events.worktreeChanged.listen(({ payload: { issueId } }) => {
      void drain(issueId);
    });
    return () => {
      disposed = true;
      void unlisten.then((off) => off());
    };
  }, [repo, qc]);
};

// ── Multi-repo fan-out ───────────────────────────────────────────────────────
// The same repo-scoped reads run across several repos at once for the sidebar's
// project tree. They reuse the single-repo query keys, so both share one cache.

/**
 * Run one repo-scoped read per repo and index the results by repo — the shape
 * the sidebar's project tree needs, where "the active repo" doesn't apply.
 *
 * Uses the SAME query keys as the single-repo hooks above, so the two share one
 * cache: rendering the tree doesn't refetch what Trees already loaded, and an
 * invalidation from either side updates both.
 */
function useResultsByRepo<T>(
  repos: string[],
  keyFor: (repo: string) => QueryKey,
  command: (repo: string) => CommandResult<T>,
  staleTime: number,
): Map<string, T> {
  const results = useQueries({
    queries: repos.map((repo) => ({
      queryKey: keyFor(repo),
      queryFn: () => unwrap(command(repo)),
      staleTime,
    })),
  });
  // `useQueries` returns a fresh array every render, so memoising on it directly
  // would rebuild the map (and re-render every consumer) on every render. The
  // update stamps change only when data actually changes, which is the real dep.
  const signature = results.map((r) => r.dataUpdatedAt).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on `signature` (see above) rather than the unstable `results` identity.
  return useMemo(() => {
    const map = new Map<string, T>();
    repos.forEach((repo, i) => {
      const data = results[i]?.data;
      if (data !== undefined) map.set(repo, data);
    });
    return map;
  }, [repos, signature]);
}

/** {@link useWorktrees} across several repos at once, keyed by repo. */
export const useWorktreesByRepo = (repos: string[]) =>
  useResultsByRepo(repos, queryKeys.worktrees, commands.worktrees, WORKTREE_STALE_TIME);

/** {@link useBaseWorktree} across several repos at once, keyed by repo. */
export const useBaseWorktreesByRepo = (repos: string[]) =>
  useResultsByRepo(repos, queryKeys.baseWorktree, commands.baseWorktree, WORKTREE_STALE_TIME);

/** {@link useTasks} across several repos at once, keyed by repo. */
export const useTasksByRepo = (repos: string[]) =>
  useResultsByRepo(repos, queryKeys.tasks, commands.linearListIssues, TASKS_STALE_TIME);

/** {@link useWorktreePrs} across several repos at once, keyed by repo. */
export const useWorktreePrsByRepo = (repos: string[]) =>
  useResultsByRepo(repos, queryKeys.worktreePrs, commands.worktreePrs, WORKTREE_STALE_TIME);

// ── Worktree lifecycle: create, remove, sync ─────────────────────────────────
// The writes that make or unmake a worktree, plus the branch-level syncs. Each is
// non-idempotent, so the callers keep them mounted rather than conditionally rendered.

/** What one {@link useCreateWorktree} call is asked to make. `launch` is the
 *  worktree's origin (see the Rust `WorktreeLaunch`) and decides both the branch
 *  and whether there is a Linear project behind it. */
export interface CreateWorktreeVars {
  /** The project to create it in. A var rather than a hook argument because the
   *  answer arrives at click time: the Work gate resolves it per ticket, and a
   *  hook bound at render can only ever hold the project the view was already
   *  showing — which is how a ticket used to start in the wrong one. */
  repo: string;
  issueId: string;
  title: string;
  launch: WorktreeLaunch;
  /** The parent worktree's branch — a *stacked* worktree — or null for the
   *  repo's default branch. */
  base: string | null;
  agent: AgentKind | null;
  /** The ticket `base` belongs to. Toast copy only: the backend takes the
   *  branch, and this just lets the confirmation name what it stacked on. */
  stackedOn?: string;
  /** Suppress the success toast — a bulk launch raises one summary toast for the
   *  whole batch instead of N near-identical ones, and a caller that goes on to
   *  do something visible (open the tree, start an agent) has already said so. */
  quiet?: boolean;
}

/** The confirmation for one create, in the origin's own terms. */
function createdWorktreeMessage(worktree: Worktree, vars: CreateWorktreeVars): string {
  if (vars.launch.type === "pr") return `Opened ${worktree.branch} as a tree.`;
  if (vars.launch.type === "ticket")
    return vars.stackedOn
      ? `Created worktree for ${worktree.id}, stacked on ${vars.stackedOn}.`
      : `Created worktree for ${worktree.id}.`;
  return `Created worktree ${worktree.id} on ${worktree.branch}.`;
}

/**
 * Create a worktree — from a ticket, from a branch picked or typed in the
 * "Create worktree" dialog, or from someone else's pull request. One hook for
 * all three, because they are one command and one concept: the `launch` origin
 * is the only thing they differ on.
 *
 * The immediate "Creating workspace…" feedback is owned by `pendingLaunches` in
 * AppContext (merged into the Trees list at display time) rather than a cache
 * patch — a patch here gets clobbered by the refetch the Trees mount triggers.
 *
 * `silent` is for a caller that renders the failure itself: the Create-worktree
 * dialog stays open on an error, because a name git refuses is fixed where it
 * was typed, not read off a toast after the form has closed.
 */
export const useCreateWorktree = (opts?: { silent?: boolean }) =>
  useActionMutation({
    mutationFn: (a: CreateWorktreeVars) =>
      unwrap(commands.createWorktree(a.repo, a.issueId, a.title, a.launch, a.base, a.agent)),
    silent: opts?.silent,
    // The branch list as well as the worktree list, for every origin: each one
    // either creates a branch or takes an existing one into a checkout, and
    // either way `repo_branches`' `hasWorktree` flag is now wrong — a reopened
    // dialog would offer a branch git can no longer check out.
    //
    // NOT tasks, though. The graph relies on the `tasks` query reference staying
    // stable (re-firing fitView mid-rebuild blanks the canvas), and a full graph
    // refetch on every launch is heavy. The WIP badge already signals "being
    // worked on"; a moved Linear status refreshes on the next natural refetch.
    invalidate: (vars) => [queryKeys.worktrees(vars.repo), queryKeys.repoBranches(vars.repo)],
    success: (worktree, vars) => (vars.quiet ? null : createdWorktreeMessage(worktree, vars)),
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

/** Stop a running `.santree/init.sh` (the Setup tab's Stop button). The backend kills
 *  the script's PTY, so the run ends as a failed setup through the normal path — the
 *  streaming Channel in `AgentRuns` closes the tab itself, with nothing to invalidate. */
export const useCancelSetup = (repo: string) =>
  useActionMutation({
    mutationFn: (issueId: string) => unwrap(commands.cancelWorktreeSetup(repo, issueId)),
    invalidate: () => [],
  });

/** A bulk delete where only *some* worktrees failed. Carries the survivors so the
 *  caller can un-hide exactly those and leave the genuinely-deleted ones hidden. */
export class BulkDeleteError extends Error {
  constructor(readonly failed: string[]) {
    super(`Couldn't delete ${failed.join(", ")}.`);
    this.name = "BulkDeleteError";
  }
}

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
      if (failed.length) throw new BulkDeleteError(failed);
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
    invalidate: () => [
      queryKeys.worktrees(repo),
      queryKeys.baseWorktree(repo),
      queryKeys.worktreePrs(repo),
    ],
    success: () => "Pushed to origin.",
  });

/** Integrate origin/<branch> into the worktree's own branch — pulls commits added
 *  to the branch remotely (PR-UI suggestions, "Update branch", a teammate's push).
 *  Fast-forwards when possible, else merges; refuses up front (nothing touched)
 *  when the merge would conflict. */
export const usePullRemoteWorktree = (repo: string) =>
  useActionMutation({
    mutationFn: (issueId: string) => unwrap(commands.pullRemoteWorktree(repo, issueId)),
    invalidate: (issueId) => [
      queryKeys.worktrees(repo),
      queryKeys.baseWorktree(repo),
      queryKeys.worktreeStatus(repo, issueId),
    ],
    success: () => "Pulled from origin.",
  });

/** Fast-forward the repo's local base branch (main/master) to origin. */
export const useUpdateBaseBranch = (repo: string) =>
  useActionMutation({
    mutationFn: (issueId: string) => unwrap(commands.updateBaseBranch(repo, issueId)),
    invalidate: () => [queryKeys.worktrees(repo), queryKeys.baseWorktree(repo)],
    success: (base) => `Updated ${base} from origin.`,
  });

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

// ── Staging, commits and opening a PR ────────────────────────────────────────
// The commit box, end to end. Everything that touches the git index shares
// `gitIndexScope` so two index writes on one worktree can never interleave.

/**
 * The shared serialization scope for everything that reads or writes one
 * worktree's git index — staging, discarding, committing, and the AI message
 * draft that reads `git diff --cached`.
 *
 * React Query runs same-scope mutations one at a time, **in call order**, which is
 * the part the backend's index lock can't supply on its own: each Tauri command is
 * dispatched as its own task, so a mutex grants them in arrival order, which isn't
 * necessarily the order they were clicked. Toggling a file on and then off could
 * otherwise land as off-then-on, leaving the index staged while the UI shows it
 * unstaged. Queueing here keeps the two ends telling the same story — and keeps a
 * commit behind the staging clicks that preceded it, so it can never capture a
 * selection the user hasn't finished making.
 *
 * This costs nothing visually: the optimistic cache patch runs on `onMutate`,
 * before the queue gate, so every click still repaints immediately.
 */
const gitIndexScope = (repo: string, id: string) => ({ id: `git-index:${repo}:${id}` });

/** Draft a commit message from the staged diff (headless `claude -p`).
 *
 *  Deliberately *not* in {@link gitIndexScope}: it only reads the index, and it
 *  waits on a multi-second model call — queueing staging clicks behind it would
 *  hold their optimistic patches open long enough for a watcher-driven status
 *  refetch to reconcile them away, flipping checkboxes back under the user. */
export const useCommitMessage = (repo: string) =>
  useMutation({
    mutationFn: (id: string) => unwrap(commands.commitMessage(repo, id)),
  });

/** Commit a worktree (optionally staging everything first). A commit only touches
 *  git metadata, which the filesystem watcher deliberately skips — so the cached
 *  per-file diffs (and the sources the viewer expands from) have to be dropped
 *  here, or a just-committed file still renders its pre-commit diff as pending. */
export const useCommitWorktree = (repo: string, id: string) =>
  useActionMutation({
    mutationFn: (a: { message: string; stageAll: boolean }) =>
      unwrap(commands.commitWorktree(repo, id, a.message, a.stageAll)),
    invalidate: () => [
      queryKeys.worktreeStatus(repo, id),
      queryKeys.worktreeFileDiffPrefix(repo, id),
      queryKeys.worktreeFileSourcePrefix(repo, id),
      queryKeys.worktreeBranchChanges(repo, id),
      queryKeys.worktreeBranchFileDiffPrefix(repo, id),
      queryKeys.worktrees(repo),
      queryKeys.baseWorktree(repo),
    ],
    success: () => "Committed.",
    // Queues behind any staging click still in flight, so the commit can only ever
    // capture the selection the user has finished making.
    scope: gitIndexScope(repo, id),
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
/** Whether a staging target covers a file: the file itself, or a directory it
 *  sits under. Folder rows stage with the directory path — `git add <dir>` — so
 *  the optimistic patch has to move every file beneath it, not just an exact
 *  match, or a folder's whole subtree sits unchanged until the refetch lands.
 *  Matched on the path boundary so `src` never captures `src2/…`. */
const stageTargets = (path: string, target: string | undefined) =>
  target !== undefined && (path === target || path.startsWith(`${target}/`));

export function applyStage(files: ChangedFile[], a: StageVars): ChangedFile[] {
  switch (a.action) {
    case "stage":
      return files.map((f) => (stageTargets(f.path, a.path) ? { ...f, staged: true } : f));
    case "unstage":
      return files.map((f) => (stageTargets(f.path, a.path) ? { ...f, staged: false } : f));
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
    // ...and each one is a separate `git` process contending for the same
    // `.git/index.lock`, which git fails rather than queues. Run them one at a
    // time, in click order.
    scope: gitIndexScope(repo, id),
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
      const diffPrefix = queryKeys.worktreeFileDiffPrefix(repo, id);
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

/** Draft a PR title + body for the create-PR dialog. `fill` runs the AI draft;
 *  otherwise it returns the raw PR template + first-commit-subject title. */
export const usePrDraft = (repo: string) =>
  useMutation({
    mutationFn: (a: { id: string; fill: boolean; sendTranscripts: boolean }) =>
      unwrap(commands.prDraft(repo, a.id, a.fill, a.sendTranscripts)),
    // The dialog shows draft errors inline; don't double-surface as a toast.
    meta: { silent: true },
  });

/** Whether the worktree has any Claude session transcript on disk — gates the PR
 *  dialog's "use transcripts" checkbox so it only appears when there's history to
 *  send. Cheap and rarely changes while the dialog is open. */
export const useWorktreeHasTranscripts = (repo: string, id: string) =>
  useUnwrappedQuery(
    queryKeys.worktreeHasTranscripts(repo, id),
    () => commands.worktreeHasTranscripts(repo, id),
    { enabled: !!repo && !!id, staleTime: SETTING_STALE_TIME },
  );

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

// ── Worktree agent tabs, prompts and session history ─────────────────────────
// The main area's tabs and what they relaunch with: the persisted tab rows, the
// on-disk prompt a launch is seeded from, and the past sessions a tab can resume.

/** The agent sessions that have run in a worktree, newest first. Sessions end
 *  and transcripts grow without an event we listen for, so this refetches on a
 *  slow interval while the panel is mounted. */
export const useWorktreeSessions = (repo: string, id: string) =>
  useUnwrappedQuery(
    queryKeys.worktreeSessions(repo, id),
    () => commands.worktreeSessions(repo, id),
    { enabled: !!repo && !!id, staleTime: 15_000, refetchInterval: 30_000 },
  );

/** What a session's history row shows once it is expanded: the full first
 *  prompt (kept out of the list, where it would bloat every scan) and the tail
 *  of the conversation. `enabled` is the collapsed row's cost — nothing.
 *
 *  `placeholderData: keepPreviousData` so a background refetch doesn't blank an
 *  open row; the transcript is append-only, so what's shown stays true. */
export const useWorktreeSessionDetail = (
  repo: string,
  id: string,
  sessionId: string,
  enabled: boolean,
) =>
  useUnwrappedQuery(
    queryKeys.worktreeSessionDetail(repo, id, sessionId),
    () => commands.worktreeSessionDetail(repo, id, sessionId),
    {
      enabled: enabled && !!repo && !!id && !!sessionId,
      staleTime: 30_000,
      placeholderData: keepPreviousData,
    },
  );

/** The Task subagents of one session, flat, each carrying the parent and depth
 *  its sidecar records — the pane nests them. Gate `enabled` on the session's
 *  own `subagentCount` so a session with none reads nothing from disk. */
export const useWorktreeSessionSubagents = (
  repo: string,
  id: string,
  sessionId: string,
  enabled: boolean,
) =>
  useUnwrappedQuery(
    queryKeys.worktreeSessionSubagents(repo, id, sessionId),
    () => commands.worktreeSessionSubagents(repo, id, sessionId),
    {
      enabled: enabled && !!repo && !!id && !!sessionId,
      staleTime: 30_000,
      placeholderData: keepPreviousData,
    },
  );

/** Reveal a session's transcript in the OS file browser. The backend derives the
 *  path from the same validated listing the pane reads — the webview names a
 *  session, never a file. */
export const useRevealSessionTranscript = (repo: string, id: string) =>
  useActionMutation<string>({
    mutationFn: (sessionId) =>
      unwrap(commands.revealWorktreeSessionTranscript(repo, id, sessionId)),
  });

/** Point a freshly-minted agent tab at one of the worktree's past sessions, so
 *  that tab launches into the same conversation. The backend re-points the tab's
 *  session row and stops there — the `--resume` line is still built by the tab's
 *  own launch, on the click that opened it.
 *
 *  The caller mints `tabId` (like every other tab), so the row this patches is
 *  the tab it is about to persist and focus. Await it before either: a pane that
 *  mounts first resolves a *fresh* session and the resume is lost. */
export const useResumeWorktreeSession = (repo: string, id: string) =>
  useOptimisticMutation<{ tabId: string; sessionId: string; agentKind: AgentKind }, null>({
    mutationFn: ({ tabId, sessionId, agentKind }) =>
      unwrap(commands.resumeWorktreeSession(repo, id, tabId, sessionId, agentKind)),
    // The session now belongs to the new tab — the one thing the write changes
    // that a cached read already holds.
    optimistic: (qc, { tabId, sessionId }) => {
      const key = queryKeys.worktreeSessions(repo, id);
      const prev = qc.getQueryData<WorktreeSession[]>(key);
      qc.setQueryData<WorktreeSession[]>(key, (cur = []) =>
        cur.map((s) =>
          s.sessionId === sessionId ? { ...s, termKey: `tree:${id}:tab:${tabId}` } : s,
        ),
      );
      return () => qc.setQueryData(key, prev);
    },
    invalidate: ({ tabId }) => [
      queryKeys.worktreeSessions(repo, id),
      queryKeys.sessionProviders(repo, `tree:${id}:tab:${tabId}`),
    ],
  });

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

/** The PATH of the on-disk Triage-investigation prompt for a ticket. Like
 *  {@link useWorkPrompt} but for the Investigate action: the backend renders the
 *  `triage` template from the live ticket, extracts the ticket's screenshots to
 *  files the agent can `Read`, writes the prompt to a file, and returns its path;
 *  the terminal seeds `claude 'Read <path> …'`. `staleTime: 0` so every fresh
 *  launch re-renders (new comments/screenshots) and overwrites. */
export const useInvestigatePrompt = (repo: string, id: string, enabled: boolean) =>
  useUnwrappedQuery(
    queryKeys.investigatePrompt(repo, id),
    () => commands.investigatePrompt(repo, id),
    { enabled: enabled && !!repo && !!id, staleTime: 0 },
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
      unwrap(
        commands.addWorktreeTab(
          repo,
          tab.worktreeId,
          tab.id,
          tab.kind,
          tab.agentKind,
          tab.title,
          tab.pr,
        ),
      ),
    optimistic: (qc, tab) => {
      const key = queryKeys.worktreeTabs(repo);
      const prev = qc.getQueryData<WorktreeTab[]>(key);
      qc.setQueryData<WorktreeTab[]>(key, (cur = []) => [...cur, tab]);
      return () => qc.setQueryData(key, prev);
    },
    invalidate: () => [queryKeys.worktreeTabs(repo)],
  });

/** What a persisted review tab relaunches with — its `--settings` (the review deny
 *  list) and its `--mcp-config` (santree's review tools, scoped to the tab's PR),
 *  re-derived by the backend from the stored row.
 *
 *  The in-memory hand-off that carries these on a first launch dies with the app,
 *  so without this a tab resumed after a restart fell back to the plain no-git
 *  settings — losing the `gh` deny list and the review tools with no error. Cached
 *  indefinitely: the answer is a function of the row, which only changes when the
 *  tab is replaced. */
export const useWorktreeTabLaunch = (repo: string, id: string, enabled: boolean) =>
  useUnwrappedQuery(
    queryKeys.worktreeTabLaunch(repo, id),
    () => commands.worktreeTabLaunch(repo, id),
    { enabled: enabled && !!repo && !!id, staleTime: Number.POSITIVE_INFINITY },
  );

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

// ── Pull requests ────────────────────────────────────────────────────────────
// PR data for both hosts — your own PR in Trees and other people's in Reviews.
// One set of hooks, because the difference is which view mounts them, not the data.

/** Live PR status (number/url/state) for the repo's worktrees, from GitHub. Empty
 *  when `gh` isn't authenticated. Cached a minute — merge state changes server-side
 *  and the user can refetch by revisiting. */
export const useWorktreePrs = (repo: string) =>
  useUnwrappedQuery(queryKeys.worktreePrs(repo), () => commands.worktreePrs(repo), {
    enabled: !!repo,
    staleTime: WORKTREE_STALE_TIME,
  });

/** One PR's summary row — the same shape the Reviews inbox ships, fetched by
 *  number. This is what the Trees right panel renders for a worktree's own PR:
 *  `useWorktreePrs` carries only number/url/state, and the panel needs the title,
 *  the checks rollup, the review decision and the node id a comment is written
 *  against. `null` when `gh` isn't authenticated or the PR is gone.
 *
 *  Same one-minute staleTime as `useReviews`, for the same reason — PR state
 *  changes server-side, and ⌘⇧R re-pulls it with the other external reads. */
export const usePrSummary = (prRepo: string | null, number: number) =>
  useUnwrappedQuery(
    queryKeys.prSummary(prRepo ?? "", number),
    () => {
      const [owner, name] = splitRepoSlug(prRepo ?? "");
      return commands.prSummary(owner, name, number);
    },
    { enabled: !!prRepo && number > 0, staleTime: 60_000 },
  );

/** The Reviews dashboard inbox (my PRs / review requests / per-team) across every
 *  registered project — which it names back, with the orgs it searched and whether
 *  `gh` was connected, so an empty inbox can say what it covered. Deliberately not
 *  keyed by repo: the inbox spans the registry, so scoping it to the selected
 *  project answered for one org and stayed silent about the rest. Cached a minute —
 *  PR state changes server-side and the user can refetch by revisiting. */
export const useReviews = () =>
  useUnwrappedQuery(queryKeys.reviews(), () => commands.reviews(), { staleTime: 60_000 });

/** Linear project/title for each of `ids` — what lets the Reviews sidebar group
 *  PRs by project. Empty when no Linear org is connected (the sidebar then just
 *  doesn't offer the grouping). Cached long: a ticket's project rarely moves, and
 *  the key already changes whenever the inbox's ticket set does. */
export const usePrTickets = (repo: string, ids: string[], enabled = true) =>
  useUnwrappedQuery(queryKeys.prTickets(repo, ids), () => commands.prTickets(repo, ids), {
    enabled: enabled && !!repo && ids.length > 0,
    staleTime: 10 * 60_000,
  });

/**
 * {@link usePrTickets} for several projects at once, keyed by project.
 *
 * One query per project rather than one big one, because the Linear org is a
 * *per-repo* binding (Settings → Repo → Linear): two registered projects can
 * resolve `AK-12` in two different workspaces, and asking one of them for both
 * would answer confidently with the wrong ticket. The keys are the single-repo
 * hook's own, so the sidebar and the Reviews view share one cache.
 *
 * `enabled` is the grouping switch: with the section flat there is nothing to
 * resolve, and this should cost no Linear call at all.
 */
export const usePrTicketsByRepo = (
  idsByRepo: Map<string, string[]>,
  enabled = true,
): Map<string, TicketRef[]> => {
  const entries = [...idsByRepo];
  const results = useQueries({
    queries: entries.map(([repo, ids]) => ({
      queryKey: queryKeys.prTickets(repo, ids),
      queryFn: () => unwrap(commands.prTickets(repo, ids)),
      enabled: enabled && ids.length > 0,
      staleTime: 10 * 60_000,
    })),
  });
  const signature = results.map((r) => r.dataUpdatedAt).join("|");
  const repos = entries.map(([repo]) => repo).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the stamps and the repo list, not on `useQueries`' fresh-every-render identity (see `useResultsByRepo`).
  return useMemo(() => {
    const byRepo = new Map<string, TicketRef[]>();
    entries.forEach(([repo], i) => {
      const data = results[i]?.data;
      if (data !== undefined) byRepo.set(repo, data);
    });
    return byRepo;
  }, [repos, signature]);
};

/** The active repo's merge queue (its default branch's queue) — the ordered PRs
 *  waiting to merge, for the Reviews tab's merge-queue panel. Always resolves to
 *  the `owner/name` it asked about plus whether `gh` could be asked; `queue` is
 *  `null` when that repo has no merge queue. Positions shift as PRs merge, so
 *  it's cached only briefly and refetches on revisit. */
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

/** The repo's full label palette — the options for the PR label picker. Gated by
 *  `enabled` so it only fetches when the picker is opened (labels rarely change, so
 *  a long staleTime avoids refetching per open). */
export const useRepoLabels = (owner: string, name: string, enabled: boolean) =>
  useUnwrappedQuery(queryKeys.prRepoLabels(owner, name), () => commands.prRepoLabels(owner, name), {
    enabled: enabled && !!owner && !!name,
    staleTime: 5 * 60_000,
  });

/** Replace a PR's labels (GitHub PUT semantics — the whole set is overwritten).
 *  Optimistically patches the cached PR detail's `labels` so the header updates
 *  instantly, then reconciles with the authoritative set the API returns (no full
 *  detail refetch). Rolls back and red-toasts on failure. */
export const useSetPrLabels = (owner: string, name: string, number: number) => {
  const qc = useQueryClient();
  const key = queryKeys.prDetail(owner, name, number);
  return useMutation({
    // `next` carries full label objects for the optimistic patch (colors and all);
    // only the names go to the API.
    mutationFn: (next: PrLabel[]) =>
      unwrap(
        commands.setPrLabels(
          owner,
          name,
          number,
          next.map((l) => l.name),
        ),
      ),
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<PrDetail>(key);
      if (prev) qc.setQueryData<PrDetail>(key, { ...prev, labels: next });
      return { prev };
    },
    onError: (_err, _next, ctx) => {
      if (ctx?.prev) qc.setQueryData<PrDetail>(key, ctx.prev);
    },
    onSuccess: (labels) => {
      // The API returns the resulting set — adopt it verbatim (order/casing).
      qc.setQueryData<PrDetail>(key, (d) => (d ? { ...d, labels } : d));
    },
  });
};

/** The cached detail of a PR the caller knows by its `owner/name` slug — the write
 *  hooks below all reconcile through it, since every one of them changes what the
 *  conversation, the threads, or the pending review look like. */
const prDetailKey = (prRepo: string, number: number) => {
  const [owner, name] = splitRepoSlug(prRepo);
  return queryKeys.prDetail(owner, name, number);
};

/**
 * Leave an inline review comment on a PR line — the diff's `+` button.
 *
 * `pending` picks between GitHub's two halves: post it now, or stack it into the
 * viewer's pending review (invisible to the author until it's submitted). Not
 * optimistic: a comment that appears in the diff and then vanishes because GitHub
 * rejected the line is worse than a beat of latency, and the round-trip is one
 * REST call.
 *
 * Every hook in this block is the **user** writing. Nothing in santree's AI review
 * surfaces can reach these — they get no posting command at all.
 */
export const useAddPrInlineComment = (prRepo: string, number: number) =>
  useActionMutation<NewInlineComment, null>({
    mutationFn: (c) => unwrap(commands.addPrInlineComment(c)),
    invalidate: () => [prDetailKey(prRepo, number)],
    success: (_d, c) => (c.pending ? "Added to your review." : "Comment posted."),
  });

/** Reply under an existing inline review thread. */
export const useReplyToPrThread = (prRepo: string, number: number) =>
  useActionMutation<{ replyToId: string; body: string }, null>({
    mutationFn: (v) => unwrap(commands.replyToPrThread(prRepo, number, v.replyToId, v.body)),
    invalidate: () => [prDetailKey(prRepo, number)],
    success: () => "Reply posted.",
  });

/** Resolve an inline review thread, or reopen it. Optimistic: the card collapses
 *  the moment it's clicked, since the whole point is clearing what you've dealt
 *  with, and a resolve that lags reads as a dead button. */
export const useSetPrThreadResolved = (prRepo: string, number: number) =>
  useOptimisticMutation<{ threadId: string; resolved: boolean }, null>({
    mutationKey: ["set-pr-thread-resolved", prRepo, number],
    mutationFn: (v) => unwrap(commands.setPrThreadResolved(v.threadId, v.resolved)),
    optimistic: (qc, v) => {
      const key = prDetailKey(prRepo, number);
      const prev = qc.getQueryData<PrDetail>(key);
      qc.setQueryData<PrDetail>(key, (d) =>
        d
          ? {
              ...d,
              threads: d.threads.map((t) =>
                t.id === v.threadId ? { ...t, isResolved: v.resolved } : t,
              ),
            }
          : d,
      );
      return () => qc.setQueryData(key, prev);
    },
    invalidate: () => [prDetailKey(prRepo, number)],
  });

/** Submit the viewer's pending review — its draft comments become visible and the
 *  verdict (comment / approve / request changes) lands on the PR. Also refreshes
 *  the inbox: the sidebar buckets on whether you've reviewed a PR. */
export const useSubmitPrReview = (prRepo: string, number: number) =>
  useActionMutation<{ reviewId: string; event: ReviewEvent; body: string }, null>({
    mutationFn: (v) => unwrap(commands.submitPrReview(v.reviewId, v.event, v.body)),
    // The submit dialog shows GitHub's rejection inline and stays open to retry
    // ("Can not approve your own pull request"), so a toast would double it.
    silent: true,
    invalidate: () => [prDetailKey(prRepo, number), queryKeys.reviews()],
    success: (_d, v) =>
      v.event === "Approve"
        ? "Approved."
        : v.event === "RequestChanges"
          ? "Changes requested."
          : "Review submitted.",
  });

/** Discard the viewer's pending review and every draft comment in it. */
export const useDiscardPrReview = (prRepo: string, number: number) =>
  useActionMutation<string, null>({
    mutationFn: (reviewId) => unwrap(commands.discardPrReview(reviewId)),
    // Confirmed in a dialog that owns its own error UI.
    silent: true,
    invalidate: () => [prDetailKey(prRepo, number)],
    success: () => "Draft review discarded.",
  });

/** Post a top-level comment on a PR's conversation (not anchored to a diff line). */
export const useAddPrConversationComment = (prRepo: string, number: number) =>
  useActionMutation<string, null>({
    mutationFn: (body) => unwrap(commands.addPrComment(prRepo, number, body)),
    invalidate: () => [prDetailKey(prRepo, number)],
    success: () => "Comment posted.",
  });

/** One PR file's old (base) + new (head) full contents, fetched on demand so the
 *  diff can expand unchanged context (GitHub-style). Gated by `enabled` so it only
 *  fires for an expanded, non-binary file. Content at a commit is immutable, so
 *  it's cached forever. */
export const usePrFileSource = (
  owner: string,
  name: string,
  base: string,
  head: string,
  oldPath: string,
  newPath: string,
  enabled: boolean,
) =>
  useUnwrappedQuery(
    queryKeys.prFileSource(owner, name, base, head, oldPath, newPath),
    () => commands.prFileSource(owner, name, base, head, oldPath, newPath),
    {
      enabled: enabled && !!owner && !!name && !!base && !!head && !!oldPath && !!newPath,
      staleTime: Number.POSITIVE_INFINITY,
    },
  );

/** A failed GitHub Actions check's job log, sliced to the failing step, fetched on
 *  demand when the user expands the check (gated by `enabled`). A completed run's
 *  log is immutable, so it's cached forever. */
export const usePrCheckLog = (
  owner: string,
  name: string,
  jobId: number | null,
  enabled: boolean,
) =>
  useUnwrappedQuery(
    queryKeys.prCheckLog(owner, name, jobId ?? 0),
    () => commands.prCheckLog(owner, name, jobId),
    {
      enabled: enabled && !!owner && !!name && jobId != null,
      staleTime: Number.POSITIVE_INFINITY,
    },
  );

/** The files the user has marked "Viewed" for a PR, each with the blob SHA it was
 *  marked at. A file counts as reviewed only while its current [`PrFile.sha`]
 *  still equals the stored SHA (the caller compares) — so a commit that changes
 *  the file auto-drops the mark. Marks are local + durable, so never stale. */
export const useReviewedFiles = (prRepo: string, number: number, enabled = true) =>
  useUnwrappedQuery(
    queryKeys.reviewedFiles(prRepo, number),
    () => commands.reviewedFiles(prRepo, number),
    { enabled: enabled && !!prRepo && number > 0, staleTime: Number.POSITIVE_INFINITY },
  );

/** Toggle a PR file's "Viewed" mark in whichever store is live — this machine's
 *  table (against the file's blob SHA) or GitHub's own per-viewer state. `prId` is
 *  the PR's GraphQL node id, which the synced path marks against.
 *
 *  Optimistic — patches the marks cache so the checkbox + diff collapse react
 *  instantly even when the write is a GitHub round-trip; the mutationKey lets rapid
 *  toggles reconcile last-write-wins. The patch mirrors whichever variant is cached
 *  rather than assuming one: applying a local-shaped patch to synced marks would
 *  drop the toggle on the floor. */
export const useSetFileReviewed = (prRepo: string, number: number, prId: string) =>
  useOptimisticMutation<{ path: string; sha: string; reviewed: boolean }, null>({
    mutationKey: ["set-file-reviewed", prRepo, number],
    mutationFn: (v) =>
      unwrap(commands.setFileReviewed(prRepo, number, prId, v.path, v.sha, v.reviewed)),
    optimistic: (qc, v) => {
      const key = queryKeys.reviewedFiles(prRepo, number);
      const prev = qc.getQueryData<ViewedMarks>(key);
      qc.setQueryData<ViewedMarks>(key, (cur) => {
        // Nothing cached yet: the load in flight brings the truth, and inventing a
        // variant here would guess at which store is live.
        if (!cur) return cur;
        if (cur.source === "synced") {
          const rest = cur.paths.filter((p) => p !== v.path);
          return { ...cur, paths: v.reviewed ? [...rest, v.path] : rest };
        }
        const rest = cur.files.filter((f) => f.path !== v.path);
        return { ...cur, files: v.reviewed ? [...rest, { path: v.path, sha: v.sha }] : rest };
      });
      return () => qc.setQueryData(key, prev);
    },
    invalidate: () => [queryKeys.reviewedFiles(prRepo, number)],
  });

/** Flip whether "Viewed" marks live on GitHub or on this machine.
 *
 *  Beyond writing the setting it drops every PR's cached marks: the two stores
 *  answer in different shapes and with different staleness rules, so a cache from
 *  the old source would otherwise sit there — showing marks the new source doesn't
 *  have — until something else happened to refetch it. */
export const useSetSyncViewed = () =>
  useOptimisticMutation<boolean, null>({
    mutationKey: ["set-sync-viewed"],
    mutationFn: (on) => unwrap(commands.setSetting("app", SYNC_VIEWED_KEY, on ? "true" : "false")),
    optimistic: (qc, on) =>
      patchSettingCache(qc, {
        scope: "app",
        key: SYNC_VIEWED_KEY,
        value: on ? "true" : "false",
      }),
    invalidate: () => [queryKeys.setting("app", SYNC_VIEWED_KEY), queryKeys.reviewedFilesPrefix],
  });

// ── AI review: brief, drafts, work items and checkouts ───────────────────────
// santree's own rows, written by the review agent's MCP tools and never visible on
// GitHub until a click: `usePublishReviewDrafts` is the only path out of here.

/**
 * The read-only checkout of a PR's head that an AI review session runs in, created
 * on demand. `null` when the PR lives in a repo santree has no clone of — the
 * session then runs diff-only, which the pane says out loud.
 *
 * Keyed on the head SHA so a PR that gains commits gets a fresh checkout instead
 * of an agent reading last week's code. `staleTime: Infinity` because the backend
 * call is find-or-create: once a key has resolved, re-running it would only redo
 * a fetch that changed nothing.
 */
export const useReviewWorkspace = (repo: string, target: ReviewTarget | null, enabled: boolean) => {
  const query = useUnwrappedQuery(
    queryKeys.reviewWorkspace(
      repo,
      target?.prRepo ?? "",
      target?.number ?? 0,
      target?.headSha ?? "",
    ),
    // biome-ignore lint/style/noNonNullAssertion: gated by `enabled` below.
    () => commands.reviewWorkspace(repo, target!),
    { enabled: enabled && !!repo && !!target?.headSha, staleTime: Number.POSITIVE_INFINITY },
  );
  // Creating the checkout is what makes its worktree row exist, and the rail's
  // panes are a sibling of whatever asked for it — so the row they read is
  // announced here rather than left until something else happens to refetch.
  const { data: path } = query;
  const qc = useQueryClient();
  const prRepo = target?.prRepo ?? "";
  const number = target?.number ?? 0;
  useEffect(() => {
    if (path)
      void qc.invalidateQueries({ queryKey: queryKeys.reviewCheckout(repo, prRepo, number) });
  }, [path, qc, repo, prRepo, number]);
  return query;
};

/** The AI review's checkout of a PR, when one exists — the fallback the rail's
 *  branch panes read for a pull request with no worktree of its own. `null` until
 *  a review has run for it. Never creates one; see `useReviewWorkspace`
 *  for moving a stale one to the PR's current head. */
export const useReviewCheckout = (repo: string, prRepo: string, number: number) =>
  useUnwrappedQuery(
    queryKeys.reviewCheckout(repo, prRepo, number),
    () => commands.reviewCheckout(repo, prRepo, number),
    { enabled: !!repo && !!prRepo && number > 0, staleTime: WORKTREE_STALE_TIME },
  );

/** Close one provider's AI review on a PR — the tab's ✕.
 *
 *  Forgets the stored conversation so the tab doesn't come back on the next
 *  launch. The drafts it wrote and its transcript both outlive it, which is what
 *  makes reopening from Session history the same review rather than a new one. */
export const useCloseReviewSession = (repo: string) => {
  return useActionMutation<{ prRepo: string; number: number; agent: AgentKind }, null>({
    mutationFn: ({ prRepo, number, agent }) =>
      unwrap(commands.closeReviewSession(repo, prRepo, number, agent)),
    invalidate: ({ prRepo, number }) => [
      queryKeys.sessionProviders(repo, `ai-review:${prRepo}#${number}`),
    ],
  });
};

/** Close one provider's investigation on a triage ticket — the tab's ✕.
 *
 *  Forgets the stored `triage:<ticketId>` conversation for that provider so the
 *  tab doesn't come back on the next launch. The agent's own transcript is
 *  untouched; only santree's record of where it left off goes. */
export const useCloseInvestigationSession = (repo: string) =>
  useOptimisticMutation<{ ticketId: string; agent: AgentKind }, null>({
    mutationKey: ["close-investigation", repo],
    mutationFn: ({ ticketId, agent }) =>
      unwrap(commands.closeInvestigationSession(repo, ticketId, agent)),
    // The tab is the stored row's presence, so the row leaves the cache on the
    // click — otherwise a closed tab sits in the strip until the delete and the
    // refetch both land, looking like the ✕ did nothing.
    optimistic: (qc, { ticketId, agent }) => {
      const startedKey = queryKeys.startedInvestigations(repo);
      const providersKey = queryKeys.sessionProviders(repo, `triage:${ticketId}`);
      const started = qc.getQueryData<TriageSession[]>(startedKey);
      const providers = qc.getQueryData<AgentKind[]>(providersKey);
      if (started) {
        qc.setQueryData<TriageSession[]>(
          startedKey,
          started.filter((s) => !(s.refId === ticketId && s.agentKind === agent)),
        );
      }
      if (providers) {
        qc.setQueryData<AgentKind[]>(
          providersKey,
          providers.filter((kind) => kind !== agent),
        );
      }
      return () => {
        if (started) qc.setQueryData(startedKey, started);
        if (providers) qc.setQueryData(providersKey, providers);
      };
    },
    invalidate: ({ ticketId }) => [
      queryKeys.startedInvestigations(repo),
      queryKeys.sessionProviders(repo, `triage:${ticketId}`),
    ],
  });

/** Keep a PR's checkout: it stops being labelled a review and appears in Trees
 *  like any other worktree.
 *
 *  There is one checkout per pull request now, so "work on this PR" is a change
 *  of label rather than a second directory — which is why this is a tiny mutation
 *  and not another create. */
export const usePromoteReviewWorktree = (repo: string) => {
  const qc = useQueryClient();
  return useActionMutation<{ prRepo: string; number: number }, null>({
    mutationFn: ({ prRepo, number }) =>
      unwrap(commands.promoteReviewWorktree(repo, prRepo, number)),
    invalidate: ({ prRepo, number }) => {
      const checkoutRepo = qc.getQueryData<ReviewCheckout | null>(
        queryKeys.reviewCheckout(repo, prRepo, number),
      )?.repo;
      return [
        queryKeys.reviewCheckout(repo, prRepo, number),
        // It joins the worktree list it was being kept out of, so every read
        // built on that list has to look again.
        ...(checkoutRepo ? [queryKeys.worktrees(checkoutRepo), queryKeys.repos] : []),
      ];
    },
    success: () => "Kept as a worktree — it's in Trees now.",
  });
};

/** The cached AI review brief for a PR, or `null` when none exists yet. One row
 *  read — no model call — so the panel renders instantly and offers to generate. */
export const usePrReviewBrief = (prRepo: string, number: number) =>
  useUnwrappedQuery(
    queryKeys.prReviewBrief(prRepo, number),
    () => commands.prReviewBrief(prRepo, number),
    { enabled: !!prRepo && number > 0, staleTime: Number.POSITIVE_INFINITY },
  );

/** The three files an AI-review session launches with: its prompt, its `--settings`
 *  file, and the `--mcp-config` that gives it santree's review tools.
 *
 *  One query for all three because the terminal seed is built once, at spawn: a
 *  flag that resolves late is silently dropped, and the failure isn't symmetrical.
 *  A session without its MCP config looks fine until it has nowhere to put what it
 *  found; one without its settings has no deny list. `staleTime: 0` so each launch
 *  re-renders against the PR as it is now — including its current head, which the
 *  tools validate comment anchors against. */
export const useAiReviewLaunch = (repo: string, target: ReviewTarget | null, enabled: boolean) =>
  useUnwrappedQuery(
    queryKeys.aiReviewLaunch(repo, target?.prRepo ?? "", target?.number ?? 0),
    // biome-ignore lint/style/noNonNullAssertion: gated by `enabled` below.
    () => commands.aiReviewLaunch(repo, target!),
    { enabled: enabled && !!repo && !!target, staleTime: 0 },
  );

/** The AI review's draft comments for a PR: written by its MCP tools, held in
 *  santree, and invisible to GitHub until the user publishes them. Refreshed live
 *  by {@link useReviewAiWatcher} while a review session is writing. */
export const useReviewDrafts = (prRepo: string, number: number) =>
  useUnwrappedQuery(
    queryKeys.reviewDrafts(prRepo, number),
    () => commands.reviewDrafts(prRepo, number),
    { enabled: !!prRepo && number > 0, staleTime: 30_000 },
  );

export const useReviewWorkItems = (prRepo: string, number: number) =>
  useUnwrappedQuery(
    queryKeys.reviewWorkItems(prRepo, number),
    () => commands.reviewWorkItems(prRepo, number),
    { enabled: !!prRepo && number > 0, staleTime: Number.POSITIVE_INFINITY },
  );

export interface AddReviewWorkItem {
  id: string;
  body: string;
  source: ReviewWorkItemSource;
  sourceId: string | null;
  path: string | null;
  line: number | null;
  startLine: number | null;
  onRight: boolean | null;
}

export const useAddReviewWorkItem = (prRepo: string, number: number) =>
  useOptimisticMutation<AddReviewWorkItem, ReviewWorkItem>({
    mutationKey: ["add-review-work-item", prRepo, number],
    mutationFn: (item) => unwrap(commands.addReviewWorkItem(prRepo, number, item)),
    optimistic: (qc, item) =>
      patchWorkItems(qc, prRepo, number, (items) => [
        ...items.filter(
          (candidate) =>
            !(
              item.sourceId &&
              candidate.source === item.source &&
              candidate.sourceId === item.sourceId
            ),
        ),
        {
          ...item,
          prRepo,
          prNumber: number,
          done: false,
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
        },
      ]),
    invalidate: () => [queryKeys.reviewWorkItems(prRepo, number)],
  });

export const useUpdateReviewWorkItem = (prRepo: string, number: number) =>
  useOptimisticMutation<{ id: string; body: string; done: boolean }, ReviewWorkItem>({
    mutationKey: ["update-review-work-item", prRepo, number],
    mutationFn: ({ id, body, done }) =>
      unwrap(commands.updateReviewWorkItem(prRepo, number, id, body, done)),
    optimistic: (qc, update) =>
      patchWorkItems(qc, prRepo, number, (items) =>
        items.map((item) =>
          item.id === update.id ? { ...item, ...update, updatedAtMs: Date.now() } : item,
        ),
      ),
    invalidate: () => [queryKeys.reviewWorkItems(prRepo, number)],
  });

export const useDeleteReviewWorkItem = (prRepo: string, number: number) =>
  useOptimisticMutation<string, null>({
    mutationKey: ["delete-review-work-item", prRepo, number],
    mutationFn: (id) => unwrap(commands.deleteReviewWorkItem(prRepo, number, id)),
    optimistic: (qc, id) =>
      patchWorkItems(qc, prRepo, number, (items) => items.filter((item) => item.id !== id)),
    invalidate: () => [queryKeys.reviewWorkItems(prRepo, number)],
  });

function patchWorkItems(
  qc: QueryClient,
  prRepo: string,
  number: number,
  next: (items: ReviewWorkItem[]) => ReviewWorkItem[],
) {
  const key = queryKeys.reviewWorkItems(prRepo, number);
  const before = qc.getQueryData<ReviewWorkItem[]>(key);
  if (!before) return;
  qc.setQueryData(key, next(before));
  return () => qc.setQueryData(key, before);
}

/** Save an edit to a draft. Optimistic: it's a local row, so the round-trip is
 *  disk, and waiting on it would make editing feel like posting. */
export const useUpdateReviewDraft = (prRepo: string, number: number) =>
  useOptimisticMutation<{ id: string; body: string; suggestion: string | null }, ReviewDraft>({
    mutationKey: ["update-review-draft", prRepo, number],
    mutationFn: ({ id, body, suggestion }) =>
      unwrap(commands.updateReviewDraft(id, body, suggestion)),
    optimistic: (qc, { id, body, suggestion }) =>
      patchDrafts(qc, prRepo, number, (drafts) =>
        drafts.map((d) => (d.id === id ? { ...d, body, suggestion } : d)),
      ),
    invalidate: () => [queryKeys.reviewDrafts(prRepo, number)],
  });

/** Drop a draft the user doesn't want to send. */
export const useDeleteReviewDraft = (prRepo: string, number: number) =>
  useOptimisticMutation<string, null>({
    mutationKey: ["delete-review-draft", prRepo, number],
    mutationFn: (id) => unwrap(commands.deleteReviewDraft(id)),
    optimistic: (qc, id) => {
      const restoreDrafts = patchDrafts(qc, prRepo, number, (drafts) =>
        drafts.filter((d) => d.id !== id),
      );
      const restoreInboxes = patchAiDraftCount(qc, prRepo, number, -1);
      return () => {
        restoreDrafts?.();
        restoreInboxes();
      };
    },
    invalidate: () => [queryKeys.reviewDrafts(prRepo, number), queryKeys.reviewsPrefix],
  });

/** Patch the cached drafts and hand back the rollback. */
function patchDrafts(
  qc: QueryClient,
  prRepo: string,
  number: number,
  next: (drafts: ReviewDraft[]) => ReviewDraft[],
) {
  const key = queryKeys.reviewDrafts(prRepo, number);
  const before = qc.getQueryData<ReviewDraft[]>(key);
  if (!before) return;
  qc.setQueryData(key, next(before));
  return () => qc.setQueryData(key, before);
}

/** Keep the inbox spark count in lockstep with an optimistic local deletion.
 * Every category may carry the same PR, so patch all occurrences and all cached
 * repo inboxes; the settled invalidation reconciles with SQLite afterward. */
function patchAiDraftCount(qc: QueryClient, prRepo: string, number: number, delta: number) {
  const before = qc.getQueriesData<ReviewInbox>({ queryKey: queryKeys.reviewsPrefix });
  const patch = (pr: ReviewPr) =>
    pr.repo === prRepo && pr.number === number
      ? { ...pr, aiDraftCount: Math.max(0, pr.aiDraftCount + delta) }
      : pr;
  for (const [key, inbox] of before) {
    if (!inbox) continue;
    qc.setQueryData<ReviewInbox>(key, {
      ...inbox,
      mine: inbox.mine.map(patch),
      requested: inbox.requested.map(patch),
      teams: inbox.teams.map((team) => ({ ...team, prs: team.prs.map(patch) })),
    });
  }
  return () => {
    for (const [key, inbox] of before) qc.setQueryData(key, inbox);
  };
}

/** Send drafts to GitHub as comments in the user's pending review. **The one step
 *  in this flow that leaves the machine**, and it happens on a click.
 *
 *  Takes only draft ids: the commit they anchor to and the review they join are
 *  read from GitHub inside the command, so a stale value on screen can't send a
 *  comment to the wrong lines. Not optimistic either — a published draft is a real
 *  comment under the user's name, and the outcome carries how many actually went
 *  (it stops at the first failure). The PR detail is invalidated too, since the
 *  first comment may have opened the pending review the submit bar renders from. */
export const usePublishReviewDrafts = (
  prRepo: string,
  number: number,
  opts?: { silent?: boolean },
) => {
  const [owner, name] = splitRepoSlug(prRepo);
  return useActionMutation<string[], ReviewPublishOutcome>({
    mutationFn: (ids) => unwrap(commands.publishReviewDrafts(prRepo, number, ids)),
    invalidate: () => [
      queryKeys.reviewDrafts(prRepo, number),
      queryKeys.prDetail(owner, name, number),
      queryKeys.reviewsPrefix,
    ],
    success: (outcome, ids) =>
      outcome.failed
        ? null
        : ids.length === 1
          ? "Added to your review."
          : `Added ${outcome.published} comments to your review.`,
    silent: opts?.silent,
  });
};

/** Realtime refresh for the AI review's output: its MCP tools ping the signal
 *  socket (tagged `r`) after each write, the Rust listener emits
 *  `reviewAiChanged`, and we drop both caches it can touch. Mount once at the app
 *  root — a draft should appear in the diff while the user is reading it.
 *
 *  Whole prefixes rather than one PR's keys: the event carries no payload (the
 *  tables are tiny), and a review of another PR writing is a real case. */
export const useReviewAiWatcher = () => {
  const qc = useQueryClient();
  useEffect(() => {
    const unlisten = events.reviewAiChanged.listen(() => {
      qc.invalidateQueries({ queryKey: queryKeys.reviewDraftsPrefix });
      qc.invalidateQueries({ queryKey: queryKeys.prReviewBriefPrefix });
      qc.invalidateQueries({ queryKey: queryKeys.reviewsPrefix });
      qc.invalidateQueries({ queryKey: queryKeys.reviewWorkItemsPrefix });
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [qc]);
};

/** Delete a PR's review checkout — the pane's "Remove checkout" action. */
export const useRemoveReviewWorkspace = (repo: string) => {
  const qc = useQueryClient();
  return useActionMutation<{ prRepo: string; number: number; headSha: string }, null>({
    mutationFn: ({ prRepo, number }) =>
      unwrap(commands.removeReviewWorkspace(repo, prRepo, number)),
    invalidate: ({ prRepo, number, headSha }) => {
      // Drop the memoized path so the next open recreates rather than handing the
      // terminal a cwd that no longer exists.
      qc.removeQueries({ queryKey: queryKeys.reviewWorkspace(repo, prRepo, number, headSha) });
      return [];
    },
    success: () => "Review checkout removed.",
  });
};

// ── Triage ───────────────────────────────────────────────────────────────────
// The Linear triage queue and its investigations. Separate from the Linear section
// above because it caches on its own terms — generously, with explicit refresh.

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

/** The full triage issue (description + comments) for the discussion pane.
 *
 *  Three states, not two: `undefined` while it loads, `null` once Linear has said
 *  this id names no issue (a worktree cut from a plain branch is keyed by a branch
 *  slug, not a ticket) and the detail otherwise. `null` is a *successful* answer —
 *  the surfaces that read it hide their ticket UI rather than raising a toast, which
 *  a rejected query would. Anything Linear couldn't answer still rejects. */
export const useTriageDetail = (repo: string, id: string | null) =>
  useUnwrappedQuery(
    queryKeys.triageDetail(repo, id ?? ""),
    () => commands.triageDetail(repo, id ?? ""),
    {
      enabled: !!repo && !!id,
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
 * queue and the issue detail — and the Issues task graph, which the promoted
 * issue has just *entered* (nothing else would refetch it before the stale
 * window lapses, so it would simply be missing there).
 */
export const useTriageSetState = (repo: string) =>
  useOptimisticMutation({
    mutationKey: ["triage-set-state", repo],
    mutationFn: (args: { ticketId: string; stateId: string }) =>
      unwrap(commands.triageSetState(repo, args.ticketId, args.stateId)),
    optimistic: (qc, args) => {
      const detailKey = queryKeys.triageDetail(repo, args.ticketId);
      const queueKey = queryKeys.triageTickets(repo);
      const prevDetail = qc.getQueryData<TriageDetail | null>(detailKey);
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
      queryKeys.tasks(repo),
    ],
  });

/**
 * Snooze a triage ticket until `untilMs`, or wake it with `null` — the sidebar
 * row's menu. Optimistically moves the row between the queue and its Snoozed
 * lane (both are read off `snoozedUntilMs`) and stamps the open ticket's header.
 */
export const useTriageSnooze = (repo: string) =>
  useOptimisticMutation({
    mutationKey: ["triage-snooze", repo],
    mutationFn: (args: { ticketId: string; untilMs: number | null }) =>
      unwrap(commands.triageSnooze(repo, args.ticketId, args.untilMs)),
    optimistic: (qc, args) => {
      const queueKey = queryKeys.triageTickets(repo);
      const detailKey = queryKeys.triageDetail(repo, args.ticketId);
      const prevQueue = qc.getQueryData<TriageTicket[]>(queueKey);
      const prevDetail = qc.getQueryData<TriageDetail | null>(detailKey);
      if (prevQueue) {
        qc.setQueryData<TriageTicket[]>(
          queueKey,
          prevQueue.map((t) =>
            t.id === args.ticketId ? { ...t, snoozedUntilMs: args.untilMs } : t,
          ),
        );
      }
      if (prevDetail) {
        qc.setQueryData<TriageDetail>(detailKey, { ...prevDetail, snoozedUntilMs: args.untilMs });
      }
      if (prevQueue === undefined && prevDetail === undefined) return;
      return () => {
        if (prevQueue !== undefined) qc.setQueryData(queueKey, prevQueue);
        if (prevDetail !== undefined) qc.setQueryData(detailKey, prevDetail);
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
      const prev = qc.getQueryData<TriageDetail | null>(detailKey);
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

/** Stored Triage sessions and their sticky providers. Drives the tab, resume
 *  affordance, and provider-correct branding across restarts. Cached briefly; a
 *  new investigation invalidates it, and it refetches on Triage revisit/focus. */
export const useStartedInvestigations = (repo: string) =>
  useUnwrappedQuery(
    queryKeys.startedInvestigations(repo),
    () => commands.startedInvestigations(repo),
    { enabled: !!repo, staleTime: 30_000 },
  );

export interface TriageQueue {
  /** Not-snoozed tickets after the mine/all filter, in the backend's order
   *  (soonest SLA first). */
  active: TriageTicket[];
  /** Snoozed tickets after the same filter, in the same order. */
  snoozed: TriageTicket[];
  /** The Mine/All switch: `true` is All (the whole team inbox), `false` is Mine. */
  goodCitizen: boolean;
  /** The queue hasn't resolved yet — an empty `active` means nothing at all. A
   *  view must render a skeleton (not "all caught up") while this holds. */
  loading: boolean;
}

/**
 * The mine/all filter and the snoozed split for the triage queue. Both lists keep
 * the backend's order — it already sorted by SLA, and a second sort here is how
 * two surfaces reading the same queue come to disagree on who is first.
 * Extracted out of `useTriageQueue` so it's testable without mounting the hook
 * (no QueryClient / settings reads needed) — see queries.test.ts.
 */
export function filterTriageQueue(
  tickets: TriageTicket[],
  opts: { goodCitizen: boolean },
): Pick<TriageQueue, "active" | "snoozed"> {
  // "Be a good citizen" widens to the whole team inbox (issues not assigned to
  // you included) so you can pitch in — unconditionally, on triage duty or not.
  const base = opts.goodCitizen ? tickets : tickets.filter((t) => t.mine);
  return {
    active: base.filter((t) => t.snoozedUntilMs == null),
    snoozed: base.filter((t) => t.snoozedUntilMs != null),
  };
}

/**
 * The resolved triage queue for a repo — the single source of truth for what the
 * sidebar's Triage section shows and counts. Defaults to the viewer's own issues;
 * "be a good citizen" widens to the whole team inbox so you can help on anyone's
 * tickets. Snoozed issues are never hidden, they come back as their own list:
 * the section draws them under a collapsible "Snoozed" heading of their own.
 */
export const useTriageQueue = (repo: string): TriageQueue => {
  const { data, isLoading } = useTriageTickets(repo);
  const { value: goodCitizen, isFetched: filterKnown } = useBoolSetting(
    "app",
    TRIAGE_GOOD_CITIZEN_KEY,
  );

  return useMemo(() => {
    const { active, snoozed } = filterTriageQueue(data ?? [], { goodCitizen });
    // A disconnected backend returns `Ok([])`, never an error or a pending
    // read — so "still loading" is exactly "the first fetch hasn't landed". The
    // filter is part of that: `goodCitizen` reads false until its row lands, so
    // an "All" queue would otherwise show its Mine subset for a frame.
    return { active, snoozed, goodCitizen, loading: isLoading || !filterKnown };
  }, [data, goodCitizen, isLoading, filterKnown]);
};

/** The registered repo a stored name points at, or `null` when it names none —
 *  a project removed from the registry must read as "nothing attached", not as
 *  a name every launch would then fail on. */
function registeredRepo(name: string | null | undefined, repos: Repo[] | undefined): string | null {
  return name && repos?.some((r) => r.name === name) ? name : null;
}

/** The Work default project — {@link WORK_DEFAULT_REPO_KEY}, when it is set and
 *  still registered — and its one writer. `loading` holds until both reads land. */
export function useWorkDefaultRepo(): {
  repo: string | null;
  loading: boolean;
  setRepo: (repo: string | null) => void;
} {
  const { data: repos, isFetched: reposKnown } = useRepos();
  const { data: value, isFetched: valueKnown } = useSetting("app", WORK_DEFAULT_REPO_KEY);
  const { mutate } = useSetSetting();
  const setRepo = useCallback(
    (next: string | null) => mutate({ scope: "app", key: WORK_DEFAULT_REPO_KEY, value: next }),
    [mutate],
  );
  return { repo: registeredRepo(value, repos), loading: !reposKnown || !valueKnown, setRepo };
}

/**
 * The project a triage ticket runs on: its own pick, else the triage-wide
 * default, else nothing. Only registered repos count (see {@link registeredRepo}).
 *
 * `attached` says whether the ticket has a pick of its own — what the Project
 * pane's "Use default" acts on — and `defaultRepo` is the default it would fall
 * to, so that control can say whether clearing leaves anything attached.
 * `setRepo(null)` clears the pick; `asDefault` writes the same name as the
 * default too, so one dialog answer can settle both. Both go through
 * {@link useSetSetting}, so they land in the cache before the round-trip and
 * roll back if it fails.
 *
 * `loading` holds until the registry and both rows have been read. Until then
 * `repo` is not an answer: the per-ticket row lands a frame after the default
 * does, and a launch in that frame would run on the default when the ticket
 * had picked otherwise.
 */
export function useTriageRepo(ticketId: string | null): {
  repo: string | null;
  attached: boolean;
  defaultRepo: string | null;
  loading: boolean;
  setRepo: (repo: string | null, opts?: { asDefault?: boolean }) => void;
} {
  const { data: repos, isFetched: reposKnown } = useRepos();
  const { data: fallback, isFetched: fallbackKnown } = useSetting("app", TRIAGE_DEFAULT_REPO_KEY);
  // The key is minted from the ticket, so there is nothing to read without one.
  const { data: own, isFetched: ownKnown } = useSetting(
    "app",
    triageRepoKey(ticketId ?? ""),
    ticketId !== null,
  );
  const { mutate } = useSetSetting();

  const ownRepo = registeredRepo(own, repos);
  const defaultRepo = registeredRepo(fallback, repos);
  const loading = !reposKnown || !fallbackKnown || (ticketId !== null && !ownKnown);

  const setRepo = useCallback(
    (next: string | null, opts?: { asDefault?: boolean }) => {
      if (ticketId !== null) mutate({ scope: "app", key: triageRepoKey(ticketId), value: next });
      if (opts?.asDefault) mutate({ scope: "app", key: TRIAGE_DEFAULT_REPO_KEY, value: next });
    },
    [mutate, ticketId],
  );

  return {
    repo: ownRepo ?? defaultRepo,
    attached: ownRepo !== null,
    defaultRepo,
    loading,
    setRepo,
  };
}

/**
 * The repo whose Linear org the triage queue is read from: the default project
 * when one is set, else the first registered one. Both the sidebar section and
 * the workspace read the queue through this, so the row you clicked and the
 * ticket that opens can never come from two different orgs.
 *
 * The fallback is deliberately *stable* rather than "wherever you are looking".
 * A queue that re-pointed itself as you moved around the app is a queue whose
 * rows change under the cursor, and — since a repo with no explicit link
 * resolves to the only connected org anyway (see `resolve_org_slug`) — the
 * first project answers the org question as well as any other. Setting
 * {@link TRIAGE_DEFAULT_REPO_KEY} is how you pick a different one.
 */
export function useTriageOrgRepo(): string {
  const { data: repos } = useRepos();
  const { data: fallback } = useSetting("app", TRIAGE_DEFAULT_REPO_KEY);
  return registeredRepo(fallback, repos) ?? repos?.[0]?.name ?? "";
}

/**
 * Every registered project a ticket read through `repo` could be started in —
 * the ones resolving to the same Linear org, in registration order.
 *
 * A ticket belongs to an org, not to a project, and several projects routinely
 * resolve to one org (a project with no explicit link takes the only connected
 * one — see `resolve_org_slug`). So "which projects carry this ticket" has an
 * answer wider than "the project whose list I read it from", and that answer is
 * what {@link useWorkRepoGate} chooses between. Same rule as `useTickets`' fold,
 * which keys a row by (org, id) for exactly this reason.
 */
export function useOrgSiblings(repo: string): string[] {
  const { data: repos } = useRepos();
  return useMemo(() => {
    const org = repos?.find((r) => r.name === repo)?.tracker;
    if (!repos || org === undefined) return repo ? [repo] : [];
    return repos.filter((r) => r.tracker === org).map((r) => r.name);
  }, [repos, repo]);
}

/**
 * The project the Tickets page *reads* through — the graph's tickets, and the
 * worktrees it marks as started. Read scope only: it never decides where
 * anything runs, which is the whole point of separating it. Every start goes
 * through {@link WORK_DEFAULT_REPO_KEY}'s gate instead, so the list you are
 * looking at and the project a ticket lands in are two different questions with
 * two different answers.
 */
export function useWorkScopeRepo(): string {
  const { data: repos } = useRepos();
  const { data: preferred } = useSetting("app", WORK_DEFAULT_REPO_KEY);
  return registeredRepo(preferred, repos) ?? repos?.[0]?.name ?? "";
}

// ── English tutor ────────────────────────────────────────────────────────────
// The opt-in writing coach: the practice log agents append to, and the analysis
// run over it on demand.

/** The practice log the tutor appends corrections to, read-only. `staleTime: 0`
 *  because agents append to it in the background — coming back to the pane should
 *  show what they wrote, not what was there last time. */
export const useEnglishLog = () =>
  useUnwrappedQuery(queryKeys.englishLog, () => commands.englishLog(), { staleTime: 0 });

/** The stored analysis of the practice log; `null` until one has been run. */
export const useEnglishAnalysis = () =>
  useUnwrappedQuery(queryKeys.englishAnalysis, () => commands.englishAnalysis(), {
    staleTime: SETTING_STALE_TIME,
  });

/** Analyze one scope of the practice log and store the result. A real (paid) model
 *  call that takes tens of seconds, so it's only ever fired by an Analyze button. */
export const useRunEnglishAnalysis = () =>
  useActionMutation({
    mutationFn: (scope: AnalysisScope) => unwrap(commands.runEnglishAnalysis(scope)),
    invalidate: () => [queryKeys.englishAnalysis],
  });

// ── Editable AI prompts ──────────────────────────────────────────────────────
// The prompts santree launches agents with, their per-scope overrides, and the live
// preview of an unsaved draft (keyed by content hash so editing doesn't thrash).

/** The editable AI prompts with the override stored at `scope` (`"app"` or
 *  `"repo:<name>"`), each with its default + variable/include catalog. */
export const usePrompts = (scope: string) =>
  useUnwrappedQuery(queryKeys.prompts(scope), () => commands.listPrompts(scope), {
    staleTime: SETTING_STALE_TIME,
  });

interface SetPromptVars {
  name: string;
  /** The override text, or `null` to clear it (reset to the inherited value). */
  content: string | null;
}

/** Save (or clear, with `null`) a prompt's override for `scope`. Optimistically
 *  patches the cached prompt list's `overrideSource` so the "Modified" badge and
 *  editor reflect the write before it lands, with rollback on error. */
export const useSetPrompt = (scope: string) =>
  useOptimisticMutation({
    mutationKey: ["set-prompt", scope],
    mutationFn: ({ name, content }: SetPromptVars) =>
      unwrap(commands.setPrompt(scope, name, content)),
    optimistic: (qc, { name, content }) => {
      const key = queryKeys.prompts(scope);
      const prev = qc.getQueryData<PromptInfo[]>(key);
      if (prev) {
        qc.setQueryData<PromptInfo[]>(
          key,
          prev.map((p) => (p.name === name ? { ...p, overrideSource: content } : p)),
        );
      }
      return () => qc.setQueryData(key, prev);
    },
    invalidate: () => [queryKeys.prompts(scope)],
  });

/** Collapses a multi-KB string to a short token for a query key: FNV-1a (32-bit)
 *  tagged with the length, so two drafts that collide must also be the same size. */
function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${text.length.toString(36)}.${(h >>> 0).toString(36)}`;
}

/**
 * The cache key for one preview render. Every input the render depends on is in
 * it — including the sample issue, so a refetched `detail` (new comment, edited
 * body) re-renders instead of serving a stale preview forever.
 *
 * The draft and the issue go in *hashed*: keying on the raw text would retain a
 * copy of every keystroke's multi-KB template in the query cache (twice — key and
 * value), which with a never-expiring entry is an unbounded leak while typing.
 * Exported for the key-derivation test.
 */
export function promptPreviewKey(
  name: string,
  content: string,
  repo: string | undefined,
  issueId: string | undefined,
  detail: TriageDetail | undefined,
  workItems: PromptWorkItemSample[] | undefined,
): QueryKey {
  return queryKeys.promptPreview(
    name,
    hashText(content),
    repo ?? "",
    issueId ?? "",
    detail ? hashText(JSON.stringify(detail)) : "",
    workItems ? hashText(JSON.stringify(workItems)) : "",
  );
}

/** Render a draft prompt for the live preview. Rendering is pure on the backend —
 *  the real issue (`detail`, already in the editor's cache) is passed in, not
 *  fetched — so this re-renders instantly on each keystroke. `keepPreviousData`
 *  holds the last render visible so the pane never flashes empty mid-type.
 *  Disabled while the draft is empty, or while a chosen issue's `detail` is still
 *  loading (so we never render it as the sample).
 *
 *  `workItems` is the editor's sample work queue for the Start-work prompt;
 *  `undefined` leaves the backend's own sample in place.
 *
 *  A render is pure in its key (see {@link promptPreviewKey}), so an entry never
 *  goes stale — but the keystroke that minted it is gone the moment the next one
 *  lands, so the entry is collected shortly after nothing observes it. */
export const usePreviewPrompt = (
  name: string,
  content: string,
  repo: string | undefined,
  issueId: string | undefined,
  detail: TriageDetail | undefined,
  workItems: PromptWorkItemSample[] | undefined,
) =>
  useUnwrappedQuery(
    promptPreviewKey(name, content, repo, issueId, detail, workItems),
    () => commands.previewPrompt(name, content, repo ?? null, detail ?? null, workItems ?? null),
    {
      enabled: content.trim().length > 0 && (!issueId || detail !== undefined),
      staleTime: SETTING_STALE_TIME,
      gcTime: 30_000,
      placeholderData: keepPreviousData,
    },
  );

/** Create a user-defined shared block; refreshes every scope's prompt list. */
export const useCreatePromptBlock = () =>
  useActionMutation({
    mutationFn: (v: { name: string; label: string }) =>
      unwrap(commands.createPromptBlock(v.name, v.label)),
    invalidate: () => [queryKeys.promptsPrefix],
    success: (_d, v) => `Created block “${v.label || v.name}”.`,
  });

/** Delete a user-defined shared block; refreshes every scope's prompt list. */
export const useDeletePromptBlock = () =>
  useActionMutation({
    mutationFn: (name: string) => unwrap(commands.deletePromptBlock(name)),
    invalidate: () => [queryKeys.promptsPrefix],
  });

// ── Cross-view counts and refresh ────────────────────────────────────────────
// The two things that read across every domain above: the sidebar's "needs you"
// counts, and the one refresh that re-pulls everything sourced from Linear or GitHub.

/**
 * The unique direct/team review requests whose current head this viewer has not
 * reviewed — santree's one definition of a PR that still needs you.
 *
 * Every "needs your review" number comes through here — today that is the sidebar's
 * per-project rows and the count their collapsed project header carries. A second
 * filter that merely *looked* like this one is how two surfaces start disagreeing
 * about what is waiting; counting raw open PRs instead is how a row claims work
 * you already did.
 */
export function awaitingReviewPrs(inbox: ReviewInbox | undefined): ReviewPr[] {
  if (!inbox) return [];
  const seen = new Set<string>();
  return [...inbox.requested, ...inbox.teams.flatMap((team) => team.prs)].filter((pr) => {
    if (seen.has(pr.id)) return false;
    seen.add(pr.id);
    return !pr.viewerReview || pr.headCommittedAt > pr.viewerReview.submittedAt;
  });
}

/** One project's share of the review requests waiting on you. */
export interface ReviewProjectCounts {
  /** Requested of you personally. */
  direct: number;
  /** Requested of a team you're on, and not of you directly. */
  team: number;
  /** `direct + team` — what a single badge shows. */
  total: number;
  /**
   * The teams behind {@link ReviewProjectCounts.team}, as `org/slug`, in the order
   * the inbox lists them.
   *
   * Org-qualified for the same reason the inbox's sections are: `acme/core` and
   * `other/core` are different groups of people, and a row that named only "core"
   * would send you asking the wrong ones. It rides on the counts rather than being
   * looked up again at the row, because the row's whole job is to say *who* is
   * waiting and a second lookup is a second chance to disagree.
   */
  teams: string[];
}

/**
 * The same count, per registered project — keyed by registry name, which is what
 * the sidebar addresses a project by, and split the way the inbox itself is.
 *
 * The attribution is the backend's ({@link ReviewPr.project}, resolved from each
 * checkout's `origin`); the rule for what counts is {@link awaitingReviewPrs},
 * unchanged. Every registered project gets an entry, zero included: a project with
 * nothing waiting has to render as a quiet row, not as a missing one. PRs from
 * repos in the org that aren't registered have no project and are counted by
 * nobody here — they still show in the inbox itself.
 *
 * A PR asked of you *and* of your team counts once, as direct: the personal ask is
 * the stronger one, and it keeps `direct + team` equal to `total`.
 *
 * A Map rather than an object because the keys are registry names, and a registry
 * name can be whatever the folder on disk is called.
 */
export function reviewCountsByProject(
  inbox: ReviewInbox | undefined,
): Map<string, ReviewProjectCounts> {
  const blank = (): ReviewProjectCounts => ({ direct: 0, team: 0, total: 0, teams: [] });
  const counts = new Map<string, ReviewProjectCounts>();
  for (const project of inbox?.projects ?? []) counts.set(project.repo, blank());

  const askedDirectly = new Set((inbox?.requested ?? []).map((pr) => pr.id));
  // Every team that asked for a given PR, not just the first: two teams you're on
  // can both be on one review, and naming one of them is how a row sends you to
  // the wrong standup.
  const askedByTeams = new Map<string, string[]>();
  for (const team of inbox?.teams ?? []) {
    const key = `${team.org}/${team.slug}`;
    for (const pr of team.prs) {
      const named = askedByTeams.get(pr.id) ?? [];
      if (!named.includes(key)) askedByTeams.set(pr.id, [...named, key]);
    }
  }

  for (const pr of awaitingReviewPrs(inbox)) {
    if (pr.project === null) continue;
    // Always present: `project` is a registry name, and every one was seeded above.
    const row = counts.get(pr.project) ?? blank();
    if (askedDirectly.has(pr.id)) {
      row.direct += 1;
    } else {
      row.team += 1;
      for (const team of askedByTeams.get(pr.id) ?? []) {
        if (!row.teams.includes(team)) row.teams.push(team);
      }
    }
    row.total += 1;
    counts.set(pr.project, row);
  }
  return counts;
}

/** One block of a project's Reviews section in the sidebar. */
export interface ReviewGroup {
  /** Stable React key, and what the section's persisted fold is keyed on. */
  key: string;
  label: string;
  /** Hover text when the label alone is ambiguous — a team's org, which two
   *  same-named teams need and a single team does not. */
  title: string | null;
  prs: ReviewPr[];
}

/** Oldest wait first: the same order the Reviews rail opens on, so a PR does not
 *  change places when you cross from the sidebar into the view. */
const byWaitingLongest = (a: ReviewPr, b: ReviewPr) =>
  a.waitingSince.localeCompare(b.waitingSince) || a.id.localeCompare(b.id);

/**
 * A project's Reviews section, as the blocks the sidebar draws under it: what is
 * asked of you personally, then one block per team that asked.
 *
 * Built beside {@link reviewCountsByProject} and over the same
 * {@link awaitingReviewPrs} rule on purpose: the number on the folded heading and
 * the rows under the open one are the same fact, and a list assembled by its own
 * filter is how a "3" comes to sit above four rows.
 *
 * Your own PRs (`inbox.mine`) are not blocks here: a PR you opened is worked on
 * beside its worktree, which already has a row in this rail. This section is
 * only what is waiting on you.
 *
 * **The blocks are disjoint and sum to `counts.total`.** A PR asked of you *and*
 * of your team appears once, under the personal ask (the stronger one, and the
 * same tiebreak the counts use); a PR asked of two teams you're on appears under
 * the first.
 *
 * Only registered projects get an entry (a project with nothing waiting gets an
 * empty one): a PR from a repo you never cloned belongs to no project and has no
 * row here to sit under. It is still in the Reviews view itself.
 */
export function reviewGroupsByProject(inbox: ReviewInbox | undefined): Map<string, ReviewGroup[]> {
  const groups = new Map<string, ReviewGroup[]>();
  for (const project of inbox?.projects ?? []) groups.set(project.repo, []);
  if (!inbox) return groups;

  const add = (project: string, group: Omit<ReviewGroup, "prs">, prs: ReviewPr[]) => {
    if (prs.length === 0) return;
    const rows = groups.get(project);
    // Unregistered projects are deliberately absent: no row to hang a block on.
    if (rows) rows.push({ ...group, prs });
  };

  const askedDirectly = new Set(inbox.requested.map((pr) => pr.id));
  const awaiting = awaitingReviewPrs(inbox);
  const awaitingIds = new Set(awaiting.map((pr) => pr.id));

  for (const [project] of groups) {
    const ofProject = (prs: ReviewPr[]) => prs.filter((pr) => pr.project === project);

    add(
      project,
      { key: "direct", label: "Assigned to me", title: null },
      ofProject(awaiting)
        .filter((pr) => askedDirectly.has(pr.id))
        .sort(byWaitingLongest),
    );

    // One PR can reach you through two teams you're on. Claimed by the first, so
    // the blocks stay disjoint and still add up to the heading's number.
    const claimed = new Set(askedDirectly);
    for (const team of inbox.teams) {
      const prs = ofProject(team.prs).filter((pr) => {
        if (!awaitingIds.has(pr.id) || claimed.has(pr.id)) return false;
        claimed.add(pr.id);
        return true;
      });
      add(
        project,
        {
          key: `team:${team.org}/${team.slug}`,
          label: `Team · ${team.name}`,
          // Org-qualified in the hover for the reason the counts are: `acme/core`
          // and `other/core` are different groups of people.
          title: `Requested from @${team.org}/${team.slug}`,
        },
        prs.sort(byWaitingLongest),
      );
    }
  }
  return groups;
}

/** How many tickets the Tickets destination has to show — the count on its rail
 *  row. Distinct by (org, id), which is the whole difference from asking one
 *  project: several registered projects routinely resolve to the same Linear
 *  org (see `resolve_org_slug`), so a per-project count counts the same ticket
 *  once per project. The rail row is not scoped to a project, so its number
 *  must not be either. Shares {@link useTasksByRepo}'s cache with the page. */
export const useTicketCount = (): number => {
  const { data: repos } = useRepos();
  const names = useMemo(() => (repos ?? []).map((r) => r.name), [repos]);
  const tasksByRepo = useTasksByRepo(names);
  return useMemo(() => {
    const seen = new Set<string>();
    for (const repo of repos ?? []) {
      for (const task of tasksByRepo.get(repo.name) ?? []) seen.add(`${repo.tracker}|${task.id}`);
    }
    return seen.size;
  }, [repos, tasksByRepo]);
};

/** The "needs your review" counts for every registered project, for the sidebar's
 *  per-project rows. Shares {@link useReviews}' cache with the badge above, so the
 *  two numbers can never disagree and neither one costs a second fetch. */
export const useReviewCountsByProject = (): Map<string, ReviewProjectCounts> => {
  const { data: inbox } = useReviews();
  return useMemo(() => reviewCountsByProject(inbox), [inbox]);
};

/** What {@link useRefreshExternal} re-pulls: every read sourced from Linear or
 *  GitHub. Local git state is deliberately absent — it has a filesystem watcher
 *  and refreshes itself, so a manual refresh would only duplicate that. */
const EXTERNAL_PREFIXES = [
  queryKeys.tasksPrefix,
  queryKeys.triageTicketsPrefix,
  queryKeys.triageDetailPrefix,
  queryKeys.triageSchedulePrefix,
  queryKeys.reviewsPrefix,
  queryKeys.worktreePrsPrefix,
  queryKeys.mergeQueuePrefix,
  queryKeys.prDetailPrefix,
  queryKeys.prSummaryPrefix,
  queryKeys.prTicketsPrefix,
] as const;

/**
 * Force-refetch everything santree reads from Linear and GitHub — the chrome's
 * Refresh button and ⌘⇧R.
 *
 * Nothing polls those services and `refetchOnWindowFocus` is off globally, so a
 * ticket created seconds ago is otherwise invisible until the view remounts
 * *and* its stale window has lapsed. This is the only way to pull on demand.
 *
 * Invalidated by *prefix* rather than scoped to the active repo on purpose:
 * TanStack refetches only the queries something is currently rendering
 * (`refetchType: "active"` by default) and merely marks the rest stale for their
 * next mount — so the wide net costs exactly the same network as a repo-scoped
 * one, while also covering the cross-repo reads (the sidebar's project tree
 * spans several repos at once) that a single-repo key would miss.
 */
export const useRefreshExternal = () => {
  const qc = useQueryClient();
  const refresh = useCallback(() => {
    // Drop the backend's org caches first, or a refresh inside their TTL would
    // be served the very list the user is refreshing to get past. Fire and
    // forget: the invalidations below refetch either way.
    void commands.linearInvalidateCaches();
    for (const queryKey of EXTERNAL_PREFIXES) qc.invalidateQueries({ queryKey });
  }, [qc]);
  // Spin whenever external data is in flight, whoever asked for it. Note this
  // also catches `usePrDetail`'s 30s poll while a CI check is pending — which is
  // why the button must not disable itself on `fetching`, or a polling PR would
  // block manual refreshes for as long as its checks run.
  const fetching = useIsFetching({
    predicate: (q) => EXTERNAL_PREFIXES.some(([head]) => q.queryKey[0] === head),
  });
  return { refresh, fetching: fetching > 0 };
};
