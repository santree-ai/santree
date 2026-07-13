//! Headless agent invocation: a one-shot `claude -p` call used by the AI helpers
//! (commit message, PR body). Mirrors the santree CLI's `runAgent` — same
//! large-prompt temp-file fallback — so behaviour matches the CLI. Runs in
//! `--safe-mode --strict-mcp-config` so no hooks/plugins/MCP servers spin up on
//! startup: these are latency-sensitive text tasks that need only the model.

/// The model these background helpers run on. They're short, cheap, high-volume
/// text tasks (commit messages, PR bodies), so we pin them to the cheapest tier
/// rather than the (pricier) model the interactive agent uses. An alias, so the
/// CLI resolves it to the latest Haiku without us pinning a dated id here.
pub const HELPER_MODEL: &str = "haiku";

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use uuid::Uuid;

use crate::settings;

/// Conservative arg-size limit (bytes): macOS `ARG_MAX` is 256 KB, leave room for env.
const ARG_MAX_SAFE: usize = 200 * 1024;

/// Hard ceiling on a single headless agent call. Claude normally answers in
/// 5–30s; this only fires when it hangs, so the UI spinner can't wait forever and
/// a blocking-pool thread can't leak.
const AGENT_TIMEOUT: Duration = Duration::from_secs(120);

/// Turn a prompt into the argument to pass after `--`, plus an optional temp-file
/// path the caller must delete once the agent has run. If the prompt fits within
/// the OS arg limit it's passed directly; otherwise it's written to a unique temp
/// file and a short "read this file" instruction is passed instead.
fn prompt_arg(prompt: &str) -> (String, Option<PathBuf>) {
    if prompt.len() <= ARG_MAX_SAFE {
        return (prompt.to_string(), None);
    }
    // The prompt can carry the repo diff (and thus possibly secrets), so it goes in
    // santree's own 0700 dir under a random name, created exclusively (`create_new`)
    // at 0600 — a shared `/tmp` with a predictable name lets another local user
    // pre-plant the file and read what we then write into it. `private_dir` failing
    // is a non-issue: create_new + a v4 name is still unguessable and unclobberable.
    let dir = crate::private_dir().unwrap_or_else(std::env::temp_dir);
    let path = dir.join(format!("santree-prompt-{}.md", Uuid::new_v4()));
    if write_new_private(&path, prompt).is_ok() {
        (
            format!(
                "Read {} and follow the instructions inside.",
                path.display()
            ),
            Some(path),
        )
    } else {
        // Fall back to truncation rather than failing outright. ARG_MAX_SAFE is a
        // byte budget, so truncate on a char boundary (not `.chars().take()`,
        // which counts characters and could exceed the byte limit).
        (truncate_bytes(prompt, ARG_MAX_SAFE), None)
    }
}

/// Create `path` — failing if it already exists — with owner-only (0600) permissions
/// and write `contents` to it.
fn write_new_private(path: &Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(contents.as_bytes())
}

