//! Resumable agent sessions for terminals that auto-launch a CLI.
//!
//! When a terminal auto-launches the agent (Trees "work", Triage "investigate")
//! we remember its session in `terminal_sessions`, so reopening the tab later —
//! after the app restarted or the agent was quit — resumes the *same*
//! conversation instead of dropping to a bare shell or starting over. A session
//! is "resumable" only while its own on-disk record survives; once the CLI
//! prunes it we start fresh.
//!
//! The two providers differ in **who mints the id**, and everything else follows
//! from that:
//!
//! * **Claude** takes one at launch (`--session-id`), so [`resolve`] mints and
//!   stores the UUID itself, and the record to stat is the transcript at
//!   `~/.claude/projects/<escaped-cwd>/<id>.jsonl`.
//! * **Codex** has no such flag: it mints its own id and reports it through the
//!   `SessionStart` hook, which is what writes the row (see `santree-hook`). So
//!   [`resolve_codex`] persists nothing, a fresh launch carries no id at all, and
//!   the record to look for is the rollout under `$CODEX_HOME/sessions`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, ensure, Result};
use santree_core::domain::{
    AgentKind, AgentSession, EnvVar, LastMessageFrom, SessionDetail, SessionSpend, SessionSubagent,
    TriageSession, WorktreeSession,
};
use serde_json::Value;
use uuid::Uuid;

use crate::db::Db;
use crate::sessions::{LiveTerminal, Liveness};

/// Claude stores each session's transcript at
/// `~/.claude/projects/<escaped-cwd>/<session-id>.jsonl`, escaping the working
/// directory by replacing every non-alphanumeric character with `-` (verified
/// against real transcripts, e.g. `…/acme/.santree/worktrees/AK-1` becomes
/// `…-acme--santree-worktrees-AK-1`, and `…/dev/my_repo` becomes
/// `…-dev-my-repo`). `None` for an id that names no transcript ([`transcript_file`]).
fn transcript_path(home: &Path, cwd: &str, session_id: &str) -> Option<PathBuf> {
    transcript_file(&home.join(".claude/projects"), cwd, session_id)
}

/// `<projects>/<escaped cwd>/<session_id>.jsonl` under one of Claude's
/// `projects` roots, or `None` when `session_id` is not a session id's shape.
///
/// The ids joined here are read from santree's database, and `santree-hook`
/// stores whatever its payload said — any process running as the user can run
/// it. Joined unchecked, a `../` or an absolute id names a file anywhere.
pub(crate) fn transcript_file(projects: &Path, cwd: &str, session_id: &str) -> Option<PathBuf> {
    is_session_id(session_id).then(|| {
        projects
            .join(project_slug(cwd))
            .join(format!("{session_id}.jsonl"))
    })
}

/// Whether `id` has the shape of a provider session id: a hyphenated UUID, which
/// is what both providers use — the id santree mints for Claude's `--session-id`,
/// and the thread id Codex mints for itself. An id from outside santree (a hook
/// relayed from Daedalus) is checked against it before it is stored, and every
/// stored id again before it is joined into a transcript path ([`transcript_file`]).
pub(crate) fn is_session_id(id: &str) -> bool {
    // 36 characters is the hyphenated form only: `try_parse` also takes the
    // braced, urn and bare-hex spellings, none of which a provider emits.
    id.len() == 36 && Uuid::try_parse(id).is_ok()
}

/// The `projects/` directory name Claude derives from a working directory (see
/// [`transcript_path`] for the escaping, verified against real transcripts).
pub(crate) fn project_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// What santree could learn about a session's on-disk record — a Claude
/// transcript, a Codex rollout.
///
/// **Absence and "couldn't look" are different answers**, and collapsing them
/// into one `bool` is a data-loss bug rather than an untidiness. A bare
/// `path.exists()` answers `false` when `~/.claude/projects` is unreadable —
/// a permission change, an unmounted volume, a transient IO error — santree
/// reads that as "the CLI pruned it", and the tab silently starts a *new*
/// conversation on top of one the user still has. Only [`std::io::ErrorKind::NotFound`]
/// and [`std::io::ErrorKind::NotADirectory`] mean the record is gone; every
/// other error means santree does not know, and a caller may not round that
/// down to "gone".
#[derive(Debug)]
pub(crate) enum RecordPresence {
    /// The record is there: this session can be resumed.
    Present,
    /// The record is genuinely not there — the CLI pruned it, or it never
    /// existed.
    Absent,
    /// santree could not find out. Carries why, for the message the user sees.
    Unknown(String),
}

impl RecordPresence {
    /// Stat one record. Blocking; callers hand it to the blocking pool.
    pub(crate) fn of(path: &Path) -> Self {
        match std::fs::metadata(path) {
            Ok(_) => Self::Present,
            Err(e) if is_absence(&e) => Self::Absent,
            Err(e) => Self::Unknown(format!("{}: {e}", path.display())),
        }
    }
}

/// The only two IO errors that mean "there is nothing here". Everything else —
/// `PermissionDenied`, `Other` from an unmounted volume, an interrupted or
/// timed-out network filesystem — means the question went unanswered.
pub(crate) fn is_absence(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
    )
}

/// Whether `session_id` can still be resumed for a claude run in `cwd`. The stat
/// goes to the blocking pool: `~/.claude/projects` can sit on a slow or networked
/// filesystem, and every caller here is on the async runtime.
///
/// No `home` is [`RecordPresence::Unknown`], not [`RecordPresence::Absent`]:
/// without it transcripts cannot be located *at all*, so santree is guessing,
/// not observing. (A surface with no stored row never reaches here — a first
/// launch still mints a session on a machine with no `HOME`.)
async fn transcript_presence(home: Option<&Path>, cwd: &str, session_id: &str) -> RecordPresence {
    let Some(home) = home else {
        return RecordPresence::Unknown(
            "HOME is not set, so Claude's transcripts cannot be located".into(),
        );
    };
    let Some(path) = transcript_path(home, cwd, session_id) else {
        return RecordPresence::Unknown(format!("{session_id:?} is not a session id"));
    };
    tokio::task::spawn_blocking(move || RecordPresence::of(&path))
        .await
        // A cancelled or panicked stat is another way of not knowing — the old
        // `unwrap_or(false)` here reported it as "pruned".
        .unwrap_or_else(|e| RecordPresence::Unknown(format!("the transcript check failed: {e}")))
}

/// The message a resume decision refuses with when it could not read the
/// record. Refusing is the whole point: the alternative is starting a fresh
/// conversation over one that is probably still there.
fn unreadable_record(why: &str) -> anyhow::Error {
    anyhow!(
        "santree couldn't read this session's record, so it can't tell whether the saved \
         conversation is still there — and it won't start a new one over it. Check that the \
         agent's session directory is readable, then try again ({why})"
    )
}

/// A session Claude's own daemon is running in the background (`claude --bg`):
/// `claude agents --json` entries of kind `background`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BackgroundSession {
    /// The short id `claude attach` takes.
    pub id: String,
    pub session_id: String,
}

/// How long a launch waits for `claude agents --json` before treating the answer
/// as "none". It answers in ~0.1s; the bound only matters if the CLI wedges.
const AGENTS_LISTING_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// The shape `claude attach` accepts as an id, and the only one that may reach
/// its argv: the listing's text is the CLI's, not santree's.
fn is_background_id(id: &str) -> bool {
    (6..=16).contains(&id.len()) && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The background entries of a `claude agents --json` array. Anything that is
/// not a well-formed background entry — including an id that is not
/// [`is_background_id`] — is dropped, never an error: this only ever *adds* an
/// attach, and a launch must not fail because the listing was odd.
fn parse_background_sessions(json: &[u8]) -> Vec<BackgroundSession> {
    let Ok(Value::Array(entries)) = serde_json::from_slice::<Value>(json) else {
        return Vec::new();
    };
    entries
        .iter()
        .filter(|e| e.get("kind").and_then(Value::as_str) == Some("background"))
        .filter_map(|e| {
            let id = e.get("id")?.as_str()?;
            let session_id = e.get("sessionId")?.as_str()?;
            is_background_id(id).then(|| BackgroundSession {
                id: id.to_string(),
                session_id: session_id.to_string(),
            })
        })
        .collect()
}

/// Claude's background sessions on this Mac, from the CLI itself (process
/// identity, never terminal output). Any failure — no such binary, a timeout, a
/// non-zero exit, text that is not JSON — is "none": a launch then does what it
/// always did.
///
/// `env` is the launch's account environment: each account's daemon is its own,
/// so a session is only found by asking under the account it runs on.
pub(crate) async fn background_sessions(
    executable: &str,
    env: &[EnvVar],
) -> Vec<BackgroundSession> {
    let mut cmd = tokio::process::Command::new(executable);
    cmd.envs(env.iter().map(|var| (&var.name, &var.value)));
    cmd.args(["agents", "--json"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let Ok(Ok(out)) = tokio::time::timeout(AGENTS_LISTING_TIMEOUT, cmd.output()).await else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    parse_background_sessions(&out.stdout)
}

/// Resolve how to (re)launch claude for the logical terminal `term_key` in
/// `repo`: resume a still-on-disk session, mint a fresh one (only when
/// `allow_fresh` — i.e. an explicit launch, not a passive reopen), or leave it a
/// plain shell. A fresh launch reuses the stored id when the transcript was
/// pruned, so a later resume can still find the conversation. `home` is the
/// user's home directory (`None` when `HOME` isn't set), resolved once by the
/// caller.
///
/// **Errs when the transcript could not be read** (see [`RecordPresence`]).
/// A stored session whose record santree cannot stat is not a pruned one: the
/// launch stops, the tab falls back to a plain shell in the same directory, and
/// the row is left untouched so the conversation is still there to resume once
/// the filesystem is. Reporting "pruned" instead would mint a launch over it.
///
/// `account` is the launch's account (`accounts::for_launch`): its id, which a
/// minted row records, and the environment the background listing runs under.
#[allow(clippy::too_many_arguments)]
pub async fn resolve(
    db: &Db,
    repo: &str,
    term_key: &str,
    cwd: &str,
    home: Option<&Path>,
    executable: &str,
    allow_fresh: bool,
    account: Option<(&str, &[EnvVar])>,
) -> Result<AgentSession> {
    let env = account.map(|(_, env)| env).unwrap_or_default();
    resolve_with(
        db,
        repo,
        term_key,
        cwd,
        executable,
        allow_fresh,
        account.map(|(id, _)| id),
        |stored_cwd, id| async move { transcript_presence(home, &stored_cwd, &id).await },
        || background_sessions(executable, env),
    )
    .await
}

/// [`resolve`], asking `presence(stored_cwd, session_id)` whether a stored
/// session's transcript is still there — wherever the transcripts are: this
/// machine's `~/.claude`, or the box's for a Daedalus project.
///
/// `background` lists Claude's background sessions where the agent runs; it is
/// asked only when a session is stored. One of them being the stored session
/// means the tab's conversation outlived its pane in Claude's daemon, so the
/// tab attaches to it ([`AgentSession::Attach`]) — checked before the
/// transcript, since a running session is attachable whatever its record says.
/// Daedalus passes an empty listing: `claude attach` is this Mac's daemon's.
///
/// `account` is recorded on a row this mints; a stored row keeps its own.
#[allow(clippy::too_many_arguments)]
pub async fn resolve_with<F, Fut, B, BFut>(
    db: &Db,
    repo: &str,
    term_key: &str,
    cwd: &str,
    executable: &str,
    allow_fresh: bool,
    account: Option<&str>,
    presence: F,
    background: B,
) -> Result<AgentSession>
where
    F: FnOnce(String, String) -> Fut,
    Fut: std::future::Future<Output = RecordPresence>,
    B: FnOnce() -> BFut,
    BFut: std::future::Future<Output = Vec<BackgroundSession>>,
{
    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT session_id, cwd, agent_kind FROM terminal_sessions
         WHERE repo = ? AND term_key = ? AND agent_kind = 'Claude'",
    )
    .bind(repo)
    .bind(term_key)
    .fetch_optional(db)
    .await?;

    if let Some((session_id, stored_cwd, agent_kind)) = row {
        let agent_kind: AgentKind = agent_kind.parse()?;
        if agent_kind != AgentKind::Claude {
            anyhow::bail!("stored provider does not match Claude session resolver");
        }
        if let Some(running) = background()
            .await
            .into_iter()
            .find(|b| b.session_id == session_id)
        {
            return Ok(AgentSession::Attach {
                agent_kind: AgentKind::Claude,
                executable: executable.to_string(),
                session_id,
                background_id: running.id,
                launch_env: Vec::new(),
                account: None,
            });
        }
        match presence(stored_cwd, session_id.clone()).await {
            RecordPresence::Present => {
                return Ok(AgentSession::Resume {
                    agent_kind: AgentKind::Claude,
                    executable: executable.to_string(),
                    session_id,
                    launch_flags: String::new(),
                    launch_env: Vec::new(),
                    account: None,
                })
            }
            RecordPresence::Unknown(why) => return Err(unreadable_record(&why)),
            RecordPresence::Absent => {}
        }
        return Ok(if allow_fresh {
            AgentSession::Fresh {
                agent_kind: AgentKind::Claude,
                executable: executable.to_string(),
                session_id: Some(session_id),
                launch_flags: String::new(),
                launch_env: Vec::new(),
                account: None,
            }
        } else {
            AgentSession::Shell
        });
    }

    if !allow_fresh {
        return Ok(AgentSession::Shell);
    }

    Ok(AgentSession::Fresh {
        agent_kind: AgentKind::Claude,
        executable: executable.to_string(),
        session_id: Some(mint(db, repo, term_key, cwd, account).await?),
        launch_flags: String::new(),
        launch_env: Vec::new(),
        account: None,
    })
}

/// What [`resolve_codex`] needs. `sessions_root` is Codex's rollout directory
/// (`$CODEX_HOME/sessions`), resolved once by the caller and passed in — the
/// mirror of `resolve`'s `home`, so tests can point at a fixture without
/// mutating process-global env. `None` means "no rollouts are findable", which
/// resolves the same way a pruned one does: start fresh.
pub struct CodexSessionOpts<'a> {
    pub executable: &'a str,
    pub repo: &'a str,
    pub term_key: &'a str,
    pub allow_fresh: bool,
    pub sessions_root: Option<&'a Path>,
}

/// Resolve how to (re)launch `codex` for the logical terminal `term_key` in
/// `repo`.
///
/// Unlike Claude, santree cannot choose the id: `codex` has no launch-time
/// `--session-id`, so a fresh run mints its own and reports it back through the
/// `SessionStart` hook, which is what writes the `terminal_sessions` row (see
/// `santree-hook`). That is why a fresh launch resolves to *no* id — inventing
/// one here would name a thread `codex resume` will never find — and why this
/// function writes nothing: there is no id to persist yet.
pub async fn resolve_codex(db: &Db, opts: CodexSessionOpts<'_>) -> Result<AgentSession> {
    let sessions_root = opts.sessions_root;
    resolve_codex_with(db, opts, |thread_id| async move {
        codex_rollout_presence(sessions_root, &thread_id).await
    })
    .await
}

/// [`resolve_codex`], asking `presence(thread_id)` whether a stored thread's
/// rollout is still there — wherever the rollouts are (`opts.sessions_root` is
/// not read): this machine's, or the box's for a Daedalus project.
pub async fn resolve_codex_with<F, Fut>(
    db: &Db,
    opts: CodexSessionOpts<'_>,
    presence: F,
) -> Result<AgentSession>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = RecordPresence>,
{
    let CodexSessionOpts {
        executable,
        repo,
        term_key,
        allow_fresh,
        sessions_root: _,
    } = opts;
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT session_id FROM terminal_sessions
         WHERE repo = ? AND term_key = ? AND agent_kind = 'Codex'",
    )
    .bind(repo)
    .bind(term_key)
    .fetch_optional(db)
    .await?;

    if let Some((thread_id,)) = row {
        // `codex resume <id>` errors out in the user's face when the rollout is
        // gone (Codex pruned it, or `CODEX_HOME` moved), so the stored id is only
        // a resume target while its rollout is on disk. A stale row is left in
        // place rather than deleted: the fresh run's `SessionStart` repoints it.
        match presence(thread_id.clone()).await {
            RecordPresence::Present => {
                return Ok(AgentSession::Resume {
                    agent_kind: AgentKind::Codex,
                    executable: executable.to_string(),
                    session_id: thread_id,
                    // Filled in by `CodexProvider`, which owns what a Codex session
                    // runs under; the resolver only decides which thread it is.
                    launch_flags: String::new(),
                    launch_env: Vec::new(),
                    account: None,
                });
            }
            // An unreadable rollout tree is not a pruned thread. Starting fresh
            // here lets the new run's `SessionStart` repoint the row, and the
            // user's thread stops being reachable from this surface at all.
            RecordPresence::Unknown(why) => return Err(unreadable_record(&why)),
            RecordPresence::Absent => {}
        }
    }

    if !allow_fresh {
        return Ok(AgentSession::Shell);
    }
    Ok(AgentSession::Fresh {
        agent_kind: AgentKind::Codex,
        executable: executable.to_string(),
        session_id: None,
        launch_flags: String::new(),
        launch_env: Vec::new(),
        account: None,
    })
}

