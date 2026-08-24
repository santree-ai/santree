/**
 * Typed data layer. Every backend read is a TanStack Query hook wrapping a
 * generated command from `bindings.ts`. Components never call `commands.*`
 * directly — they consume these hooks, so caching and loading states are
 * uniform and the live/empty data source stays swappable.
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
  DevRelease,
  DevTodo,
  KeepAwakeStatus,
  NewInlineComment,
  PrDetail,
  PrLabel,
  PromptInfo,
  ReviewDraft,
  ReviewEvent,
  ReviewPublishOutcome,
  ReviewTarget,
  ScriptInfo,
  SessionState,
  Settings,
  TriageComment,
  TriageDetail,
  TriageTicket,
  UpdateProgress,
  ViewedMarks,
  WorktreeTab,
} from "../bindings";
import { commands, events } from "../bindings";
// `useViewCounts` needs live PTY presence for its "N running" badge — the one
// place this data layer reaches into a feature, since TerminalsContext is
// mounted at the app root and is the single source of live-session state.
import { useTerminals } from "../features/terminal/TerminalsContext";
import { type ToastOptions, toast } from "../state/toast";
import { splitRepoSlug } from "./repo";

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

/** The Linear issue graph is heavy and changes infrequently; mutations invalidate
 *  `tasksPrefix` explicitly, so a stale window keeps re-entering the Issues tab
 *  from re-fetching the whole graph on every mount. */
const TASKS_STALE_TIME = 3 * 60_000;

export const queryKeys = {
  appVersion: ["app-version"] as const,
  keepAwake: ["keep-awake"] as const,
  envFileVars: (path: string) => ["env-file-vars", path] as const,
  repos: ["repos"] as const,
  agents: ["agents"] as const,
  claudeModels: ["claude-models"] as const,
  agentAuth: (kind: AgentKind) => ["agent-auth", kind] as const,
  codexHealth: ["codex-health"] as const,
  codexAccount: ["codex-account"] as const,
  codexModels: ["codex-models"] as const,
  codexRateLimits: ["codex-rate-limits"] as const,
  githubStatus: ["github-status"] as const,
  binaryStatus: (name: string) => ["binary-status", name] as const,
  claudeHookSettings: ["claude-hook-settings"] as const,
  claudeHookSettingsNoGit: ["claude-hook-settings-no-git"] as const,
  englishLog: ["english-log"] as const,
  englishAnalysis: ["english-analysis"] as const,
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
  /** Prefix for every cached per-file diff of one worktree. */
  worktreeFileDiffPrefix: (repo: string, id: string) => ["worktree-file-diff", repo, id] as const,
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
  commitDraft: (repo: string, id: string) => ["commit-draft", repo, id] as const,
  worktreePrs: (repo: string) => ["worktree-prs", repo] as const,
  prReviewers: (repo: string, id: string) => ["pr-reviewers", repo, id] as const,
  worktreeHasTranscripts: (repo: string, id: string) =>
    ["worktree-has-transcripts", repo, id] as const,
  reviews: (repo: string) => ["reviews", repo] as const,
  githubViewer: () => ["github-viewer"] as const,
  prTickets: (repo: string, ids: string[]) => ["pr-tickets", repo, ids] as const,
  /** Keyed on the head SHA: a PR that gains commits needs a fresh checkout, not
   *  the one an agent already read. */
  reviewWorkspace: (repo: string, prRepo: string, number: number, headSha: string) =>
    ["review-workspace", repo, prRepo, number, headSha] as const,
  prReviewBrief: (prRepo: string, number: number) => ["pr-review-brief", prRepo, number] as const,
  prReviewBriefPrefix: ["pr-review-brief"] as const,
  aiReviewLaunch: (repo: string, prRepo: string, number: number) =>
    ["ai-review-launch", repo, prRepo, number] as const,
  reviewDrafts: (prRepo: string, number: number) => ["review-drafts", prRepo, number] as const,
  reviewDraftsPrefix: ["review-drafts"] as const,
  mergeQueue: (repo: string) => ["merge-queue", repo] as const,
  prDetail: (owner: string, name: string, number: number) =>
    ["pr-detail", owner, name, number] as const,
  /** Prefixes for the reads that come from an external service (Linear, GitHub)
   *  rather than local disk — the set {@link useRefreshExternal} re-pulls. They
   *  can't be scoped by repo from one place (`pr-detail` is keyed by owner/name/
   *  number, `pr-tickets` by a ticket-id list), and don't need to be: see the
   *  hook for why a prefix costs the same as a repo-scoped key. */
  reviewsPrefix: ["reviews"] as const,
  worktreePrsPrefix: ["worktree-prs"] as const,
  mergeQueuePrefix: ["merge-queue"] as const,
  prDetailPrefix: ["pr-detail"] as const,
  prTicketsPrefix: ["pr-tickets"] as const,
  prRepoLabels: (owner: string, name: string) => ["pr-repo-labels", owner, name] as const,
  reviewedFiles: (prRepo: string, number: number) => ["reviewed-files", prRepo, number] as const,
  /** Every PR's marks — invalidated when the local/synced source itself changes. */
  reviewedFilesPrefix: ["reviewed-files"] as const,
  prFileSource: (owner: string, name: string, base: string, head: string, path: string) =>
    ["pr-file-source", owner, name, base, head, path] as const,
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
  ) => ["prompt-preview", name, draftHash, repo, issueId, issueHash] as const,
  /** Prefix for every repo's Linear connection status — invalidate this (not
   *  `linearStatus(repo)`) when a change (e.g. connect/disconnect) should
   *  refetch all repos' status at once. */
  linearStatusPrefix: ["linear-status"] as const,
  linearStatus: (repo: string) => ["linear-status", repo] as const,
  linearOrgs: ["linear-orgs"] as const,
  claudeUsage: ["claude-usage"] as const,
  // Dev tab (dogfooding — see features/dev; delete with it).
  devTodos: ["dev-todos"] as const,
  devInfo: (repoPath: string) => ["dev-info", repoPath] as const,
  devScreenshot: (path: string) => ["dev-screenshot", path] as const,
  devVersion: (repoPath: string) => ["dev-version", repoPath] as const,
};

