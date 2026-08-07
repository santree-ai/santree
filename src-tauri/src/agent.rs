//! Headless agent invocation: a one-shot `claude -p` call used by the AI helpers
//! (commit message, PR body). The prompt goes in on **stdin** — never argv, which
//! is world-readable on Linux — and tool grants are path-scoped (see
//! [`read_within`]). Runs in `--safe-mode --strict-mcp-config` so no
//! hooks/plugins/MCP servers spin up on startup: these are latency-sensitive text
//! tasks that need only the model.

/// The model these background helpers run on. They're short, cheap, high-volume
/// text tasks (commit messages, PR bodies), so we pin them to the cheapest tier
/// rather than the (pricier) model the interactive agent uses. An alias, so the
/// CLI resolves it to the latest Haiku without us pinning a dated id here.
pub const HELPER_MODEL: &str = "haiku";

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::settings;

/// Default ceiling on a single headless agent call. Claude normally answers in
/// 5–30s; this only fires when it hangs, so the UI spinner can't wait forever and
/// a blocking-pool thread can't leak. Callers whose work legitimately runs longer
/// pass their own via [`run_print_within`].
pub const AGENT_TIMEOUT: Duration = Duration::from_secs(120);

/// How long to wait for a pipe to reach EOF once the child is gone, before taking
/// whatever was read so far and moving on. A grandchild that inherited the pipe
/// keeps its write end open after the child dies, so EOF may simply never come —
/// see [`Drain::take`].
const READER_GRACE: Duration = Duration::from_secs(2);

/// The `--allowedTools` rule granting `Read` **only** underneath `dir`.
///
/// Claude's path rules are gitignore-style and spell an absolute path `//<path>`,
/// hence the extra leading `/` on an already-absolute `dir`. Verified against the
/// CLI: a read inside the scope succeeds, one outside is denied. Callers must pass
/// an absolute path — a malformed rule matches nothing and every read is denied,
/// which is the direction to fail in: each helper's real context is in its prompt,
/// so a denied `Read` costs quality, not correctness.
pub fn read_within(dir: &Path) -> String {
    format!("Read(/{}/**)", dir.display())
}