/// [`crate::codex_rollouts::rollout_presence_in`] off the async runtime — the
/// rollout directory is a real directory walk, and every caller here is on it.
///
/// No `sessions_root` is [`RecordPresence::Absent`], not `Unknown`, and that is
/// not the same call as Claude's `home`: `codex_rollouts::sessions_root()`
/// answers `Some` only for a directory that is *there*, so `None` is Codex
/// never having written a session on this machine — a real absence.
async fn codex_rollout_presence(sessions_root: Option<&Path>, thread_id: &str) -> RecordPresence {
    let Some(root) = sessions_root.map(Path::to_path_buf) else {
        return RecordPresence::Absent;
    };
    let thread_id = thread_id.to_string();
    tokio::task::spawn_blocking(move || {
        crate::codex_rollouts::rollout_presence_in(&root, &thread_id)
    })
    .await
    .unwrap_or_else(|e| RecordPresence::Unknown(format!("the rollout check failed: {e}")))
}

/// Store a new session id for the terminal and return the id it will actually
/// run under. Two launches of the same terminal can race — both see no row and
/// mint an id — so the insert yields to whoever got there first and we re-read:
/// the loser adopts the winner's session instead of failing the primary key.
///
/// `account` is the account the session launches on, recorded with it so every
/// later resume of this surface runs under the same login.
async fn mint(
    db: &Db,
    repo: &str,
    term_key: &str,
    cwd: &str,
    account: Option<&str>,
) -> Result<String> {
    sqlx::query(
        "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, agent_kind, account)
         VALUES (?, ?, ?, ?, 'Claude', ?)
         ON CONFLICT (repo, term_key, agent_kind) DO NOTHING",
    )
    .bind(repo)
    .bind(term_key)
    .bind(cwd)
    .bind(Uuid::new_v4().to_string())
    .bind(account)
    .execute(db)
    .await?;
    let (session_id,): (String,) = sqlx::query_as(
        "SELECT session_id FROM terminal_sessions
             WHERE repo = ? AND term_key = ? AND agent_kind = 'Claude'",
    )
    .bind(repo)
    .bind(term_key)
    .fetch_one(db)
    .await?;
    Ok(session_id)
}

/// Every Triage surface that has a *stored session* for `repo`, including the
/// provider that owns it, so the frontend can preserve historical branding.
///
/// Mirrors how a worktree row makes the Trees work terminal resumable: presence
/// of the record — not the on-disk transcript — is what surfaces the tab +
/// resume affordance. We intentionally don't stat the transcript here: even if
/// Claude has pruned it, `resolve` (with `allow_fresh`) reuses the stored id to
/// start fresh, so a stored session is always a valid resume target.
pub async fn started_investigations(db: &Db, repo: &str) -> Result<Vec<TriageSession>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT term_key, agent_kind FROM terminal_sessions
         WHERE repo = ? AND term_key LIKE 'triage:%'",
    )
    .bind(repo)
    .fetch_all(db)
    .await?;
    rows.into_iter()
        .filter_map(|(key, kind)| {
            key.strip_prefix("triage:")
                // Sentinel keys from the removed repo-wide Triage desk are still in
                // the table, and no ticket will ever match them again.
                .filter(|ref_id| !ref_id.starts_with("__"))
                // A ticket's plain tabs (`triage:<ticket>:tab:<id>`) share the
                // prefix but are not investigations: they come back as
                // `worktree_tabs` rows, not as a resume offer on the ticket.
                .filter(|ref_id| !ref_id.contains(":tab:"))
                .map(|ref_id| (ref_id.to_string(), kind))
        })
        .map(|(ref_id, kind)| {
            Ok(TriageSession {
                ref_id,
                agent_kind: kind.parse()?,
            })
        })
        .collect()
}

/// Providers with a durable conversation on one logical surface.
pub async fn providers(db: &Db, repo: &str, term_key: &str) -> Result<Vec<AgentKind>> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT agent_kind FROM terminal_sessions
         WHERE repo = ? AND term_key = ? ORDER BY created_at, agent_kind",
    )
    .bind(repo)
    .bind(term_key)
    .fetch_all(db)
    .await?;
    rows.into_iter()
        .map(|(agent,)| agent.parse().map_err(anyhow::Error::from))
        .collect()
}

/// Max characters of mined transcript text fed to the PR-draft prompt. Generous
/// (Haiku has plenty of context) but bounded so a long-running worktree's history
/// can't blow up the prompt size or the 120s helper timeout. Tune here.
const TRANSCRIPT_BUDGET: usize = 40_000;

/// The stored sessions for a worktree, newest last: its main work terminal
/// (`tree:<id>`) plus any extra tabs (`tree:<id>:tab:<tab>`, `…:fixci`, …). Each
/// row is `(session_id, cwd, term_key)`. The `cwd` is what locates the transcript
/// (see [`transcript_path`]).
///
/// `issue_id`'s LIKE metacharacters are escaped so an id containing `%`/`_` can't
/// widen the prefix match into other worktrees' sessions.
async fn worktree_session_rows(
    db: &Db,
    repo: &str,
    issue_id: &str,
) -> Result<Vec<(String, String, String)>> {
    let (exact, prefix) = worktree_key_patterns(issue_id);
    let rows = sqlx::query_as(
        "SELECT session_id, cwd, term_key FROM terminal_sessions
         WHERE repo = ? AND (term_key = ? OR term_key LIKE ? ESCAPE '\\')
         ORDER BY created_at",
    )
    .bind(repo)
    .bind(exact)
    .bind(prefix)
    .fetch_all(db)
    .await?;
    Ok(rows)
}

/// The `term_key` match for a worktree's terminals: `(exact, like-prefix)` — its
/// main terminal `tree:<id>` and, under `ESCAPE '\'`, every `tree:<id>:…` tab.
fn worktree_key_patterns(issue_id: &str) -> (String, String) {
    (
        format!("tree:{issue_id}"),
        format!("tree:{}:%", escape_like(issue_id)),
    )
}

/// What a session's on-disk record (a Claude transcript, a Codex rollout) says
/// about it, in the shape the Trees history shows. Filled by `usage.rs` and
/// `codex_rollouts.rs`; timestamps stay integral here and convert at the wire.
#[derive(Clone)]
pub(crate) struct SessionSummary {
    pub title: Option<String>,
    pub last_message: Option<String>,
    pub last_message_from: Option<LastMessageFrom>,
    pub message_count: u32,
    pub subagent_count: u32,
    pub model: Option<String>,
    pub started_at_ms: Option<i64>,
    pub last_activity_ms: Option<i64>,
    /// Tokens + cost, when the provider's record carries them. Codex rollouts
    /// don't, so theirs stays `None` rather than reporting a zero as a total.
    pub spend: Option<SessionSpend>,
    /// Summarised from the record's first and last pages only (a Daedalus
    /// transcript too large to read whole): counts are lower bounds.
    pub sampled: bool,
}

/// A worktree's registered session with the hook-tracked state joined on:
/// `(session_id, agent_kind, term_key, cwd, created_at, updated_at_ms)`.
pub(crate) type HistoryRow = (String, String, String, String, String, Option<i64>);

/// The agent sessions that have run in a worktree, newest first: every session
/// the terminal registry attributes to it (its main terminal and tabs), plus the
/// Claude transcripts and Codex rollouts on disk for that directory with no
/// registry row (launched by hand, or a row since forgotten). Both providers are
/// summarised from their own record — a Claude session from its transcript, a
/// Codex one from its rollout. Empty when nothing ran. A Daedalus project's
/// are read on the box instead (`daedalus/history.rs`), over the same rows.
pub async fn history(
    db: &Db,
    repo: &str,
    issue_id: &str,
    worktree: &Path,
) -> Result<Vec<WorktreeSession>> {
    let rows = history_rows(db, repo, issue_id).await?;
    let (known_claude, known_codex) = known_sessions(&rows);
    let dir = worktree.to_path_buf();
    // The same table the Usage panel prices with, so a session's cost reads the
    // same in both places. Never blocks on the network (see `pricing`).
    let table = crate::pricing::ensure_fresh(db).await;
    let summaries: HashMap<String, (AgentKind, SessionSummary)> =
        tokio::task::spawn_blocking(move || {
            let claude = crate::usage::worktree_summaries(&dir, &known_claude, &table)
                .into_iter()
                .map(|(id, s)| (id, (AgentKind::Claude, s)));
            let codex = crate::codex_rollouts::worktree_summaries(&dir, &known_codex)
                .into_iter()
                .map(|(id, s)| (id, (AgentKind::Codex, s)));
            claude.chain(codex).collect()
        })
        .await?;
    Ok(merge_history(rows, summaries))
}

/// The registry's rows for a worktree's sessions, every provider's, oldest first.
pub(crate) async fn history_rows(db: &Db, repo: &str, issue_id: &str) -> Result<Vec<HistoryRow>> {
    let (exact, prefix) = worktree_key_patterns(issue_id);
    // LEFT JOIN: `session_state` is written by Claude's hooks, so a Codex row (or
    // a Claude one from before the hooks) has none — it still counts as a session.
    Ok(sqlx::query_as(
        "SELECT t.session_id, t.agent_kind, t.term_key, t.cwd, t.created_at, s.updated_at_ms
         FROM terminal_sessions t
         LEFT JOIN session_state s ON s.session_id = t.session_id
         WHERE t.repo = ? AND (t.term_key = ? OR t.term_key LIKE ? ESCAPE '\\')
         ORDER BY t.created_at",
    )
    .bind(repo)
    .bind(exact)
    .bind(prefix)
    .fetch_all(db)
    .await?)
}