/** Setting keys for the Triage Investigation action (agent · model · effort).
 *  `effort` maps to the agent's `--effort` flag (Claude only). The investigation
 *  prompt itself is the editable `triage` prompt (Settings → Prompts). */
export const INVESTIGATE_AGENT_KEY = "investigate_agent";
export const INVESTIGATE_MODEL_KEY = "investigate_model";
export const INVESTIGATE_EFFORT_KEY = "investigate_effort";
export const INVESTIGATE_PERMISSION_MODE_KEY = "investigate_permission_mode";
/** Whether an Investigate launch passes Claude's `--remote-control` flag
 *  (names the session for Remote Control web). Defaults to on — missing/unset
 *  means enabled, only the literal `"false"` turns it off — so a build of
 *  `claude` old enough to predate the flag has an escape hatch (CLAUDE.md's
 *  "verify vendor flags" gotcha). */
export const INVESTIGATE_REMOTE_CONTROL_KEY = "investigate_remote_control";

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
 *  Codex instead follows its App Server recommended model. */
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
 * Triage queue preference keys (app-scoped, string "true"/"false").
 * - good_citizen: show the whole team inbox (issues not assigned to you) too, so
 *   you can pitch in on anyone's tickets — on triage duty or not. Off = just
 *   yours. Surfaced as the Mine/All toggle in the Triage header.
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

/** Read a boolean setting for an exact scope (defaults to false until loaded).
 *  `isFetched` is the *only* way to tell "off" from "not loaded yet" — `value` is
 *  a boolean, so it reads false in both cases. Anything that gates a side effect
 *  on it (a launch flag, the setup script) must wait for `isFetched`. */
