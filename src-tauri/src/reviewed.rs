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

/// How long a PR's marks outlive the last time the user touched them. A PR nobody
/// has looked at in three months is merged, closed, or abandoned; if it somehow
/// comes back, the marks would be stale against its new head SHAs anyway and the
/// files would show as unreviewed regardless.
const STALE_MARK_DAYS: i64 = 90;

/// Drop the marks for PRs gone quiet for [`STALE_MARK_DAYS`]. Nothing else ever
/// deletes a row for a PR that got merged or closed — the Reviews inbox spans the
/// whole org — so without this the table grows monotonically with the org's PR
/// history. Returns how many rows it dropped.
///
/// Grouped by PR, not by row: an old mark on a PR reviewed yesterday is still live
/// (files that never changed are never re-marked), so pruning per-row would quietly
/// un-review parts of an active PR.
pub async fn prune_stale(db: &Db) -> Result<u64> {
    let cutoff = now_ms() - STALE_MARK_DAYS * 24 * 60 * 60 * 1_000;
    let done = sqlx::query(
        "DELETE FROM reviewed_files WHERE (pr_repo, pr_number) IN (
             SELECT pr_repo, pr_number FROM reviewed_files
             GROUP BY pr_repo, pr_number
             HAVING MAX(updated_at) < ?
         )",
    )
    .bind(cutoff)
    .execute(db)
    .await?;
    Ok(done.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A PR is pruned as a unit: every mark goes when its *newest* mark ages out, and
    /// none go while any mark on it is recent.
    #[tokio::test]
    async fn prune_stale_drops_whole_prs_not_rows() {
        let base = std::env::temp_dir().join(format!("santree-reviewed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let db = crate::db::init(base.join("test.db")).await.unwrap();

        let day = 24 * 60 * 60 * 1_000;
        let now = now_ms();
        // "old" was last touched 100 days ago; "active" has one ancient mark and one
        // from yesterday — a file that hasn't changed since it was first reviewed.
        for (pr, path, age_days) in [
            ("o/r", "old-a.rs", 100),
            ("o/r", "old-b.rs", 120),
            ("o/other", "kept.rs", 1),
        ] {
            let number = if pr == "o/r" { 1 } else { 2 };
            insert(&db, pr, number, path, now - age_days * day).await;
        }
        insert(&db, "o/other", 2, "ancient-but-active.rs", now - 200 * day).await;

        assert_eq!(prune_stale(&db).await.unwrap(), 2);
        assert!(list(&db, "o/r", 1).await.unwrap().is_empty());
        assert_eq!(list(&db, "o/other", 2).await.unwrap().len(), 2);

        let _ = std::fs::remove_dir_all(&base);
    }

    async fn insert(db: &Db, pr_repo: &str, pr_number: u32, path: &str, updated_at: i64) {
        sqlx::query(
            "INSERT INTO reviewed_files (pr_repo, pr_number, path, sha, updated_at)
             VALUES (?, ?, ?, 'sha', ?)",
        )
        .bind(pr_repo)
        .bind(pr_number)
        .bind(path)
        .bind(updated_at)
        .execute(db)
        .await
        .unwrap();
    }
}
