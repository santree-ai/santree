/**
 * The Investigate tab: a real Claude session scoped to the repo, run over a
 * persisted `--session-id` (see COMPLIANCE.md — placement + seeding only). The
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

import { Spinner } from "../../components/primitives";
import { SessionEndedPane } from "../../components/SessionEndedPane";
import {
  CLAUDE_START_WITH_CHROME_KEY,
  INVESTIGATE_REMOTE_CONTROL_KEY,
  queryKeys,
  useAgentSession,
  useBoolSetting,
  useClaudeHookSettings,
  useInvestigatePrompt,
  useResolvedSetting,
} from "../../lib/queries";
import { agentSessionSeed, shellQuote } from "../terminal/agentSeed";
import { useTerminals } from "../terminal/TerminalsContext";
import { useEmbeddedTerminal } from "../terminal/useEmbeddedTerminal";

export function InvestigatePane({
  repo,
  ticketId,
  cwd,
  agentExec,
  model,
  effort,
  hasStartedSession,
  onExited,
}: {
  /** Active repo name — scopes the persisted Claude session. */
  repo: string;
  ticketId: string;
  cwd?: string;
  /** The chosen agent's executable from settings; falls back to PATH when blank. */
  agentExec: string;
  /** Model override for the run, or null to use the agent's default. */
  model: string | null;
  /** Effort level (Claude's --effort), or null for the CLI default. */
  effort: string | null;
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
  const liveSession = tabs.some((t) => t.source === "triage" && t.refId === ticketId);
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
  // Something to resume: it ran and exited in-place (liveSeen), or a past
  // investigation left a stored session. Show the resume pane instead of a dead
  // terminal — unless the user just asked to resume (then we launch).
  const resumable = liveSeen || hasStartedSession;
  const ended = canLaunch && !liveSession && resumable && !resumeRequested;
  // Auto-launch only a genuinely fresh investigation (nothing to resume), or the
  // one the user just clicked Resume on.
  const needsSeed = canLaunch && !liveSession && !liveSeen && (resumeRequested || !resumable);
  const session = useAgentSession(repo, termKey, cwd ?? "", canLaunch, needsSeed);
  // The opening prompt is rendered backend-side from the live ticket (its
  // screenshots extracted to files the agent can Read) and written to a file;
  // fetch that file's PATH only for a fresh seed. The terminal waits on it (via
  // `ready`) so the file exists before the agent starts.
  const investigatePrompt = useInvestigatePrompt(repo, ticketId, needsSeed);
  const exec = agentExec.trim() || "claude";
  const modelFlag = model ? `--model ${shellQuote(model)}` : undefined;
  const effortFlag = effort ? `--effort ${shellQuote(effort)}` : undefined;
  // `--remote-control` is opt-out (Settings → Investigation): some environments
  // run a `claude` build old enough to predate the flag, which would otherwise
  // fail every launch with no visible cause (see CLAUDE.md's "verify vendor
  // flags" gotcha) and no way to turn it off.
  const remoteControlSetting = useResolvedSetting(repo, INVESTIGATE_REMOTE_CONTROL_KEY);
  const remoteControlEnabled = remoteControlSetting.data !== "false";
  // Investigate is Claude-only by design, so inject session-state hooks unconditionally.
  const hookSettings = useClaudeHookSettings().data;
  const startWithChrome = useBoolSetting("app", CLAUDE_START_WITH_CHROME_KEY).value;
  const seed = agentSessionSeed(session.data, exec, {
    // Seed the short "read the file" instruction rather than the prompt text: the
    // rendered triage prompt (full ticket + comment thread) is far too large to
    // type into the interactive-shell seed. The one-liner is only a fallback for
    // the window where the path is still loading (which `ready` gates out).
    prompt: investigatePrompt.data
      ? `Read ${investigatePrompt.data} and follow the instructions inside.`
      : `Investigate ${ticketId}.`,
    modelFlag,
    effortFlag,
    remoteControl: remoteControlEnabled ? ticketId : undefined,
    settingsFlag: hookSettings ? `--settings ${shellQuote(hookSettings)}` : undefined,
    chrome: startWithChrome,
  });
  // Hold the embed until the seed decision, the remote-control setting, and the
  // prompt file are all fresh, so the new PTY carries the right flags and reads a
  // file that already exists from the first frame.
  const ready =
    !needsSeed ||
    (!session.isFetching && !remoteControlSetting.isLoading && investigatePrompt.isFetched);

  const qc = useQueryClient();
  const dropCachedSession = useCallback(
    // Drop the cached session resolution so the next launch re-asks the backend
    // instead of replaying a stale "fresh" decision whose transcript now exists
    // on disk (which `session::resolve` would correctly resolve to Resume).
    () => qc.removeQueries({ queryKey: ["agent-session", repo, termKey] }),
    [qc, repo, termKey],
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
            The investigation for <span className="font-mono text-fg-3">{ticketId}</span> is saved —
            resume the same conversation whenever you're ready.
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
        <InvestigateTerminal ticketId={ticketId} cwd={cwd} seed={seed} onExited={handleExited} />
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
  cwd,
  seed,
  onExited,
}: {
  ticketId: string;
  cwd?: string;
  seed?: string;
  onExited: () => void;
}) {
  const { hostRef } = useEmbeddedTerminal({
    spec: { title: ticketId, cwd, source: "triage", refId: ticketId, seed },
    onExited,
  });
  // The TerminalLayer overlays this host with the ticket's live session.
  return <div ref={hostRef} className="h-full w-full" />;
}
