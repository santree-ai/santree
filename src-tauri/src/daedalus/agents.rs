//! Claude and Codex in a Daedalus project, run on the box (docs/remote.md,
//! "Agents on the box"). The launch is the same one a local project gets —
//! the frontend's seed, typed into a remote pane (`terminals.rs`) — and
//! everything that seed names lives on the box too:
//!
//! - **santree's files there**: the hook settings and the rendered prompts go
//!   in `santree/` inside the checkout's common git dir ([`santree_dir`]) —
//!   under `projectsRoot`, never in a working tree's `git status`, beside the
//!   git that the split's index and the setup's status file already use.
//! - **the hooks** run `<hookBin> hook <args>` (`hello`'s `hookBin`), which
//!   queues the event on the box for `host.rs`'s relay to apply here.
//! - **the session record** (does a stored session's transcript or rollout
//!   still exist) is asked of the box's `~/.claude` and `~/.codex`.
//! - **the CLIs** are the box's, by their plain names on the login shell's
//!   `PATH`; which of them are there is asked once a minute ([`BoxAgents::clis`]).
//! - **which agent a pane runs** is read from the box's process table, the way
//!   `agent_procs` reads this Mac's ([`BoxAgents::detect`]).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, ensure, Result};
use serde_json::{Map, Value};

use santree_core::domain::{AgentKind, AgentProcess, AgentSession, DaedalusAgentHooks};
use santree_remote_client::proto::{m, ExecParams};
use santree_remote_client::RemoteClient;

use super::host::{describe, DaedalusHost};
use crate::codex_config;
use crate::git::{Checkout, FsKind};
use crate::hooks;
use crate::proc_table::{parse_ps, ProcTree};
use crate::provider::SessionRequest;
use crate::session::{self, CodexSessionOpts, RecordPresence};
use crate::settings::agent_binary;
use crate::terminal::LiveTerminal;

/// The providers santree launches on the box — the ones with a launch spec.
const LAUNCHABLE: [AgentKind; 2] = [AgentKind::Claude, AgentKind::Codex];

/// How long the answer to "which CLIs does the box have" is reused: long
/// enough that a menu opening doesn't ask every time, short enough that
/// installing one there shows up without restarting anything.
const CLIS_TTL: Duration = Duration::from_secs(60);

/// The box's process table is reused this long, like this Mac's
/// (`proc_table::TTL`).
const PROCS_TTL: Duration = Duration::from_millis(500);

/// How long one read of the box's process table may take, round trip
/// included, before detection answers "don't know".
const PROCS_TIMEOUT: Duration = Duration::from_secs(3);

/// The Claude settings files santree writes on the box, beside each other in
/// [`santree_dir`].
const CLAUDE_SETTINGS_FILE: &str = "claude-hooks.json";
const CLAUDE_SETTINGS_NO_GIT_FILE: &str = "claude-hooks-fixci.json";

/// Which of `$@` the box's login shell finds, one per line. A login shell
/// because that is what a pane runs its seed in, so it is the `PATH` the
/// launch will meet.
const PROBE: &str =
    r#"for c in "$@"; do command -v -- "$c" >/dev/null 2>&1 && printf '%s\n' "$c"; done; exit 0"#;

/// The agent state santree keeps per link: the CLIs the box has and its last
/// process table. Owned by [`DaedalusHost`].
#[derive(Default)]
pub struct BoxAgents {
    /// `(bootId, when, the CLIs found)`: a new session host is asked again.
    clis: tokio::sync::Mutex<Option<(String, Instant, Vec<AgentKind>)>>,
    /// The last process table and when it was read; `None` inside = that read
    /// failed (cached too, so a broken `ps` costs one timeout per TTL).
    procs: tokio::sync::Mutex<Option<(Instant, Option<Arc<ProcTree>>)>>,
}

impl BoxAgents {
    /// The agent CLIs the box's login shell finds, or `None` when that can't
    /// be asked right now (no link, or the probe failed) — which is not the
    /// same as "none".
    pub async fn clis(&self, daedalus: &DaedalusHost) -> Option<Vec<AgentKind>> {
        let client = daedalus.client().ok()?;
        let hello = daedalus.hello()?;
        let mut cached = self.clis.lock().await;
        if let Some((boot, at, clis)) = cached.as_ref() {
            if *boot == hello.boot_id && at.elapsed() < CLIS_TTL {
                return Some(clis.clone());
            }
        }
        match probe_clis(&client, &hello.projects_root).await {
            Ok(clis) => {
                *cached = Some((hello.boot_id.clone(), Instant::now(), clis.clone()));
                Some(clis)
            }
            Err(e) => {
                log::warn!("daedalus: asking which agent CLIs the box has failed: {e:#}");
                None
            }
        }
    }

