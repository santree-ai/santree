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

/// Whether `session_id` can still be resumed for a claude run in `cwd`.
fn is_resumable(home: &Path, cwd: &str, session_id: &str) -> bool {
    transcript_path(home, cwd, session_id).exists()
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
        if home.is_some_and(|h| is_resumable(h, &stored_cwd, &session_id)) {
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
