/**
 * Build the shell command that (re)launches an agent in a terminal, from a
 * backend-resolved {@link AgentSession}. `exec` is the agent binary; `prompt` is
 * the first message for a fresh start (the rendered work prompt, or a
 * `/investigate` command); `modelFlag` / `effortFlag` are optional pre-quoted
 * `--model …` / `--effort …` prefixes (applied only on a fresh start — a resume
 * keeps the session's own model/effort); `remoteControl` names the session for
 * Claude's Remote Control web (we pass the ticket id, so triage/work sessions are
 * easy to spot there). Returns `undefined` for a plain shell.
 *
 * `exec <bin>` replaces the login shell so quitting the agent ends the PTY — and
 * the next time the tab opens, the session has a transcript on disk, so the
 * backend resolves it to a `--resume` instead of a fresh start.
 */
import type { AgentSession } from "../../bindings";

/** Single-quote a string for a POSIX shell command line. */
export function shellQuote(s: string): string {
  // The result is typed into a live interactive shell, not just parsed by it —
  // quoting alone stops the shell parser but not the terminal's line editor, which
  // interprets raw C0 bytes (e.g. \x15 kill-line, \r accept-line) as they arrive.
  // Strip them so untrusted content (ticket titles/bodies) can't break out of the
  // quoted string mid-paste; a literal newline is folded to a space for the same
  // reason (one PTY write is meant to stay one typed line).
  const sanitized = Array.from(s.replace(/\n/g, " "))
    .filter((c) => {
      const code = c.codePointAt(0) ?? 0;
      return !(code <= 0x1f || code === 0x7f);
    })
    .join("");
  return `'${sanitized.replace(/'/g, `'\\''`)}'`;
}

export function agentSessionSeed(
  session: AgentSession | undefined,
  exec: string,
  opts: { prompt: string; modelFlag?: string; effortFlag?: string; remoteControl?: string },
): string | undefined {
  if (!session || session.type === "shell") return undefined;
  const bin = shellQuote(exec);
  // Enable + name Remote Control (Claude's `--remote-control [name]`) with the
  // ticket id, so the session is identifiable on the Remote Control web.
  const rc = opts.remoteControl ? `--remote-control ${shellQuote(opts.remoteControl)} ` : "";
  if (session.type === "resume") {
    return `exec ${bin} ${rc}--resume ${shellQuote(session.sessionId)}`;
  }
  const model = opts.modelFlag ? `${opts.modelFlag} ` : "";
  const effort = opts.effortFlag ? `${opts.effortFlag} ` : "";
  return `exec ${bin} ${rc}${model}${effort}--session-id ${shellQuote(session.sessionId)} ${shellQuote(opts.prompt)}`;
}