export const useBoolSetting = (scope: string, key: string) => {
  const q = useSetting(scope, key);
  return { value: q.data === "true", loading: q.isLoading, isFetched: q.isFetched };
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

/** What santree asks Linear for when connecting: `"read"` or `"read_write"`.
 *  App-scoped, defaults to read_write — what it requested unconditionally before
 *  the choice existed. Read by Rust (`linear.rs`), so the two declarations of
 *  this key have to agree, same split as {@link CONFIRM_ON_QUIT_KEY}. */
export const LINEAR_SCOPE_KEY = "linear_scope";

/** The permission levels santree can request from Linear. */
export type LinearScope = "read" | "read_write";

/** The stored `linear_scope`, or read_write for anything unset/unknown —
 *  mirroring the Rust fallback, so a bad value can't quietly strip access. */
export const parseLinearScope = (raw: string | null | undefined): LinearScope =>
  raw === "read" ? "read" : "read_write";

/** Said wherever a Linear write is disabled, so the four places that gate on it
 *  can't drift into four different explanations. */
export const LINEAR_READ_ONLY_HINT =
  "santree can't change Linear right now: it is set to read-only, or the workspace was connected without write access. Both live in Settings → Integrations.";

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

export const useCodexHealth = () =>
  useUnwrappedQuery(queryKeys.codexHealth, () => commands.codexHealth(), { staleTime: 30_000 });

export const useCodexAccount = () =>
  useUnwrappedQuery(queryKeys.codexAccount, () => commands.codexAccount(), {
    staleTime: 30_000,
    refetchInterval: (query) => (query.state.data?.connected ? false : 3_000),
  });

export const useCodexModels = () =>
  useUnwrappedQuery(queryKeys.codexModels, () => commands.codexModels(), {
    staleTime: 5 * 60 * 1000,
  });

export const useCodexRateLimits = () =>
  useUnwrappedQuery(queryKeys.codexRateLimits, () => commands.codexRateLimits(), {
    staleTime: 60_000,
  });

export const useCodexLogin = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deviceCode: boolean) => unwrap(commands.codexLoginStart(deviceCode)),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.codexAccount }),
  });
};

export const useCancelCodexLogin = () =>
  useMutation({ mutationFn: (loginId: string) => unwrap(commands.codexLoginCancel(loginId)) });

export const useCodexLogout = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(commands.codexLogout()),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.codexAccount }),
  });
};

/** The `gh` CLI integration status (installed? authenticated? which account?). */
export const useGithubStatus = () =>
  useQuery({ queryKey: queryKeys.githubStatus, queryFn: () => commands.githubStatus() });

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

/** Like {@link useClaudeHookSettings} but the commit/push-denying variant — the
 *  `--settings` path a "Fix CI" session launches with, so the AI fixes + validates
 *  but never commits/pushes. Same caching rule as {@link useClaudeHookSettings}. */
export const useClaudeHookSettingsNoGit = () =>
  useQuery({
    queryKey: queryKeys.claudeHookSettingsNoGit,
    queryFn: () => commands.claudeHookSettingsNoGit(),
    staleTime: Infinity,
  });

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
 * The live session for each worktree path (`cwd` — the directory Claude ran in),
 * newest wins. A worktree can host several Claude tabs, so the correlation has to
 * pick one: the most recently updated row, chosen explicitly rather than by
 * trusting the backend's `ORDER BY updated_at_ms DESC` (a first-seen-wins map
 * silently shows a stale session the day that ordering changes). Ties keep the
 * first row, preserving the backend's order. Exported for testing.
 */
export function newestSessionByPath(states: SessionState[]): Map<string, SessionState> {
  const map = new Map<string, SessionState>();
  for (const s of states) {
    const seen = map.get(s.cwd);
    if (!seen || (s.updatedAtMs ?? 0) > (seen.updatedAtMs ?? 0)) map.set(s.cwd, s);
  }
  return map;
}

/** {@link newestSessionByPath} over the live session states — the "what is this
 *  worktree's agent doing" signal shared by the Trees sidebar and the all-agents
 *  grid (both key it by `worktree.path`). */
export const useSessionByPath = (): Map<string, SessionState> => {
  const { data } = useSessionStates();
  return useMemo(() => newestSessionByPath(data ?? []), [data]);
};

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

/**
 * Run one repo-scoped read per repo and index the results by repo — the shape
 * the cross-repo Agents panel needs, where "the active repo" doesn't apply.
 *
 * Uses the SAME query keys as the single-repo hooks above, so the two share one
 * cache: opening the panel doesn't refetch what Trees already loaded, and an
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
  useResultsByRepo(repos, queryKeys.worktreePrs, commands.worktreePrs, 60_000);

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

/** Stored Triage sessions and their sticky providers. Drives the tab, resume
 *  affordance, and provider-correct branding across restarts. Cached briefly; a
 *  new investigation invalidates it, and it refetches on Triage revisit/focus. */
