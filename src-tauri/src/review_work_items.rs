use anyhow::{anyhow, bail, Result};
use santree_core::domain::{ReviewWorkItem, ReviewWorkItemSource};

use crate::db::{now_ms, Db};
use crate::github;

type Row = (
    String,
    String,
    i64,
    String,
    bool,
    String,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<i64>,
    Option<bool>,
    i64,
    i64,
);

const COLUMNS: &str = "id, pr_repo, pr_number, body, done, source_kind, source_id, path, \
                       line, start_line, on_right, created_at, updated_at";

fn item(row: Row) -> ReviewWorkItem {
    ReviewWorkItem {
        id: row.0,
        pr_repo: row.1,
        pr_number: row.2 as u32,
        body: row.3,
        done: row.4,
        source: ReviewWorkItemSource::from_db_str(&row.5),
        source_id: row.6,
        path: row.7,
        line: row.8.map(|v| v as u32),
        start_line: row.9.map(|v| v as u32),
        on_right: row.10,
        created_at_ms: row.11 as f64,
        updated_at_ms: row.12 as f64,
    }
}

fn validate_scope(repo: &str, number: u32) -> Result<()> {
    // Strict component check, not just `split_slug`: that one accepts ".." as an
    // owner, and this scope keys rows that the fixing agent's prompt is built from.
    let (owner, name) = github::split_slug(repo)?;
    if !crate::repo::valid_github_component(owner) || !crate::repo::valid_github_component(name) {
        bail!("invalid repository identity: {repo:?}");
    }
    if number == 0 {
        bail!("pull request number must be greater than zero");
    }
    Ok(())
}

fn validate_id(id: &str) -> Result<()> {
    uuid::Uuid::parse_str(id).map_err(|_| anyhow!("invalid review work-item id"))?;
    Ok(())
}

pub async fn list(db: &Db, repo: &str, number: u32) -> Result<Vec<ReviewWorkItem>> {
    validate_scope(repo, number)?;
    let rows: Vec<Row> = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM review_work_items WHERE pr_repo = ? AND pr_number = ? \
         ORDER BY done, created_at"
    ))
    .bind(repo)
    .bind(number)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(item).collect())
}

/// Upper bound on a check's name, which is what identifies a check-sourced item.
/// GitHub caps check-run names well below this; the bound is here so an absurd or
/// hostile name can't bloat the row or the fixing agent's prompt.
const MAX_CHECK_NAME: usize = 255;

/// Upper bound on a work item's text.
///
/// An item's body is not always something the user typed: queueing a PR comment
/// files whoever wrote it — often a bot — as the item's description, and a CI
/// summary comment can run to hundreds of kilobytes. Without a bound that lands
/// whole in SQLite *and* in the fixing agent's prompt file. Generous enough for a
/// real review comment, which is what an item legitimately holds.
const MAX_BODY: usize = 8_000;

