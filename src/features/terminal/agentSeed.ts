/**
 * Build the shell command that (re)launches an agent in a terminal, from a
 * backend-resolved {@link AgentSession}. `exec` is the agent binary; `prompt` is
 * the first message for a fresh start (the rendered work prompt, or a
 * `/investigate` command); `modelFlag` is an optional pre-quoted `--model …`
 * prefix. Returns `undefined` for a plain shell.
 *
 * `exec <bin>` replaces the login shell so quitting the agent ends the PTY — and
 * the next time the tab opens, the session has a transcript on disk, so the
 * backend resolves it to a `--resume` instead of a fresh start.
 */
import type { AgentSession } from "../../bindings";

/** Single-quote a string for a POSIX shell command line. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function agentSessionSeed(
  session: AgentSession | undefined,
  exec: string,
  opts: { prompt: string; modelFlag?: string },
): string | undefined {
  if (!session || session.type === "shell") return undefined;
  const bin = shellQuote(exec);
  if (session.type === "resume") {
    return `exec ${bin} --resume ${shellQuote(session.sessionId)}`;
  }
  const model = opts.modelFlag ? `${opts.modelFlag} ` : "";
  return `exec ${bin} ${model}--session-id ${shellQuote(session.sessionId)} ${shellQuote(opts.prompt)}`;
}
