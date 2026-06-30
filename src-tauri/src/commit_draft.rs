//! Persisted commit-message drafts. The Changes box autosaves what you type so
//! it survives closing the tab / switching worktrees / a crash, until you commit
//! (which clears it) or regenerate it. Keyed by (repo, issue_id) in
//! `commit_drafts`. Mirrors `notes` — local-only, never synced; both back onto
//! the shared `text_store`.

use anyhow::Result;

use crate::db::Db;
use crate::text_store::Store;

const DRAFTS: Store = Store {
    table: "commit_drafts",
    key: "issue_id",
    value: "message",
};

/// The saved draft for a worktree, or `None` when there's none.
pub async fn get(db: &Db, repo: &str, issue_id: &str) -> Result<Option<String>> {
    DRAFTS.get(db, repo, issue_id).await
}

/// Upsert the draft, or delete the row when `message` is blank — so a cleared
/// draft (e.g. right after committing) doesn't linger.
pub async fn set(db: &Db, repo: &str, issue_id: &str, message: &str) -> Result<()> {
    DRAFTS.set(db, repo, issue_id, message).await
}