#[allow(clippy::too_many_arguments)]
pub async fn add(
    db: &Db,
    repo: &str,
    number: u32,
    id: &str,
    body: &str,
    source: ReviewWorkItemSource,
    source_id: Option<&str>,
    path: Option<&str>,
    line: Option<u32>,
    start_line: Option<u32>,
    on_right: Option<bool>,
) -> Result<ReviewWorkItem> {
    validate_scope(repo, number)?;
    validate_id(id)?;
    let body = body.trim();
    if body.is_empty() {
        bail!("a work item needs a description");
    }
    if body.len() > MAX_BODY {
        bail!(
            "that work item's description is too long ({} bytes)",
            body.len()
        );
    }
    match (source, source_id) {
        (ReviewWorkItemSource::Manual, None) => {}
        (ReviewWorkItemSource::Manual, Some(_)) => bail!("manual items cannot have a source id"),
        (ReviewWorkItemSource::GithubThread, Some(value))
            if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) => {}
        (ReviewWorkItemSource::GithubThread, _) => {
            bail!("a GitHub thread source id must be a decimal comment id")
        }
        (ReviewWorkItemSource::AiDraft, Some(value)) if !value.trim().is_empty() => {}
        (ReviewWorkItemSource::Check, Some(value))
            if !value.trim().is_empty() && value.len() <= MAX_CHECK_NAME => {}
        (ReviewWorkItemSource::Check, _) => {
            bail!("a check source id must be the check's name")
        }
        _ => bail!("source-backed items need a source id"),
    }
    if source == ReviewWorkItemSource::AiDraft {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM review_drafts WHERE id = ? AND pr_repo = ? AND pr_number = ?)",
        )
        .bind(source_id)
        .bind(repo)
        .bind(number)
        .fetch_one(db)
        .await?;
        if !exists {
            bail!("that AI review draft does not belong to this pull request");
        }
    }
    if let (Some(start), Some(end)) = (start_line, line) {
        if start > end {
            bail!("start line must not be after the end line");
        }
    }
    let now = now_ms();
    sqlx::query(
        "INSERT INTO review_work_items \
           (id, pr_repo, pr_number, body, source_kind, source_id, path, line, start_line, on_right, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(pr_repo, pr_number, source_kind, source_id) WHERE source_id IS NOT NULL \
         DO UPDATE SET body = excluded.body, path = excluded.path, line = excluded.line, \
           start_line = excluded.start_line, on_right = excluded.on_right, updated_at = excluded.updated_at"
    )
    .bind(id).bind(repo).bind(number).bind(body).bind(source.as_db_str())
    .bind(source_id).bind(path).bind(line).bind(start_line).bind(on_right).bind(now).bind(now)
    .execute(db).await?;
    let row: Row = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM review_work_items WHERE pr_repo = ? AND pr_number = ? AND \
         ((source_id = ? AND source_kind = ?) OR (id = ?)) LIMIT 1"
    ))
    .bind(repo)
    .bind(number)
    .bind(source_id)
    .bind(source.as_db_str())
    .bind(id)
    .fetch_one(db)
    .await?;
    Ok(item(row))
}

pub async fn update(
    db: &Db,
    repo: &str,
    number: u32,
    id: &str,
    body: &str,
    done: bool,
) -> Result<ReviewWorkItem> {
    validate_scope(repo, number)?;
    validate_id(id)?;
    let body = body.trim();
    if body.is_empty() {
        bail!("a work item needs a description");
    }
    if body.len() > MAX_BODY {
        bail!(
            "that work item's description is too long ({} bytes)",
            body.len()
        );
    }
    let row: Option<Row> = sqlx::query_as(&format!(
        "UPDATE review_work_items SET body = ?, done = ?, updated_at = ? \
         WHERE id = ? AND pr_repo = ? AND pr_number = ? RETURNING {COLUMNS}"
    ))
    .bind(body)
    .bind(done)
    .bind(now_ms())
    .bind(id)
    .bind(repo)
    .bind(number)
    .fetch_optional(db)
    .await?;
    row.map(item)
        .ok_or_else(|| anyhow!("that review work item is no longer there"))
}