/// What locates the rows' records: Claude transcripts by `(cwd, session_id)`;
/// Codex rollouts by thread id alone (the registry's `session_id` for a Codex
/// row *is* the thread id — what `session_meta.id` carries).
pub(crate) fn known_sessions(rows: &[HistoryRow]) -> (Vec<(String, String)>, Vec<String>) {
    let claude = rows
        .iter()
        .filter(|r| r.1 == AgentKind::Claude.as_str())
        .map(|r| (r.3.clone(), r.0.clone()))
        .collect();
    let codex = rows
        .iter()
        .filter(|r| r.1 == AgentKind::Codex.as_str())
        .map(|r| r.0.clone())
        .collect();
    (claude, codex)
}

/// The registry's rows joined with what the records say (`summaries`, by
/// session id), plus the records no row names — newest first.
pub(crate) fn merge_history(
    rows: Vec<HistoryRow>,
    mut summaries: HashMap<String, (AgentKind, SessionSummary)>,
) -> Vec<WorktreeSession> {
    // Each session paired with its sort key (epoch ms, kept integral here — the
    // wire type is `f64` because specta refuses `i64`), newest first.
    let mut out: Vec<(Option<i64>, WorktreeSession)> =
        Vec::with_capacity(rows.len() + summaries.len());
    let mut seen = HashSet::new();
    for (session_id, agent_kind, term_key, _cwd, created_at, updated_at_ms) in rows {
        // A stale hook binary can't write an unknown kind here (the column is
        // CHECKed), but a future variant this build lacks would — skip, don't guess.
        let Ok(agent_kind) = agent_kind.parse::<AgentKind>() else {
            continue;
        };
        if !seen.insert(session_id.clone()) {
            continue;
        }
        let created_ms = chrono::DateTime::parse_from_rfc3339(&created_at)
            .ok()
            .map(|dt| dt.timestamp_millis());
        // The row's provider is authoritative over whichever record matched the id.
        let s = summaries.remove(&session_id).map(|(_, s)| s);
        let started = s.as_ref().and_then(|s| s.started_at_ms).or(created_ms);
        let last = s
            .as_ref()
            .and_then(|s| s.last_activity_ms)
            .max(updated_at_ms);
        out.push((
            last.or(started),
            WorktreeSession {
                session_id,
                agent_kind,
                term_key: Some(term_key),
                title: s.as_ref().and_then(|s| s.title.clone()),
                last_message: s.as_ref().and_then(|s| s.last_message.clone()),
                last_message_from: s.as_ref().and_then(|s| s.last_message_from),
                message_count: s.as_ref().map_or(0, |s| s.message_count),
                subagent_count: s.as_ref().map_or(0, |s| s.subagent_count),
                model: s.as_ref().and_then(|s| s.model.clone()),
                started_at_ms: started.map(|ms| ms as f64),
                last_activity_ms: last.map(|ms| ms as f64),
                spend: s.as_ref().and_then(|s| s.spend.clone()),
                sampled: s.as_ref().is_some_and(|s| s.sampled),
            },
        ));
    }
    for (session_id, (agent_kind, s)) in summaries {
        if !seen.insert(session_id.clone()) {
            continue;
        }
        out.push((
            s.last_activity_ms.or(s.started_at_ms),
            WorktreeSession {
                session_id,
                agent_kind,
                term_key: None,
                title: s.title,
                last_message: s.last_message,
                last_message_from: s.last_message_from,
                message_count: s.message_count,
                subagent_count: s.subagent_count,
                model: s.model,
                started_at_ms: s.started_at_ms.map(|ms| ms as f64),
                last_activity_ms: s.last_activity_ms.map(|ms| ms as f64),
                spend: s.spend,
                sampled: s.sampled,
            },
        ));
    }
    // Newest first; a session with no timestamp at all sinks to the bottom.
    out.sort_by_key(|(when, _)| std::cmp::Reverse(*when));
    out.into_iter().map(|(_, s)| s).collect()
}

/// The Claude transcript of one of the worktree's *listed* sessions.
///
/// `session_id` crosses IPC, so it is never looked up directly: `listed` is
/// re-derived by the caller from [`history`] — the very command the pane reads —
/// and the id must name a Claude session in it. That is the same
/// "discoverable ⇒ actionable" gate [`adopt`] applies, and it is also the
/// `issue_id` gate, since `listed` only exists for a worktree the repo tracks.
/// The id then only ever *compares* against a candidate's file stem; nothing
/// derived from IPC is joined onto a path.
///
/// `Ok(None)` when the session is a Codex one (no Claude transcript exists) or
/// its transcript has since been pruned — an empty result, not an error.
pub(crate) async fn listed_transcript(
    db: &Db,
    repo: &str,
    issue_id: &str,
    worktree: &Path,
    listed: &[WorktreeSession],
    session_id: &str,
) -> Result<Option<PathBuf>> {
    if !listed_claude(listed, session_id)? {
        return Ok(None); // listed, but not a Claude session
    }
    let known = claude_known(db, repo, issue_id).await?;
    let dir = worktree.to_path_buf();
    let id = session_id.to_string();
    Ok(
        tokio::task::spawn_blocking(move || crate::usage::worktree_transcript(&dir, &known, &id))
            .await?,
    )
}

/// Whether `session_id` is a Claude session of `listed` — the worktree's own
/// listing, re-derived by the caller: `false` for one of its other providers',
/// an error for an id it doesn't list (the "discoverable ⇒ actionable" gate).
pub(crate) fn listed_claude(listed: &[WorktreeSession], session_id: &str) -> Result<bool> {
    ensure!(
        listed.iter().any(|s| s.session_id == session_id),
        "no session '{session_id}' has run in this worktree"
    );
    Ok(listed
        .iter()
        .any(|s| s.session_id == session_id && s.agent_kind == AgentKind::Claude))
}

/// The `(cwd, session_id)` pairs of the worktree's registered Claude sessions —
/// what locates their transcripts, wherever they ran.
async fn claude_known(db: &Db, repo: &str, issue_id: &str) -> Result<Vec<(String, String)>> {
    let (exact, prefix) = worktree_key_patterns(issue_id);
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT cwd, session_id FROM terminal_sessions
         WHERE repo = ? AND agent_kind = ? AND (term_key = ? OR term_key LIKE ? ESCAPE '\\')",
    )
    .bind(repo)
    .bind(AgentKind::Claude.as_str())
    .bind(exact)
    .bind(prefix)
    .fetch_all(db)
    .await?;
    Ok(rows)
}

/// What the expanded history row shows for one session: the full first prompt
/// and the tail of the conversation. Empty when the session has no Claude
/// transcript (see [`listed_transcript`] for the validation).
pub async fn detail(
    db: &Db,
    repo: &str,
    issue_id: &str,
    worktree: &Path,
    listed: &[WorktreeSession],
    session_id: &str,
) -> Result<SessionDetail> {
    let Some(path) = listed_transcript(db, repo, issue_id, worktree, listed, session_id).await?
    else {
        return Ok(SessionDetail::default());
    };
    Ok(tokio::task::spawn_blocking(move || crate::usage::session_detail(&path)).await?)
}

/// The session's Task subagents, with the spawn relationships their sidecars
/// record. Empty for a session with none, and for a provider that writes no
/// sidecars (Codex folds its children into the parent's count instead).
pub async fn subagents(
    db: &Db,
    repo: &str,
    issue_id: &str,
    worktree: &Path,
    listed: &[WorktreeSession],
    session_id: &str,
) -> Result<Vec<SessionSubagent>> {
    let Some(path) = listed_transcript(db, repo, issue_id, worktree, listed, session_id).await?
    else {
        return Ok(Vec::new());
    };
    let now = chrono::Local::now().timestamp_millis();
    Ok(tokio::task::spawn_blocking(move || crate::usage::session_subagents(&path, now)).await?)
}

/// Reveal the session's transcript in the OS file browser. The path is derived
/// here, from the same validated listing everything else in this pane uses — a
/// webview supplies a session id and never a path (AGENTS.md, "santree derives
/// its own paths").
pub async fn reveal_transcript(
    db: &Db,
    repo: &str,
    issue_id: &str,
    worktree: &Path,
    listed: &[WorktreeSession],
    session_id: &str,
) -> Result<()> {
    let path = listed_transcript(db, repo, issue_id, worktree, listed, session_id)
        .await?
        .ok_or_else(|| anyhow!("that session has no transcript on disk"))?;
    tokio::task::spawn_blocking(move || crate::openers::reveal(&path)).await?
}

/// Which surface [`adopt`] points at which session, and where the two providers'
/// records are looked for. The roots are passed in rather than read from the
/// environment here, for the same reason [`CodexSessionOpts`] does it: a test
/// pins a fixture instead of mutating process-global state.
pub struct ResumeRequest<'a> {
    pub repo: &'a str,
    /// The freshly-minted surface to point at the session. Derived in Rust from
    /// the worktree and the new tab's id — never taken whole from IPC, or a
    /// caller could repoint an unrelated surface's conversation.
    pub term_key: &'a str,
    pub session_id: &'a str,
    pub agent_kind: AgentKind,
    /// The worktree directory — the cwd a session found on disk with no registry
    /// row ran in.
    pub worktree: &'a Path,
    /// The user's home directory, which locates a Claude transcript.
    pub home: Option<&'a Path>,
    /// `$CODEX_HOME/sessions`, which locates a Codex rollout.
    pub sessions_root: Option<&'a Path>,
}

/// Whether a session is held by a running terminal: the answer to "may it be
/// resumed into another tab?".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Occupancy {
    /// Some surface it is bound to has a live PTY with that provider in it.
    Running,
    /// No terminal is known to hold it, but the terminals santree could ask
    /// don't add up to the whole (a local server it can't reach yet may be
    /// holding it): neither running nor free.
    Unknown,
    /// Nothing holds it.
    Free,
}

/// Whether `session_id` is running right now in one of `repo`'s terminals: some
/// surface it is bound to has a live PTY with that provider in it.
///
/// A resume of such a session must be refused rather than opened beside it. The
/// CLI would refuse it anyway ("already running") — but only after santree had
/// bound the session to the new tab as well, and a session bound to two
/// surfaces reads through whichever join row comes last.
///
/// An absence only means "free" when `terminals` is `complete`, or when no
/// surface is bound to the session at all (nothing santree launched can be
/// holding it). Otherwise it is [`Occupancy::Unknown`]: right after a relaunch
/// the agent is still running on the local server while the app has not yet
/// adopted it, and resuming then would start the conversation twice.
pub async fn occupancy(
    db: &Db,
    repo: &str,
    session_id: &str,
    agent_kind: AgentKind,
    terminals: &Liveness,
) -> Result<Occupancy> {
    let keys: Vec<(String,)> = sqlx::query_as(
        "SELECT term_key FROM terminal_sessions
         WHERE repo = ? AND session_id = ? AND agent_kind = ?",
    )
    .bind(repo)
    .bind(session_id)
    .bind(agent_kind.as_str())
    .fetch_all(db)
    .await?;
    let bound = |pane: &LiveTerminal| {
        pane.agent_kind == Some(agent_kind) && keys.iter().any(|(key,)| *key == pane.term_key)
    };
    match terminals.knows(bound) {
        Some(true) => return Ok(Occupancy::Running),
        // Nothing known holds it, but the answer didn't cover everything: the
        // binding above is deleted when a tab closes, and a tab closed while the
        // server couldn't be told leaves its agent running there. Not free.
        None => return Ok(Occupancy::Unknown),
        Some(false) => {}
    }
    // A complete answer, and no bound surface is live. The same orphan, once the
    // server answers in full, is a live pane of this provider that no binding
    // accounts for, beside fresh word from the session itself (its hooks or its
    // status line). Only both together: a pane no binding accounts for is also a
    // new agent that hasn't bound yet, and a session heard from a while ago is
    // not one to refuse over. With in-app terminals a closed tab's process is
    // gone, so there is no such pane and this is `Free` as it always was.
    if unattributed_pane(db, agent_kind, terminals).await?
        && heard_from_lately(db, session_id).await?
    {
        return Ok(Occupancy::Running);
    }
    Ok(Occupancy::Free)
}

/// Whether the agent tab `term_key` may be relaunched where it is — a lost
/// pane's Resume, which reopens the tab on its own stored session. Not while
/// its own surface still has a live pane, nor while a session bound to it is
/// running anywhere; and an answer that could not see every terminal frees
/// nothing, bound session or not (a Codex tab that was never prompted has no
/// binding, and its agent may still be on a server not yet adopted).
pub async fn tab_occupancy(
    db: &Db,
    repo: &str,
    term_key: &str,
    terminals: &Liveness,
) -> Result<Occupancy> {
    match terminals.knows(|pane| pane.term_key == term_key) {
        Some(true) => return Ok(Occupancy::Running),
        None => return Ok(Occupancy::Unknown),
        Some(false) => {}
    }
    let bound: Vec<(String, String)> = sqlx::query_as(
        "SELECT session_id, agent_kind FROM terminal_sessions WHERE repo = ? AND term_key = ?",
    )
    .bind(repo)
    .bind(term_key)
    .fetch_all(db)
    .await?;
    for (session_id, agent_kind) in bound {
        let held = occupancy(db, repo, &session_id, agent_kind.parse()?, terminals).await?;
        if held != Occupancy::Free {
            return Ok(held);
        }
    }
    Ok(Occupancy::Free)
}