/// Truncate `s` to at most `max` bytes, backing up to the nearest char boundary so
/// the result stays valid UTF-8.
fn truncate_bytes(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// Build the argument list for a headless `claude -p` invocation. Pure and
/// separated out from `run_print` so the permission/tool flags are testable
/// without spawning a process.
fn build_args(allowed_tools: &[&str], model: Option<&str>, arg: &str) -> Vec<String> {
    let mut args = vec!["--permission-mode".to_string(), "default".to_string()];
    // `default` (not `auto`) — in `-p`/print mode `default` denies any tool use
    // that isn't explicitly allowlisted below, instead of auto-approving it. These
    // prompts embed diff/PR content that may be attacker-influenceable (a malicious
    // diff hunk, PR text), so nothing here should be able to trigger tool use the
    // caller didn't explicitly ask for. `--disallowedTools` is belt-and-braces on
    // top of that: even if a future call site's `--allowedTools` is loosened, these
    // three stay denied for headless helpers.
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
    args.extend(["--output-format", "text", "--", arg].map(str::to_string));
    args
}

/// Run the configured `claude` binary in non-interactive print mode and capture
/// its text output, run with `cwd` as the working directory. `allowed_tools`
/// maps to `--allowedTools` (empty = none); `model` maps to `--model` (`None` =
/// the CLI default). Returns `None` when the binary isn't found, the call fails,
/// or the output is empty — every such failure is also `log::warn!`'d (with
/// stderr, when captured) so a signed-out CLI or a rejected flag/model shows up
/// in the app's log file instead of silently falling back to defaults.
///
/// Blocking — call from `spawn_blocking` (Claude can take 5–30s).
pub fn run_print(
    cwd: &Path,
    prompt: &str,
    allowed_tools: &[&str],
    model: Option<&str>,
) -> Option<String> {
    let bin = settings::discover_binary("claude")?;

    let (arg, temp) = prompt_arg(prompt);

    let mut cmd = Command::new(bin);
    cmd.current_dir(cwd)
        .args(build_args(allowed_tools, model, &arg));

    let out = run_with_timeout(cmd, AGENT_TIMEOUT);
    // Clean up the large-prompt temp file regardless of how the call went.
    if let Some(path) = temp {
        let _ = std::fs::remove_file(path);
    }
    let (status, stdout, stderr) = out?;
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

/// Run `cmd`, capturing stdout and stderr, but kill it if it hasn't exited within
/// `timeout`. Returns `None` (after logging why) if it can't be spawned or is
/// killed for exceeding the deadline. Dedicated threads drain stdout/stderr so a
/// full pipe buffer can't deadlock the wait (and can't be mistaken for a hang).
fn run_with_timeout(
    mut cmd: Command,
    timeout: Duration,
) -> Option<(std::process::ExitStatus, Vec<u8>, Vec<u8>)> {
    let mut child = match cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(child) => child,
        Err(e) => {
            log::warn!("claude -p failed to spawn: {e}");
            return None;
        }
    };
    let mut stdout = child.stdout.take()?;
    let mut stderr = child.stderr.take()?;
    let stdout_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        buf
    });

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
    // The readers return once their pipe closes (on exit or kill), so this never hangs.
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
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
        let args = build_args(&[], Some(HELPER_MODEL), "prompt");
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
        let args = build_args(&["Read"], Some(HELPER_MODEL), "prompt");
        assert!(args.windows(2).any(|w| w == ["--disallowedTools", "Bash"]));
        assert!(args.windows(2).any(|w| w == ["--allowedTools", "Read"]));
    }

    #[test]
    fn build_args_omits_model_flag_when_none() {
        let args = build_args(&[], None, "prompt");
        assert!(!args.contains(&"--model".to_string()));
    }

    /// An oversized prompt spills to a file that is owner-only and that we only ever
    /// *create* — never write through to one that already exists.
    #[cfg(unix)]
    #[test]
    fn large_prompt_spills_to_an_exclusively_created_private_file() {
        use std::os::unix::fs::PermissionsExt;

        let prompt = "x".repeat(ARG_MAX_SAFE + 1);
        let (arg, temp) = prompt_arg(&prompt);
        let path = temp.expect("an oversized prompt must spill to a file");
        assert!(arg.contains(&path.display().to_string()));
        assert!(
            path.starts_with(crate::private_dir().unwrap()),
            "prompts must not land in a shared tmp dir"
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(
            write_new_private(&path, "planted").is_err(),
            "an existing file must never be written through"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), prompt);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn build_args_ends_with_prompt_after_double_dash() {
        let args = build_args(&[], None, "the prompt text");
        assert_eq!(
            &args[args.len() - 4..],
            &[
                "--output-format".to_string(),
                "text".to_string(),
                "--".to_string(),
                "the prompt text".to_string()
            ]
        );
    }
}