export const useStartedInvestigations = (repo: string) =>
  useUnwrappedQuery(
    queryKeys.startedInvestigations(repo),
    () => commands.startedInvestigations(repo),
    { enabled: !!repo, staleTime: 30_000 },
  );

/** Providers with a durable conversation on one logical surface. */
export const useSessionProviders = (repo: string, termKey: string) =>
  useUnwrappedQuery(
    queryKeys.sessionProviders(repo, termKey),
    () => commands.sessionProviders(repo, termKey),
    { enabled: !!repo && !!termKey, staleTime: 30_000 },
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
        commands.addWorktreeTab(repo, tab.worktreeId, tab.id, tab.kind, tab.agentKind, tab.title),
      ),
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
 * The read-only checkout of a PR's head that an AI review session runs in, created
 * on demand. `null` when the PR lives in a repo santree has no clone of — the
 * session then runs diff-only, which the pane says out loud.
 *
 * Keyed on the head SHA so a PR that gains commits gets a fresh checkout instead
 * of an agent reading last week's code. `staleTime: Infinity` because the backend
 * call is find-or-create: once a key has resolved, re-running it would only redo
 * a fetch that changed nothing.
 */
export const useReviewWorkspace = (repo: string, target: ReviewTarget | null, enabled: boolean) =>
  useUnwrappedQuery(
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
    optimistic: (qc, id) =>
      patchDrafts(qc, prRepo, number, (drafts) => drafts.filter((d) => d.id !== id)),
    invalidate: () => [queryKeys.reviewDrafts(prRepo, number)],
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
    mutationFn: ({ number }) => unwrap(commands.removeReviewWorkspace(repo, number)),
    invalidate: ({ prRepo, number, headSha }) => {
      // Drop the memoized path so the next open recreates rather than handing the
      // terminal a cwd that no longer exists.
      qc.removeQueries({ queryKey: queryKeys.reviewWorkspace(repo, prRepo, number, headSha) });
      return [];
    },
    success: () => "Review checkout removed.",
  });
};

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

/** The signed-in GitHub user's login — who the review composer writes as. Not
 *  repo-scoped and effectively fixed for the session, so it's cached for an hour
 *  rather than re-asked on every PR. `null` when `gh` isn't authenticated. */
