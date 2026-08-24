/**
 * The repo session: an agent session on the base checkout that belongs to no
 * ticket — for asking questions about the codebase, running a CLI command, or
 * anything the queue hasn't got a row for.
 *
 * Trees has always exposed the repo root as a general terminal; Triage only ever
 * offered agents *attached to a ticket*, so wanting
 * to ask one general question meant hijacking some unrelated investigation.
 *
 * Deliberately thinner than {@link InvestigatePane}: no rendered ticket prompt to
 * wait on, no `--remote-control` name (there's no ticket to name it after), and
 * no stored-investigation registry to consult. What it does share is the session
 * plumbing — a persisted `--session-id` resolved by the backend, seeding only
 * (see COMPLIANCE.md), and the same "resume when ready" pane on exit so quitting
 * the agent can't spin into a relaunch loop.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import type { AgentKind } from "../../bindings";
import { Spinner } from "../../components/primitives";
import { SessionEndedPane } from "../../components/SessionEndedPane";
import {
  CLAUDE_START_WITH_CHROME_KEY,
  INVESTIGATE_AGENT_KEY,
  INVESTIGATE_EFFORT_KEY,
  INVESTIGATE_MODEL_KEY,
  INVESTIGATE_PERMISSION_MODE_KEY,
  queryKeys,
  useAgentSession,
  useBoolSetting,
  useClaudeHookSettings,
  useResolvedProviderSetting,
} from "../../lib/queries";
import { agentProvider, sessionAgent } from "../terminal/agentProvider";
import { agentSessionSeed, shellQuote } from "../terminal/agentSeed";
import { useTerminals } from "../terminal/TerminalsContext";
import { useEmbeddedTerminal } from "../terminal/useEmbeddedTerminal";
import { triageTerminalRef } from "./providerSessions";

/**
 * Terminal `refId` for a repo's session — a sentinel, never a ticket id, so the
 * registry keys it apart from every investigation while still grouping it under
 * "Triage" in the Terminal tab. Can't collide with a Linear id (which never
 * contains `__`).
 *
 * **Scoped by repo**, because the registry dedups on `(source, refId)` alone —
 * no cwd, no repo (see `orchestrator.ts`'s `ensure`). A bare `__repo__` would
 * hand the second repo's session the first one's live PTY, still running in the
 * first one's directory. Per-ticket panes get this for free from globally unique
 * Linear ids; a sentinel has to earn it.
 */
export const repoSessionRefId = (repo: string) => `__repo__:${repo}`;

