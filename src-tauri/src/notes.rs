//! Local, per-task free-text notes — context the user attaches to a task. Never
//! synced to Linear; later fed to agents as prompt context. Keyed by
//! (repo, task_id) in the `task_notes` table. Backed by the shared `text_store`.

use anyhow::Result;

use crate::db::Db;
use crate::text_store::Store;

const NOTES: Store = Store {
    table: "task_notes",
    key: "task_id",
    value: "body",
};

/// The note for a task, or `None` when none is stored.
pub async fn get(db: &Db, repo: &str, task_id: &str) -> Result<Option<String>> {
    NOTES.get(db, repo, task_id).await
}

/// Upsert the note, or delete the row when `body` is blank — so an emptied note
/// doesn't linger and read as "has content".
pub async fn set(db: &Db, repo: &str, task_id: &str, body: &str) -> Result<()> {
    NOTES.set(db, repo, task_id, body).await
}
