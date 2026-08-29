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

use anyhow::Result;
use santree_core::domain::{
    AgentKind, AgentSession, LastMessageFrom, TriageSession, WorktreeSession,
};
use serde_json::Value;
use uuid::Uuid;

use crate::db::Db;

/// Claude stores each session's transcript at
/// `~/.claude/projects/<escaped-cwd>/<session-id>.jsonl`, escaping the working
/// directory by replacing every non-alphanumeric character with `-` (verified
/// against real transcripts, e.g. `…/canary/.santree/worktrees/AK-1` becomes
/// `…-canary--santree-worktrees-AK-1`, and `…/dev/my_repo` becomes
/// `…-dev-my-repo`).
fn transcript_path(home: &Path, cwd: &str, session_id: &str) -> PathBuf {
    home.join(".claude/projects")
        .join(project_slug(cwd))
        .join(format!("{session_id}.jsonl"))
}

/// The `projects/` directory name Claude derives from a working directory (see
/// [`transcript_path`] for the escaping, verified against real transcripts).
pub(crate) fn project_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Whether `session_id` can still be resumed for a claude run in `cwd`. The stat
/// goes to the blocking pool: `~/.claude/projects` can sit on a slow or networked
/// filesystem, and every caller here is on the async runtime.
async fn is_resumable(home: &Path, cwd: &str, session_id: &str) -> bool {
    let path = transcript_path(home, cwd, session_id);
    tokio::task::spawn_blocking(move || path.exists())
        .await
        .unwrap_or(false)
}

