//! "Viewed" marks for the Reviews tab, from one of two stores.
//!
//! **Local** (the default): marking a PR file reviewed stores its current blob SHA
//! in this machine's `reviewed_files` table; the UI shows the file as reviewed only
//! while its head SHA still matches, so a commit that changes the file auto-clears
//! the mark (see migration 0012). Keyed by the PR's own repo ("owner/name") +
//! number + path, since the inbox spans repos.
//!
//! **Synced**: the mark is GitHub's own per-viewer `viewerViewedState`, so it's the
//! same checkbox as the github.com Files tab and follows the user across machines.
//! GitHub does the staleness work itself (a changed file comes back `DISMISSED`),
//! so no SHA is stored or compared.
//!
//! [`sync_token`] picks between them, and [`ViewedMarks`] tells the frontend which
//! it got — the staleness rules differ, so the mode can't be inferred client-side.

use anyhow::Result;

use santree_core::domain::{ReviewedFile, ViewedMarks};

use crate::db::{now_ms, Db};
use crate::{github, settings};

/// App-scoped setting: send "Viewed" marks to GitHub instead of this machine's
/// table. Off unless explicitly `"true"` — the local store is the safe default
/// since it needs no network and can't touch anyone else's view of the PR.
pub const SYNC_VIEWED_KEY: &str = "reviews_sync_viewed";

/// The token to round-trip marks through, or `None` to use the local table.
///
/// A token is required as well as the setting: with sync on but `gh` signed out
/// there's nothing to read or write through, and the Reviews tab has no PRs to show
/// marks for either, so falling back to local is the only behavior that can't drop
/// a mark on the floor. Cheap to call twice — `github::token` is cached (60s TTL).
async fn sync_token(db: &Db) -> Option<String> {
    let on = settings::get(db, "app", SYNC_VIEWED_KEY)
        .await
        .unwrap_or_default()
        .as_deref()
        == Some("true");
    if !on {
        return None;
    }
    github::token().await
}

use github::split_slug;

/// Every "Viewed" mark for a PR, tagged with the store it came from.
pub async fn marks(db: &Db, pr_repo: &str, pr_number: u32) -> Result<ViewedMarks> {
    let Some(token) = sync_token(db).await else {
        return Ok(ViewedMarks::Local {
            files: list(db, pr_repo, pr_number).await?,
        });
    };
    let (owner, name) = split_slug(pr_repo)?;
    Ok(ViewedMarks::Synced {
        paths: github::pr_viewed_files(&token, owner, name, pr_number).await?,
    })
}

/// Set or clear one file's mark in whichever store is live. `pr_id` is the PR's
/// GraphQL node id, needed only by the synced path (the local table is keyed by
/// repo + number); `sha` is needed only by the local path.
pub async fn set_mark(
    db: &Db,
    pr_repo: &str,
    pr_number: u32,
    pr_id: &str,
    path: &str,
    sha: &str,
    viewed: bool,
) -> Result<()> {
    let Some(token) = sync_token(db).await else {
        return set(db, pr_repo, pr_number, path, sha, viewed).await;
    };
    github::set_file_viewed(&token, pr_id, path, viewed).await
}

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
