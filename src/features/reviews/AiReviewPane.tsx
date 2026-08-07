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
import { useCallback, useEffect, useMemo, useState } from "react";

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
import { agentSessionSeed, shellQuote } from "../terminal/agentSeed";
import { useTerminals } from "../terminal/TerminalsContext";
import { useEmbeddedTerminal } from "../terminal/useEmbeddedTerminal";
import { useReviewsModel } from "./model";
import { ticketIdFor } from "./ticket";

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

export function AiReviewPane({ pr }: { pr: ReviewPr }) {
  const { repo } = useReviewsModel();
  const termKey = reviewTermKey(pr);

  // Only resolve a (re)launch when there's no live PTY to attach to; `liveSeen`
  // latches (as state, so the exit re-renders) so quitting the agent doesn't
  // immediately re-resume it into a loop — the resume pane shows instead.
  const { tabs } = useTerminals();
  const liveSession = tabs.some((t) => t.source === "review" && t.refId === termKey);
  const [liveSeen, setLiveSeen] = useState(false);
  const [resumeRequested, setResumeRequested] = useState(false);
  useEffect(() => {
    if (liveSession) {
      setLiveSeen(true);
      setResumeRequested(false);
    }
  }, [liveSession]);

  // `headSha` is empty only if GitHub returned a PR with no commits — treat that
  // as "nothing to check out" rather than detaching at an empty ref.
  const target = useMemo(() => (pr.headSha ? reviewTargetFor(pr) : null), [pr]);

  const ended = !liveSession && liveSeen && !resumeRequested;
  const needsSeed = !!target && !liveSession && !liveSeen;

  // The checkout comes first: it's the session's cwd *and* what tells the prompt
  // whether the agent can read real code, so both the session resolve and the
  // prompt render wait on it.
  const workspace = useReviewWorkspace(repo, target, needsSeed || resumeRequested);
  const cwd = workspace.data ?? undefined;
  const session = useAgentSession(repo, termKey, cwd ?? "", true, needsSeed && workspace.isFetched);
  // Rendered only after the checkout resolves: the prompt tells the agent whether
  // it can read real code, and the backend derives that from the checkout's
  // existence — so asking before it's made would render the diff-only variant.
  const prompt = useReviewPrompt(repo, target, needsSeed && workspace.isFetched);

  const model = useResolvedSetting(repo, REVIEW_MODEL_KEY);
  const effort = useResolvedSetting(repo, REVIEW_EFFORT_KEY);
  const hookSettings = useClaudeHookSettingsReview();
  const startWithChrome = useBoolSetting("app", CLAUDE_START_WITH_CHROME_KEY);

  const seed = agentSessionSeed(session.data, "claude", {
    repo,
    termKey,
    // Seed the short "read the file" instruction, not the prompt text: the
    // rendered review prompt carries a whole PR diff, far past what can be typed
    // into an interactive shell.
    prompt: prompt.data
      ? `Read ${prompt.data} and follow the instructions inside.`
      : `Help me review pull request #${pr.number}.`,
    modelFlag: model.data ? `--model ${shellQuote(model.data)}` : undefined,
    effortFlag: effort.data ? `--effort ${shellQuote(effort.data)}` : undefined,
    // Load-bearing, not hygiene: this is the deny-list that stops a `gh pr
    // comment`. Gated on `isFetched` below so a launch can't race past it.
    settingsFlag: hookSettings.data ? `--settings ${shellQuote(hookSettings.data)}` : undefined,
    chrome: startWithChrome.value,
  });

  // Every launch input must have *resolved* before the PTY spawns — the seed is
  // built once and applied at session creation, so a flag that arrives late is
  // silently dropped. Gate on `isFetched`, never on the value: a boolean setting
  // reads `false` both when it's off and when it hasn't loaded.
  const ready =
    !needsSeed ||
    (workspace.isFetched &&
      !session.isFetching &&
      prompt.isFetched &&
      model.isFetched &&
      effort.isFetched &&
      hookSettings.isFetched &&
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
            is saved — pick it back up whenever you're ready.
          </>
        }
        onResume={() => {
          dropCachedSession();
          setResumeRequested(true);
          setLiveSeen(false);
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
      <ReviewFooter pr={pr} hasWorkspace={!!cwd} />
    </div>
  );
}

/** The embedded terminal host, split out so it fully unmounts when the pane swaps
 *  to the resume state — that tears the embed down cleanly rather than leaving it
 *  pointed at a detached node. */
function ReviewTerminal({
  termKey,
  title,
  cwd,
  seed,
  onExited,
}: {
  termKey: string;
  title: string;
  cwd?: string;
  seed?: string;
  onExited: () => void;
}) {
  const { hostRef } = useEmbeddedTerminal({
    spec: { title, cwd, source: "review", refId: termKey, seed },
    onExited,
  });
  return <div ref={hostRef} className="h-full w-full" />;
}

/** States the guarantee the whole pane is built around, and offers to reclaim the
 *  checkout's disk. A promise the user can't see isn't one they can rely on. */
function ReviewFooter({ pr, hasWorkspace }: { pr: ReviewPr; hasWorkspace: boolean }) {
  const { repo } = useReviewsModel();
  const { mutate: removeWorkspace, isPending } = useRemoveReviewWorkspace(repo);

  return (
    <div className="flex flex-none items-center gap-2 border-t border-hairline bg-raised px-3 py-1.5 text-[10.5px] text-muted-3">
      <ClaudeSparkIcon size={11} className="flex-none" />
      <span className="min-w-0 flex-1 truncate">
        Reads this PR and answers questions. It never comments, approves, or pushes —{" "}
        <span className="text-fg-3">you do that.</span>
      </span>
      {!hasWorkspace && (
        <span
          className="flex flex-none items-center gap-1 text-status-amber"
          title="santree has no local clone of this PR's repository, so the session only has the diff — it can't grep the codebase or open files the diff doesn't touch."
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