export const useGithubViewerLogin = () =>
  useUnwrappedQuery(queryKeys.githubViewer(), () => commands.githubViewerLogin(), {
    staleTime: 60 * 60_000,
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
export const useSubmitPrReview = (repo: string, prRepo: string, number: number) =>
  useActionMutation<{ reviewId: string; event: ReviewEvent; body: string }, null>({
    mutationFn: (v) => unwrap(commands.submitPrReview(v.reviewId, v.event, v.body)),
    // The submit dialog shows GitHub's rejection inline and stays open to retry
    // ("Can not approve your own pull request"), so a toast would double it.
    silent: true,
    invalidate: () => [prDetailKey(prRepo, number), queryKeys.reviews(repo)],
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
  path: string,
  enabled: boolean,
) =>
  useUnwrappedQuery(
    queryKeys.prFileSource(owner, name, base, head, path),
    () => commands.prFileSource(owner, name, base, head, path),
    {
      enabled: enabled && !!owner && !!name && !!head && !!path,
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
      /** Branch off a blocker's worktree branch instead of the repo's default
       *  branch (a stacked worktree). The ticket id rides along only so the toast
       *  can name it — the backend takes the branch. */
      stackOn: { ticket: string; branch: string } | null;
      agent: AgentKind;
      // Suppress the per-worktree toast — a bulk launch raises one summary toast
      // for the whole batch instead of N near-identical ones.
      quiet?: boolean;
    }) =>
      unwrap(
        commands.createWorktree(
          repo,
          a.issueId,
          a.title,
          a.project,
          a.stackOn?.branch ?? null,
          a.agent,
        ),
      ),
    // Only the worktree list — NOT tasks. The graph relies on the `tasks` query
    // reference staying stable (re-firing fitView mid-rebuild blanks the canvas),
    // and a full graph refetch on every launch is heavy. The WIP badge already
    // signals "being worked on"; a moved Linear status refreshes on the next
    // natural tasks refetch.
    invalidate: () => [queryKeys.worktrees(repo)],
    success: (wt, a) =>
      a.quiet
        ? null
        : a.stackOn
          ? `Created worktree for ${wt.id}, stacked on ${a.stackOn.ticket}.`
          : `Created worktree for ${wt.id}.`,
  });

/** Check out a pull request as a normal writable tree. It intentionally does not
 * launch an agent: Trees owns provider choice through its persisted `+` tabs. */
export const useCreateReviewWorktree = (repo: string) =>
  useActionMutation({
    mutationFn: (args: {
      id: string;
      title: string;
      branch: string;
      base: string | null;
      agent: AgentKind;
    }) =>
      unwrap(
        commands.createWorktreeForPr(repo, args.id, args.title, args.branch, args.base, args.agent),
      ),
    invalidate: () => [queryKeys.worktrees(repo)],
    success: (worktree) => `Opened ${worktree.branch} as a tree.`,
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
      queryKeys.worktrees(repo),
      queryKeys.baseWorktree(repo),
    ],
    success: () => "Committed.",
    // Queues behind any staging click still in flight, so the commit can only ever
    // capture the selection the user has finished making.
    scope: gitIndexScope(repo, id),
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
  // Default *inside* the memo, not in the destructuring: a `= []` default mints a
  // fresh array on every render while the read is still loading, so the dep array
  // would change identity every render — the memo would do nothing at exactly the
  // moment (mount) it matters.
  const { data: tasks } = useTasks(repo);
  const { data: worktrees } = useWorktrees(repo);
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
      tasks: tasks?.length ?? 0,
      tasksReady: tasks?.filter((t) => t.ready).length ?? 0,
      worktrees: worktrees?.length ?? 0,
      worktreesRunning: worktrees?.filter((w) => liveTermRefIds.has(`tree:${w.id}`)).length ?? 0,
      // The Reviews badge counts PRs awaiting *my* review (individual + team),
      // not my own authored PRs.
      reviews:
        (reviews?.requested.length ?? 0) +
        (reviews?.teams.reduce((n, t) => n + t.prs.length, 0) ?? 0),
    };
  }, [tasks, worktrees, reviews, terminalTabs]);
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
 * one, while also covering the cross-repo views (Agents reads several repos at
 * once) that a single-repo key would miss.
 */
export const useRefreshExternal = () => {
  const qc = useQueryClient();
  const refresh = useCallback(() => {
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
      queryKeys.tasks(repo),
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
  /** The queue hasn't resolved yet — an empty `visible` means nothing at all. A
   *  view must render a skeleton (not "all caught up") while this holds. */
  loading: boolean;
}

/**
 * Pure mine/good-citizen/snoozed filter matrix for the triage queue. Extracted
 * out of `useTriageQueue` so it's testable without mounting the hook (no
 * QueryClient / settings reads needed) — see queries.test.ts.
 */
export function filterTriageQueue(
  tickets: TriageTicket[],
  opts: { goodCitizen: boolean; showSnoozed: boolean },
): Pick<TriageQueue, "visible" | "teamWaiting"> {
  const { goodCitizen, showSnoozed } = opts;
  const mine = tickets.filter((t) => t.mine);
  // "Be a good citizen" widens to the whole team inbox (issues not assigned to
  // you included) so you can pitch in — unconditionally, on triage duty or not.
  const base = goodCitizen ? tickets : mine;
  return {
    visible: showSnoozed ? base : base.filter((t) => t.snoozedUntilMs == null),
    teamWaiting: tickets.filter((t) => !t.mine && t.snoozedUntilMs == null).length,
  };
}

/**
 * The resolved triage queue for a repo — the single source of truth for what's
 * shown and the tab count. Defaults to the viewer's own issues; "be a good
 * citizen" widens to the whole team inbox so you can help on anyone's tickets.
 */
export const useTriageQueue = (repo: string): TriageQueue => {
  const { data, isLoading } = useTriageTickets(repo);
  const goodCitizen = useBoolSetting("app", TRIAGE_GOOD_CITIZEN_KEY).value;
  const showSnoozed = useBoolSetting("app", TRIAGE_SNOOZED_KEY).value;

  return useMemo(() => {
    const tickets = data ?? [];
    const { visible, teamWaiting } = filterTriageQueue(tickets, { goodCitizen, showSnoozed });
    // A disconnected backend returns `Ok([])`, never an error or a pending
    // read — so "still loading" is exactly "the first fetch hasn't landed".
    return { visible, teamWaiting, goodCitizen, showSnoozed, loading: isLoading };
  }, [data, goodCitizen, showSnoozed, isLoading]);
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
  return "Codex";
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

/** Read a repo-resolved boolean setting: the repo's override, else the app
 *  value (defaults to false until loaded). Same false-while-loading caveat as
 *  {@link useBoolSetting} — gate side effects on `isFetched`. */
export const useResolvedBoolSetting = (repo: string, key: string) => {
  const q = useResolvedSetting(repo, key);
  return { value: q.data === "true", loading: q.isLoading, isFetched: q.isFetched };
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
        ? [queryKeys.claudeHookSettings, queryKeys.claudeHookSettingsNoGit]
        : []),
      // Read-only mode is folded into what the backend reports as writable, so
      // the status has to be re-read for the write controls to gray out at once
      // — the whole point of the switch is that it applies without reconnecting.
      ...(a.key === LINEAR_SCOPE_KEY ? [queryKeys.linearStatusPrefix, queryKeys.linearOrgs] : []),
    ],
  });

