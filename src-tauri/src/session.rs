//! Resumable Claude sessions for terminals that auto-launch `claude`.
//!
//! When a terminal auto-launches the agent (Trees "work", Triage "investigate")
//! we give it a stable session UUID and remember it in `terminal_sessions`, so
//! reopening the tab later — after the app restarted or the agent was quit —
//! resumes the *same* conversation (`claude --resume <id>`) instead of dropping
//! to a bare shell or starting over. A session is "resumable" only while its
//! transcript still exists on disk; once Claude prunes/deletes it we start fresh.

use std::path::{Path, PathBuf};

use anyhow::Result;
use santree_core::domain::AgentSession;
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
    let escaped: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    home.join(".claude/projects")
        .join(escaped)
        .join(format!("{session_id}.jsonl"))
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
    allow_fresh: bool,
) -> Result<AgentSession> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT session_id, cwd FROM terminal_sessions WHERE repo = ? AND term_key = ?",
    )
    .bind(repo)
    .bind(term_key)
    .fetch_optional(db)
    .await?;

    if let Some((session_id, stored_cwd)) = row {
        let resumable = match home {
            Some(h) => is_resumable(h, &stored_cwd, &session_id).await,
            None => false,
        };
        if resumable {
            return Ok(AgentSession::Resume { session_id });
        }
        return Ok(if allow_fresh {
            AgentSession::Fresh { session_id }
        } else {
            AgentSession::Shell
        });
    }

    if !allow_fresh {
        return Ok(AgentSession::Shell);
    }

    Ok(AgentSession::Fresh {
        session_id: mint(db, repo, term_key, cwd).await?,
    })
}

/// Store a new session id for the terminal and return the id it will actually
/// run under. Two launches of the same terminal can race — both see no row and
/// mint an id — so the insert yields to whoever got there first and we re-read:
/// the loser adopts the winner's session instead of failing the primary key.
async fn mint(db: &Db, repo: &str, term_key: &str, cwd: &str) -> Result<String> {
    sqlx::query(
        "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id) VALUES (?, ?, ?, ?)
         ON CONFLICT (repo, term_key) DO NOTHING",
    )
    .bind(repo)
    .bind(term_key)
    .bind(cwd)
    .bind(Uuid::new_v4().to_string())
    .execute(db)
    .await?;
    let (session_id,): (String,) =
        sqlx::query_as("SELECT session_id FROM terminal_sessions WHERE repo = ? AND term_key = ?")
            .bind(repo)
            .bind(term_key)
            .fetch_one(db)
            .await?;
    Ok(session_id)
}

