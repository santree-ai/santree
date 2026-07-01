//! Resumable Claude sessions for terminals that auto-launch `claude`.
//!
//! When a terminal auto-launches the agent (Trees "work", Triage "investigate")
//! we give it a stable session UUID and remember it in `terminal_sessions`, so
//! reopening the tab later — after the app restarted or the agent was quit —
//! resumes the *same* conversation (`claude --resume <id>`) instead of dropping
//! to a bare shell or starting over. A session is "resumable" only while its
//! transcript still exists on disk; once Claude prunes/deletes it we start fresh.

use std::path::PathBuf;

use anyhow::Result;
use santree_core::domain::AgentSession;
use uuid::Uuid;

use crate::db::Db;

/// Claude stores each session's transcript at
/// `~/.claude/projects/<escaped-cwd>/<session-id>.jsonl`, escaping the working
/// directory by replacing every `/` and `.` with `-` (verified against real
/// transcripts, e.g. `…/canary/.santree/worktrees/AK-1` becomes
/// `…-canary--santree-worktrees-AK-1`).
fn transcript_path(cwd: &str, session_id: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let escaped: String = cwd
        .chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect();
    Some(
        PathBuf::from(home)
            .join(".claude/projects")
            .join(escaped)
            .join(format!("{session_id}.jsonl")),
    )
}

/// Whether `session_id` can still be resumed for a claude run in `cwd`.
fn is_resumable(cwd: &str, session_id: &str) -> bool {
    transcript_path(cwd, session_id).is_some_and(|p| p.exists())
}

/// Resolve how to (re)launch claude for the logical terminal `term_key` in
/// `repo`: resume a still-on-disk session, mint a fresh one (only when
/// `allow_fresh` — i.e. an explicit launch, not a passive reopen), or leave it a
/// plain shell. A fresh launch reuses the stored id when the transcript was
/// pruned, so a later resume can still find the conversation.
pub async fn resolve(
    db: &Db,
    repo: &str,
    term_key: &str,
    cwd: &str,
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
        if is_resumable(&stored_cwd, &session_id) {
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

    let session_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id) VALUES (?, ?, ?, ?)",
    )
    .bind(repo)
    .bind(term_key)
    .bind(cwd)
    .bind(&session_id)
    .execute(db)
    .await?;
    Ok(AgentSession::Fresh { session_id })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn resolve_mints_fresh_then_resumes_when_transcript_exists() {
        let base = std::env::temp_dir().join(format!("santree-session-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        // Point HOME at a temp dir so transcript lookups are isolated.
        // SAFETY: single-threaded test; no other thread reads HOME concurrently.
        unsafe { std::env::set_var("HOME", &base) };

        let db = crate::db::init(base.join("test.db")).await.unwrap();
        let cwd = "/tmp/santree/work/AK-1";
        let key = "tree:AK-1";

        // First, passive reopen with nothing stored → plain shell.
        let r = resolve(&db, "repo", key, cwd, false).await.unwrap();
        assert_eq!(r, AgentSession::Shell);

        // Explicit launch mints + stores a fresh session id.
        let fresh = resolve(&db, "repo", key, cwd, true).await.unwrap();
        let AgentSession::Fresh { session_id } = fresh else {
            panic!("expected Fresh, got {fresh:?}");
        };

        // No transcript yet → a reopen still can't resume (stays a shell).
        assert_eq!(
            resolve(&db, "repo", key, cwd, false).await.unwrap(),
            AgentSession::Shell
        );

        // Drop the transcript Claude would write, then a reopen resumes it.
        let path = transcript_path(cwd, &session_id).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{}").unwrap();
        assert_eq!(
            resolve(&db, "repo", key, cwd, false).await.unwrap(),
            AgentSession::Resume {
                session_id: session_id.clone()
            }
        );

        // A re-launch prefers resuming the live session over minting a new id.
        assert_eq!(
            resolve(&db, "repo", key, cwd, true).await.unwrap(),
            AgentSession::Resume { session_id }
        );

        let _ = std::fs::remove_dir_all(&base);
    }
}