// ── CLI binaries ─────────────────────────────────────────────────────────────

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

// ── English tutor ────────────────────────────────────────────────────────────

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
): QueryKey {
  return queryKeys.promptPreview(
    name,
    hashText(content),
    repo ?? "",
    issueId ?? "",
    detail ? hashText(JSON.stringify(detail)) : "",
  );
}

/** Render a draft prompt for the live preview. Rendering is pure on the backend —
 *  the real issue (`detail`, already in the editor's cache) is passed in, not
 *  fetched — so this re-renders instantly on each keystroke. `keepPreviousData`
 *  holds the last render visible so the pane never flashes empty mid-type.
 *  Disabled while the draft is empty, or while a chosen issue's `detail` is still
 *  loading (so we never render it as the sample).
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
) =>
  useUnwrappedQuery(
    promptPreviewKey(name, content, repo, issueId, detail),
    () => commands.previewPrompt(name, content, repo ?? null, detail ?? null),
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

// ── Dev tab (dogfooding — everything below serves features/dev only and is
//    deleted with it) ───────────────────────────────────────────────────────

/** App-scoped setting: the santree checkout the Dev tab builds/works in. */
export const DEV_REPO_PATH_KEY = "dev_repo_path";

/** The Dev tab exists only for this GitHub login (the only developer for now). */
export const DEV_GITHUB_LOGIN = "santiagotoscanini";

/** Validate + normalize a picked folder to its git toplevel (errors toast). */
export const useDevNormalizeRepo = () =>
  useActionMutation<string, string>({
    mutationFn: (path) => unwrap(commands.devNormalizeRepo(path)),
  });

/** Running-build vs checkout-HEAD vs newest-DMG status for the Dev header.
 *  Polled while mounted: a `pnpm tauri build` finishing in the Build pane has no
 *  event of its own, and the reads are local git/fs calls. */
