//! Headless agent invocation: a one-shot `claude -p` call used by the AI helpers
//! (commit message, PR body). Mirrors the santree CLI's `runAgent` — same flags,
//! same large-prompt temp-file fallback — so behaviour matches the CLI.

/// The model these background helpers run on. They're short, cheap, high-volume
/// text tasks (commit messages, PR bodies), so we pin them to the cheapest tier
/// rather than the (pricier) model the interactive agent uses. An alias, so the
/// CLI resolves it to the latest Haiku without us pinning a dated id here.
pub const HELPER_MODEL: &str = "haiku";

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use crate::settings;

/// Conservative arg-size limit (bytes): macOS `ARG_MAX` is 256 KB, leave room for env.
const ARG_MAX_SAFE: usize = 200 * 1024;

/// Hard ceiling on a single headless agent call. Claude normally answers in
/// 5–30s; this only fires when it hangs, so the UI spinner can't wait forever and
/// a blocking-pool thread can't leak.
const AGENT_TIMEOUT: Duration = Duration::from_secs(120);

/// Distinguishes concurrent large-prompt temp files (pid alone collides when two
/// `run_print` calls overlap).
static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Turn a prompt into the argument to pass after `--`, plus an optional temp-file
/// path the caller must delete once the agent has run. If the prompt fits within
/// the OS arg limit it's passed directly; otherwise it's written to a unique temp
/// file and a short "read this file" instruction is passed instead.
fn prompt_arg(prompt: &str) -> (String, Option<PathBuf>) {
    if prompt.len() <= ARG_MAX_SAFE {
        return (prompt.to_string(), None);
    }
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!("santree-prompt-{}-{seq}.md", std::process::id()));
    // The prompt can carry the repo diff (and thus possibly secrets), so the temp
    // file is owner-only (0600) — never world-readable on a shared host.
    if write_private(&path, prompt).is_ok() {
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

/// Write `contents` to `path` with owner-only (0600) permissions.
#[cfg(unix)]
fn write_private(path: &Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(contents.as_bytes())
}

#[cfg(not(unix))]
fn write_private(path: &Path, contents: &str) -> std::io::Result<()> {
    std::fs::write(path, contents)
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

/// Run the configured `claude` binary in non-interactive print mode and capture
/// its text output, run with `cwd` as the working directory. `allowed_tools`
/// maps to `--allowedTools` (empty = none); `model` maps to `--model` (`None` =
/// the CLI default). Returns `None` when the binary isn't found, the call fails,
/// or the output is empty.
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
    cmd.current_dir(cwd).args(["--permission-mode", "auto"]);
    if let Some(model) = model {
        cmd.args(["--model", model]);
    }
    if !allowed_tools.is_empty() {
        cmd.arg("--allowedTools").args(allowed_tools);
    }
    cmd.args(["-p", "--output-format", "text", "--", &arg]);

    let out = run_with_timeout(cmd, AGENT_TIMEOUT);
    // Clean up the large-prompt temp file regardless of how the call went.
    if let Some(path) = temp {
        let _ = std::fs::remove_file(path);
    }
    let (status, stdout) = out?;
    status
        .success()
        .then(|| String::from_utf8_lossy(&stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Run `cmd`, capturing stdout, but kill it if it hasn't exited within `timeout`.
/// Returns `None` if it can't be spawned or is killed for exceeding the deadline.
/// A dedicated thread drains stdout so a full pipe buffer can't deadlock the wait
/// (and can't be mistaken for a hang).
fn run_with_timeout(
    mut cmd: Command,
    timeout: Duration,
) -> Option<(std::process::ExitStatus, Vec<u8>)> {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
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
            Err(_) => break None,
        }
    };
    // The reader returns once the pipe closes (on exit or kill), so this never hangs.
    let stdout = reader.join().unwrap_or_default();
    Some((status?, stdout))
}
