/**
 * The "Review with AI" tab: a real Claude session that has read the PR and can
 * answer questions about it while you review.
 *
 * Same session lifecycle as the Triage {@link InvestigatePane} — persisted
 * `--session-id`, `liveSeen` latch, resume pane on exit — with two differences
 * that matter:
 *
 *  1. **It runs in a checkout of the PR's head**, not in the repo root, so the
 *     files the agent reads are the PR's version of the code and it can trace
 *     callers or run tests. When the PR belongs to a repo santree has no clone of,
 *     the session still opens with the diff in its prompt, and says so.
 *  2. **It launches with the review deny-list** (`claudeHookSettingsReview`), and
 *     its prompt opens with a hard-rules block: it never comments, approves,
 *     requests changes, commits, or pushes. Reviews go out under the user's name,
 *     so the user writes them — the footer says this too, because a guarantee the
 *     user can't see isn't one they can rely on.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import type { ReviewPr, ReviewTarget } from "../../bindings";
import { ClaudeSparkIcon, TrashIcon, WarningIcon } from "../../components/icons";
import { Button, Spinner } from "../../components/primitives";
import { SessionEndedPane } from "../../components/SessionEndedPane";
import {
  CLAUDE_START_WITH_CHROME_KEY,
  queryKeys,
  REVIEW_EFFORT_KEY,
  REVIEW_MODEL_KEY,
  useAgentSession,
  useBoolSetting,
  useClaudeHookSettingsReview,
  useRemoveReviewWorkspace,
  useResolvedSetting,
  useReviewPrompt,
  useReviewWorkspace,
} from "../../lib/queries";
import { agentProvider, sessionAgent } from "../terminal/agentProvider";
import { agentSessionSeed, shellQuote } from "../terminal/agentSeed";
import { useReviewsModel } from "./model";
import { ReviewTerminal } from "./ReviewTerminal";
import { ticketIdFor } from "./ticket";
import { useReviewSessionLatch } from "./useReviewSessionLatch";

/** The terminal-registry key for a PR's review session. Parsed back out by the
 *  Agents panel (`registry.ts`), so the shape is a shared convention. */
export function reviewTermKey(pr: ReviewPr): string {
  return `review:${pr.repo}#${pr.number}`;
}

/** The identity all three review commands take, straight off the already-loaded
 *  list row — no second query stands between opening this tab and checking the PR
 *  out. Memoize at the call site: it feeds three query keys. */
export function reviewTargetFor(pr: ReviewPr): ReviewTarget {
  return {
    prRepo: pr.repo,
    number: pr.number,
    title: pr.title,
    author: pr.author,
    headRef: pr.headRef,
    baseRef: pr.baseRef,
    headSha: pr.headSha,
    ticketId: ticketIdFor(pr),
  };
}

