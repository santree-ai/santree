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
  // interprets raw control bytes (e.g. \x15 kill-line, \r accept-line) as they
  // arrive. Strip C0 + DEL, and the C1 range U+0080–U+009F too: a terminal in
  // 8-bit-control mode reads U+009B/U+0090/U+009D as CSI/DCS/OSC introducers, so
  // they are escape sequences in disguise. Untrusted content (ticket titles/bodies)
  // must not be able to break out of the quoted string mid-paste; a literal newline
  // is folded to a space for the same reason (one PTY write stays one typed line).
  const sanitized = Array.from(s.replace(/\n/g, " "))
    .filter((c) => {
      const code = c.codePointAt(0) ?? 0;
      return !(code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f));
    })
    .join("");
  return `'${sanitized.replace(/'/g, `'\\''`)}'`;
}

export function agentSessionSeed(
  session: AgentSession | undefined,
  exec: string,
  opts: {
    prompt?: string;
    modelFlag?: string;
    effortFlag?: string;
    remoteControl?: string;
    /** Pre-quoted `--settings '<path>'` (a settings *file*, not inline JSON —
     *  the hook config is too large to inline without breaking the shell line)
     *  to wire up santree's session-state hooks. Applied on both fresh and
     *  resume launches so state is captured either way. */
    settingsFlag?: string;
    /** Launch with Claude's `--chrome` flag (browser control). A launch-time
     *  capability, so — like `--settings` — it's applied on both fresh and
     *  resume launches. */
    chrome?: boolean;
    /** Start in a specific permission mode via Claude's `--permission-mode`
     *  (`plan` / `acceptEdits` / `auto` / …). A startup mode, so it's applied on
     *  both fresh and resume launches; empty/undefined leaves the flag off. */
    permissionMode?: string;
    /** This terminal's identity (`repo` + registry `termKey`), exported into the
     *  Claude process env so the `santree-hook` `SessionStart` hook can reconcile
     *  the stored session id back to whatever session Claude is *actually* running
     *  — the fix for `/clear`, which mints a new session id we'd otherwise never
     *  learn about and keep `--resume`ing the cleared conversation forever. Both
     *  must be set to inject; a launch without them just omits the env. */
    repo?: string;
    termKey?: string;
  },
): string | undefined {
  if (!session || session.type === "shell") return undefined;
  const bin = shellQuote(exec);
  // Prefix `env NAME=value …` (not a `NAME=value cmd` assignment) so it works the
  // same across the user's login shell — bash/zsh honour bare assignment prefixes
  // but fish does not, whereas `exec env …` is universal. Inherited by the hook
  // subprocesses Claude spawns (verified: Claude scrubs only `OTEL_*`).
  const env =
    opts.repo && opts.termKey
      ? `env SANTREE_REPO=${shellQuote(opts.repo)} SANTREE_TERM_KEY=${shellQuote(opts.termKey)} `
      : "";
  // Enable + name Remote Control (Claude's `--remote-control [name]`) with the
  // ticket id, so the session is identifiable on the Remote Control web.
  const rc = opts.remoteControl ? `--remote-control ${shellQuote(opts.remoteControl)} ` : "";
  const settings = opts.settingsFlag ? `${opts.settingsFlag} ` : "";
  const chrome = opts.chrome ? "--chrome " : "";
  const perm = opts.permissionMode ? `--permission-mode ${shellQuote(opts.permissionMode)} ` : "";
  if (session.type === "resume") {
    return `exec ${env}${bin} ${rc}${settings}${chrome}${perm}--resume ${shellQuote(session.sessionId)}`;
  }
  const model = opts.modelFlag ? `${opts.modelFlag} ` : "";
  const effort = opts.effortFlag ? `${opts.effortFlag} ` : "";
  // No prompt (a manual Claude tab) ⇒ launch interactive and let the user type.
  const prompt = opts.prompt !== undefined ? ` ${shellQuote(opts.prompt)}` : "";
  return `exec ${env}${bin} ${rc}${settings}${chrome}${perm}${model}${effort}--session-id ${shellQuote(session.sessionId)}${prompt}`;
}
