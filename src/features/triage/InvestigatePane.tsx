/**
 * The Investigate tab. For now it hosts a real terminal scoped to the repo (a
 * Claude investigation will replace it later — see COMPLIANCE.md). The terminal
 * is a *global* session (so it also appears in the Terminal tab, grouped under
 * "Triage"); we render it here by registering this pane as the embed host — the
 * persistent TerminalLayer positions the live session over it.
 *
 * The embed lifecycle (synchronous-rect placement + seen-latch exit detection)
 * lives in `useEmbeddedTerminal`; when the hosted process exits, `onExited`
 * drops us back to the discussion.
 */
import { useRef } from "react";

import { Spinner } from "../../components/primitives";
import { useAgentSession } from "../../lib/queries";
import { agentSessionSeed, shellQuote } from "../terminal/agentSeed";
import { useTerminals } from "../terminal/TerminalsContext";
import { useEmbeddedTerminal } from "../terminal/useEmbeddedTerminal";

export function InvestigatePane({
  repo,
  ticketId,
  cwd,
  command,
  agentExec,
  model,
  effort,
  onExited,
}: {
  /** Active repo name — scopes the persisted Claude session. */
  repo: string;
  ticketId: string;
  cwd?: string;
  /** Configured investigate skill name (a Claude slash-command), or null. */
  command: string | null;
  /** The chosen agent's executable from settings; falls back to PATH when blank. */
  agentExec: string;
  /** Model override for the run, or null to use the agent's default. */
  model: string | null;
  /** Effort level (Claude's --effort), or null for the CLI default. */
  effort: string | null;
  onExited: () => void;
}) {
  // When a skill is configured, launch the configured agent under a login shell so
  // it + node resolve on PATH (like a normal terminal); `exec` replaces the shell
  // so quitting the agent closes the tab. Mirrors the CLI's
  // `claude [--model M] '/<cmd> <ticket>'`. With nothing configured, a plain shell.
  //
  // The session is persisted: a first investigate mints a `--session-id`; a later
  // one (after the agent was quit or the app restarted) resumes the same
  // conversation instead of re-running the investigation from scratch.
  // Only resolve a (re)launch when there's no live PTY to attach to; latch
  // `everLive` so quitting the agent doesn't re-resume it into a restart loop
  // (this pane is keyed by ticket, so reopening for the ticket resets it).
  const { tabs } = useTerminals();
  const liveSession = tabs.some((t) => t.source === "triage" && t.refId === ticketId);
  const everLive = useRef(false);
  if (liveSession) everLive.current = true;

  const canLaunch = command != null && !!cwd;
  const needsSeed = canLaunch && !liveSession && !everLive.current;
  const session = useAgentSession(repo, `triage:${ticketId}`, cwd ?? "", canLaunch, needsSeed);
  const exec = agentExec.trim() || "claude";
  const modelFlag = model ? `--model ${shellQuote(model)}` : undefined;
  const effortFlag = effort ? `--effort ${shellQuote(effort)}` : undefined;
  const seed = command
    ? agentSessionSeed(session.data, exec, {
        prompt: `/${command} ${ticketId}`,
        modelFlag,
        effortFlag,
        remoteControl: ticketId,
      })
    : undefined;
  // Hold the embed until the seed decision is fresh, so the new PTY carries it.
  const ready = !needsSeed || !session.isFetching;

  const { hostRef } = useEmbeddedTerminal({
    spec: { title: ticketId, cwd, source: "triage", refId: ticketId, seed },
    onExited,
  });

  return (
    <div className="min-h-0 flex-1">
      {/* The TerminalLayer overlays this host with the ticket's live session. */}
      {ready ? (
        <div ref={hostRef} className="h-full w-full" />
      ) : (
        <div className="flex h-full items-center justify-center">
          <Spinner size={16} />
        </div>
      )}
    </div>
  );
}