/// Resolve how to (re)launch claude for the logical terminal `term_key` in
/// `repo`: resume a still-on-disk session, mint a fresh one (only when
/// `allow_fresh` — i.e. an explicit launch, not a passive reopen), or leave it a
/// plain shell. A fresh launch reuses the stored id when the transcript was
/// pruned, so a later resume can still find the conversation. `home` is the
/// user's home directory (`None` when `HOME` isn't set), resolved once by the
/// caller — transcripts can never be found without it, so we just treat that
/// as "nothing resumable".
pub async fn resolve(
    db: &Db,
    repo: &str,
    term_key: &str,
    cwd: &str,
    home: Option<&Path>,
    executable: &str,
    allow_fresh: bool,
) -> Result<AgentSession> {
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
        let resumable = match home {
            Some(h) => is_resumable(h, &stored_cwd, &session_id).await,
            None => false,
        };
        if resumable {
            return Ok(AgentSession::Resume {
                agent_kind: AgentKind::Claude,
                executable: executable.to_string(),
                session_id,
                launch_flags: String::new(),
            });
        }
        return Ok(if allow_fresh {
            AgentSession::Fresh {
                agent_kind: AgentKind::Claude,
                executable: executable.to_string(),
                session_id: Some(session_id),
                launch_flags: String::new(),
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
        session_id: Some(mint(db, repo, term_key, cwd).await?),
        launch_flags: String::new(),
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
    let CodexSessionOpts {
        executable,
        repo,
        term_key,
        allow_fresh,
        sessions_root,
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
        if codex_rollout_exists(sessions_root, &thread_id).await? {
            return Ok(AgentSession::Resume {
                agent_kind: AgentKind::Codex,
                executable: executable.to_string(),
                session_id: thread_id,
                // Filled in by `CodexProvider`, which owns what a Codex session
                // runs under; the resolver only decides which thread it is.
                launch_flags: String::new(),
            });
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
    })
}

/// [`crate::codex_rollouts::rollout_exists_in`] off the async runtime — the
/// rollout directory is a real directory walk, and every caller here is on it.
async fn codex_rollout_exists(sessions_root: Option<&Path>, thread_id: &str) -> Result<bool> {
    let Some(root) = sessions_root.map(Path::to_path_buf) else {
        return Ok(false);
    };
    let thread_id = thread_id.to_string();
    Ok(tokio::task::spawn_blocking(move || {
        crate::codex_rollouts::rollout_exists_in(&root, &thread_id)
    })
    .await?)
}

/// Store a new session id for the terminal and return the id it will actually
/// run under. Two launches of the same terminal can race — both see no row and
/// mint an id — so the insert yields to whoever got there first and we re-read:
/// the loser adopts the winner's session instead of failing the primary key.
async fn mint(db: &Db, repo: &str, term_key: &str, cwd: &str) -> Result<String> {
    sqlx::query(
        "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, agent_kind) VALUES (?, ?, ?, ?, 'Claude')
         ON CONFLICT (repo, term_key, agent_kind) DO NOTHING",
    )
    .bind(repo)
    .bind(term_key)
    .bind(cwd)
    .bind(Uuid::new_v4().to_string())
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
pub(crate) struct SessionSummary {
    pub title: Option<String>,
    pub last_message: Option<String>,
    pub last_message_from: Option<LastMessageFrom>,
    pub message_count: u32,
    pub subagent_count: u32,
    pub model: Option<String>,
    pub started_at_ms: Option<i64>,
    pub last_activity_ms: Option<i64>,
}

/// A worktree's registered session with the hook-tracked state joined on:
/// `(session_id, agent_kind, term_key, cwd, created_at, updated_at_ms)`.
type HistoryRow = (String, String, String, String, String, Option<i64>);

/// The agent sessions that have run in a worktree, newest first: every session
/// the terminal registry attributes to it (its main terminal and tabs), plus the
/// Claude transcripts and Codex rollouts on disk for that directory with no
/// registry row (launched by hand, or a row since forgotten). Both providers are
/// summarised from their own record — a Claude session from its transcript, a
/// Codex one from its rollout. Empty when nothing ran.
pub async fn history(
    db: &Db,
    repo: &str,
    issue_id: &str,
    worktree: &Path,
) -> Result<Vec<WorktreeSession>> {
    let (exact, prefix) = worktree_key_patterns(issue_id);
    // Every provider's rows. LEFT JOIN: `session_state` is written by Claude's
    // hooks, so a Codex row (or a Claude one from before the hooks) has none — it
    // still counts as a session.
    let rows: Vec<HistoryRow> = sqlx::query_as(
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
    .await?;

    // Claude transcripts are located by `(cwd, session_id)`; Codex rollouts by
    // thread id alone (the registry's `session_id` for a Codex row *is* the
    // thread id — what `session_meta.id` carries).
    let known_claude: Vec<(String, String)> = rows
        .iter()
        .filter(|r| r.1 == AgentKind::Claude.as_str())
        .map(|r| (r.3.clone(), r.0.clone()))
        .collect();
    let known_codex: Vec<String> = rows
        .iter()
        .filter(|r| r.1 == AgentKind::Codex.as_str())
        .map(|r| r.0.clone())
        .collect();
    let dir = worktree.to_path_buf();
    let mut summaries: HashMap<String, (AgentKind, SessionSummary)> =
        tokio::task::spawn_blocking(move || {
            let claude = crate::usage::worktree_summaries(&dir, &known_claude)
                .into_iter()
                .map(|(id, s)| (id, (AgentKind::Claude, s)));
            let codex = crate::codex_rollouts::worktree_summaries(&dir, &known_codex)
                .into_iter()
                .map(|(id, s)| (id, (AgentKind::Codex, s)));
            claude.chain(codex).collect()
        })
        .await?;

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
            },
        ));
    }
    // Newest first; a session with no timestamp at all sinks to the bottom.
    out.sort_by_key(|(when, _)| std::cmp::Reverse(*when));
    Ok(out.into_iter().map(|(_, s)| s).collect())
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
    Ok(tokio::task::spawn_blocking(move || {
        rows.iter()
            .any(|(sid, cwd, _)| transcript_path(&home, cwd, sid).exists())
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
        let path = transcript_path(home, cwd, session_id);
        let Some(raw) = read_transcript(&path) else {
            continue; // pruned or unreadable transcript — skip it
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
        if is_resumable(home, &cwd, &session_id).await {
            continue;
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
            sqlx::query(&sql)
                .bind("repo")
                .bind(key)
                .bind(cwd)
                .bind(format!("sid-{key}"))
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
        let live = transcript_path(&home, cwd, "sid-keeps-transcript");
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
        let r = resolve(&db, "repo", key, cwd, Some(&home), "/bin/claude", false)
            .await
            .unwrap();
        assert_eq!(r, AgentSession::Shell);

        // Explicit launch mints + stores a fresh session id.
        let fresh = resolve(&db, "repo", key, cwd, Some(&home), "/bin/claude", true)
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
            resolve(&db, "repo", key, cwd, Some(&home), "/bin/claude", false)
                .await
                .unwrap(),
            AgentSession::Shell
        );

        // Drop the transcript Claude would write, then a reopen resumes it.
        let path = transcript_path(&home, cwd, &session_id);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{}").unwrap();
        assert_eq!(
            resolve(&db, "repo", key, cwd, Some(&home), "/bin/claude", false)
                .await
                .unwrap(),
            AgentSession::Resume {
                agent_kind: AgentKind::Claude,
                executable: "/bin/claude".into(),
                session_id: session_id.clone(),
                launch_flags: String::new(),
            }
        );

        // A re-launch prefers resuming the live session over minting a new id.
        assert_eq!(
            resolve(&db, "repo", key, cwd, Some(&home), "/bin/claude", true)
                .await
                .unwrap(),
            AgentSession::Resume {
                agent_kind: AgentKind::Claude,
                executable: "/bin/claude".into(),
                session_id,
                launch_flags: String::new(),
            }
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn transcript_path_escapes_every_non_alphanumeric_char() {
        // Claude Code escapes underscores (and any other non-alphanumeric char),
        // not just '/' and '.' — a repo path like `.../dev/my_repo` must map to
        // `...-dev-my-repo`, matching what Claude actually writes to disk.
        let home = Path::new("/home/user");
        let path = transcript_path(home, "/Users/x/dev/my_repo", "sess-id");
        assert_eq!(
            path,
            Path::new("/home/user/.claude/projects/-Users-x-dev-my-repo/sess-id.jsonl")
        );
    }

    #[tokio::test]
    async fn resolve_finds_transcript_for_underscore_cwd() {
        // Regression test for the escaping bug: an underscore in `cwd` must be
        // escaped the same way Claude Code escapes it, or `is_resumable` never
        // finds the transcript Claude actually wrote.
        let base =
            std::env::temp_dir().join(format!("santree-session-underscore-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");

        let db = crate::db::init(base.join("test.db")).await.unwrap();
        let cwd = "/Users/x/dev/my_repo";
        let key = "tree:AK-2";

        let fresh = resolve(&db, "repo", key, cwd, Some(&home), "/bin/claude", true)
            .await
            .unwrap();
        let AgentSession::Fresh {
            session_id: Some(session_id),
            ..
        } = fresh
        else {
            panic!("expected Fresh with a santree-minted id, got {fresh:?}");
        };

        // Write the transcript at the path Claude Code would actually use.
        let path = transcript_path(&home, cwd, &session_id);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{}").unwrap();

        assert_eq!(
            resolve(&db, "repo", key, cwd, Some(&home), "/bin/claude", false)
                .await
                .unwrap(),
            AgentSession::Resume {
                agent_kind: AgentKind::Claude,
                executable: "/bin/claude".into(),
                session_id,
                launch_flags: String::new(),
            }
        );

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

        let first = mint(&db, "repo", "tree:AK-1", "/tmp/wt").await.unwrap();
        let second = mint(&db, "repo", "tree:AK-1", "/tmp/wt").await.unwrap();
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
        )
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
        )
        .await
        .unwrap();

        let mut got = started_investigations(&db, "repo").await.unwrap();
        got.sort_by(|a, b| {
            (&a.ref_id, a.agent_kind.as_str()).cmp(&(&b.ref_id, b.agent_kind.as_str()))
        });
        // Only the triage tickets with a stored row — not the worktree, the
        // never-launched AK-9, or the other repo's ticket. Transcript existence
        // is irrelevant, and one ticket can retain both providers.
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

    #[test]
    fn escape_like_escapes_only_like_metacharacters() {
        assert_eq!(escape_like("AK-170"), "AK-170");
        assert_eq!(escape_like("a%b_c\\d"), "a\\%b\\_c\\\\d");
    }

    #[test]
    fn transcript_turn_keeps_prose_and_drops_tool_noise() {
        // User string content → kept.
        assert_eq!(
            transcript_turn(r#"{"type":"user","message":{"content":"do the thing"}}"#).as_deref(),
            Some("User: do the thing")
        );
        // Assistant text blocks kept; tool_use block dropped.
        assert_eq!(
            transcript_turn(
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"I chose approach B"},{"type":"tool_use","name":"Edit","input":{"x":"secret"}}]}}"#
            )
            .as_deref(),
            Some("Assistant: I chose approach B")
        );
        // A user turn that's only a tool_result → no prose → dropped.
        assert_eq!(
            transcript_turn(
                r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"huge file dump"}]}}"#
            ),
            None
        );
        // Summaries and malformed lines → dropped.
        assert_eq!(transcript_turn(r#"{"type":"summary","summary":"x"}"#), None);
        assert_eq!(transcript_turn("not json"), None);
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
            let path = transcript_path(&home, cwd, sid);
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
