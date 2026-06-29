//! Headless agent invocation: a one-shot `claude -p` call used by the AI helpers
//! (commit message, PR body). Mirrors the santree CLI's `runAgent` — same flags,
//! same large-prompt temp-file fallback — so behaviour matches the CLI.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::settings;

/// Conservative arg-size limit (bytes): macOS `ARG_MAX` is 256 KB, leave room for env.
const ARG_MAX_SAFE: usize = 200 * 1024;

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
    if std::fs::write(&path, prompt).is_ok() {
        (
            format!("Read {} and follow the instructions inside.", path.display()),
            Some(path),
        )
    } else {
        // Fall back to truncation rather than failing outright. ARG_MAX_SAFE is a
        // byte budget, so truncate on a char boundary (not `.chars().take()`,
        // which counts characters and could exceed the byte limit).
        (truncate_bytes(prompt, ARG_MAX_SAFE), None)
    }
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
/// maps to `--allowedTools` (empty = none). Returns `None` when the binary isn't
/// found, the call fails, or the output is empty.
///
/// Blocking — call from `spawn_blocking` (Claude can take 5–30s).
pub fn run_print(cwd: &Path, prompt: &str, allowed_tools: &[&str]) -> Option<String> {
    let bin = settings::discover_binary("claude")?;

    let (arg, temp) = prompt_arg(prompt);

    let mut cmd = Command::new(bin);
    cmd.current_dir(cwd).args(["--permission-mode", "auto"]);
    if !allowed_tools.is_empty() {
        cmd.arg("--allowedTools").args(allowed_tools);
    }
    cmd.args(["-p", "--output-format", "text", "--", &arg]);

    let out = cmd.output();
    // Clean up the large-prompt temp file regardless of how the call went.
    if let Some(path) = temp {
        let _ = std::fs::remove_file(path);
    }
    let out = out.ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}