/// Build the argument list for a headless `claude -p` invocation. Pure and
/// separated out from `run_print` so the permission/tool flags are testable
/// without spawning a process. Note there is no prompt argument: the prompt is
/// written to the child's stdin (see [`run_print`]).
fn build_args(allowed_tools: &[&str], model: Option<&str>) -> Vec<String> {
    let mut args = vec!["--permission-mode".to_string(), "default".to_string()];
    // `default` (not `auto`) — in `-p`/print mode `default` denies any tool use
    // that isn't explicitly allowlisted below, instead of auto-approving it. These
    // prompts embed diff/PR/ticket content that may be attacker-influenceable (a
    // malicious diff hunk, a Linear comment any org member can write), so nothing
    // here should be able to trigger tool use the caller didn't explicitly ask for.
    // `--disallowedTools` is belt-and-braces on top of that: even if a future call
    // site's `--allowedTools` is loosened, these three stay denied for headless
    // helpers.
    args.push("--disallowedTools".to_string());
    args.extend(["Bash", "Write", "Edit"].map(str::to_string));
    // Speed: these helpers (commit message, PR body) are latency-sensitive and
    // need nothing but the model. `--safe-mode` disables user customizations —
    // hooks, plugins, auto-memory, background prefetches — that otherwise run on
    // every `claude -p` startup (auth/model/built-in tools still work normally, so
    // OAuth is unaffected). `--strict-mcp-config` with no `--mcp-config` spawns no
    // MCP servers at all. Together they roughly halve wall-clock (~7s → ~3s) and
    // also tighten the security posture — attacker-influenceable diff/PR text in
    // the prompt can't reach a hook or MCP tool. (Not `--bare`: that forces
    // ANTHROPIC_API_KEY and never reads OAuth, which would break signed-in users.)
    args.push("--safe-mode".to_string());
    args.push("--strict-mcp-config".to_string());
    if let Some(model) = model {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    if !allowed_tools.is_empty() {
        args.push("--allowedTools".to_string());
        args.extend(allowed_tools.iter().map(|s| s.to_string()));
    }
    args.push("-p".to_string());
    args.extend(["--output-format", "text"].map(str::to_string));
    args
}

/// Run the configured `claude` binary in non-interactive print mode and capture
/// its text output, run with `cwd` as the working directory. `allowed_tools`
/// maps to `--allowedTools` (empty = none; scope any `Read` with [`read_within`]);
/// `model` maps to `--model` (`None` = the CLI default). Returns `None` when the
/// binary isn't found, the call fails, or the output is empty — every such failure
/// is also `log::warn!`'d (with stderr, when captured) so a signed-out CLI or a
/// rejected flag/model shows up in the app's log file instead of silently falling
/// back to defaults.
///
/// The prompt is piped to the child's **stdin**, not passed as an argument: these
/// prompts carry the repo diff and ticket text, and argv is world-readable on Linux
/// (`/proc/<pid>/cmdline`). stdin also means no size limit — no `ARG_MAX` cap, no
/// temp-file spill.
///
/// Blocking — call from `spawn_blocking` (Claude can take 5–30s).
pub fn run_print(
    cwd: &Path,
    prompt: &str,
    allowed_tools: &[&str],
    model: Option<&str>,
) -> Option<String> {
    run_print_within(cwd, prompt, allowed_tools, model, AGENT_TIMEOUT)
}

/// [`run_print`] with an explicit deadline, for the calls [`AGENT_TIMEOUT`] isn't
/// sized for.
///
/// That ceiling assumes this module's original shape of work: a small prompt and a
/// one-line answer, where two minutes only ever elapses because something hung. A
/// call that reads tens of thousands of tokens and writes a structured answer
/// spends minutes legitimately, and killing it at 120s isn't a safety net — it's a
/// guaranteed failure the user pays for and waits out.
pub fn run_print_within(
    cwd: &Path,
    prompt: &str,
    allowed_tools: &[&str],
    model: Option<&str>,
    timeout: Duration,
) -> Option<String> {
    let bin = settings::discover_binary("claude")?;

    let mut cmd = Command::new(bin);
    cmd.current_dir(cwd).args(build_args(allowed_tools, model));

    let (status, stdout, stderr) = run_with_timeout(cmd, prompt, timeout)?;
    if !status.success() {
        log::warn!(
            "claude -p failed ({status}): {}",
            String::from_utf8_lossy(&stderr).trim()
        );
        return None;
    }
    let text = String::from_utf8_lossy(&stdout).trim().to_string();
    if text.is_empty() {
        log::warn!(
            "claude -p exited successfully but produced no output; stderr: {}",
            String::from_utf8_lossy(&stderr).trim()
        );
        return None;
    }
    Some(text)
}

/// One child pipe, drained on its own thread into a shared buffer.
struct Drain {
    buf: Arc<Mutex<Vec<u8>>>,
    eof: Receiver<()>,
}

impl Drain {
    fn spawn(mut pipe: impl Read + Send + 'static) -> Self {
        let buf = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&buf);
        let (tx, eof) = mpsc::channel();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8 * 1024];
            while let Ok(n) = pipe.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                lock(&sink).extend_from_slice(&chunk[..n]);
            }
            let _ = tx.send(());
        });
        Self { buf, eof }
    }

    /// Everything the pipe carried, after waiting until `deadline` for EOF. Both
    /// pipes share one deadline, so a wedged child costs the grace once, not twice.
    ///
    /// Deliberately does **not** join the reader thread: `kill()` reaches only the
    /// direct child, so a grandchild that inherited the pipe holds its write end
    /// open and EOF never arrives. Joining there would park this thread — a tokio
    /// blocking-pool thread — forever. Instead we read into a shared buffer as the
    /// bytes arrive and snapshot it, so a wedged reader costs us the grace period
    /// and nothing else; the abandoned thread exits whenever the pipe finally closes.
    fn take(self, deadline: Instant) -> Vec<u8> {
        let _ = self
            .eof
            .recv_timeout(deadline.saturating_duration_since(Instant::now()));
        std::mem::take(&mut *lock(&self.buf))
    }
}

/// Lock through poisoning: a panicked reader thread must not take the call down.
fn lock(buf: &Mutex<Vec<u8>>) -> std::sync::MutexGuard<'_, Vec<u8>> {
    buf.lock().unwrap_or_else(|e| e.into_inner())
}