/// Whether a live pane running `agent_kind` has no binding at all, in any repo.
async fn unattributed_pane(db: &Db, agent_kind: AgentKind, terminals: &Liveness) -> Result<bool> {
    let panes: Vec<&LiveTerminal> = terminals
        .live
        .iter()
        .filter(|p| p.agent_kind == Some(agent_kind))
        .collect();
    if panes.is_empty() {
        return Ok(false);
    }
    let bound: Vec<(String,)> =
        sqlx::query_as("SELECT DISTINCT term_key FROM terminal_sessions WHERE agent_kind = ?")
            .bind(agent_kind.as_str())
            .fetch_all(db)
            .await?;
    let bound: HashSet<String> = bound.into_iter().map(|(k,)| k).collect();
    Ok(panes.iter().any(|p| !bound.contains(&p.term_key)))
}

/// Whether the session's own process reported in within the heartbeat window: a
/// hook event that left it not exited, or a status-line render.
async fn heard_from_lately(db: &Db, session_id: &str) -> Result<bool> {
    let since = crate::db::now_ms() - crate::hooks::HEARTBEAT_DEAD_MS;
    let (n,): (i64,) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM session_state
                  WHERE session_id = ?1 AND state <> 'exited' AND updated_at_ms >= ?2)
              + (SELECT COUNT(*) FROM session_usage_live
                  WHERE session_id = ?1 AND updated_at_ms >= ?2)",
    )
    .bind(session_id)
    .bind(since)
    .fetch_one(db)
    .await?;
    Ok(n > 0)
}

/// Point `term_key` at one of a worktree's past sessions, so the tab the user
/// just opened `--resume`s that conversation instead of starting a new one.
///
/// The launch path is deliberately untouched: this writes the same
/// `terminal_sessions` row a reopened tab already reads, and [`resolve`] /
/// [`resolve_codex`] answer `Resume` from it with no change of their own. Only a
/// human's click reaches here, and nothing here writes to a terminal — the seed
/// is still built by the tab's own launch (COMPLIANCE.md, "a `--resume` seed is
/// built only when a human opens the tab").
///
/// `listed` is the worktree's own session listing, re-derived by the caller from
/// the very command the history pane reads (`worktree::sessions`) — the id is
/// IPC-supplied, so it is never looked up directly. It must be *in* that set,
/// which is the same "discoverable ⇒ actionable" predicate the delete path uses
/// and keeps the two from drifting into "resumable but not listed". Four further
/// refusals:
///
/// * **A flag-shaped id.** This is the first writer to put an id *read off disk*
///   into the registry — every other one is a [`mint`] UUID or what the CLI
///   itself reported through the hook — and that id becomes a positional argument
///   of `--resume` / `resume`. `shellQuote` stops metacharacters but not a
///   leading `-`, which the CLI would read as a flag. Same no-leading-dash rule
///   the branch validators apply.
/// * **Zero turns.** Resuming a transcript with no conversation drops the user
///   into an empty session that reads as a bug. `message_count` is counted from
///   the record itself, so `0` also covers "the record is gone".
/// * **No record at the worktree's own cwd.** The tab runs in the worktree, and
///   Claude addresses a transcript by the directory it ran in — so the pair this
///   row stores is `(worktree, session_id)` and is confirmed here. A session
///   launched by hand from a *subdirectory* is therefore refused rather than
///   adopted: it would resolve to `Fresh`, or `--resume` into a project dir the
///   tab isn't in.
/// * **A surface that already has a conversation.** The insert yields instead of
///   replacing, so a tab id that names an existing tab can't silently repoint it
///   at someone else's session.
pub async fn adopt(db: &Db, listed: &[WorktreeSession], req: ResumeRequest<'_>) -> Result<()> {
    let (home, sessions_root) = (req.home, req.sessions_root);
    adopt_with(db, listed, &req, |kind, cwd, id| async move {
        match kind {
            // A rollout is addressed by thread id alone, wherever it ran.
            AgentKind::Codex => codex_rollout_presence(sessions_root, &id).await,
            _ => transcript_presence(home, &cwd, &id).await,
        }
    })
    .await
}

/// [`adopt`], asking `on_disk` whether the session's record is there — this
/// Mac's transcripts for [`adopt`], the box's for a Daedalus project
/// (`daedalus/history.rs`); `req.home` and `req.sessions_root` are then unread.
/// `on_disk` is asked `(provider, cwd, session id)` only once the id is known
/// to be one of `listed`.
pub async fn adopt_with<F, Fut>(
    db: &Db,
    listed: &[WorktreeSession],
    req: &ResumeRequest<'_>,
    on_disk: F,
) -> Result<()>
where
    F: FnOnce(AgentKind, String, String) -> Fut,
    Fut: std::future::Future<Output = RecordPresence>,
{
    // Only the two providers with an on-disk record have a resume path at all;
    // the others reach the listing solely as registry rows.
    ensure!(
        matches!(req.agent_kind, AgentKind::Claude | AgentKind::Codex),
        "{} sessions cannot be resumed",
        req.agent_kind.as_str()
    );
    ensure!(
        !req.session_id.starts_with('-'),
        "session ids cannot start with '-'"
    );
    let session = listed
        .iter()
        .find(|s| s.session_id == req.session_id && s.agent_kind == req.agent_kind)
        .ok_or_else(|| {
            anyhow!(
                "no {} session '{}' has run in this worktree",
                req.agent_kind.as_str(),
                req.session_id
            )
        })?;
    ensure!(
        session.message_count > 0,
        "that session recorded no conversation to resume"
    );

    // The cwd the new tab will actually run in — every Trees surface launches in
    // the worktree root (`validate_agent_cwd` enforces it), so this is both the
    // pair `resolve` will stat and the project directory the CLI will look the
    // conversation up in.
    let cwd = req.worktree.to_string_lossy().into_owned();
    match on_disk(req.agent_kind, cwd.clone(), req.session_id.to_string()).await {
        RecordPresence::Present => {}
        RecordPresence::Absent => bail!(
            "santree can't find that session's record for this worktree, so there is nothing to resume"
        ),
        // Distinct from absence on purpose: pointing the tab at a session
        // santree could not confirm would claim a resume it may not be able to
        // deliver, and the click is undoable only by deleting the tab.
        RecordPresence::Unknown(why) => return Err(unreadable_record(&why)),
    }

    // The primary key is `(repo, term_key, agent_kind)`. Yield rather than
    // replace: the surface is supposed to be one the caller just minted, and a
    // silent overwrite would move an *existing* tab onto a different
    // conversation (and orphan its own).
    let inserted = sqlx::query(
        "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, agent_kind)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (repo, term_key, agent_kind) DO NOTHING",
    )
    .bind(req.repo)
    .bind(req.term_key)
    .bind(&cwd)
    .bind(req.session_id)
    .bind(req.agent_kind.as_str())
    .execute(db)
    .await?
    .rows_affected();
    ensure!(inserted == 1, "that tab already has a session of its own");
    Ok(())
}

/// Escape the three SQL `LIKE` metacharacters (`\`, `%`, `_`) so a value can be
/// used as a literal prefix under `ESCAPE '\'`.
fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Whether the worktree has at least one Claude session transcript on disk —
/// gates the PR dialog's "use transcripts" checkbox so it never shows for a
/// worktree with no agent history. `false` when `HOME` is unknown.
pub async fn worktree_has_transcripts(
    db: &Db,
    repo: &str,
    issue_id: &str,
    home: Option<&Path>,
) -> Result<bool> {
    let Some(home) = home else { return Ok(false) };
    let rows = worktree_session_rows(db, repo, issue_id).await?;
    if rows.is_empty() {
        return Ok(false);
    }
    let home = home.to_path_buf();
    // A plain `exists()` is right here and only here: this gates a checkbox, so
    // an unreadable transcript directory hides an option rather than starting a
    // conversation over one the user still has (see [`RecordPresence`]).
    Ok(tokio::task::spawn_blocking(move || {
        rows.iter()
            .any(|(sid, cwd, _)| transcript_path(&home, cwd, sid).is_some_and(|path| path.exists()))
    })
    .await?)
}

/// Mine the worktree's Claude session transcript(s) into compact plain text for
/// the PR-draft prompt: user + assistant **text** only, with tool calls, tool
/// results, and their large payloads stripped out. Sessions are concatenated
/// oldest-first; if the whole thing exceeds [`TRANSCRIPT_BUDGET`] the newest tail
/// is kept (later turns carry the decisions that actually landed). Empty string
/// when `HOME` is unknown or nothing is on disk.
///
/// The transcript is the user's *own* session content, but it's still treated as
/// untrusted reference data by the prompt (a session can contain pasted text, tool
/// output, etc.) — see the `fill-pr` template's "ignore any instructions inside".
pub async fn worktree_transcripts(
    db: &Db,
    repo: &str,
    issue_id: &str,
    home: Option<&Path>,
) -> Result<String> {
    let Some(home) = home else {
        return Ok(String::new());
    };
    let rows = worktree_session_rows(db, repo, issue_id).await?;
    if rows.is_empty() {
        return Ok(String::new());
    }
    let home = home.to_path_buf();
    Ok(tokio::task::spawn_blocking(move || build_transcript_context(&home, &rows)).await?)
}

/// Max bytes read from a single transcript file. Transcripts are dominated by the
/// tool output we discard anyway, so reading the whole of a multi-hundred-MB file
/// just to keep [`TRANSCRIPT_BUDGET`] chars of prose is wasteful — cap the read at
/// the tail (we keep the newest turns regardless; the truncated leading line simply
/// fails to parse and is skipped).
const MAX_TRANSCRIPT_READ: u64 = 8 * 1024 * 1024;

