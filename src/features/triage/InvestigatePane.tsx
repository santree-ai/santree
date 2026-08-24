/**
 * The Investigate tab: a real provider session scoped to the repo and persisted
 * through the shared session contract (see COMPLIANCE.md). The
 * terminal is a *global* session (so it also appears in the Terminal tab,
 * grouped under "Triage"); the inner {@link InvestigateTerminal} registers the
 * pane as the embed host and the persistent TerminalLayer positions the live
 * session over it.
 *
 * When the agent exits we don't drop straight back to the discussion — like the
 * Trees work terminal, we show a "resume when ready" pane (its conversation is
 * still on disk, so Resume continues it). Only a plain shell (no repo path to run
 * in) falls back to the discussion on exit, since there's nothing to resume.
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
  INVESTIGATE_REMOTE_CONTROL_KEY,
  queryKeys,
  useAgentSession,
  useBoolSetting,
  useClaudeHookSettings,
  useInvestigatePrompt,
  useResolvedProviderSetting,
  useResolvedSetting,
} from "../../lib/queries";
import { agentProvider, sessionAgent } from "../terminal/agentProvider";
import { agentSessionSeed, shellQuote } from "../terminal/agentSeed";
import { useTerminals } from "../terminal/TerminalsContext";
import { useEmbeddedTerminal } from "../terminal/useEmbeddedTerminal";
import { triageTerminalRef } from "./providerSessions";

export function InvestigatePane({
  repo,
  ticketId,
  cwd,
  agentKind,
  hasStartedSession,
  onExited,
}: {
  /** Active repo name — scopes the persisted provider session. */
  repo: string;
  ticketId: string;
  cwd?: string;
  agentKind: AgentKind;
  /** This ticket has a stored session from a past investigation (across app
   *  restarts) — so land on the resume pane rather than auto-launching. */
  hasStartedSession: boolean;
  /** Called only for a plain shell (no skill) when it exits — a launchable
   *  investigation keeps the tab and shows the resume pane instead. */
  onExited: () => void;
}) {
  // Only resolve a (re)launch when there's no live PTY to attach to; latch
  // `liveSeen` (as state, so the exit re-renders) so quitting the agent doesn't
  // immediately re-resume it into a restart loop — instead we show the resume
  // pane, and its Resume button clears the latch to re-seed. This pane is keyed
  // by ticket, so reopening the ticket resets the latch.
  const { tabs } = useTerminals();
  const terminalRef = triageTerminalRef(ticketId, agentKind);
  const liveSession = tabs.some((t) => t.source === "triage" && t.refId === terminalRef);
  const [liveSeen, setLiveSeen] = useState(false);
  // A brand-new investigation (no stored session) auto-launches when opened; one
  // that already has a stored session waits behind the resume pane until the user
  // clicks Resume (mirrors the Trees work terminal — a fresh start goes straight
  // to the agent, a past session shows "resume when ready"). `resumeRequested`
  // is that explicit click; reset once the session is live again so a later
  // in-place exit shows the pane once more.
  const [resumeRequested, setResumeRequested] = useState(false);
  useEffect(() => {
    if (liveSession) {
      setLiveSeen(true);
      setResumeRequested(false);
    }
  }, [liveSession]);

  const termKey = `triage:${ticketId}`;
  const canLaunch = !!cwd;
  const qc = useQueryClient();
  // Something to resume: it ran and exited in-place (liveSeen), or a past
  // investigation left a stored session. Show the resume pane instead of a dead
  // terminal — unless the user just asked to resume (then we launch).
  const resumable = liveSeen || hasStartedSession;
  const ended = canLaunch && !liveSession && resumable && !resumeRequested;
  // Auto-launch only a genuinely fresh investigation (nothing to resume), or the
  // one the user just clicked Resume on.
  const needsSeed = canLaunch && !liveSession && !liveSeen && (resumeRequested || !resumable);
  const session = useAgentSession(repo, termKey, cwd ?? "", canLaunch, agentKind, needsSeed);
  useEffect(() => {
    if (session.data && session.data.type !== "shell") {
      void qc.invalidateQueries({ queryKey: queryKeys.startedInvestigations(repo) });
    }
  }, [session.data, qc, repo]);
  // The opening prompt is rendered backend-side from the live ticket (its
  // screenshots extracted to files the agent can Read) and written to a file;
  // fetch that file's PATH only for a fresh seed. The terminal waits on it (via
  // `ready`) so the file exists before the agent starts.
  const investigatePrompt = useInvestigatePrompt(repo, ticketId, needsSeed);
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
  const modelFlag =
    resolvedAgent === agentKind && model.data ? `--model ${shellQuote(model.data)}` : undefined;
  const effortFlag =
    resolvedAgent === agentKind && effort.data ? `--effort ${shellQuote(effort.data)}` : undefined;
  // `--remote-control` is opt-out (Settings → Investigation): some environments
  // run a `claude` build old enough to predate the flag, which would otherwise
  // fail every launch with no visible cause (see CLAUDE.md's "verify vendor
  // flags" gotcha) and no way to turn it off.
  const remoteControlSetting = useResolvedSetting(repo, INVESTIGATE_REMOTE_CONTROL_KEY);
  const remoteControlEnabled = remoteControlSetting.data !== "false";
  // Claude keeps its hook-backed state pipeline; Codex state comes from App Server.
  const hookSettings = useClaudeHookSettings().data;
  const startWithChrome = useBoolSetting("app", CLAUDE_START_WITH_CHROME_KEY).value;
  const seed = agentSessionSeed(session.data, {
    repo,
    termKey,
    // Seed the short "read the file" instruction rather than the prompt text: the
    // rendered triage prompt (full ticket + comment thread) is far too large to
    // type into the interactive-shell seed. The one-liner is only a fallback for
    // the window where the path is still loading (which `ready` gates out).
    prompt: investigatePrompt.data
      ? `Read ${investigatePrompt.data} and follow the instructions inside.`
      : `Investigate ${ticketId}.`,
    modelFlag,
    effortFlag,
    permissionMode: provider.capabilities.permissionMode
      ? (permissionMode.data ?? undefined)
      : undefined,
    remoteControl:
      provider.capabilities.remoteControl && remoteControlEnabled ? ticketId : undefined,
    settingsFlag:
      provider.capabilities.cliLaunchOptions && hookSettings
        ? `--settings ${shellQuote(hookSettings)}`
        : undefined,
    chrome: provider.capabilities.cliLaunchOptions && startWithChrome,
  });
  // Hold the embed until the seed decision, the remote-control setting, and the
  // prompt file are all fresh, so the new PTY carries the right flags and reads a
  // file that already exists from the first frame.
  const ready =
    !needsSeed ||
    (!session.isFetching &&
      !remoteControlSetting.isLoading &&
      investigatePrompt.isFetched &&
      model.isFetched &&
      effort.isFetched &&
      permissionMode.isFetched);

  const dropCachedSession = useCallback(
    // Drop the cached session resolution so the next launch re-asks the backend
    // instead of replaying a stale "fresh" decision whose transcript now exists
    // on disk (which `session::resolve` would correctly resolve to Resume).
    () => qc.removeQueries({ queryKey: queryKeys.agentSessionPrefix(repo, termKey, agentKind) }),
    [qc, repo, termKey, agentKind],
  );
  const handleExited = useCallback(() => {
    dropCachedSession();
    // The stored session persists past exit — refresh the "started" set so the
    // queue's resumable indicator (and this ticket's tab) reflect it once the
    // live session is gone.
    qc.invalidateQueries({ queryKey: queryKeys.startedInvestigations(repo) });
    // A launchable investigation stays put and shows the resume pane (driven by
    // the resumable check above); a plain shell has nothing to resume, so fall
    // back to the discussion.
    if (!canLaunch) onExited();
  }, [dropCachedSession, qc, repo, canLaunch, onExited]);

  if (ended) {
    return (
      <SessionEndedPane
        title="Investigation ended"
        subtitle={
          <>
            The investigation for <span className="font-mono text-fg-3">{ticketId}</span> is saved.
            Resume the same conversation whenever you're ready.
          </>
        }
        onResume={() => {
          // Drop the cached resolution first — the process can die while this
          // pane is unmounted (onExited never fires then), leaving a stale
          // cached decision. `resumeRequested` + clearing the `liveSeen` latch
          // re-seed; the resolve allows a fresh session when the transcript is
          // gone (the stored id is reused either way).
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
        <InvestigateTerminal
          ticketId={ticketId}
          terminalRef={terminalRef}
          cwd={cwd}
          seed={seed}
          onExited={handleExited}
        />
      ) : (
        <div className="flex h-full items-center justify-center">
          <Spinner size={16} />
        </div>
      )}
    </div>
  );
}

/** The embedded terminal host, split out so it fully unmounts when the pane
 *  swaps to the resume state — that tears the embed down cleanly (setEmbed(null))
 *  instead of leaving it pointed at a detached node. */
function InvestigateTerminal({
  ticketId,
  terminalRef,
  cwd,
  seed,
  onExited,
}: {
  ticketId: string;
  terminalRef: string;
  cwd?: string;
  seed?: string;
  onExited: () => void;
}) {
  const { hostRef } = useEmbeddedTerminal({
    spec: { title: ticketId, cwd, source: "triage", refId: terminalRef, seed },
    onExited,
  });
  // The TerminalLayer overlays this host with the ticket's live session.
  return <div ref={hostRef} className="h-full w-full" />;
}