/// Run `cmd` with `prompt` on its stdin, capturing stdout and stderr, and kill it
/// if it hasn't exited within `timeout`. Returns `None` (after logging why) if it
/// can't be spawned or is killed for exceeding the deadline. Dedicated threads feed
/// stdin and drain stdout/stderr, so neither a prompt larger than the pipe buffer
/// nor a full output pipe can deadlock the wait.
fn run_with_timeout(
    mut cmd: Command,
    prompt: &str,
    timeout: Duration,
) -> Option<(ExitStatus, Vec<u8>, Vec<u8>)> {
    let mut child = match cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            log::warn!("claude -p failed to spawn: {e}");
            return None;
        }
    };
    // Feed the prompt from its own thread and let the handle drop, which closes
    // stdin and tells the CLI the prompt is complete. A prompt bigger than the pipe
    // buffer (64 KB — and these routinely are) would otherwise block us here until
    // the child drained it, and a child that died early would leave us on a broken
    // pipe rather than at the deadline below.
    let mut stdin = child.stdin.take()?;
    let prompt = prompt.to_string();
    std::thread::spawn(move || {
        let _ = stdin.write_all(prompt.as_bytes());
    });
    let stdout = Drain::spawn(child.stdout.take()?);
    let stderr = Drain::spawn(child.stderr.take()?);

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => {
                log::warn!("claude -p: error waiting on child process: {e}");
                break None;
            }
        }
    };
    let grace = Instant::now() + READER_GRACE;
    let stdout = stdout.take(grace);
    let stderr = stderr.take(grace);
    match status {
        Some(status) => Some((status, stdout, stderr)),
        None => {
            log::warn!(
                "claude -p timed out after {timeout:?}; stderr so far: {}",
                String::from_utf8_lossy(&stderr).trim()
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every headless call must run in `default` permission mode (never `auto`)
    /// and must always deny Bash/Write/Edit, regardless of the caller's
    /// `--allowedTools` — the fix for the prompt-injection finding.
    #[test]
    fn build_args_always_denies_tool_use_by_default() {
        // Commit-message call site: no allowlisted tools at all.
        let args = build_args(&[], Some(HELPER_MODEL));
        assert_eq!(
            &args[..2],
            &["--permission-mode".to_string(), "default".to_string()]
        );
        assert!(!args.contains(&"auto".to_string()));
        let disallowed_idx = args
            .iter()
            .position(|a| a == "--disallowedTools")
            .expect("--disallowedTools must always be present");
        assert_eq!(
            &args[disallowed_idx + 1..disallowed_idx + 4],
            &["Bash".to_string(), "Write".to_string(), "Edit".to_string()]
        );
    }

    /// PR-description call site allowlists `Read` on top of the same
    /// permission-mode/disallowed-tools baseline.
    #[test]
    fn build_args_keeps_disallowed_tools_alongside_an_allowlist() {
        let scoped = read_within(Path::new("/tmp/wt"));
        let args = build_args(&[&scoped], Some(HELPER_MODEL));
        assert!(args.windows(2).any(|w| w == ["--disallowedTools", "Bash"]));
        assert!(args
            .windows(2)
            .any(|w| w == ["--allowedTools", "Read(//tmp/wt/**)"]));
    }

    #[test]
    fn build_args_omits_model_flag_when_none() {
        let args = build_args(&[], None);
        assert!(!args.contains(&"--model".to_string()));
    }

    /// The prompt embeds the repo diff and ticket text; argv is world-readable on
    /// Linux, so it must not appear there — it goes in on stdin instead.
    #[test]
    fn build_args_carry_no_prompt() {
        let args = build_args(&[], None);
        assert_eq!(
            &args[args.len() - 3..],
            &[
                "-p".to_string(),
                "--output-format".to_string(),
                "text".to_string()
            ]
        );
        assert!(!args.contains(&"--".to_string()));
    }

    /// A `Read` grant is confined to one directory tree, so ticket text that says
    /// "read ~/.ssh/id_rsa" can't. `//abs` is the CLI's absolute-path spelling.
    #[test]
    fn read_within_scopes_the_grant_to_one_tree() {
        assert_eq!(
            read_within(Path::new("/Users/x/work/wt")),
            "Read(//Users/x/work/wt/**)"
        );
    }

    /// stdin carries the prompt (and is closed afterwards — `cat` would otherwise
    /// read until the deadline instead of echoing and exiting).
    #[cfg(unix)]
    #[test]
    fn the_prompt_is_fed_on_stdin() {
        let (status, stdout, _) = run_with_timeout(
            Command::new("cat"),
            "secret prompt",
            Duration::from_secs(20),
        )
        .expect("cat runs");
        assert!(status.success());
        assert_eq!(String::from_utf8_lossy(&stdout), "secret prompt");
    }

    /// stdin replaced the `ARG_MAX` cap and its temp-file spill, so size is no
    /// longer a limit — and a prompt past the 64 KB pipe buffer must not deadlock
    /// the writer against a child that hasn't started reading yet.
    #[cfg(unix)]
    #[test]
    fn a_prompt_larger_than_the_pipe_buffer_is_not_truncated() {
        let prompt = "x".repeat(1024 * 1024);
        let (status, stdout, _) =
            run_with_timeout(Command::new("cat"), &prompt, Duration::from_secs(20))
                .expect("cat runs");
        assert!(status.success());
        assert_eq!(stdout.len(), prompt.len());
    }

    /// `kill()` signals only the direct child, so a grandchild holding the stdout
    /// pipe keeps it from ever reaching EOF. We must still come back — with what the
    /// child did write — instead of parking a blocking-pool thread on the reader.
    /// The grandchild outlives the child by 30s; we must return in the grace period
    /// with what the child did write, not in 30s (and — before the reader threads
    /// stopped being `join`ed — not never).
    #[cfg(unix)]
    #[test]
    fn a_grandchild_holding_the_pipe_cannot_wedge_the_call() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 30 & echo hi"]);
        let started = Instant::now();
        let (status, stdout, _) =
            run_with_timeout(cmd, "", Duration::from_secs(90)).expect("sh runs");
        assert!(status.success());
        assert_eq!(String::from_utf8_lossy(&stdout).trim(), "hi");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "must not wait on the grandchild's copy of the pipe"
        );
    }

    /// A hung child is killed at the deadline rather than held to the (much longer)
    /// life of the process it spawned.
    #[cfg(unix)]
    #[test]
    fn a_hung_child_is_killed_at_the_deadline() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 30"]);
        let started = Instant::now();
        assert!(run_with_timeout(cmd, "", Duration::from_millis(200)).is_none());
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "killed, not waited out"
        );
    }
}