export function AiReviewPane({ pr, visible }: { pr: ReviewPr; visible: boolean }) {
  const { repo } = useReviewsModel();
  const termKey = reviewTermKey(pr);

  // Only resolve a (re)launch when there's no live PTY to attach to, and never
  // re-resume an agent the user just quit — the resume pane shows instead.
  const {
    ended,
    needsSeed: freshOpen,
    resumeRequested,
    requestResume,
  } = useReviewSessionLatch(termKey);

  // `headSha` is empty only if GitHub returned a PR with no commits — treat that
  // as "nothing to check out" rather than detaching at an empty ref.
  const target = useMemo(() => (pr.headSha ? reviewTargetFor(pr) : null), [pr]);
  const needsSeed = !!target && freshOpen;

  // The checkout comes first: it's the session's cwd *and* what tells the prompt
  // whether the agent can read real code, so both the session resolve and the
  // prompt render wait on it.
  const workspace = useReviewWorkspace(repo, target, needsSeed || resumeRequested);
  const cwd = workspace.data ?? undefined;
  const session = useAgentSession(
    repo,
    termKey,
    cwd ?? "",
    true,
    "Codex",
    needsSeed && workspace.isFetched,
  );
  // Rendered only after the checkout resolves: the prompt tells the agent whether
  // it can read real code, and the backend derives that from the checkout's
  // existence — so asking before it's made would render the diff-only variant.
  const prompt = useReviewPrompt(repo, target, needsSeed && workspace.isFetched);

  const model = useResolvedSetting(repo, REVIEW_MODEL_KEY);
  const effort = useResolvedSetting(repo, REVIEW_EFFORT_KEY);
  const hookSettings = useClaudeHookSettingsReview();
  const startWithChrome = useBoolSetting("app", CLAUDE_START_WITH_CHROME_KEY);
  const resolvedAgent = sessionAgent(session.data, "Codex");
  const provider = agentProvider(resolvedAgent);
  const seed = agentSessionSeed(session.data, {
    repo,
    termKey,
    // Seed the short "read the file" instruction, not the prompt text: the
    // rendered review prompt carries a whole PR diff, far past what can be typed
    // into an interactive shell.
    prompt: prompt.data
      ? `Read ${prompt.data} and follow the instructions inside.`
      : `Help me review pull request #${pr.number}.`,
    modelFlag:
      provider.capabilities.cliLaunchOptions && model.data
        ? `--model ${shellQuote(model.data)}`
        : undefined,
    effortFlag:
      provider.capabilities.cliLaunchOptions && effort.data
        ? `--effort ${shellQuote(effort.data)}`
        : undefined,
    // Load-bearing, not hygiene: this is the deny-list that stops a `gh pr
    // comment`. Gated on `isFetched` below so a launch can't race past it.
    settingsFlag:
      provider.capabilities.cliLaunchOptions && hookSettings.data
        ? `--settings ${shellQuote(hookSettings.data)}`
        : undefined,
    chrome: provider.capabilities.cliLaunchOptions && startWithChrome.value,
  });

  // Every launch input must have resolved before the PTY spawns — the seed is
  // built once and applied at session creation, so a flag that arrives late is
  // silently dropped.
  //
  // The prompt and the deny-list file gate on **having resolved to something**,
  // not on `isFetched`. An errored query is "fetched" too, and the settings command
  // answers `null` when the hook binary can't be found — either way both flags fall
  // back to `undefined`, which would spawn a session pointed at a PR with neither
  // the guardrail prompt nor the rules that stop a `gh pr comment`. The plain
  // settings gate on `isFetched`, since a boolean reads `false` both when it's off
  // and when it hasn't loaded.
  const ready =
    !needsSeed ||
    (workspace.isFetched &&
      !session.isFetching &&
      !!prompt.data &&
      (!provider.capabilities.cliLaunchOptions || !!hookSettings.data) &&
      model.isFetched &&
      effort.isFetched &&
      startWithChrome.isFetched);

  const qc = useQueryClient();
  const dropCachedSession = useCallback(
    // The process can die while this pane is unmounted, so the cached resolution
    // may predate the exit — replaying it would hand the PTY a `--session-id` for
    // a session whose transcript now exists.
    () => qc.removeQueries({ queryKey: queryKeys.agentSessionPrefix(repo, termKey) }),
    [qc, repo, termKey],
  );

  if (ended) {
    return (
      <SessionEndedPane
        title="Review session ended"
        subtitle={
          <>
            Your conversation about{" "}
            <span className="font-mono text-fg-3">
              {pr.repo}#{pr.number}
            </span>{" "}
            is saved. Pick it back up whenever you're ready.
          </>
        }
        onResume={() => {
          dropCachedSession();
          requestResume();
        }}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        {ready ? (
          <ReviewTerminal
            termKey={termKey}
            title={`#${pr.number}`}
            cwd={cwd}
            seed={seed}
            attach={visible}
            onExited={dropCachedSession}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <Spinner size={16} />
            <span className="text-[11px] text-muted-3">
              {workspace.isFetching ? "Checking out the PR…" : "Reading the pull request…"}
            </span>
          </div>
        )}
      </div>
      <ReviewFooter
        pr={pr}
        hasWorkspace={!!cwd}
        message={
          <>
            Reads this PR and answers questions. It never comments, approves, or pushes.{" "}
            <span className="text-fg-3">you do that.</span>
          </>
        }
      />
    </div>
  );
}

/** States the guarantee the pane is built around, and offers to reclaim the
 *  checkout's disk. A promise the user can't see isn't one they can rely on.
 *
 *  Shared with the AI review, which makes a different promise (it writes drafts,
 *  but only santree sees them) over the same checkout — hence `message` rather
 *  than one hardcoded line. */
export function ReviewFooter({
  pr,
  hasWorkspace,
  message,
  extra,
}: {
  pr: ReviewPr;
  hasWorkspace: boolean;
  message: React.ReactNode;
  extra?: React.ReactNode;
}) {
  const { repo } = useReviewsModel();
  const { mutate: removeWorkspace, isPending } = useRemoveReviewWorkspace(repo);

  return (
    <div className="flex flex-none items-center gap-2 border-t border-hairline bg-raised px-3 py-1.5 text-[10.5px] text-muted-3">
      <ClaudeSparkIcon size={11} className="flex-none" />
      <span className="min-w-0 flex-1 truncate">{message}</span>
      {extra}
      {!hasWorkspace && (
        <span
          className="flex flex-none items-center gap-1 text-status-amber"
          title="santree has no local clone of this PR's repository, so the session only has the diff. It can't grep the codebase or open files the diff doesn't touch."
        >
          <WarningIcon size={11} />
          diff only
        </span>
      )}
      {hasWorkspace && (
        <Button
          size="sm"
          variant="ghost"
          disabled={isPending}
          title="Delete the local checkout of this PR. It's recreated the next time you open this tab."
          onClick={() =>
            removeWorkspace({ prRepo: pr.repo, number: pr.number, headSha: pr.headSha })
          }
        >
          <TrashIcon size={10} />
          Remove checkout
        </Button>
      )}
    </div>
  );
}
