//! Local, per-task free-text notes — context the user attaches to a task. Never
//! synced to Linear; later fed to agents as prompt context. Keyed by
//! (repo, task_id) in the `task_notes` table.

use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;

use crate::db::Db;

/// The note for a task, or `None` when none is stored.
pub async fn get(db: &Db, repo: &str, task_id: &str) -> Result<Option<String>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT body FROM task_notes WHERE repo = ? AND task_id = ?")
            .bind(repo)
            .bind(task_id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(|(b,)| b))
}

/// Upsert the note, or delete the row when `body` is blank — so an emptied note
/// doesn't linger and read as "has content".
pub async fn set(db: &Db, repo: &str, task_id: &str, body: &str) -> Result<()> {
    if body.trim().is_empty() {
        sqlx::query("DELETE FROM task_notes WHERE repo = ? AND task_id = ?")
            .bind(repo)
            .bind(task_id)
            .execute(db)
            .await?;
        return Ok(());
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    sqlx::query(
        "INSERT INTO task_notes (repo, task_id, body, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(repo, task_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
    )
    .bind(repo)
    .bind(task_id)
    .bind(body)
    .bind(now)
    .execute(db)
    .await?;
    Ok(())
}