    /// Which agent owns the foreground of each agent-capable remote pane, read
    /// from the box's process table the way `agent_procs::detect` reads this
    /// Mac's. Identity only, and "don't know" (absent) on any failure.
    pub async fn detect(&self, daedalus: &DaedalusHost) -> Vec<AgentProcess> {
        let panes = daedalus.terminals().bound();
        if panes.is_empty() {
            return Vec::new();
        }
        let (Ok(client), Some(hello)) = (daedalus.client(), daedalus.hello()) else {
            return Vec::new();
        };
        let pids: HashMap<_, u32> = match client.pty_sessions().await {
            Ok(sessions) => sessions
                .into_iter()
                .filter(|s| s.alive)
                .filter_map(|s| Some((s.id, s.pid?)))
                .collect(),
            Err(e) => {
                log::debug!("daedalus: listing the box's sessions for detection: {e}");
                return Vec::new();
            }
        };
        let Some(tree) = self.table(&client, &hello.projects_root).await else {
            return Vec::new();
        };
        let roots: Vec<(LiveTerminal, u32)> = panes
            .into_iter()
            .filter_map(|(pane, remote)| Some((pane, *pids.get(&remote)?)))
            .collect();
        crate::agent_procs::attribute(&tree, &roots)
    }

    /// The box's process table, at most [`PROCS_TTL`] old.
    async fn table(&self, client: &RemoteClient, cwd: &str) -> Option<Arc<ProcTree>> {
        let mut cached = self.procs.lock().await;
        if let Some((_, tree)) = cached.as_ref().filter(|(at, _)| at.elapsed() < PROCS_TTL) {
            return tree.clone();
        }
        let read = tokio::time::timeout(PROCS_TIMEOUT, read_table(client, cwd))
            .await
            .unwrap_or_else(|_| Err(anyhow!("ps on the box did not answer in time")));
        let tree = read
            .inspect_err(|e| log::warn!("daedalus: reading the box's process table: {e:#}"))
            .ok();
        *cached = Some((Instant::now(), tree.clone()));
        tree
    }
}

/// `ps` on the box, parsed by the same parser as this Mac's — which keeps only
/// each row's `argv[0]` basename, so no command line is kept here.
async fn read_table(client: &RemoteClient, cwd: &str) -> Result<Arc<ProcTree>> {
    let out = client
        .call::<m::ExecRun>(&ExecParams {
            cwd: cwd.to_string(),
            argv: std::iter::once("ps")
                .chain(crate::proc_table::PS_ARGS.iter().copied())
                .map(str::to_string)
                .collect(),
            timeout_ms: Some(PROCS_TIMEOUT.as_millis() as u64),
            ..ExecParams::default()
        })
        .await?;
    ensure!(
        out.success() && !out.truncated,
        "ps: {}",
        String::from_utf8_lossy(&out.stderr).trim()
    );
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    Ok(Arc::new(
        tokio::task::spawn_blocking(move || ProcTree::new(parse_ps(&text))).await?,
    ))
}

/// Ask the box's login shell which of the launchable CLIs it finds.
async fn probe_clis(client: &RemoteClient, cwd: &str) -> Result<Vec<AgentKind>> {
    let argv = ["bash", "-lc", PROBE, "santree"]
        .into_iter()
        .chain(LAUNCHABLE.map(agent_binary))
        .map(str::to_string)
        .collect();
    let out = client
        .call::<m::ExecRun>(&ExecParams {
            cwd: cwd.to_string(),
            argv,
            timeout_ms: Some(15_000),
            ..ExecParams::default()
        })
        .await?;
    ensure!(
        out.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr).trim()
    );
    let found: HashSet<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_string)
        .collect();
    Ok(LAUNCHABLE
        .into_iter()
        .filter(|kind| found.contains(agent_binary(*kind)))
        .collect())
}