/// The ticket ids of every triage investigation that has a *stored session* for
/// `repo` — i.e. one was started for it at some point, so it can be resumed.
///
/// Mirrors how a worktree row makes the Trees work terminal resumable: presence
/// of the record — not the on-disk transcript — is what surfaces the tab +
/// resume affordance. We intentionally don't stat the transcript here: even if
/// Claude has pruned it, `resolve` (with `allow_fresh`) reuses the stored id to
/// start fresh, so a stored session is always a valid resume target.
pub async fn started_investigations(db: &Db, repo: &str) -> Result<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT term_key FROM terminal_sessions WHERE repo = ? AND term_key LIKE 'triage:%'",
    )
    .bind(repo)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(key,)| key.strip_prefix("triage:").map(str::to_string))
        .collect())
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
    let exact = format!("tree:{issue_id}");
    let prefix = format!("tree:{}:%", escape_like(issue_id));
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
         WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)",
    )
    .bind(format!("-{STALE_SESSION_DAYS} days"))
    .fetch_all(db)
    .await?;

    let mut reaped = 0;
    for (repo, term_key, cwd, session_id) in rows {
        if is_resumable(home, &cwd, &session_id).await {
            continue;
        }
        forget(db, &repo, &term_key).await?;
        reaped += 1;
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

        // Three aged-out rows and one recent one. `keeps-transcript` still has its
        // transcript on disk; `recent` is young enough to be out of scope entirely.
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
        let live = transcript_path(&home, cwd, "sid-keeps-transcript");
        std::fs::create_dir_all(live.parent().unwrap()).unwrap();
        std::fs::write(&live, "{}").unwrap();

        assert_eq!(reap_stale(&db, Some(&home)).await.unwrap(), 2);
        let mut left: Vec<String> =
            sqlx::query_as("SELECT term_key FROM terminal_sessions WHERE repo = 'repo'")
                .fetch_all(&db)
                .await
                .unwrap()
                .into_iter()
                .map(|(k,): (String,)| k)
                .collect();
        left.sort();
        assert_eq!(left, vec!["keeps-transcript", "recent"]);

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
        let r = resolve(&db, "repo", key, cwd, Some(&home), false)
            .await
            .unwrap();
        assert_eq!(r, AgentSession::Shell);

        // Explicit launch mints + stores a fresh session id.
        let fresh = resolve(&db, "repo", key, cwd, Some(&home), true)
            .await
            .unwrap();
        let AgentSession::Fresh { session_id } = fresh else {
            panic!("expected Fresh, got {fresh:?}");
        };

        // No transcript yet → a reopen still can't resume (stays a shell).
        assert_eq!(
            resolve(&db, "repo", key, cwd, Some(&home), false)
                .await
                .unwrap(),
            AgentSession::Shell
        );

        // Drop the transcript Claude would write, then a reopen resumes it.
        let path = transcript_path(&home, cwd, &session_id);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{}").unwrap();
        assert_eq!(
            resolve(&db, "repo", key, cwd, Some(&home), false)
                .await
                .unwrap(),
            AgentSession::Resume {
                session_id: session_id.clone()
            }
        );

        // A re-launch prefers resuming the live session over minting a new id.
        assert_eq!(
            resolve(&db, "repo", key, cwd, Some(&home), true)
                .await
                .unwrap(),
            AgentSession::Resume { session_id }
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

        let fresh = resolve(&db, "repo", key, cwd, Some(&home), true)
            .await
            .unwrap();
        let AgentSession::Fresh { session_id } = fresh else {
            panic!("expected Fresh, got {fresh:?}");
        };

        // Write the transcript at the path Claude Code would actually use.
        let path = transcript_path(&home, cwd, &session_id);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{}").unwrap();

        assert_eq!(
            resolve(&db, "repo", key, cwd, Some(&home), false)
                .await
                .unwrap(),
            AgentSession::Resume { session_id }
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
        resolve(&db, "repo", "triage:AK-1", cwd, Some(&home), true)
            .await
            .unwrap();
        resolve(&db, "repo", "triage:AK-2", cwd, Some(&home), true)
            .await
            .unwrap();
        resolve(&db, "repo", "tree:AK-3", cwd, Some(&home), true)
            .await
            .unwrap();
        resolve(&db, "repo", "triage:AK-9", cwd, Some(&home), false)
            .await
            .unwrap();
        // A different repo's investigation must not leak in.
        resolve(&db, "other", "triage:AK-8", cwd, Some(&home), true)
            .await
            .unwrap();

        let mut got = started_investigations(&db, "repo").await.unwrap();
        got.sort();
        // Only the two triage tickets with a stored row — not the worktree, the
        // never-launched AK-9, or the other repo's ticket. Transcript existence
        // is irrelevant (none were written on disk here).
        assert_eq!(got, vec!["AK-1".to_string(), "AK-2".to_string()]);

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
        let main = resolve(&db, "repo", "tree:AK-1", cwd, Some(&home), true)
            .await
            .unwrap();
        let AgentSession::Fresh {
            session_id: main_sid,
        } = main
        else {
            panic!("expected Fresh");
        };
        let tab = resolve(&db, "repo", "tree:AK-1:tab:t2", cwd, Some(&home), true)
            .await
            .unwrap();
        let AgentSession::Fresh {
            session_id: tab_sid,
        } = tab
        else {
            panic!("expected Fresh");
        };
        let other = resolve(&db, "repo", "tree:AK-2", cwd, Some(&home), true)
            .await
            .unwrap();
        let AgentSession::Fresh {
            session_id: other_sid,
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
