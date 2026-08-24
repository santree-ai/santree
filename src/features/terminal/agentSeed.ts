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
export {
  type AgentSeedOptions,
  agentSessionSeed,
  shellQuote,
} from "./agentProvider";
