//! Persisted commit-message drafts. The Changes box autosaves what you type so
//! it survives closing the tab / switching worktrees / a crash, until you commit
//! (which clears it) or regenerate it. Keyed by (repo, issue_id) in
//! `commit_drafts`. Mirrors `notes` — local-only, never synced.

use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;

use crate::db::Db;

/// The saved draft for a worktree, or `None` when there's none.
pub async fn get(db: &Db, repo: &str, issue_id: &str) -> Result<Option<String>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT message FROM commit_drafts WHERE repo = ? AND issue_id = ?")
            .bind(repo)
            .bind(issue_id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(|(m,)| m))
}

/// Upsert the draft, or delete the row when `message` is blank — so a cleared
/// draft (e.g. right after committing) doesn't linger.
pub async fn set(db: &Db, repo: &str, issue_id: &str, message: &str) -> Result<()> {
    if message.trim().is_empty() {
        sqlx::query("DELETE FROM commit_drafts WHERE repo = ? AND issue_id = ?")
            .bind(repo)
            .bind(issue_id)
            .execute(db)
            .await?;
        return Ok(());
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    sqlx::query(
        "INSERT INTO commit_drafts (repo, issue_id, message, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(repo, issue_id) DO UPDATE SET message = excluded.message, updated_at = excluded.updated_at",
    )
    .bind(repo)
    .bind(issue_id)
    .bind(message)
    .bind(now)
    .execute(db)
    .await?;
    Ok(())
}
