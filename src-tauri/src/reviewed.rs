//! Persisted "Viewed" marks for the Reviews tab. Marking a PR file reviewed
//! stores its current blob SHA; the UI shows the file as reviewed only while its
//! head SHA still matches, so a commit that changes the file auto-clears the mark
//! (see `reviewed_files` in migration 0012). Local-only, never synced. Keyed by
//! the PR's own repo ("owner/name") + number + path, since the inbox spans repos.

use anyhow::Result;

use santree_core::domain::ReviewedFile;

use crate::db::{now_ms, Db};

/// Every marked-viewed file for a PR (its path + the SHA it was marked at). The
/// frontend keeps a mark only while the file's current head SHA still matches.
pub async fn list(db: &Db, pr_repo: &str, pr_number: u32) -> Result<Vec<ReviewedFile>> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT path, sha FROM reviewed_files WHERE pr_repo = ? AND pr_number = ?")
            .bind(pr_repo)
            .bind(pr_number)
            .fetch_all(db)
            .await?;
    Ok(rows
        .into_iter()
        .map(|(path, sha)| ReviewedFile { path, sha })
        .collect())
}

/// Mark a file reviewed (upsert its current `sha`) or clear the mark. Re-marking a
/// changed file overwrites the stored SHA, so the mark tracks the latest content.
pub async fn set(
    db: &Db,
    pr_repo: &str,
    pr_number: u32,
    path: &str,
    sha: &str,
    reviewed: bool,
) -> Result<()> {
    if reviewed {
        sqlx::query(
            "INSERT INTO reviewed_files (pr_repo, pr_number, path, sha, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(pr_repo, pr_number, path)
             DO UPDATE SET sha = excluded.sha, updated_at = excluded.updated_at",
        )
        .bind(pr_repo)
        .bind(pr_number)
        .bind(path)
        .bind(sha)
        .bind(now_ms())
        .execute(db)
        .await?;
    } else {
        sqlx::query("DELETE FROM reviewed_files WHERE pr_repo = ? AND pr_number = ? AND path = ?")
            .bind(pr_repo)
            .bind(pr_number)
            .bind(path)
            .execute(db)
            .await?;
    }
    Ok(())
}
