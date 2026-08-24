//! Headless agent invocation for latency-sensitive AI helpers such as commit
//! messages and PR bodies. Prompts go over stdin, never argv, and each provider
//! runs with a fail-closed configuration that excludes ambient extensions.

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use santree_core::domain::AgentKind;

use crate::codex::CodexRuntime;
use crate::settings;

pub struct HelperConfig {
    pub agent: AgentKind,
    pub executable: String,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub enum HelperKind {
    CommitMessage,
    PrBody,
}

impl HelperKind {
    fn setting_keys(self) -> (&'static str, &'static str) {
        match self {
            Self::CommitMessage => ("commit_message_agent", "commit_message_model"),
            Self::PrBody => ("pr_body_agent", "pr_body_model"),
        }
    }
}

/// Resolve one hidden helper independently from the interactive Work session.
/// Unset helper-agent keys inherit Work for compatibility; once selected, each
/// helper keeps its own provider and per-provider model profile.
pub async fn helper_config(
    db: &crate::db::Db,
    repo: &str,
    kind: HelperKind,
) -> Result<HelperConfig> {
    let settings_value = settings::get_settings(db).await?;
    let (agent_key, model_key) = kind.setting_keys();
    let selected = settings::resolve(db, repo, agent_key).await?;
    let agent = selected
        .as_deref()
        .and_then(|value| value.parse().ok())
        .or(settings::resolve(db, repo, "work_agent")
            .await?
            .and_then(|value| value.parse().ok()))
        .unwrap_or(settings_value.default_agent);
    let profile_key = settings::provider_setting_key(model_key, agent);
    let profile = settings::resolve(db, repo, &profile_key)
        .await?
        .filter(|value| !value.trim().is_empty())
        .or(settings::resolve(db, repo, model_key)
            .await?
            .filter(|value| settings::legacy_value_matches_provider(model_key, value, agent)));
    let model = profile
        .or_else(|| (agent == AgentKind::Claude).then(|| "haiku".to_string()))
        .or_else(|| {
            settings_value.agents.iter().find_map(|configured| {
                (configured.key == agent && !configured.model.trim().is_empty())
                    .then(|| configured.model.clone())
            })
        });
    Ok(HelperConfig {
        agent,
        executable: settings::agent_executable(db, agent).await?,
        model,
    })
}

/// Ceiling for a **short** headless call — a prompt in, a line or two out (a
/// commit message). Claude normally answers in 5–30s, so this only ever fires
/// when something hangs: the UI spinner can't wait forever and a blocking-pool
/// thread can't leak.
///
/// Not a default: [`run_print`] takes the deadline as an argument precisely so a
/// call site that reads a whole diff can't silently inherit a ceiling sized for a
/// one-liner. It has happened twice — the tutor analysis and the review brief were
/// both killed mid-work at 120s, which surfaces as "Claude returned nothing"
/// rather than as a deadline. Size the constant to the work, name it at the call
/// site.
pub const SHORT_TIMEOUT: Duration = Duration::from_secs(120);

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
/// `model` maps to `--model` (`None` = the CLI default); `timeout` kills the call
/// if it hasn't answered by then — see [`SHORT_TIMEOUT`] for why every caller
/// names its own.
///
/// The error says *which* failure it was — a missing binary, a non-zero exit, an
/// empty answer, or the deadline — because these run behind a spinner the user is
/// watching, and "nothing came back" is the one message that can't be acted on.
/// Every failure is `log::warn!`'d too (with stderr, when captured), so a
/// signed-out CLI or a rejected flag still lands in the app log even where the
/// caller swallows the error to fall back.
///
/// The prompt is piped to the child's **stdin**, not passed as an argument: these
/// prompts carry the repo diff and ticket text, and argv is world-readable on Linux
/// (`/proc/<pid>/cmdline`). stdin also means no size limit — no `ARG_MAX` cap, no
/// temp-file spill.
///
/// Blocking — call from `spawn_blocking` (Claude can take 5–30s, and much longer
/// for the calls that read a diff).
pub fn run_print(
    cwd: &Path,
    prompt: &str,
    allowed_tools: &[&str],
    model: Option<&str>,
    timeout: Duration,
) -> Result<String> {
    let bin = settings::discover_binary("claude").ok_or_else(|| {
        warn("the `claude` CLI wasn't found — set its path in Settings → Integrations".into())
    })?;

    let mut cmd = Command::new(bin);
    cmd.current_dir(cwd).args(build_args(allowed_tools, model));

    let (status, stdout, stderr) = run_with_timeout(cmd, prompt, timeout)?;
    let stderr = String::from_utf8_lossy(&stderr).trim().to_string();
    if !status.success() {
        return Err(warn(format!("claude exited {status}: {stderr}")));
    }
    let text = String::from_utf8_lossy(&stdout).trim().to_string();
    if text.is_empty() {
        return Err(warn(format!(
            "claude exited cleanly but produced no output; stderr: {stderr}"
        )));
    }
    Ok(text)
}

/// Run a fail-closed, ephemeral writing helper with the configured provider.
/// Interactive-session provenance is deliberately irrelevant: this is a new
/// one-shot action and follows the current default provider/model.
pub fn run_helper(
    codex_runtime: &CodexRuntime,
    helper: &HelperConfig,
    cwd: &Path,
    prompt: &str,
    allowed_tools: &[&str],
    timeout: Duration,
) -> Result<String> {
    if helper.agent == AgentKind::Claude {
        let mut cmd = Command::new(&helper.executable);
        cmd.current_dir(cwd)
            .args(build_args(allowed_tools, helper.model.as_deref()));
        return finish_helper(cmd, prompt, timeout, "claude -p");
    }
    if helper.agent != AgentKind::Codex {
        return Err(anyhow!(
            "{} helpers are not supported",
            helper.agent.as_str()
        ));
    }

    // `sandbox_permissions` is intentionally outside the pinned strict schema.
    // The App Server's config/read handshake is our proof that this installed
    // CLI applied the empty permission layer instead of silently ignoring it.
    codex_runtime.ensure_restricted_config(&helper.executable)?;
    let args = build_codex_helper_args(cwd, helper.model.as_deref());
    let mut cmd = Command::new(&helper.executable);
    cmd.current_dir(cwd).args(args);
    finish_helper(cmd, prompt, timeout, "codex exec")
}

fn build_codex_helper_args(cwd: &Path, model: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "exec".to_string(),
        "--ephemeral".to_string(),
        "--ignore-user-config".to_string(),
        "--ignore-rules".to_string(),
        "--strict-config".to_string(),
        "--sandbox".to_string(),
        "read-only".to_string(),
        "-c".to_string(),
        "sandbox_permissions=[]".to_string(),
        "-c".to_string(),
        "mcp_servers={}".to_string(),
        "-c".to_string(),
        "apps={}".to_string(),
        "-c".to_string(),
        "plugins={}".to_string(),
        "-c".to_string(),
        "hooks={}".to_string(),
        "-c".to_string(),
        "web_search=\"disabled\"".to_string(),
        "-c".to_string(),
        "sandbox_workspace_write.network_access=false".to_string(),
        "--cd".to_string(),
        cwd.to_string_lossy().into_owned(),
    ];
    if let Some(model) = model.filter(|model| !model.trim().is_empty()) {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    args.push("-".to_string());
    args
}

fn finish_helper(cmd: Command, prompt: &str, timeout: Duration, label: &str) -> Result<String> {
    let (status, stdout, stderr) = run_with_timeout(cmd, prompt, timeout)?;
    let stderr = String::from_utf8_lossy(&stderr).trim().to_string();
    if !status.success() {
        return Err(anyhow!("{label} exited {status}: {stderr}"));
    }
    let text = String::from_utf8_lossy(&stdout).trim().to_string();
    if text.is_empty() {
        return Err(anyhow!(
            "{label} exited cleanly but produced no output: {stderr}"
        ));
    }
    Ok(text)
}

/// Log a headless failure and hand back the same message as an error, so the app
/// log records it even when the caller swallows the error to fall back.
fn warn(message: String) -> anyhow::Error {
    log::warn!("claude -p: {message}");
    anyhow!(message)
}

/// One of the spawned child's pipes. `Stdio::piped()` was just requested for all
/// three, so `None` here is unreachable — but it's `Option`-typed, and this is the
/// one place that has to say so without a `?` that swallows which pipe it was.
fn pipe<T>(handle: Option<T>) -> Result<T> {
    handle.ok_or_else(|| anyhow!("a child pipe was missing"))
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
/// if it hasn't exited within `timeout`. Errors (after logging why) if it can't be
/// spawned or is killed for exceeding the deadline. Dedicated threads feed stdin
/// and drain stdout/stderr, so neither a prompt larger than the pipe buffer nor a
/// full output pipe can deadlock the wait.
fn run_with_timeout(
    mut cmd: Command,
    prompt: &str,
    timeout: Duration,
) -> Result<(ExitStatus, Vec<u8>, Vec<u8>)> {
    let mut child = match cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => return Err(warn(format!("failed to spawn: {e}"))),
    };
    // Feed the prompt from its own thread and let the handle drop, which closes
    // stdin and tells the CLI the prompt is complete. A prompt bigger than the pipe
    // buffer (64 KB — and these routinely are) would otherwise block us here until
    // the child drained it, and a child that died early would leave us on a broken
    // pipe rather than at the deadline below.
    let mut stdin = pipe(child.stdin.take())?;
    let prompt = prompt.to_string();
    std::thread::spawn(move || {
        let _ = stdin.write_all(prompt.as_bytes());
    });
    let stdout = Drain::spawn(pipe(child.stdout.take())?);
    let stderr = Drain::spawn(pipe(child.stderr.take())?);

    let deadline = Instant::now() + timeout;
    let outcome = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(format!("timed out after {}s", timeout.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => break Err(format!("error waiting on child process: {e}")),
        }
    };
    let grace = Instant::now() + READER_GRACE;
    let stdout = stdout.take(grace);
    let stderr = stderr.take(grace);
    match outcome {
        Ok(status) => Ok((status, stdout, stderr)),
        Err(why) => Err(warn(format!(
            "{why}; stderr so far: {}",
            String::from_utf8_lossy(&stderr).trim()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn helper_kinds_select_providers_and_models_independently() {
        let base =
            std::env::temp_dir().join(format!("santree-helper-config-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&base).unwrap();
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        let mut app = santree_core::config::default_settings();
        for configured in &mut app.agents {
            if matches!(configured.key, AgentKind::Claude | AgentKind::Codex) {
                configured.exec = "/bin/echo".into();
            }
        }
        settings::set_settings(&db, &app).await.unwrap();
        settings::set(&db, "app", "work_agent", Some("Claude".into()))
            .await
            .unwrap();
        settings::set(&db, "app", "commit_message_agent", Some("Codex".into()))
            .await
            .unwrap();
        settings::set(
            &db,
            "app",
            &settings::provider_setting_key("commit_message_model", AgentKind::Codex),
            Some("gpt-5.6-sol".into()),
        )
        .await
        .unwrap();
        settings::set(
            &db,
            "app",
            &settings::provider_setting_key("pr_body_model", AgentKind::Claude),
            Some("claude-opus-5".into()),
        )
        .await
        .unwrap();

        let commit = helper_config(&db, "repo", HelperKind::CommitMessage)
            .await
            .unwrap();
        assert_eq!(commit.agent, AgentKind::Codex);
        assert_eq!(commit.model.as_deref(), Some("gpt-5.6-sol"));

        let pr = helper_config(&db, "repo", HelperKind::PrBody)
            .await
            .unwrap();
        assert_eq!(pr.agent, AgentKind::Claude);
        assert_eq!(pr.model.as_deref(), Some("claude-opus-5"));
        std::fs::remove_dir_all(base).unwrap();
    }

    /// Every headless call must run in `default` permission mode (never `auto`)
    /// and must always deny Bash/Write/Edit, regardless of the caller's
    /// `--allowedTools` — the fix for the prompt-injection finding.
    #[test]
    fn build_args_always_denies_tool_use_by_default() {
        // Commit-message call site: no allowlisted tools at all.
        let args = build_args(&[], Some("haiku"));
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
        let args = build_args(&[&scoped], Some("haiku"));
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

    #[test]
    fn codex_helpers_disable_ambient_extensions_and_writes() {
        let args = build_codex_helper_args(Path::new("/tmp/wt"), Some("gpt-5.6-sol"));
        for required in [
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--strict-config",
            "read-only",
            "mcp_servers={}",
            "apps={}",
            "plugins={}",
            "hooks={}",
            "web_search=\"disabled\"",
            "sandbox_workspace_write.network_access=false",
        ] {
            assert!(args.iter().any(|arg| arg == required), "missing {required}");
        }
        assert!(args.windows(2).any(|pair| pair == ["--cd", "/tmp/wt"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--model", "gpt-5.6-sol"]));
        assert_eq!(args.last().map(String::as_str), Some("-"));
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
        let err = run_with_timeout(cmd, "", Duration::from_millis(200))
            .expect_err("a child past its deadline must be an error, not an empty answer");
        // The message is the point: "timed out" is what tells the user (and the log)
        // that the work was killed mid-flight rather than that Claude had nothing
        // to say — the two are indistinguishable from an empty result.
        assert!(
            err.to_string().contains("timed out"),
            "the deadline must be named in the error, got: {err}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "killed, not waited out"
        );
    }
}
