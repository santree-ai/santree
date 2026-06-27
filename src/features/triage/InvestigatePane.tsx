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
import { useEmbeddedTerminal } from "../terminal/useEmbeddedTerminal";

/** Single-quote a string for a POSIX shell command line. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function InvestigatePane({
  ticketId,
  cwd,
  command,
  agentExec,
  model,
  onExited,
}: {
  ticketId: string;
  cwd?: string;
  /** Configured investigate skill name (a Claude slash-command), or null. */
  command: string | null;
  /** The chosen agent's executable from settings; falls back to PATH when blank. */
  agentExec: string;
  /** Model override for the run, or null to use the agent's default. */
  model: string | null;
  onExited: () => void;
}) {
  // When a skill is configured, launch the configured agent executable under a
  // login shell so it + node resolve on PATH (like a normal terminal); `exec`
  // replaces the shell so quitting the agent closes the tab. Mirrors the CLI's
  // `claude [--model M] '/<cmd> <ticket>'`. With nothing configured, a plain shell.
  const exec = agentExec.trim() || "claude";
  const modelFlag = model ? `--model ${shellQuote(model)} ` : "";
  const seed = command
    ? `exec ${shellQuote(exec)} ${modelFlag}${shellQuote(`/${command} ${ticketId}`)}`
    : undefined;

  const { hostRef } = useEmbeddedTerminal({
    spec: { title: ticketId, cwd, source: "triage", refId: ticketId, seed },
    onExited,
  });

  return (
    <div className="min-h-0 flex-1">
      {/* The TerminalLayer overlays this host with the ticket's live session. */}
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}