/// What a launch of `kind` says when the box has no such CLI.
pub fn not_installed(kind: AgentKind) -> String {
    let name = match kind {
        AgentKind::Claude => "Claude Code",
        AgentKind::Codex => "Codex",
        AgentKind::Cursor => "Cursor",
        AgentKind::Opencode => "OpenCode",
    };
    format!(
        "{name} isn't installed on Daedalus: `{}` isn't on the box's PATH.",
        agent_binary(kind)
    )
}

/// The checkout's common git dir, absolute, as git on its machine names it.
/// Blocking.
fn common_git_dir(at: &Checkout) -> Result<PathBuf> {
    let out = at.git(&["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
    ensure!(out.ok, "{}", out.stderr.trim());
    let dir = PathBuf::from(String::from_utf8(out.stdout)?.trim());
    ensure!(dir.is_absolute(), "git named no absolute git directory");
    Ok(dir)
}

/// santree's own directory for a checkout on the box: `santree/` in its common
/// git dir. Blocking.
pub fn santree_dir(root: &Checkout) -> Result<PathBuf> {
    Ok(common_git_dir(root)?.join("santree"))
}

/// Write santree's hook settings for `repo` on the box and say how a launch
/// there carries them: the Claude settings files' paths and Codex's flags,
/// every command `<hookBin> hook <args>`. No English tutor: its instruction
/// and practice log are this Mac's files.
pub async fn hooks(
    db: &crate::db::Db,
    daedalus: &DaedalusHost,
    repo: &str,
) -> Result<DaedalusAgentHooks> {
    ensure!(
        crate::repo::is_daedalus(db, repo).await?,
        "{repo} isn't a Daedalus project"
    );
    let root = crate::worktree::root(db, daedalus, repo).await?;
    let hello = daedalus
        .hello()
        .ok_or_else(|| anyhow!(describe(&daedalus.state())))?;
    let prefix = hooks::box_prefix(&hello.hook_bin);
    tokio::task::spawn_blocking(move || {
        let dir = santree_dir(&root)?;
        let write = |name: &str, settings: Map<String, Value>| -> Result<String> {
            let path = dir.join(name);
            let json = serde_json::to_string_pretty(&Value::Object(settings))?;
            root.write(&path, json.as_bytes())?;
            Ok(path.to_string_lossy().into_owned())
        };
        Ok(DaedalusAgentHooks {
            claude_settings: write(CLAUDE_SETTINGS_FILE, hooks::hook_settings(&prefix))?,
            claude_settings_no_git: write(
                CLAUDE_SETTINGS_NO_GIT_FILE,
                hooks::hook_settings_no_git(&prefix),
            )?,
            codex_flags: hooks::codex_flags_for(&prefix),
        })
    })
    .await?
}

/// Resolve a launch of `agent` in a Daedalus project, as `provider.rs` does a
/// local one: resume a session whose record is still on the box, else start
/// fresh (or stay a shell); a Codex session also gets what it runs under,
/// checked against the box's own `codex`. `root` is the repo's checkout;
/// `request.cwd` a directory on the box, already vetted by the caller.
pub async fn resolve_session(
    daedalus: &DaedalusHost,
    root: &Checkout,
    agent: AgentKind,
    request: SessionRequest<'_>,
) -> Result<AgentSession> {
    let hello = daedalus
        .hello()
        .ok_or_else(|| anyhow!(describe(&daedalus.state())))?;
    if let Some(clis) = daedalus.agents().clis(daedalus).await {
        ensure!(clis.contains(&agent), not_installed(agent));
    }
    let executable = agent_binary(agent);
    let at = root.at(request.cwd);
    let home = PathBuf::from(&hello.home);
    let cwd = request.cwd.to_string_lossy().into_owned();
    match agent {
        AgentKind::Claude => {
            session::resolve_with(
                request.db,
                request.repo,
                request.term_key,
                &cwd,
                executable,
                request.allow_fresh,
                |stored_cwd, id| {
                    let (at, home) = (at.clone(), home.clone());
                    blocking(move || transcript_on_box(&at, &home, &stored_cwd, &id))
                },
            )
            .await
        }
        AgentKind::Codex => {
            let session = session::resolve_codex_with(
                request.db,
                CodexSessionOpts {
                    executable,
                    repo: request.repo,
                    term_key: request.term_key,
                    allow_fresh: request.allow_fresh,
                    sessions_root: None,
                },
                |id| {
                    let (at, home) = (at.clone(), home.clone());
                    blocking(move || rollout_on_box(&at, &home, &id))
                },
            )
            .await?;
            if matches!(session, AgentSession::Shell) {
                return Ok(session);
            }
            let git_dir = {
                let at = at.clone();
                tokio::task::spawn_blocking(move || common_git_dir(&at).ok()).await?
            };
            let flags = codex_config::launch_flags(&codex_config::LaunchConfig {
                surface: request.surface,
                fresh: matches!(session, AgentSession::Fresh { .. }),
                model: request.model,
                effort: request.effort,
                review_mcp_config: None,
                git_dir: git_dir.as_deref(),
                network_access: crate::provider::codex_network_access(request.db).await,
            })?;
            validate_on_box(&at, executable, &flags).await?;
            Ok(session.with_launch_flags(flags))
        }
        AgentKind::Cursor | AgentKind::Opencode => {
            Err(anyhow!("{} sessions aren't supported", agent.as_str()))
        }
    }
}

/// [`codex_config::validate_overrides`], against the box's `codex`.
async fn validate_on_box(at: &Checkout, executable: &str, flags: &str) -> Result<()> {
    let Some(args) = codex_config::validation_args(flags) else {
        return Ok(());
    };
    let (at, executable) = (at.clone(), executable.to_string());
    let out = tokio::time::timeout(
        codex_config::VALIDATION_TIMEOUT,
        tokio::task::spawn_blocking(move || {
            let argv: Vec<&str> = std::iter::once(executable.as_str())
                .chain(args.iter().map(String::as_str))
                .collect();
            at.run(&argv)
        }),
    )
    .await
    .map_err(|_| anyhow!("checking santree's Codex launch configuration timed out"))???;
    codex_config::validation_verdict(&out.stdout, out.stderr.as_bytes())
}

/// Run a blocking presence check on the pool; a check that couldn't run is
/// "couldn't look", never "gone".
async fn blocking(check: impl FnOnce() -> RecordPresence + Send + 'static) -> RecordPresence {
    tokio::task::spawn_blocking(check)
        .await
        .unwrap_or_else(|e| RecordPresence::Unknown(format!("the check failed: {e}")))
}

/// Whether Claude's transcript for `id`, run in `stored_cwd`, is on the box:
/// `<home>/.claude/projects/<escaped cwd>/<id>.jsonl`, as locally.
fn transcript_on_box(at: &Checkout, home: &Path, stored_cwd: &str, id: &str) -> RecordPresence {
    if !session::is_session_id(id) {
        return RecordPresence::Unknown(format!("{id:?} is not a session id"));
    }
    let path = home
        .join(".claude/projects")
        .join(session::project_slug(stored_cwd))
        .join(format!("{id}.jsonl"));
    match at.stat(&path) {
        Ok(Some(_)) => RecordPresence::Present,
        Ok(None) => RecordPresence::Absent,
        Err(e) => RecordPresence::Unknown(format!("{e:#}")),
    }
}

/// Whether Codex's rollout for thread `id` is on the box, under
/// `<home>/.codex/sessions` (a rollout's file name ends in its thread id).
fn rollout_on_box(at: &Checkout, home: &Path, id: &str) -> RecordPresence {
    if !session::is_session_id(id) {
        return RecordPresence::Unknown(format!("{id:?} is not a thread id"));
    }
    let sessions = home.join(".codex/sessions");
    match at.stat(&sessions) {
        Ok(Some(FsKind::Dir)) => {}
        Ok(_) => return RecordPresence::Absent,
        Err(e) => return RecordPresence::Unknown(format!("{e:#}")),
    }
    let sessions = sessions.to_string_lossy();
    let name = format!("rollout-*-{id}.jsonl");
    match at.run(&["find", &sessions, "-name", &name, "-print", "-quit"]) {
        Ok(out) if out.ok && out.stdout.iter().any(|b| !b.is_ascii_whitespace()) => {
            RecordPresence::Present
        }
        Ok(out) if out.ok => RecordPresence::Absent,
        Ok(out) => RecordPresence::Unknown(out.stderr.trim().to_string()),
        Err(e) => RecordPresence::Unknown(format!("{e:#}")),
    }
}
