/**
 * An AI review provider session that reads the pull request and writes its
 * findings back into santree as **drafts**.
 *
 * It launches with santree's own MCP server registered
 * (`--mcp-config`), so it has tools for a review brief and for draft comments —
 * and those tools are the only place it can write anything. The drafts land in
 * santree's database, appear inline in the diff, and reach GitHub only when the
 * user adds them to their own review. The same deny list still blocks every `gh`
 * route, so "it can't post" is not a promise about the model.
 *
 * Claude keeps the existing scoped settings path. Codex receives only santree's
 * review server as thread-scoped configuration; ambient extensions stay disabled.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";

import type { AgentKind, ReviewPr } from "../../bindings";
import { AgentIcon, WarningIcon } from "../../components/icons";
import { Button, TerminalActivity } from "../../components/primitives";
import { SessionEndedPane } from "../../components/SessionEndedPane";
import {
  CLAUDE_START_WITH_CHROME_KEY,
  queryKeys,
  REVIEW_AGENT_KEY,
  REVIEW_EFFORT_KEY,
  REVIEW_MODEL_KEY,
  REVIEW_PERMISSION_MODE_KEY,
  useAgentSession,
  useAiReviewLaunch,
  useBoolSetting,
  useResolvedProviderSetting,
  useReviewDrafts,
  useReviewWorkspace,
} from "../../lib/queries";
import { agentProvider, sessionAgent } from "../terminal/agentProvider";
import { agentSessionSeed, shellQuote } from "../terminal/agentSeed";
import { useHookInjection } from "../terminal/useHookInjection";
import { useReviewsModel } from "./model";
import { ReviewFooter, reviewTargetFor } from "./ReviewSessionShared";
import { ReviewTerminal } from "./ReviewTerminal";
import { useReviewSessionLatch } from "./useReviewSessionLatch";

/** The provider-neutral terminal key for a PR's AI review. Parsed back out by the
 * Agents panel (`registry.ts`), so the shape is a shared convention. */
export function aiReviewTermKey(pr: ReviewPr): string {
  return `ai-review:${pr.repo}#${pr.number}`;
}

export function AiReviewSessionPane({
  pr,
  agentKind,
  visible,
  onShowDrafts,
}: {
  pr: ReviewPr;
  agentKind: AgentKind;
  visible: boolean;
  onShowDrafts: () => void;
}) {
  const { repo } = useReviewsModel();
  const termKey = aiReviewTermKey(pr);
  const terminalRef = `${termKey}::${agentKind.toLowerCase()}`;
  const {
    ended,
    needsSeed: freshOpen,
    resumeRequested,
    requestResume,
  } = useReviewSessionLatch(terminalRef);

  const target = useMemo(() => (pr.headSha ? reviewTargetFor(pr) : null), [pr]);
  const needsSeed = !!target && freshOpen;

  // The checkout comes first: it's the session's cwd, and the launch's prompt
  // branches on whether it exists.
  const workspace = useReviewWorkspace(repo, target, needsSeed || resumeRequested);
  const cwd = workspace.data ?? undefined;
  const launch = useAiReviewLaunch(repo, target, needsSeed && workspace.isFetched);
  const session = useAgentSession(
    repo,
    termKey,
    cwd ?? "",
    true,
    agentKind,
    needsSeed && workspace.isFetched && !!launch.data,
  );

  const model = useResolvedProviderSetting(repo, REVIEW_MODEL_KEY, agentKind, REVIEW_AGENT_KEY);
  const effort = useResolvedProviderSetting(repo, REVIEW_EFFORT_KEY, agentKind, REVIEW_AGENT_KEY);
  const permissionMode = useResolvedProviderSetting(
    repo,
    REVIEW_PERMISSION_MODE_KEY,
    agentKind,
    REVIEW_AGENT_KEY,
  );
  const startWithChrome = useBoolSetting("app", CLAUDE_START_WITH_CHROME_KEY);
  const resolvedAgent = sessionAgent(session.data, agentKind);
  const provider = agentProvider(resolvedAgent);
  // The review's own restricted settings file, not the standard one — and never a
  // fallback to it: `ready` below holds the launch until `launch.data` resolves.
  // A provider that takes its hooks another way (Codex's `-c` overrides) still
  // gets them, so its session is registered and resumable like any other.
  const hooks = useHookInjection({ settingsPath: launch.data?.settingsPath });
  const seed = agentSessionSeed(session.data, {
    repo,
    termKey,
    // The rendered prompt carries a whole PR diff, far past what can be typed into
    // an interactive shell — so seed the instruction to read it.
    prompt: launch.data
      ? `Read ${launch.data.promptPath} and follow the instructions inside.`
      : `Review pull request #${pr.number}.`,
    modelFlag:
      provider.capabilities.cliLaunchOptions && model.data
        ? `--model ${shellQuote(model.data)}`
        : undefined,
    effortFlag:
      provider.capabilities.cliLaunchOptions && effort.data
        ? `--effort ${shellQuote(effort.data)}`
        : undefined,
    permissionMode: provider.capabilities.permissionMode
      ? (permissionMode.data ?? undefined)
      : undefined,
    settingsFlag: hooks.flagFor(resolvedAgent),
    mcpFlag:
      provider.capabilities.cliLaunchOptions && launch.data
        ? `--mcp-config ${shellQuote(launch.data.mcpConfigPath)}`
        : undefined,
    chrome: provider.capabilities.cliLaunchOptions && startWithChrome.value,
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
      hooks.readyFor(resolvedAgent) &&
      model.isFetched &&
      effort.isFetched &&
      permissionMode.isFetched &&
      startWithChrome.isFetched);

  const qc = useQueryClient();
  useEffect(() => {
    if (session.data && session.data.type !== "shell") {
      void qc.invalidateQueries({ queryKey: queryKeys.sessionProviders(repo, termKey) });
    }
  }, [session.data, qc, repo, termKey]);
  const dropCachedSession = useCallback(
    // The process can die while this pane is unmounted, so the cached resolution
    // may predate the exit — replaying it would hand the PTY a `--session-id` for
    // a session whose transcript now exists.
    () => qc.removeQueries({ queryKey: queryKeys.agentSessionPrefix(repo, termKey, agentKind) }),
    [qc, repo, termKey, agentKind],
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
            terminalRef={terminalRef}
            title={`Review #${pr.number} · ${provider.label}`}
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
          <div className="flex h-full flex-col items-center justify-center">
            <TerminalActivity
              label={workspace.isFetching ? "Checking out the PR…" : "Reading the pull request…"}
            />
          </div>
        )}
      </div>
      <AiReviewFooter
        pr={pr}
        agentKind={agentKind}
        hasWorkspace={!!cwd}
        onShowDrafts={onShowDrafts}
      />
    </div>
  );
}

function AiReviewFooter({
  pr,
  agentKind,
  hasWorkspace,
  onShowDrafts,
}: {
  pr: ReviewPr;
  agentKind: AgentKind;
  hasWorkspace: boolean;
  onShowDrafts: () => void;
}) {
  const { data: drafts } = useReviewDrafts(pr.repo, pr.number);
  const count = drafts?.filter((draft) => draft.agentKind === agentKind).length ?? 0;
  return (
    <ReviewFooter
      pr={pr}
      agentKind={agentKind}
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
            <AgentIcon kind={agentKind} size={10} />
            {count} draft{count === 1 ? "" : "s"}
          </button>
        ) : null
      }
    />
  );
}