export const useDevInfo = (repoPath: string) =>
  useUnwrappedQuery(queryKeys.devInfo(repoPath), () => commands.devInfo(repoPath), {
    enabled: !!repoPath,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

/** The Dev TODO list, newest first. Changes only through the mutations below. */
export const useDevTodos = () =>
  useUnwrappedQuery(queryKeys.devTodos, () => commands.devTodos(), {
    staleTime: SETTING_STALE_TIME,
  });

/** Add a TODO (id minted by the caller; screenshots as data URLs). Optimistic —
 *  the row appears instantly; screenshot paths reconcile on settle. */
export const useAddDevTodo = () =>
  useOptimisticMutation<{ id: string; body: string; screenshots: string[] }, DevTodo>({
    mutationFn: ({ id, body, screenshots }) => unwrap(commands.devAddTodo(id, body, screenshots)),
    optimistic: (qc, { id, body }) => {
      const prev = qc.getQueryData<DevTodo[]>(queryKeys.devTodos);
      qc.setQueryData<DevTodo[]>(queryKeys.devTodos, (cur = []) => [
        { id, body, done: false, screenshots: [], createdAtMs: Date.now() },
        ...cur,
      ]);
      return () => qc.setQueryData(queryKeys.devTodos, prev);
    },
    invalidate: () => [queryKeys.devTodos],
  });

export const useSetDevTodoDone = () =>
  useOptimisticMutation<{ id: string; done: boolean }, null>({
    mutationFn: ({ id, done }) => unwrap(commands.devSetTodoDone(id, done)),
    optimistic: (qc, { id, done }) => {
      const prev = qc.getQueryData<DevTodo[]>(queryKeys.devTodos);
      qc.setQueryData<DevTodo[]>(queryKeys.devTodos, (cur = []) =>
        cur.map((t) => (t.id === id ? { ...t, done } : t)),
      );
      return () => qc.setQueryData(queryKeys.devTodos, prev);
    },
    invalidate: () => [queryKeys.devTodos],
  });

export const useDeleteDevTodo = () =>
  useOptimisticMutation<string, null>({
    mutationFn: (id) => unwrap(commands.devDeleteTodo(id)),
    optimistic: (qc, id) => {
      const prev = qc.getQueryData<DevTodo[]>(queryKeys.devTodos);
      qc.setQueryData<DevTodo[]>(queryKeys.devTodos, (cur = []) => cur.filter((t) => t.id !== id));
      return () => qc.setQueryData(queryKeys.devTodos, prev);
    },
    invalidate: () => [queryKeys.devTodos],
  });

/** Render a TODO into an on-disk prompt file; resolves to the file's path. */
export const useDevTodoPrompt = () =>
  useActionMutation<{ repoPath: string; id: string }, string>({
    mutationFn: ({ repoPath, id }) => unwrap(commands.devTodoPrompt(repoPath, id)),
  });

/** A pasted screenshot as a data URI for inline display. Immutable once written. */
export const useDevScreenshot = (path: string) =>
  useUnwrappedQuery(queryKeys.devScreenshot(path), () => commands.devScreenshotSrc(path), {
    enabled: !!path,
    staleTime: SETTING_STALE_TIME,
    gcTime: 5 * 60_000,
  });

/** Open the newest DMG (and, when running installed, quit for the drag-and-drop
 *  install). Silent — the confirm dialog renders the error inline. */
export const useDevInstall = () =>
  useActionMutation<string, boolean>({
    mutationFn: (repoPath) => unwrap(commands.devInstall(repoPath)),
    silent: true,
  });

/** Where the checkout's declared version sits, what it could become, and the
 *  reasons a release from here would be refused. Cheap local git/fs reads, but
 *  a bump changes all of it — so it's invalidated by {@link useDevRelease}. */
export const useDevVersion = (repoPath: string) =>
  useUnwrappedQuery(queryKeys.devVersion(repoPath), () => commands.devVersion(repoPath), {
    enabled: !!repoPath,
    staleTime: 10_000,
  });

/** Bump the version files, commit them, tag and push — which starts the signed
 *  release in CI. Not optimistic and not silent: this one reports exactly what
 *  it did, because a half-finished release is a thing you have to know about.
 *  The dialog confirms before it ever gets here. */
export const useDevRelease = (repoPath: string) =>
  useActionMutation<{ version: string; notes: string }, DevRelease>({
    mutationFn: ({ version, notes }) => unwrap(commands.devRelease(repoPath, version, notes)),
    // The release commit moves the working tree the Files pane is showing. Its
    // queries are keyed by repo *name*, which this hook doesn't have — the
    // prefixes cover every repo, and re-reading a clean status is cheap.
    invalidate: () => [
      queryKeys.devVersion(repoPath),
      queryKeys.devInfo(repoPath),
      ["worktree-status"],
      ["worktree-file-diff"],
    ],
    success: (r) => `${r.tag} pushed. CI is building the release.`,
  });

/** Eject any mounted santree DMG volume left on the desktop. */
export const useDevEject = () =>
  useActionMutation<void, number>({
    mutationFn: () => unwrap(commands.devEject()),
    success: (n) =>
      n > 0 ? `Ejected ${n} volume${n === 1 ? "" : "s"}.` : "No santree DMG volumes are mounted.",
  });