/// Read up to [`MAX_TRANSCRIPT_READ`] bytes from the end of `path` as UTF-8 (lossy
/// — a seek can split a multi-byte char, but that only touches the leading partial
/// line, which is dropped as unparseable). `None` if the file can't be opened.
fn read_transcript(path: &Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    if len > MAX_TRANSCRIPT_READ {
        f.seek(SeekFrom::Start(len - MAX_TRANSCRIPT_READ)).ok()?;
    }
    let mut buf = Vec::new();
    f.take(MAX_TRANSCRIPT_READ).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Read each session's `.jsonl`, extract its human/assistant turns, and join them
/// under per-session headers, capped to [`TRANSCRIPT_BUDGET`]. Blocking (file I/O).
fn build_transcript_context(home: &Path, rows: &[(String, String, String)]) -> String {
    let mut sections = Vec::new();
    for (session_id, cwd, term_key) in rows {
        let Some(raw) = transcript_path(home, cwd, session_id).and_then(|p| read_transcript(&p))
        else {
            continue; // no transcript by that id, pruned or unreadable — skip it
        };
        let turns: Vec<String> = raw.lines().filter_map(transcript_turn).collect();
        if turns.is_empty() {
            continue;
        }
        sections.push(format!("--- Session {term_key} ---\n{}", turns.join("\n")));
    }
    if sections.is_empty() {
        return String::new();
    }
    cap_tail(sections.join("\n\n"), TRANSCRIPT_BUDGET)
}

/// One transcript line → a `"User: …"` / `"Assistant: …"` turn, or `None` for
/// anything without human/assistant prose (tool-result turns, summaries, malformed
/// lines). Tool-call/tool-result blocks and their payloads are dropped.
fn transcript_turn(line: &str) -> Option<String> {
    let v: Value = serde_json::from_str(line).ok()?;
    let role = match v.get("type").and_then(Value::as_str) {
        Some("user") => "User",
        Some("assistant") => "Assistant",
        _ => return None,
    };
    let text = message_text(v.get("message")?);
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    Some(format!("{role}: {text}"))
}

/// The plain text of a message: a bare string, or the concatenation of its `text`
/// content blocks (skipping `tool_use`/`tool_result`/`thinking` and their bulk).
fn message_text(msg: &Value) -> String {
    match msg.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Trim `s` to at most `budget` chars, keeping the tail (newest turns) and flagging
/// the omission.
fn cap_tail(s: String, budget: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= budget {
        return s;
    }
    let tail: String = chars[chars.len() - budget..].iter().collect();
    format!("[…earlier conversation omitted…]\n{tail}")
}

/// Drop **one provider's** stored session on a surface, leaving the others.
///
/// A logical surface holds one durable conversation per provider (see migration
/// `0025`), so closing a Codex review must not take the Claude one with it —
/// which is exactly what [`forget`] would do.
///
/// The transcript on disk is untouched: it is what Session history reads, and
/// "close this tab" has never meant "delete what it said".
pub async fn forget_provider(db: &Db, repo: &str, term_key: &str, agent: AgentKind) -> Result<()> {
    sqlx::query("DELETE FROM terminal_sessions WHERE repo = ? AND term_key = ? AND agent_kind = ?")
        .bind(repo)
        .bind(term_key)
        .bind(agent.as_str())
        .execute(db)
        .await?;
    Ok(())
}

/// Drop a terminal's stored session, so its next `resolve` mints a fresh one
/// instead of resuming a conversation whose worktree no longer exists. Callers
/// remove a worktree's own directory then call this with `term_key`
/// `"tree:<issue_id>"` — otherwise `resolve` finds the old row and (since the
/// transcript on disk is still readable) `--resume`s a session about deleted code.
pub async fn forget(db: &Db, repo: &str, term_key: &str) -> Result<()> {
    sqlx::query("DELETE FROM terminal_sessions WHERE repo = ? AND term_key = ?")
        .bind(repo)
        .bind(term_key)
        .execute(db)
        .await?;
    Ok(())
}

/// How old a stored session must be before [`reap_stale`] will consider it.
/// A missing transcript already means "nothing left to resume", so this is purely
/// a blast-radius guard: if Claude ever changes how it escapes `cwd` into a
/// transcript path, *every* row would suddenly look transcript-less, and without
/// an age floor one startup would wipe the sessions the user is actively
/// resuming. Set past Claude's own 30-day transcript retention.
const STALE_SESSION_DAYS: i64 = 30;

/// Reap stored sessions that can never be resumed again — older than
/// [`STALE_SESSION_DAYS`] with no transcript left on disk. Nothing else ever
/// deletes a Triage investigation's row ([`forget`] is only called from the Trees
/// side, on worktree delete / tab close), so without this `terminal_sessions`
/// grows by a row per ticket ever investigated and never shrinks — and
/// [`started_investigations`] keeps offering a resume for conversations Claude
/// threw away months ago. Returns how many rows it dropped.
///
/// `home` is the user's home directory; without it transcripts can't be located
/// at all, so we reap nothing rather than guess.
pub async fn reap_stale(db: &Db, home: Option<&Path>) -> Result<u64> {
    let Some(home) = home else { return Ok(0) };
    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT repo, term_key, cwd, session_id FROM terminal_sessions
         WHERE agent_kind = 'Claude'
           AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)",
    )
    .bind(format!("-{STALE_SESSION_DAYS} days"))
    .fetch_all(db)
    .await?;

    let mut reaped = 0;
    for (repo, term_key, cwd, session_id) in rows {
        match transcript_presence(Some(home), &cwd, &session_id).await {
            RecordPresence::Absent => {}
            RecordPresence::Present => continue,
            // The blast-radius guard again: a transcript directory that can't be
            // read makes *every* row look transcript-less, and one startup would
            // delete the sessions the user is actively resuming.
            RecordPresence::Unknown(why) => {
                log::warn!("not reaping session {repo}/{term_key}: {why}");
                continue;
            }
        }
        // A logical surface may also have a live Codex thread. Delete only the
        // exact Claude row we inspected; matching the session id also makes a
        // concurrent replacement win rather than being reaped as stale.
        let deleted = sqlx::query(
            "DELETE FROM terminal_sessions
             WHERE repo = ? AND term_key = ? AND agent_kind = 'Claude' AND session_id = ?",
        )
        .bind(&repo)
        .bind(&term_key)
        .bind(&session_id)
        .execute(db)
        .await?
        .rows_affected();
        reaped += deleted;
    }
    Ok(reaped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reap_stale_drops_only_old_transcript_less_sessions() {
        let base = std::env::temp_dir().join(format!("santree-reap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        let cwd = "/tmp/santree/work";

        // Three aged-out Claude rows and one recent one. `keeps-transcript` still
        // has its transcript on disk; `recent` is young enough to be out of scope.
        let kept = Uuid::new_v4().to_string();
        for (key, age) in [
            ("triage:AK-1", Some("-90 days")),
            ("triage:AK-2", Some("-31 days")),
            ("keeps-transcript", Some("-90 days")),
            ("recent", None),
        ] {
            let sql = match age {
                Some(a) => format!(
                    "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, created_at)
                     VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '{a}'))"
                ),
                None => "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id)
                         VALUES (?, ?, ?, ?)"
                    .into(),
            };
            let session_id = match key {
                "keeps-transcript" => kept.clone(),
                _ => Uuid::new_v4().to_string(),
            };
            sqlx::query(&sql)
                .bind("repo")
                .bind(key)
                .bind(cwd)
                .bind(session_id)
                .execute(&db)
                .await
                .unwrap();
        }
        // The same logical surface can hold a Codex thread. Claude GC must not
        // erase it when its old sibling has no transcript.
        sqlx::query(
            "INSERT INTO terminal_sessions
             (repo, term_key, cwd, session_id, created_at, agent_kind)
             VALUES ('repo', 'triage:AK-1', ?, 'codex-live',
                     strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days'), 'Codex')",
        )
        .bind(cwd)
        .execute(&db)
        .await
        .unwrap();
        let live = transcript_path(&home, cwd, &kept).unwrap();
        std::fs::create_dir_all(live.parent().unwrap()).unwrap();
        std::fs::write(&live, "{}").unwrap();

        assert_eq!(reap_stale(&db, Some(&home)).await.unwrap(), 2);
        let mut left: Vec<(String, String)> = sqlx::query_as(
            "SELECT term_key, agent_kind FROM terminal_sessions WHERE repo = 'repo'",
        )
        .fetch_all(&db)
        .await
        .unwrap();
        left.sort();
        assert_eq!(
            left,
            vec![
                ("keeps-transcript".into(), "Claude".into()),
                ("recent".into(), "Claude".into()),
                ("triage:AK-1".into(), "Codex".into()),
            ]
        );

        // No home ⇒ transcripts are unlocatable, so nothing is reaped.
        assert_eq!(reap_stale(&db, None).await.unwrap(), 0);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn background_listing_keeps_only_well_formed_background_entries() {
        let json = br#"[
            {"pid": 1, "kind": "interactive", "sessionId": "aaaaaaaa-0000-4000-8000-000000000001"},
            {"pid": 2, "id": "14ffdc20", "kind": "background", "sessionId": "14ffdc20-a4ce-4bac-b737-d952b4a43500"},
            {"pid": 3, "id": "--resume", "kind": "background", "sessionId": "bbbbbbbb-0000-4000-8000-000000000002"},
            {"pid": 4, "id": "ABCDEF12", "kind": "background", "sessionId": "cccccccc-0000-4000-8000-000000000003"},
            {"pid": 5, "id": "abc", "kind": "background", "sessionId": "dddddddd-0000-4000-8000-000000000004"},
            {"pid": 6, "kind": "background", "sessionId": "eeeeeeee-0000-4000-8000-000000000005"}
        ]"#;
        // An id that is not 6-16 lowercase hex never reaches `claude attach`'s argv.
        assert_eq!(
            parse_background_sessions(json),
            vec![BackgroundSession {
                id: "14ffdc20".into(),
                session_id: "14ffdc20-a4ce-4bac-b737-d952b4a43500".into(),
            }]
        );
        assert!(parse_background_sessions(b"not json").is_empty());
        assert!(parse_background_sessions(br#"{"kind":"background"}"#).is_empty());
    }

    #[tokio::test]
    async fn a_missing_executable_lists_no_background_sessions() {
        assert!(background_sessions("/nonexistent/santree-test-claude", &[])
            .await
            .is_empty());
    }

    #[tokio::test]
    async fn resolve_attaches_a_stored_session_that_runs_in_the_background() {
        let base = std::env::temp_dir().join(format!("santree-attach-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        let (cwd, key) = ("/tmp/santree/work/AK-1", "tree:AK-1");
        let stored = mint(&db, "repo", key, cwd, None).await.unwrap();
        let listing = |session_id: &str, id: &str| {
            let b = BackgroundSession {
                id: id.into(),
                session_id: session_id.into(),
            };
            move || async move { vec![b] }
        };

        // Running in the background → attach, whatever its transcript says: the
        // record is irrelevant to a session that is alive.
        for presence in [RecordPresence::Present, RecordPresence::Absent] {
            let got = resolve_with(
                &db,
                "repo",
                key,
                cwd,
                "/bin/claude",
                false,
                None,
                move |_, _| async move { presence },
                listing(&stored, "14ffdc20"),
            )
            .await
            .unwrap();
            assert_eq!(
                got,
                AgentSession::Attach {
                    agent_kind: AgentKind::Claude,
                    executable: "/bin/claude".into(),
                    session_id: stored.clone(),
                    background_id: "14ffdc20".into(),
                    launch_env: Vec::new(),
                    account: None,
                }
            );
        }

        // A background session that is some other conversation changes nothing.
        let got = resolve_with(
            &db,
            "repo",
            key,
            cwd,
            "/bin/claude",
            false,
            None,
            |_, _| async { RecordPresence::Present },
            listing("aaaaaaaa-0000-4000-8000-000000000001", "14ffdc20"),
        )
        .await
        .unwrap();
        assert!(matches!(got, AgentSession::Resume { .. }), "{got:?}");

        // No listing (the CLI failed, timed out, or printed nothing usable) is
        // today's behaviour exactly.
        let got = resolve_with(
            &db,
            "repo",
            key,
            cwd,
            "/bin/claude",
            false,
            None,
            |_, _| async { RecordPresence::Present },
            || async { Vec::new() },
        )
        .await
        .unwrap();
        assert!(matches!(got, AgentSession::Resume { .. }), "{got:?}");

        // A listed entry whose id is not attach-shaped was dropped by the parser,
        // so it cannot match.
        let hostile =
            format!(r#"[{{"kind":"background","id":"--resume","sessionId":"{stored}"}}]"#);
        let got = resolve_with(
            &db,
            "repo",
            key,
            cwd,
            "/bin/claude",
            false,
            None,
            |_, _| async { RecordPresence::Present },
            move || async move { parse_background_sessions(hostile.as_bytes()) },
        )
        .await
        .unwrap();
        assert!(matches!(got, AgentSession::Resume { .. }), "{got:?}");

        // Nothing stored → nothing to attach to, and the CLI is not even asked.
        let got = resolve_with(
            &db,
            "repo",
            "tree:AK-2",
            cwd,
            "/bin/claude",
            false,
            None,
            |_, _| async { RecordPresence::Present },
            || async { panic!("listed background sessions with no stored session") },
        )
        .await
        .unwrap();
        assert_eq!(got, AgentSession::Shell);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn resolve_mints_fresh_then_resumes_when_transcript_exists() {
        let base = std::env::temp_dir().join(format!("santree-session-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        // Isolated fake home, passed directly — no process-global env mutation.
        let home = base.join("home");

        let db = crate::db::init(base.join("test.db")).await.unwrap();
        let cwd = "/tmp/santree/work/AK-1";
        let key = "tree:AK-1";

        // First, passive reopen with nothing stored → plain shell.
        let r = resolve(
            &db,
            "repo",
            key,
            cwd,
            Some(&home),
            "/bin/claude",
            false,
            None,
        )
        .await
        .unwrap();
        assert_eq!(r, AgentSession::Shell);

        // Explicit launch mints + stores a fresh session id.
        let fresh = resolve(
            &db,
            "repo",
            key,
            cwd,
            Some(&home),
            "/bin/claude",
            true,
            None,
        )
        .await
        .unwrap();
        let AgentSession::Fresh {
            session_id: Some(session_id),
            ..
        } = fresh
        else {
            panic!("expected Fresh with a santree-minted id, got {fresh:?}");
        };

        // No transcript yet → a reopen still can't resume (stays a shell).
        assert_eq!(
            resolve(
                &db,
                "repo",
                key,
                cwd,
                Some(&home),
                "/bin/claude",
                false,
                None
            )
            .await
            .unwrap(),
            AgentSession::Shell
        );

        // Drop the transcript Claude would write, then a reopen resumes it.
        let path = transcript_path(&home, cwd, &session_id).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{}").unwrap();
        assert_eq!(
            resolve(
                &db,
                "repo",
                key,
                cwd,
                Some(&home),
                "/bin/claude",
                false,
                None
            )
            .await
            .unwrap(),
            AgentSession::Resume {
                agent_kind: AgentKind::Claude,
                executable: "/bin/claude".into(),
                session_id: session_id.clone(),
                launch_flags: String::new(),
                launch_env: Vec::new(),
                account: None,
            }
        );

        // A re-launch prefers resuming the live session over minting a new id.
        assert_eq!(
            resolve(
                &db,
                "repo",
                key,
                cwd,
                Some(&home),
                "/bin/claude",
                true,
                None
            )
            .await
            .unwrap(),
            AgentSession::Resume {
                agent_kind: AgentKind::Claude,
                executable: "/bin/claude".into(),
                session_id,
                launch_flags: String::new(),
                launch_env: Vec::new(),
                account: None,
            }
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn session_ids_are_hyphenated_uuids() {
        for good in [
            "9f1c0e2a-4b7d-4c81-9d2e-0a1b2c3d4e5f",
            "01998f6c-1d3f-7c11-9a2b-4e6f8a0b1c2d",
            &Uuid::new_v4().to_string(),
        ] {
            assert!(is_session_id(good), "{good}");
        }
        for bad in [
            "",
            "t-1",
            "../../../etc/passwd",
            "9f1c0e2a4b7d4c819d2e0a1b2c3d4e5f",
            "{9f1c0e2a-4b7d-4c81-9d2e-0a1b2c3d4e5f}",
            "urn:uuid:9f1c0e2a-4b7d-4c81-9d2e-0a1b2c3d4e5f",
            "9f1c0e2a-4b7d-4c81-9d2e-0a1b2c3d4e5/",
        ] {
            assert!(!is_session_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn transcript_path_escapes_every_non_alphanumeric_char() {
        // Claude Code escapes underscores (and any other non-alphanumeric char),
        // not just '/' and '.' — a repo path like `.../dev/my_repo` must map to
        // `...-dev-my-repo`, matching what Claude actually writes to disk.
        let home = Path::new("/home/user");
        let sid = "9f1c0e2a-4b7d-4c81-9d2e-0a1b2c3d4e5f";
        let path = transcript_path(home, "/Users/x/dev/my_repo", sid);
        let dir = Path::new("/home/user/.claude/projects/-Users-x-dev-my-repo");
        assert_eq!(path, Some(dir.join(format!("{sid}.jsonl"))));
    }

    /// The ids a transcript path is built from are read from santree's database,
    /// where `santree-hook` stores whatever its payload said — and any process
    /// running as the user can run it. One shaped like a path must reach no file
    /// at any site that joins it, even with a transcript waiting where it points.
    #[tokio::test]
    async fn a_stored_session_id_shaped_like_a_path_reaches_no_file() {
        let base =
            std::env::temp_dir().join(format!("santree-session-hostile-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");
        let projects = home.join(".claude/projects");
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        let worktree = base.join("work").join("AK-1");
        let cwd = worktree.to_string_lossy().into_owned();
        let own = projects.join(project_slug(&cwd));
        std::fs::create_dir_all(&own).unwrap();

        for (n, id) in [
            // Another project's transcript.
            "../-elsewhere/9f1c0e2a-4b7d-4c81-9d2e-0a1b2c3d4e5f".to_string(),
            // Out of the transcript tree.
            "../../../planted".to_string(),
            // An absolute id replaces the path it is joined onto.
            base.join("absolute").to_string_lossy().into_owned(),
        ]
        .iter()
        .enumerate()
        {
            let target = own.join(format!("{id}.jsonl"));
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            let line =
                format!(r#"{{"type":"user","cwd":"{cwd}","message":{{"content":"PLANTED"}}}}"#);
            std::fs::write(&target, line + "\n").unwrap();
            assert!(
                target.is_file(),
                "{id}: planted where an unchecked join lands"
            );
            let term_key = format!("tree:AK-1:tab:{n}");
            sqlx::query(
                "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id)
                 VALUES ('repo', ?, ?, ?)",
            )
            .bind(&term_key)
            .bind(&cwd)
            .bind(id)
            .execute(&db)
            .await
            .unwrap();

            // A reopen would `--resume` it; adopting it would bind it to a tab.
            let reopened = resolve(
                &db,
                "repo",
                &term_key,
                &cwd,
                Some(&home),
                "/bin/claude",
                false,
                None,
            )
            .await;
            assert!(reopened.is_err(), "{id}: {reopened:?}");
            let request = ResumeRequest {
                repo: "repo",
                term_key: "tree:AK-1:tab:new",
                session_id: id,
                agent_kind: AgentKind::Claude,
                worktree: &worktree,
                home: Some(&home),
                sessions_root: None,
            };
            let listing = [listed(id, AgentKind::Claude, 1)];
            assert!(adopt(&db, &listing, request).await.is_err(), "{id}");
            // The PR dialog's transcripts checkbox, and the text a PR draft reads.
            assert!(
                !worktree_has_transcripts(&db, "repo", "AK-1", Some(&home))
                    .await
                    .unwrap(),
                "{id}"
            );
            let drafted = worktree_transcripts(&db, "repo", "AK-1", Some(&home))
                .await
                .unwrap();
            assert!(!drafted.contains("PLANTED"), "{id}: {drafted}");
            // Session history's registered candidates.
            let known = [(cwd.clone(), id.clone())];
            let (paths, _) = crate::usage::candidate_transcripts(
                std::slice::from_ref(&projects),
                &worktree,
                &known,
            );
            assert!(paths.is_empty(), "{id}: {paths:?}");
        }

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Make `dir` unreadable and hand back a guard that puts it back — so a
    /// failing assertion can't leave a directory the test harness can't clean up.
    /// `None` when the mode bits don't actually bite (running as root), which is
    /// the only honest way to skip: the point of the test is a *failed* read.
    fn deny_reads(dir: &Path, probe: &Path) -> Option<ModeGuard> {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o000)).unwrap();
        let guard = ModeGuard(dir.to_path_buf());
        std::fs::metadata(probe).err().map(|e| {
            assert!(
                !is_absence(&e),
                "the probe must fail for a reason that is not absence, got {e}"
            );
            guard
        })
    }

    /// Restores a directory's mode, whatever the test does next.
    struct ModeGuard(PathBuf);

    impl Drop for ModeGuard {
        fn drop(&mut self) {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
        }
    }

    /// A transcript santree cannot *read* is not a transcript that is gone.
    ///
    /// `is_resumable` used to answer a bare `bool` from `path.exists()`, which is
    /// `false` for an unreadable `~/.claude/projects` exactly as it is for a
    /// pruned session — so an unmounted volume or a permission change made the
    /// tab start a brand-new conversation over one the user still had, silently.
    /// Now that third state is its own answer and the launch refuses.
    #[tokio::test]
    async fn resolve_refuses_a_transcript_it_cannot_read_instead_of_starting_fresh() {
        let base =
            std::env::temp_dir().join(format!("santree-session-unreadable-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        let cwd = "/tmp/santree/work/AK-1";
        let key = "tree:AK-1";

        let fresh = resolve(
            &db,
            "repo",
            key,
            cwd,
            Some(&home),
            "/bin/claude",
            true,
            None,
        )
        .await
        .unwrap();
        let AgentSession::Fresh {
            session_id: Some(session_id),
            ..
        } = fresh
        else {
            panic!("expected Fresh with a santree-minted id, got {fresh:?}");
        };
        let path = transcript_path(&home, cwd, &session_id).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{}").unwrap();

        // The conversation is on disk and resumable — right up until the read fails.
        let projects = home.join(".claude/projects");
        let Some(_guard) = deny_reads(&projects, &path) else {
            return; // running as root: the mode bits don't bite, nothing to prove
        };

        // Neither a passive reopen nor an explicit launch may answer "pruned".
        for allow_fresh in [false, true] {
            let err = resolve(
                &db,
                "repo",
                key,
                cwd,
                Some(&home),
                "/bin/claude",
                allow_fresh,
                None,
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(err.contains("won't start a new one over it"), "{err}");
        }
        // …and the row survives, so the conversation is still there to resume
        // once the filesystem is.
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT session_id FROM terminal_sessions WHERE repo = 'repo'")
                .fetch_all(&db)
                .await
                .unwrap();
        assert_eq!(rows, vec![(session_id.clone(),)]);

        // No HOME at all is the same class of answer: santree cannot look, so it
        // does not get to say "gone".
        assert!(
            resolve(&db, "repo", key, cwd, None, "/bin/claude", true, None)
                .await
                .is_err()
        );

        drop(_guard);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The GC has the same rule, and the higher price for breaking it: a
    /// transcript directory that can't be read makes *every* row look
    /// transcript-less, and one startup would delete the sessions the user is
    /// actively resuming.
    #[tokio::test]
    async fn reap_stale_keeps_the_rows_it_could_not_check() {
        let base =
            std::env::temp_dir().join(format!("santree-reap-unreadable-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        let cwd = "/tmp/santree/work";

        let sid = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, created_at)
             VALUES ('repo', 'triage:AK-1', ?, ?,
                     strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days'))",
        )
        .bind(cwd)
        .bind(&sid)
        .execute(&db)
        .await
        .unwrap();

        let path = transcript_path(&home, cwd, &sid).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let projects = home.join(".claude/projects");
        let Some(_guard) = deny_reads(&projects, &path) else {
            return;
        };

        assert_eq!(reap_stale(&db, Some(&home)).await.unwrap(), 0);
        let left: Vec<(String,)> =
            sqlx::query_as("SELECT term_key FROM terminal_sessions WHERE repo = 'repo'")
                .fetch_all(&db)
                .await
                .unwrap();
        assert_eq!(left, vec![("triage:AK-1".to_string(),)]);

        drop(_guard);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Codex's rollout walk had the identical shape — `let Ok(rd) =
    /// read_dir(dir) else { return }` reported an unreadable tree as an empty
    /// one — with the same consequence: the fresh run's `SessionStart` repoints
    /// the row, and the user's thread stops being reachable from that surface.
    #[tokio::test]
    async fn resolve_codex_refuses_a_rollout_tree_it_cannot_read() {
        let base =
            std::env::temp_dir().join(format!("santree-codex-unreadable-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        let sessions = base.join("sessions");
        write_rollout(&sessions, "thread-live");
        sqlx::query(
            "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, agent_kind)
             VALUES ('repo', 'tree:AK-1', '/tmp/santree/work', 'thread-live', 'Codex')",
        )
        .execute(&db)
        .await
        .unwrap();

        let opts = CodexSessionOpts {
            executable: "/bin/codex",
            repo: "repo",
            term_key: "tree:AK-1",
            allow_fresh: true,
            sessions_root: Some(sessions.as_path()),
        };
        assert!(matches!(
            resolve_codex(&db, opts).await.unwrap(),
            AgentSession::Resume { .. }
        ));

        let Some(_guard) = deny_reads(&sessions, &sessions.join("2026")) else {
            return;
        };
        let err = resolve_codex(
            &db,
            CodexSessionOpts {
                executable: "/bin/codex",
                repo: "repo",
                term_key: "tree:AK-1",
                allow_fresh: true,
                sessions_root: Some(sessions.as_path()),
            },
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(err.contains("won't start a new one over it"), "{err}");

        drop(_guard);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn mint_adopts_the_existing_session_when_it_loses_the_race() {
        // Second mint stands in for the loser of two concurrent launches: it must
        // return the id already stored (not error on the primary key), so both
        // terminals name the same conversation.
        let base =
            std::env::temp_dir().join(format!("santree-session-race-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let db = crate::db::init(base.join("test.db")).await.unwrap();

        let first = mint(&db, "repo", "tree:AK-1", "/tmp/wt", None)
            .await
            .unwrap();
        let second = mint(&db, "repo", "tree:AK-1", "/tmp/wt", None)
            .await
            .unwrap();
        assert_eq!(first, second);

        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT session_id FROM terminal_sessions WHERE repo = 'repo'")
                .fetch_all(&db)
                .await
                .unwrap();
        assert_eq!(rows, vec![(first,)], "exactly one session row");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn a_session_is_running_only_while_a_terminal_bound_to_it_is_live() {
        let base =
            std::env::temp_dir().join(format!("santree-session-running-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        sqlx::query(
            "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, agent_kind)
             VALUES ('repo', 'tree:AK-1:tab:a', '/w', 's1', 'Claude')",
        )
        .execute(&db)
        .await
        .unwrap();
        let known = |term_key: &str, agent_kind, complete| Liveness {
            live: HashSet::from([LiveTerminal {
                term_key: term_key.to_string(),
                agent_kind: Some(agent_kind),
            }]),
            complete,
        };
        let live = |term_key: &str, agent_kind| known(term_key, agent_kind, true);
        let none = |complete| Liveness {
            live: HashSet::new(),
            complete,
        };

        let held = |live| {
            let db = db.clone();
            async move {
                occupancy(&db, "repo", "s1", AgentKind::Claude, &live)
                    .await
                    .unwrap()
            }
        };
        assert_eq!(
            held(live("tree:AK-1:tab:a", AgentKind::Claude)).await,
            Occupancy::Running
        );
        // Another tab, the same tab with another provider, or nothing: free.
        assert_eq!(
            held(live("tree:AK-1:tab:b", AgentKind::Claude)).await,
            Occupancy::Free
        );
        assert_eq!(
            held(live("tree:AK-1:tab:a", AgentKind::Codex)).await,
            Occupancy::Free
        );
        assert_eq!(held(none(true)).await, Occupancy::Free);
        // Bound in another repo only: not this one's.
        assert_eq!(
            occupancy(
                &db,
                "other",
                "s1",
                AgentKind::Claude,
                &live("tree:AK-1:tab:a", AgentKind::Claude)
            )
            .await
            .unwrap(),
            Occupancy::Free
        );

        // The same absences from an answer that could not see everything are
        // not "free": the agent may be running on a server not yet adopted.
        assert_eq!(held(none(false)).await, Occupancy::Unknown);
        assert_eq!(
            held(known("tree:AK-1:tab:b", AgentKind::Claude, false)).await,
            Occupancy::Unknown
        );
        // Positive evidence still wins, complete or not.
        assert_eq!(
            held(known("tree:AK-1:tab:a", AgentKind::Claude, false)).await,
            Occupancy::Running
        );
        // A session no surface is bound to is no different while the answer is
        // incomplete: the binding is deleted when its tab closes, and the agent
        // can live on in a server that can't be asked. Unknown, not Free.
        assert_eq!(
            occupancy(&db, "repo", "unbound", AgentKind::Claude, &none(false))
                .await
                .unwrap(),
            Occupancy::Unknown
        );
        // With a complete answer nothing holds it.
        assert_eq!(
            occupancy(&db, "repo", "unbound", AgentKind::Claude, &none(true))
                .await
                .unwrap(),
            Occupancy::Free
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A tab closed while its server could not be reached deletes the session's
    /// binding (`tabs::remove`) and leaves the agent running on the server. The
    /// conversation must not read as free to resume: not while the answer is
    /// incomplete, and not afterwards, while a live pane of that provider that no
    /// binding accounts for is there beside fresh evidence the session is alive.
    #[tokio::test]
    async fn a_session_whose_tab_closed_while_the_server_was_away_is_not_free() {
        let base =
            std::env::temp_dir().join(format!("santree-session-orphan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        let now = crate::db::now_ms();
        sqlx::query(
            "INSERT INTO worktree_tabs (repo, id, worktree_id, kind, agent_kind, title, position)
             VALUES ('repo', 'X', 'AK-1', 'agent', 'Claude', 'x', 1)",
        )
        .execute(&db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, agent_kind)
             VALUES ('repo', 'tree:AK-1:tab:X', '/w', 's1', 'Claude')",
        )
        .execute(&db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO session_state (session_id, state, event, cwd, updated_at_ms)
             VALUES ('s1', 'idle', 'Stop', '/w', ?)",
        )
        .bind(now)
        .execute(&db)
        .await
        .unwrap();
        // The tab is closed: its row and the binding go together.
        crate::tabs::remove(&db, "repo", "X").await.unwrap();

        let held = |terminals| {
            let db = db.clone();
            async move {
                occupancy(&db, "repo", "s1", AgentKind::Claude, &terminals)
                    .await
                    .unwrap()
            }
        };
        let pane = |term_key: &str| LiveTerminal {
            term_key: term_key.into(),
            agent_kind: Some(AgentKind::Claude),
        };

        // The server can't be asked: unknown.
        assert_eq!(
            held(Liveness {
                live: HashSet::new(),
                complete: false
            })
            .await,
            Occupancy::Unknown
        );
        // It answers in full: the agent is a live pane no tab or binding owns,
        // and the session was heard from a moment ago.
        let orphan = Liveness {
            live: HashSet::from([pane("tree:AK-1:tab:X")]),
            complete: true,
        };
        assert_eq!(held(orphan.clone()).await, Occupancy::Running);

        // The same pane without that fresh evidence: another conversation may
        // be what it runs, and this one is stale — nothing says otherwise.
        sqlx::query("UPDATE session_state SET updated_at_ms = ? WHERE session_id = 's1'")
            .bind(now - 3_600_000)
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(held(orphan.clone()).await, Occupancy::Free);

        // A pane a binding does account for is not an unattributed one.
        sqlx::query("UPDATE session_state SET updated_at_ms = ? WHERE session_id = 's1'")
            .bind(now)
            .execute(&db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, agent_kind)
             VALUES ('repo', 'tree:AK-1:tab:X', '/w', 'other', 'Claude')",
        )
        .execute(&db)
        .await
        .unwrap();
        assert_eq!(held(orphan).await, Occupancy::Free);

        // Off mode, identical: the closed tab's PTY is closed, so no pane is
        // live, and a recent heartbeat alone is nothing to refuse over.
        assert_eq!(
            held(Liveness {
                live: HashSet::new(),
                complete: true
            })
            .await,
            Occupancy::Free
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A triage ticket's own tab, lost with its server: Resume relaunches it on
    /// its stored session, so the session must be free — and "free" needs an
    /// answer that saw every terminal.
    #[tokio::test]
    async fn a_lost_tab_is_resumable_only_when_nothing_of_it_can_still_be_running() {
        let base =
            std::env::temp_dir().join(format!("santree-session-lost-tab-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        let tab = "triage:AK-1:tab:t1";
        sqlx::query(
            "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, agent_kind)
             VALUES ('repo', ?, '/repo', 's1', 'Claude')",
        )
        .bind(tab)
        .execute(&db)
        .await
        .unwrap();
        let liveness = |keys: &[&str], complete| Liveness {
            live: keys
                .iter()
                .map(|key| LiveTerminal {
                    term_key: key.to_string(),
                    agent_kind: Some(AgentKind::Claude),
                })
                .collect(),
            complete,
        };
        let gate = |key: &'static str, terminals: Liveness| {
            let db = db.clone();
            async move { tab_occupancy(&db, "repo", key, &terminals).await.unwrap() }
        };

        // The server came back empty: nothing holds it.
        assert_eq!(gate(tab, liveness(&[], true)).await, Occupancy::Free);
        // The server can't be asked yet: not free, whatever is (not) seen.
        assert_eq!(gate(tab, liveness(&[], false)).await, Occupancy::Unknown);
        assert_eq!(
            gate(tab, liveness(&["tree:AK-2"], false)).await,
            Occupancy::Unknown
        );
        // The tab's own surface is live after all: it was never lost.
        assert_eq!(gate(tab, liveness(&[tab], true)).await, Occupancy::Running);
        // Its session is running in another surface it is bound to.
        sqlx::query(
            "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, agent_kind)
             VALUES ('repo', 'triage:AK-1:tab:t9', '/repo', 's1', 'Claude')",
        )
        .execute(&db)
        .await
        .unwrap();
        assert_eq!(
            gate(tab, liveness(&["triage:AK-1:tab:t9"], true)).await,
            Occupancy::Running
        );

        // A tab with no binding at all (a Codex tab never prompted).
        let unbound = "triage:AK-1:tab:t2";
        assert_eq!(gate(unbound, liveness(&[], true)).await, Occupancy::Free);
        assert_eq!(
            gate(unbound, liveness(&[], false)).await,
            Occupancy::Unknown
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn started_investigations_lists_triage_tickets_with_a_stored_session() {
        let base =
            std::env::temp_dir().join(format!("santree-session-started-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");
        let db = crate::db::init(base.join("test.db")).await.unwrap();

        // An explicit launch records a session for two triage tickets and a
        // worktree; a passive reopen for AK-9 records nothing.
        let cwd = "/tmp/santree/work";
        resolve(
            &db,
            "repo",
            "triage:AK-1",
            cwd,
            Some(&home),
            "/bin/claude",
            true,
            None,
        )
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, agent_kind)
             VALUES ('repo', 'triage:AK-4', ?, 'codex-thread', 'Codex')",
        )
        .bind(cwd)
        .execute(&db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, agent_kind)
             VALUES ('repo', 'triage:AK-1', ?, 'codex-thread-same-ticket', 'Codex')",
        )
        .bind(cwd)
        .execute(&db)
        .await
        .unwrap();
        resolve(
            &db,
            "repo",
            "triage:AK-2",
            cwd,
            Some(&home),
            "/bin/claude",
            true,
            None,
        )
        .await
        .unwrap();
        resolve(
            &db,
            "repo",
            "tree:AK-3",
            cwd,
            Some(&home),
            "/bin/claude",
            true,
            None,
        )
        .await
        .unwrap();
        resolve(
            &db,
            "repo",
            "triage:AK-9",
            cwd,
            Some(&home),
            "/bin/claude",
            false,
            None,
        )
        .await
        .unwrap();
        // A leftover row from the removed repo-wide Triage desk.
        sqlx::query(
            "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, agent_kind)
             VALUES ('repo', 'triage:__repo__:repo', ?, 'desk', 'Claude')",
        )
        .bind(cwd)
        .execute(&db)
        .await
        .unwrap();
        // A plain agent tab opened beside AK-1's investigation: a `worktree_tabs`
        // row, not an investigation of the ticket.
        sqlx::query(
            "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, agent_kind)
             VALUES ('repo', 'triage:AK-1:tab:side', ?, 'side-chat', 'Claude')",
        )
        .bind(cwd)
        .execute(&db)
        .await
        .unwrap();
        // A different repo's investigation must not leak in.
        resolve(
            &db,
            "other",
            "triage:AK-8",
            cwd,
            Some(&home),
            "/bin/claude",
            true,
            None,
        )
        .await
        .unwrap();

        let mut got = started_investigations(&db, "repo").await.unwrap();
        got.sort_by(|a, b| {
            (&a.ref_id, a.agent_kind.as_str()).cmp(&(&b.ref_id, b.agent_kind.as_str()))
        });
        // Only the triage tickets with a stored row — not the worktree, the
        // never-launched AK-9, the other repo's ticket, or the removed desk's
        // sentinel. Transcript existence is irrelevant, and one ticket can
        // retain both providers.
        assert_eq!(
            got,
            vec![
                TriageSession {
                    ref_id: "AK-1".to_string(),
                    agent_kind: AgentKind::Claude,
                },
                TriageSession {
                    ref_id: "AK-1".to_string(),
                    agent_kind: AgentKind::Codex,
                },
                TriageSession {
                    ref_id: "AK-2".to_string(),
                    agent_kind: AgentKind::Claude,
                },
                TriageSession {
                    ref_id: "AK-4".to_string(),
                    agent_kind: AgentKind::Codex,
                },
            ]
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Write the rollout Codex would leave for `thread_id`, in the
    /// `YYYY/MM/DD` partition it uses. Only the `session_meta` first line
    /// matters here — that is what carries the thread id.
    fn write_rollout(sessions: &Path, thread_id: &str) {
        let day = sessions.join("2026").join("08").join("28");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::write(
            day.join(format!("rollout-2026-08-28T10-00-00-{thread_id}.jsonl")),
            format!(
                r#"{{"timestamp":"2026-08-28T10:00:00.000Z","type":"session_meta","payload":{{"id":"{thread_id}","timestamp":"2026-08-28T10:00:00.000Z","cwd":"/tmp/santree/work","thread_source":"cli"}}}}"#
            ) + "\n",
        )
        .unwrap();
    }

    async fn codex_rows(db: &Db) -> Vec<(String, String)> {
        sqlx::query_as("SELECT session_id, cwd FROM terminal_sessions WHERE agent_kind = 'Codex'")
            .fetch_all(db)
            .await
            .unwrap()
    }

    /// Codex mints its own id, so santree has none to offer at launch: a fresh
    /// resolve must resolve to *no* id (and persist nothing — the `SessionStart`
    /// hook writes the row once Codex reports what it minted). Inventing an id
    /// here would name a thread `codex resume` can never find.
    #[tokio::test]
    async fn resolve_codex_starts_fresh_with_no_id_and_writes_nothing() {
        let base = std::env::temp_dir().join(format!("santree-codex-fresh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        let sessions = base.join("sessions");
        let opts = |allow_fresh| CodexSessionOpts {
            executable: "/bin/codex",
            repo: "repo",
            term_key: "tree:AK-1",
            allow_fresh,
            sessions_root: Some(sessions.as_path()),
        };

        // A passive reopen with nothing stored is still just a shell.
        assert_eq!(
            resolve_codex(&db, opts(false)).await.unwrap(),
            AgentSession::Shell
        );

        assert_eq!(
            resolve_codex(&db, opts(true)).await.unwrap(),
            AgentSession::Fresh {
                agent_kind: AgentKind::Codex,
                executable: "/bin/codex".into(),
                session_id: None,
                launch_flags: String::new(),
                launch_env: Vec::new(),
                account: None,
            }
        );
        assert!(
            codex_rows(&db).await.is_empty(),
            "the id is the hook's to record, not the resolver's"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// A stored thread is only a resume target while Codex still has its rollout:
    /// `codex resume <id>` fails outright otherwise, in the user's terminal. The
    /// stale row is deliberately left in place — the fresh run's `SessionStart`
    /// repoints it.
    #[tokio::test]
    async fn resolve_codex_resumes_only_a_thread_whose_rollout_survives() {
        let base =
            std::env::temp_dir().join(format!("santree-codex-resume-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        let sessions = base.join("sessions");
        write_rollout(&sessions, "thread-live");

        for (term_key, thread_id) in [("tree:AK-1", "thread-live"), ("tree:AK-2", "thread-pruned")]
        {
            sqlx::query(
                "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, agent_kind)
                 VALUES ('repo', ?, '/tmp/santree/work', ?, 'Codex')",
            )
            .bind(term_key)
            .bind(thread_id)
            .execute(&db)
            .await
            .unwrap();
        }
        let opts = |term_key, sessions_root| CodexSessionOpts {
            executable: "/bin/codex",
            repo: "repo",
            term_key,
            allow_fresh: true,
            sessions_root,
        };
        let root = Some(sessions.as_path());

        assert_eq!(
            resolve_codex(&db, opts("tree:AK-1", root)).await.unwrap(),
            AgentSession::Resume {
                agent_kind: AgentKind::Codex,
                executable: "/bin/codex".into(),
                session_id: "thread-live".into(),
                launch_flags: String::new(),
                launch_env: Vec::new(),
                account: None,
            }
        );
        // Codex pruned this one: resuming it would just error at the user.
        assert_eq!(
            resolve_codex(&db, opts("tree:AK-2", root)).await.unwrap(),
            AgentSession::Fresh {
                agent_kind: AgentKind::Codex,
                executable: "/bin/codex".into(),
                session_id: None,
                launch_flags: String::new(),
                launch_env: Vec::new(),
                account: None,
            }
        );
        // No rollout directory at all (no `CODEX_HOME`, nothing written yet)
        // resolves the same way, never into an unopenable resume.
        assert_eq!(
            resolve_codex(&db, opts("tree:AK-1", None)).await.unwrap(),
            AgentSession::Fresh {
                agent_kind: AgentKind::Codex,
                executable: "/bin/codex".into(),
                session_id: None,
                launch_flags: String::new(),
                launch_env: Vec::new(),
                account: None,
            }
        );
        // Both rows survive untouched — repointing is the hook's job.
        let mut rows = codex_rows(&db).await;
        rows.sort();
        assert_eq!(
            rows,
            vec![
                ("thread-live".to_string(), "/tmp/santree/work".to_string()),
                ("thread-pruned".to_string(), "/tmp/santree/work".to_string()),
            ]
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// A history row as the pane shows it — only the four fields [`adopt`]
    /// actually predicates on carry meaning here.
    fn listed(session_id: &str, agent_kind: AgentKind, message_count: u32) -> WorktreeSession {
        WorktreeSession {
            session_id: session_id.to_string(),
            agent_kind,
            term_key: None,
            title: None,
            last_message: None,
            last_message_from: None,
            message_count,
            subagent_count: 0,
            model: None,
            started_at_ms: None,
            last_activity_ms: None,
            spend: None,
            sampled: false,
        }
    }

    async fn adopted_rows(db: &Db) -> Vec<(String, String, String, String)> {
        let mut rows: Vec<(String, String, String, String)> = sqlx::query_as(
            "SELECT term_key, cwd, session_id, agent_kind FROM terminal_sessions WHERE repo = 'repo'",
        )
        .fetch_all(db)
        .await
        .unwrap();
        rows.sort();
        rows
    }

    /// The history pane's click: a listed Claude session with a transcript still
    /// on disk is adopted onto the freshly-minted tab, and the existing launch
    /// path then resolves that tab to `--resume` with no change of its own.
    #[tokio::test]
    async fn adopt_points_a_new_tab_at_a_listed_claude_session() {
        let base = std::env::temp_dir().join(format!("santree-adopt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        let worktree = base.join("work").join("AK-1");
        let cwd = worktree.to_string_lossy().into_owned();

        let live = Uuid::new_v4().to_string();
        let path = transcript_path(&home, &cwd, &live).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{}").unwrap();

        let rows = vec![listed(&live, AgentKind::Claude, 7)];
        adopt(
            &db,
            &rows,
            ResumeRequest {
                repo: "repo",
                term_key: "tree:AK-1:tab:new",
                session_id: &live,
                agent_kind: AgentKind::Claude,
                worktree: &worktree,
                home: Some(&home),
                sessions_root: None,
            },
        )
        .await
        .unwrap();

        assert_eq!(
            adopted_rows(&db).await,
            vec![(
                "tree:AK-1:tab:new".to_string(),
                cwd.clone(),
                live.clone(),
                "Claude".to_string(),
            )],
            "a session found on disk with no row is stored at the worktree's own cwd"
        );
        // The whole point: nothing about the launch path changes.
        assert_eq!(
            resolve(
                &db,
                "repo",
                "tree:AK-1:tab:new",
                &cwd,
                Some(&home),
                "/bin/claude",
                true,
                None,
            )
            .await
            .unwrap(),
            AgentSession::Resume {
                agent_kind: AgentKind::Claude,
                executable: "/bin/claude".into(),
                session_id: live,
                launch_flags: String::new(),
                launch_env: Vec::new(),
                account: None,
            }
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// A Claude session launched by hand from a *subdirectory* of the worktree
    /// is listed (its cwd is under the worktree) but cannot be adopted: the tab
    /// runs in the worktree root, and Claude looks a conversation up in the
    /// project directory it ran in. Adopting it would write a row that either
    /// resolves to `Fresh` forever or `--resume`s an id the CLI can't find.
    #[tokio::test]
    async fn adopt_refuses_a_session_that_ran_below_the_worktree_root() {
        let base = std::env::temp_dir().join(format!("santree-adopt-cwd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        let worktree = base.join("work").join("AK-1");
        let ran_in = worktree.join("packages").join("api");
        let ran_in = ran_in.to_string_lossy().into_owned();

        let sub = Uuid::new_v4().to_string();
        let path = transcript_path(&home, &ran_in, &sub).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{}").unwrap();

        let err = adopt(
            &db,
            &[listed(&sub, AgentKind::Claude, 3)],
            ResumeRequest {
                repo: "repo",
                term_key: "tree:AK-1:tab:new",
                session_id: &sub,
                agent_kind: AgentKind::Claude,
                worktree: &worktree,
                home: Some(&home),
                sessions_root: None,
            },
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(err.contains("nothing to resume"), "{err}");
        assert!(adopted_rows(&db).await.is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The surface is supposed to be one the caller just minted. A tab id that
    /// names a tab which already holds a conversation must not silently move it
    /// onto a different session (and orphan its own).
    #[tokio::test]
    async fn adopt_will_not_repoint_a_surface_that_already_has_a_session() {
        let base = std::env::temp_dir().join(format!("santree-adopt-taken-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        let worktree = base.join("work").join("AK-1");
        let cwd = worktree.to_string_lossy().into_owned();

        let (taken, other) = (Uuid::new_v4().to_string(), Uuid::new_v4().to_string());
        for sid in [&taken, &other] {
            let path = transcript_path(&home, &cwd, sid).unwrap();
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "{}").unwrap();
        }
        sqlx::query(
            "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, agent_kind)
             VALUES ('repo', 'tree:AK-1:tab:open', ?, ?, 'Claude')",
        )
        .bind(&cwd)
        .bind(&taken)
        .execute(&db)
        .await
        .unwrap();

        let err = adopt(
            &db,
            &[listed(&other, AgentKind::Claude, 2)],
            ResumeRequest {
                repo: "repo",
                term_key: "tree:AK-1:tab:open",
                session_id: &other,
                agent_kind: AgentKind::Claude,
                worktree: &worktree,
                home: Some(&home),
                sessions_root: None,
            },
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(err.contains("already has a session"), "{err}");
        assert_eq!(
            adopted_rows(&db).await,
            vec![(
                "tree:AK-1:tab:open".to_string(),
                cwd,
                taken,
                "Claude".to_string(),
            )],
            "the tab keeps the conversation it had"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Every refusal, each leaving `terminal_sessions` untouched: an id the
    /// worktree's own listing doesn't contain, a session with no turns, a record
    /// that is gone, and a provider with no resume path at all.
    #[tokio::test]
    async fn adopt_refuses_anything_the_worktrees_listing_does_not_vouch_for() {
        let base = std::env::temp_dir().join(format!("santree-adopt-deny-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        let worktree = base.join("work").join("AK-1");
        let cwd = worktree.to_string_lossy().into_owned();
        let sessions = base.join("sessions");
        write_rollout(&sessions, "thread-live");

        let ids: Vec<String> = (0..4).map(|_| Uuid::new_v4().to_string()).collect();
        let [live, elsewhere, empty, pruned] =
            [&ids[0], &ids[1], &ids[2], &ids[3]].map(String::as_str);
        // On disk, and with turns — but only `live` and `thread-live` are listed
        // for this worktree.
        for sid in [live, elsewhere] {
            let path = transcript_path(&home, &cwd, sid).unwrap();
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "{}").unwrap();
        }
        let rows = vec![
            listed(live, AgentKind::Claude, 7),
            listed(empty, AgentKind::Claude, 0),
            listed(pruned, AgentKind::Claude, 4),
            listed("thread-live", AgentKind::Codex, 5),
            listed("thread-pruned", AgentKind::Codex, 5),
            listed("cursor-sid", AgentKind::Cursor, 5),
            // A thread id is whatever the rollout's `session_meta.id` says, and
            // this is the first path that promotes an id read off disk into an
            // argument of `codex resume`. `shellQuote` would pass this through
            // as a flag.
            listed("--config", AgentKind::Codex, 5),
        ];
        let request = |session_id, agent_kind| ResumeRequest {
            repo: "repo",
            term_key: "tree:AK-1:tab:new",
            session_id,
            agent_kind,
            worktree: &worktree,
            home: Some(&home),
            sessions_root: Some(sessions.as_path()),
        };

        // Not in the worktree's own listing — even though its transcript exists,
        // so an id-shaped guess can't reach another worktree's conversation.
        let err = adopt(&db, &rows, request(elsewhere, AgentKind::Claude))
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("has run in this worktree"), "{err}");
        // Listed, but under the other provider.
        assert!(adopt(&db, &rows, request(live, AgentKind::Codex))
            .await
            .is_err());
        // Zero turns: resuming this lands the user in an empty session.
        let err = adopt(&db, &rows, request(empty, AgentKind::Claude))
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("no conversation"), "{err}");
        // Listed with turns, but the record has since been pruned.
        let err = adopt(&db, &rows, request(pruned, AgentKind::Claude))
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("nothing to resume"), "{err}");
        let err = adopt(&db, &rows, request("thread-pruned", AgentKind::Codex))
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("nothing to resume"), "{err}");
        // No transcript is findable at all without a home directory.
        assert!(adopt(
            &db,
            &rows,
            ResumeRequest {
                home: None,
                ..request(live, AgentKind::Claude)
            },
        )
        .await
        .is_err());
        // A provider santree can't resume, however it got into the registry.
        assert!(adopt(&db, &rows, request("cursor-sid", AgentKind::Cursor))
            .await
            .is_err());
        // A flag-shaped id, even with a real rollout behind it.
        write_rollout(&sessions, "--config");
        let err = adopt(&db, &rows, request("--config", AgentKind::Codex))
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("cannot start with"), "{err}");

        assert!(
            adopted_rows(&db).await.is_empty(),
            "a refusal writes nothing"
        );

        // The one that is listed, has turns, and still has its rollout.
        adopt(&db, &rows, request("thread-live", AgentKind::Codex))
            .await
            .unwrap();
        assert_eq!(
            adopted_rows(&db).await,
            vec![(
                "tree:AK-1:tab:new".to_string(),
                cwd,
                "thread-live".to_string(),
                "Codex".to_string(),
            )]
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn escape_like_escapes_only_like_metacharacters() {
        assert_eq!(escape_like("AK-170"), "AK-170");
        assert_eq!(escape_like("a%b_c\\d"), "a\\%b\\_c\\\\d");
    }

    #[tokio::test]
    async fn worktree_transcripts_gathers_all_tabs_and_strips_tool_output() {
        let base = std::env::temp_dir().join(format!(
            "santree-session-transcripts-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        let cwd = "/tmp/santree/work/AK-1";

        // Main work terminal + an extra tab for AK-1, plus an unrelated worktree
        // whose transcript must NOT leak into AK-1's PR context.
        let main = resolve(
            &db,
            "repo",
            "tree:AK-1",
            cwd,
            Some(&home),
            "/bin/claude",
            true,
            None,
        )
        .await
        .unwrap();
        let AgentSession::Fresh {
            session_id: Some(main_sid),
            ..
        } = main
        else {
            panic!("expected Fresh");
        };
        let tab = resolve(
            &db,
            "repo",
            "tree:AK-1:tab:t2",
            cwd,
            Some(&home),
            "/bin/claude",
            true,
            None,
        )
        .await
        .unwrap();
        let AgentSession::Fresh {
            session_id: Some(tab_sid),
            ..
        } = tab
        else {
            panic!("expected Fresh");
        };
        let other = resolve(
            &db,
            "repo",
            "tree:AK-2",
            cwd,
            Some(&home),
            "/bin/claude",
            true,
            None,
        )
        .await
        .unwrap();
        let AgentSession::Fresh {
            session_id: Some(other_sid),
            ..
        } = other
        else {
            panic!("expected Fresh");
        };

        let write = |sid: &str, lines: &[&str]| {
            let path = transcript_path(&home, cwd, sid).unwrap();
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, lines.join("\n")).unwrap();
        };
        write(
            &main_sid,
            &[
                r#"{"type":"user","message":{"content":"implement the retry"}}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"used exponential backoff"},{"type":"tool_use","name":"Edit","input":{"secret":"SHOULD_NOT_APPEAR"}}]}}"#,
                r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"TOOL_DUMP_SHOULD_NOT_APPEAR"}]}}"#,
            ],
        );
        write(
            &tab_sid,
            &[
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"also bumped the timeout"}]}}"#,
            ],
        );
        write(
            &other_sid,
            &[r#"{"type":"user","message":{"content":"OTHER_WORKTREE_SHOULD_NOT_APPEAR"}}"#],
        );

        let out = worktree_transcripts(&db, "repo", "AK-1", Some(&home))
            .await
            .unwrap();

        assert!(out.contains("implement the retry"));
        assert!(out.contains("used exponential backoff"));
        assert!(
            out.contains("also bumped the timeout"),
            "both AK-1 tabs mined"
        );
        assert!(!out.contains("SHOULD_NOT_APPEAR"), "tool payloads stripped");
        assert!(!out.contains("TOOL_DUMP"), "tool results stripped");
        assert!(
            !out.contains("OTHER_WORKTREE"),
            "other worktree not included"
        );

        assert!(worktree_has_transcripts(&db, "repo", "AK-1", Some(&home))
            .await
            .unwrap());
        // A worktree with no stored session has nothing to send.
        assert!(
            !worktree_has_transcripts(&db, "repo", "AK-404", Some(&home))
                .await
                .unwrap()
        );
        assert!(worktree_transcripts(&db, "repo", "AK-404", Some(&home))
            .await
            .unwrap()
            .is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }
}