export function RepoSessionPane({
  repo,
  branch,
  cwd,
  agentKind,
}: {
  /** Active repo name — scopes the persisted provider session. */
  repo: string;
  /** The base branch it runs on, for the resume pane's copy. */
  branch: string;
  /** The repo root — the same checkout investigations run in. */
  cwd?: string;
  agentKind: AgentKind;
}) {
  const refId = repoSessionRefId(repo);
  const terminalRef = triageTerminalRef(refId, agentKind);
  const { tabs } = useTerminals();
  const liveSession = tabs.some((t) => t.source === "triage" && t.refId === terminalRef);
  // Latch that we've seen it live (as state, so the exit re-renders): without it,
  // quitting the agent would immediately re-seed and restart it.
  const [liveSeen, setLiveSeen] = useState(false);
  const [resumeRequested, setResumeRequested] = useState(false);
  useEffect(() => {
    if (liveSession) {
      setLiveSeen(true);
      setResumeRequested(false);
    }
  }, [liveSession]);

  const termKey = `triage:${refId}`;
  const canLaunch = !!cwd;
  const qc = useQueryClient();
  // Unlike an investigation, opening this launches straight away — it's a scratch
  // session you opened to ask something, not a saved piece of work to decide about
  // resuming. The backend still reuses the stored session id, so what you get is
  // the same conversation continued rather than a fresh one each time.
  const ended = canLaunch && !liveSession && liveSeen && !resumeRequested;
  const needsSeed = canLaunch && !liveSession && (!liveSeen || resumeRequested);
  const session = useAgentSession(repo, termKey, cwd ?? "", canLaunch, agentKind, needsSeed);
  useEffect(() => {
    if (session.data && session.data.type !== "shell") {
      void qc.invalidateQueries({ queryKey: queryKeys.startedInvestigations(repo) });
    }
  }, [session.data, qc, repo]);

  const resolvedAgent = sessionAgent(session.data, agentKind);
  const provider = agentProvider(resolvedAgent);
  const model = useResolvedProviderSetting(
    repo,
    INVESTIGATE_MODEL_KEY,
    agentKind,
    INVESTIGATE_AGENT_KEY,
  );
  const effort = useResolvedProviderSetting(
    repo,
    INVESTIGATE_EFFORT_KEY,
    agentKind,
    INVESTIGATE_AGENT_KEY,
  );
  const permissionMode = useResolvedProviderSetting(
    repo,
    INVESTIGATE_PERMISSION_MODE_KEY,
    agentKind,
    INVESTIGATE_AGENT_KEY,
  );
  const hookSettings = useClaudeHookSettings().data;
  const startWithChrome = useBoolSetting("app", CLAUDE_START_WITH_CHROME_KEY).value;
  const seed = agentSessionSeed(session.data, {
    repo,
    termKey,
    // No opening prompt: the whole point is that you bring the question.
    modelFlag:
      resolvedAgent === agentKind && model.data ? `--model ${shellQuote(model.data)}` : undefined,
    effortFlag:
      resolvedAgent === agentKind && effort.data
        ? `--effort ${shellQuote(effort.data)}`
        : undefined,
    permissionMode: provider.capabilities.permissionMode
      ? (permissionMode.data ?? undefined)
      : undefined,
    settingsFlag:
      provider.capabilities.cliLaunchOptions && hookSettings
        ? `--settings ${shellQuote(hookSettings)}`
        : undefined,
    chrome: provider.capabilities.cliLaunchOptions && startWithChrome,
  });
  // Hold the embed until the seed decision is fresh, so the new PTY carries the
  // right flags from its first frame.
  const ready =
    !needsSeed ||
    (!session.isFetching && model.isFetched && effort.isFetched && permissionMode.isFetched);

  const dropCachedSession = useCallback(
    // Drop the cached resolution so the next launch re-asks the backend instead of
    // replaying a stale "fresh" decision whose transcript now exists on disk.
    () => qc.removeQueries({ queryKey: queryKeys.agentSessionPrefix(repo, termKey, agentKind) }),
    [qc, repo, termKey, agentKind],
  );

  if (ended) {
    return (
      <SessionEndedPane
        title="Session ended"
        subtitle={
          <>
            Your session on <span className="font-mono text-fg-3">{branch}</span> is saved. Resume
            the same conversation whenever you're ready.
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
    <div className="min-h-0 flex-1">
      {ready ? (
        <RepoSessionTerminal
          refId={terminalRef}
          branch={branch}
          cwd={cwd}
          seed={seed}
          onExited={dropCachedSession}
        />
      ) : (
        <div className="flex h-full items-center justify-center">
          <Spinner size={16} />
        </div>
      )}
    </div>
  );
}

/** The embedded terminal host, split out so it fully unmounts when the pane swaps
 *  to the resume state — tearing the embed down cleanly instead of leaving it
 *  pointed at a detached node. */
function RepoSessionTerminal({
  refId,
  branch,
  cwd,
  seed,
  onExited,
}: {
  refId: string;
  branch: string;
  cwd?: string;
  seed?: string;
  onExited: () => void;
}) {
  const { hostRef } = useEmbeddedTerminal({
    spec: { title: branch, cwd, source: "triage", refId, seed },
    onExited,
  });
  return <div ref={hostRef} className="h-full w-full" />;
}
