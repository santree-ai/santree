/**
 * The "AI review" tab: a Claude session that reads the pull request and writes its
 * findings back into santree as **drafts**.
 *
 * The difference from {@link AiReviewPane} ("Ask AI") is what the session is asked
 * to produce. This one launches with santree's own MCP server registered
 * (`--mcp-config`), so it has tools for a review brief and for draft comments —
 * and those tools are the only place it can write anything. The drafts land in
 * santree's database, appear inline in the diff, and reach GitHub only when the
 * user adds them to their own review. The same deny list still blocks every `gh`
 * route, so "it can't post" is not a promise about the model.
 *
 * Its user's own MCP servers stay available on purpose: a review that can read the
 * ticket, the design doc it links, and the related issues is worth several that
 * only see the diff. Read widely, write in one place.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import type { ReviewPr } from "../../bindings";
import { ClaudeSparkIcon, WarningIcon } from "../../components/icons";
import { Button, Spinner } from "../../components/primitives";
import { SessionEndedPane } from "../../components/SessionEndedPane";
import {
  CLAUDE_START_WITH_CHROME_KEY,
  queryKeys,
  REVIEW_EFFORT_KEY,
  REVIEW_MODEL_KEY,
  useAgentSession,
  useAiReviewLaunch,
  useBoolSetting,
  useResolvedSetting,
  useReviewDrafts,
  useReviewWorkspace,
} from "../../lib/queries";
import { agentSessionSeed, shellQuote } from "../terminal/agentSeed";
import { ReviewFooter, reviewTargetFor } from "./AiReviewPane";
import { useReviewsModel } from "./model";
import { ReviewTerminal } from "./ReviewTerminal";
import { useReviewSessionLatch } from "./useReviewSessionLatch";

/** The terminal-registry key for a PR's AI review. Distinct from the Ask AI
 *  session's `review:` key so the two can be open at once — reading a PR and
 *  reviewing it are different jobs, often on the same PR. Parsed back out by the
 *  Agents panel (`registry.ts`), so the shape is a shared convention. */
export function aiReviewTermKey(pr: ReviewPr): string {
  return `ai-review:${pr.repo}#${pr.number}`;
}

export function AiReviewSessionPane({
  pr,
  visible,
  onShowDrafts,
}: {
  pr: ReviewPr;
  visible: boolean;
  onShowDrafts: () => void;
}) {
  const { repo } = useReviewsModel();
  const termKey = aiReviewTermKey(pr);
  const {
    ended,
    needsSeed: freshOpen,
    resumeRequested,
    requestResume,
  } = useReviewSessionLatch(termKey);

  const target = useMemo(() => (pr.headSha ? reviewTargetFor(pr) : null), [pr]);
  const needsSeed = !!target && freshOpen;

  // The checkout comes first: it's the session's cwd, and the launch's prompt
  // branches on whether it exists.
  const workspace = useReviewWorkspace(repo, target, needsSeed || resumeRequested);
  const cwd = workspace.data ?? undefined;
  const session = useAgentSession(repo, termKey, cwd ?? "", true, needsSeed && workspace.isFetched);
  const launch = useAiReviewLaunch(repo, target, needsSeed && workspace.isFetched);

  const model = useResolvedSetting(repo, REVIEW_MODEL_KEY);
  const effort = useResolvedSetting(repo, REVIEW_EFFORT_KEY);
  const startWithChrome = useBoolSetting("app", CLAUDE_START_WITH_CHROME_KEY);

  const seed = agentSessionSeed(session.data, "claude", {
    repo,
    termKey,
    // The rendered prompt carries a whole PR diff, far past what can be typed into
    // an interactive shell — so seed the instruction to read it.
    prompt: launch.data
      ? `Read ${launch.data.promptPath} and follow the instructions inside.`
      : `Review pull request #${pr.number}.`,
    modelFlag: model.data ? `--model ${shellQuote(model.data)}` : undefined,
    effortFlag: effort.data ? `--effort ${shellQuote(effort.data)}` : undefined,
    settingsFlag: launch.data ? `--settings ${shellQuote(launch.data.settingsPath)}` : undefined,
    mcpFlag: launch.data ? `--mcp-config ${shellQuote(launch.data.mcpConfigPath)}` : undefined,
    chrome: startWithChrome.value,
  });

  // Every launch input must have resolved before the PTY spawns: the seed is built
  // once and applied at session creation, so a flag that arrives late is silently
  // dropped.
  //
  // The launch is gated on **having resolved**, not on `isFetched`. An errored query is
  // "fetched" too, and the flags all fall back to `undefined` — which would spawn a
  // session told to review a PR with no deny list, no tools, and no untrusted-data
  // fence around the diff. That's the one outcome this feature exists to prevent,
  // so a failed launch is a failed launch: nothing spawns, and the pane says why.
  // The settings-only inputs still gate on `isFetched` (a boolean setting reads
  // `false` both when it's off and when it hasn't loaded).
  const ready =
    !needsSeed ||
    (workspace.isFetched &&
      !session.isFetching &&
      !!launch.data &&
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
        title="AI review ended"
        subtitle={
          <>
            Its drafts and brief for{" "}
            <span className="font-mono text-fg-3">
              {pr.repo}#{pr.number}
            </span>{" "}
            are saved. Pick the session back up to revise them.
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
            title={`Review #${pr.number}`}
            cwd={cwd}
            seed={seed}
            attach={visible}
            onExited={dropCachedSession}
          />
        ) : launch.isError ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <WarningIcon size={16} className="text-status-amber" />
            <span className="text-[12px] text-fg-2">Couldn't start the AI review</span>
            <span className="max-w-md text-[11px] leading-[1.5] text-muted-3">
              {launch.error instanceof Error ? launch.error.message : "Something went wrong."}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void launch.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <Spinner size={16} />
            <span className="text-[11px] text-muted-3">
              {workspace.isFetching ? "Checking out the PR…" : "Reading the pull request…"}
            </span>
          </div>
        )}
      </div>
      <AiReviewFooter pr={pr} hasWorkspace={!!cwd} onShowDrafts={onShowDrafts} />
    </div>
  );
}

function AiReviewFooter({
  pr,
  hasWorkspace,
  onShowDrafts,
}: {
  pr: ReviewPr;
  hasWorkspace: boolean;
  onShowDrafts: () => void;
}) {
  const { data: drafts } = useReviewDrafts(pr.repo, pr.number);
  const count = drafts?.length ?? 0;
  return (
    <ReviewFooter
      pr={pr}
      hasWorkspace={hasWorkspace}
      message={
        <>
          Writes drafts and a brief here. Nothing reaches GitHub until{" "}
          <span className="text-fg-3">you add them to your review.</span>
        </>
      }
      extra={
        count > 0 ? (
          <button
            type="button"
            onClick={onShowDrafts}
            title="Show the drafts in the diff, where you can edit and send them"
            className="flex flex-none cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] text-muted-2 transition-colors hover:bg-hover hover:text-fg-2"
          >
            <ClaudeSparkIcon size={10} />
            {count} draft{count === 1 ? "" : "s"}
          </button>
        ) : null
      }
    />
  );
}