pub async fn delete(db: &Db, repo: &str, number: u32, id: &str) -> Result<()> {
    validate_scope(repo, number)?;
    validate_id(id)?;
    sqlx::query("DELETE FROM review_work_items WHERE id = ? AND pr_repo = ? AND pr_number = ?")
        .bind(id)
        .bind(repo)
        .bind(number)
        .execute(db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn db() -> Db {
        let dir = std::env::temp_dir().join(format!(
            "santree-review-items-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        crate::db::init(dir.join("review-items.db")).await.unwrap()
    }

    #[tokio::test]
    async fn source_add_is_deduplicated_and_crud_is_pr_scoped() {
        let db = db().await;
        let first_id = uuid::Uuid::new_v4().to_string();
        let second_id = uuid::Uuid::new_v4().to_string();
        let first = add(
            &db,
            "acme/api",
            7,
            &first_id,
            "Handle the null case",
            ReviewWorkItemSource::GithubThread,
            Some("1234"),
            Some("src/api.rs"),
            Some(42),
            None,
            Some(true),
        )
        .await
        .unwrap();
        let duplicate = add(
            &db,
            "acme/api",
            7,
            &second_id,
            "Handle the new null and retry cases",
            ReviewWorkItemSource::GithubThread,
            Some("1234"),
            Some("src/api.rs"),
            Some(43),
            None,
            Some(true),
        )
        .await
        .unwrap();
        assert_eq!(duplicate.id, first.id);
        assert_eq!(list(&db, "acme/api", 7).await.unwrap().len(), 1);

        let updated = update(&db, "acme/api", 7, &first.id, "Implemented", true)
            .await
            .unwrap();
        assert!(updated.done);
        assert!(update(&db, "acme/api", 8, &first.id, "Wrong PR", true)
            .await
            .is_err());
        delete(&db, "acme/api", 7, &first.id).await.unwrap();
        assert!(list(&db, "acme/api", 7).await.unwrap().is_empty());
    }

    /// Proves three things at once, against a real migrated database: 0029's
    /// widened CHECK applied, the partial UNIQUE index **survived the table
    /// rebuild** (without it this upsert errors outright — a partial conflict
    /// target requires its index to exist), and re-queueing a check that is still
    /// red updates in place instead of stacking duplicates.
    #[tokio::test]
    async fn check_items_are_accepted_and_deduplicated_by_name() {
        let db = db().await;
        let first = add(
            &db,
            "acme/api",
            7,
            &uuid::Uuid::new_v4().to_string(),
            "Fix failing check: test (ubuntu-latest)",
            ReviewWorkItemSource::Check,
            Some("test (ubuntu-latest)"),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        let again = add(
            &db,
            "acme/api",
            7,
            &uuid::Uuid::new_v4().to_string(),
            "Fix failing check: test (ubuntu-latest) (GitHub Actions)",
            ReviewWorkItemSource::Check,
            Some("test (ubuntu-latest)"),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(again.id, first.id, "the same red check is one queue row");
        assert_eq!(
            again.body,
            "Fix failing check: test (ubuntu-latest) (GitHub Actions)"
        );
        let items = list(&db, "acme/api", 7).await.unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].source, ReviewWorkItemSource::Check);
    }

    #[tokio::test]
    async fn a_check_item_needs_a_real_name() {
        let db = db().await;
        for source_id in [None, Some(""), Some("   ")] {
            assert!(add(
                &db,
                "acme/api",
                7,
                &uuid::Uuid::new_v4().to_string(),
                "Fix it",
                ReviewWorkItemSource::Check,
                source_id,
                None,
                None,
                None,
                None,
            )
            .await
            .is_err());
        }
        let too_long = "x".repeat(MAX_CHECK_NAME + 1);
        assert!(add(
            &db,
            "acme/api",
            7,
            &uuid::Uuid::new_v4().to_string(),
            "Fix it",
            ReviewWorkItemSource::Check,
            Some(&too_long),
            None,
            None,
            None,
            None,
        )
        .await
        .is_err());
    }

    /// The dedupe key is the `(kind, id)` pair, not the id alone — a check named
    /// "1234" must not collide with review thread 1234 on the same PR.
    #[tokio::test]
    async fn check_and_thread_source_ids_do_not_collide() {
        let db = db().await;
        add(
            &db,
            "acme/api",
            7,
            &uuid::Uuid::new_v4().to_string(),
            "Fix failing check: 1234",
            ReviewWorkItemSource::Check,
            Some("1234"),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        add(
            &db,
            "acme/api",
            7,
            &uuid::Uuid::new_v4().to_string(),
            "Address the review comment",
            ReviewWorkItemSource::GithubThread,
            Some("1234"),
            Some("src/api.rs"),
            Some(42),
            None,
            Some(true),
        )
        .await
        .unwrap();
        assert_eq!(list(&db, "acme/api", 7).await.unwrap().len(), 2);
    }
}
