//! Persisted extra main-area tabs for Trees (the "+" menu): Claude agent tabs
//! and plain terminal tabs, stored in `worktree_tabs` so they come back after
//! an app restart. A Claude tab's conversation lives in the shared session
//! registry (`terminal_sessions`) under [`term_key`], so reopening it resumes
//! the same conversation; a terminal tab just reopens a fresh shell (a dead
//! shell's history can't be restored).

use anyhow::{bail, Result};
use santree_core::domain::{TabKind, WorktreeTab};

use crate::db::Db;

/// The session-registry key for a Claude tab — the same key the frontend uses
/// as the PTY `refId`, so the two sides always name one logical terminal the
/// same way.
pub fn term_key(worktree_id: &str, tab_id: &str) -> String {
    format!("tree:{worktree_id}:tab:{tab_id}")
}

/// All extra tabs for the repo (every worktree), in open order.
pub async fn list(db: &Db, repo: &str) -> Result<Vec<WorktreeTab>> {
    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT id, worktree_id, kind, title FROM worktree_tabs
         WHERE repo = ? ORDER BY worktree_id, position",
    )
    .bind(repo)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, worktree_id, kind, title)| WorktreeTab {
            id,
            worktree_id,
            kind: TabKind::from_db_str(&kind),
            title,
        })
        .collect())
}

/// Persist a new tab. The frontend mints the id (so it can patch its cache and
/// focus the tab optimistically) and picks the initial title.
pub async fn add(
    db: &Db,
    repo: &str,
    worktree_id: &str,
    id: &str,
    kind: TabKind,
    title: &str,
) -> Result<()> {
    let title = title.trim();
    if title.is_empty() {
        bail!("tab title can't be empty");
    }
    sqlx::query(
        "INSERT INTO worktree_tabs (id, repo, worktree_id, kind, title, position)
         VALUES (?, ?, ?, ?, ?,
                 (SELECT COALESCE(MAX(position), 0) + 1 FROM worktree_tabs
                  WHERE repo = ? AND worktree_id = ?))",
    )
    .bind(id)
    .bind(repo)
    .bind(worktree_id)
    .bind(kind.as_db_str())
    .bind(title)
    .bind(repo)
    .bind(worktree_id)
    .execute(db)
    .await?;
    Ok(())
}

/// Rename a tab (blank titles are rejected — a tab must stay findable).
pub async fn rename(db: &Db, repo: &str, id: &str, title: &str) -> Result<()> {
    let title = title.trim();
    if title.is_empty() {
        bail!("tab title can't be empty");
    }
    sqlx::query("UPDATE worktree_tabs SET title = ? WHERE repo = ? AND id = ?")
        .bind(title)
        .bind(repo)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// Remove a tab, and — for a Claude tab — forget its stored session so a future
/// tab can't accidentally resume a conversation the user explicitly closed.
///
/// Both deletes go in one transaction: a tab that outlives its session would
/// just reopen as a shell, but a *session* that outlives its tab is a
/// conversation the user thought was closed, waiting to be resumed by whatever
/// tab next lands on the same coordinates.
pub async fn remove(db: &Db, repo: &str, id: &str) -> Result<()> {
    let mut tx = db.begin().await?;
    let row: Option<(String,)> =
        sqlx::query_as("DELETE FROM worktree_tabs WHERE repo = ? AND id = ? RETURNING worktree_id")
            .bind(repo)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some((worktree_id,)) = row {
        sqlx::query("DELETE FROM terminal_sessions WHERE repo = ? AND term_key = ?")
            .bind(repo)
            .bind(term_key(&worktree_id, id))
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Drop every tab of a worktree (called when the worktree itself is removed),
/// including each Claude tab's stored session — atomically, for the reason in
/// [`remove`].
pub async fn remove_for_worktree(db: &Db, repo: &str, worktree_id: &str) -> Result<()> {
    let mut tx = db.begin().await?;
    let ids: Vec<(String,)> =
        sqlx::query_as("DELETE FROM worktree_tabs WHERE repo = ? AND worktree_id = ? RETURNING id")
            .bind(repo)
            .bind(worktree_id)
            .fetch_all(&mut *tx)
            .await?;
    if !ids.is_empty() {
        let placeholders = vec!["?"; ids.len()].join(",");
        let sql = format!(
            "DELETE FROM terminal_sessions WHERE repo = ? AND term_key IN ({placeholders})"
        );
        let mut q = sqlx::query(&sql).bind(repo);
        for (id,) in &ids {
            q = q.bind(term_key(worktree_id, id));
        }
        q.execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_db(name: &str) -> Db {
        let base = std::env::temp_dir().join(format!("santree-tabs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        crate::db::init(base.join("test.db")).await.unwrap()
    }

    #[tokio::test]
    async fn add_list_rename_remove_roundtrip() {
        let db = test_db("crud").await;

        add(&db, "repo", "AK-1", "tab-a", TabKind::Claude, "Claude")
            .await
            .unwrap();
        add(
            &db,
            "repo",
            "AK-1",
            "tab-b",
            TabKind::Terminal,
            "Terminal 2",
        )
        .await
        .unwrap();
        add(&db, "repo", "AK-2", "tab-c", TabKind::Claude, "Claude")
            .await
            .unwrap();

        let tabs = list(&db, "repo").await.unwrap();
        assert_eq!(tabs.len(), 3);
        // Ordered by worktree then position (open order).
        assert_eq!(tabs[0].id, "tab-a");
        assert_eq!(tabs[0].kind, TabKind::Claude);
        assert_eq!(tabs[1].id, "tab-b");
        assert_eq!(tabs[1].kind, TabKind::Terminal);
        assert_eq!(tabs[2].worktree_id, "AK-2");

        rename(&db, "repo", "tab-a", "  Debugging the parser  ")
            .await
            .unwrap();
        let tabs = list(&db, "repo").await.unwrap();
        assert_eq!(tabs[0].title, "Debugging the parser");

        assert!(rename(&db, "repo", "tab-a", "   ").await.is_err());

        remove(&db, "repo", "tab-b").await.unwrap();
        let tabs = list(&db, "repo").await.unwrap();
        assert_eq!(
            tabs.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            ["tab-a", "tab-c"]
        );
    }

    #[tokio::test]
    async fn accepts_fix_ci_kind() {
        // Migration 0013 widened the kind CHECK to include 'fixci'; without it this
        // INSERT fails the constraint (the AK-84 "Fix CI with AI" bug).
        let db = test_db("fixci").await;
        add(&db, "repo", "AK-1", "tab-fix", TabKind::FixCi, "Fix CI")
            .await
            .unwrap();
        let tabs = list(&db, "repo").await.unwrap();
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].kind, TabKind::FixCi);
        assert_eq!(tabs[0].title, "Fix CI");
    }

    #[tokio::test]
    async fn removing_a_claude_tab_forgets_its_session() {
        let db = test_db("session").await;
        add(&db, "repo", "AK-1", "tab-a", TabKind::Claude, "Claude")
            .await
            .unwrap();
        // Simulate the session the tab's first launch would have minted.
        sqlx::query(
            "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id) VALUES (?, ?, ?, ?)",
        )
        .bind("repo")
        .bind(term_key("AK-1", "tab-a"))
        .bind("/tmp/wt")
        .bind("sess-1")
        .execute(&db)
        .await
        .unwrap();

        remove(&db, "repo", "tab-a").await.unwrap();

        let left: Option<(String,)> =
            sqlx::query_as("SELECT session_id FROM terminal_sessions WHERE repo = 'repo'")
                .fetch_optional(&db)
                .await
                .unwrap();
        assert_eq!(left, None);
    }

    #[tokio::test]
    async fn remove_for_worktree_drops_only_that_worktrees_tabs_and_sessions() {
        let db = test_db("wt").await;
        add(&db, "repo", "AK-1", "tab-a", TabKind::Claude, "Claude")
            .await
            .unwrap();
        add(&db, "repo", "AK-2", "tab-b", TabKind::Claude, "Claude")
            .await
            .unwrap();
        for (wt, tab) in [("AK-1", "tab-a"), ("AK-2", "tab-b")] {
            sqlx::query(
                "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id) VALUES (?, ?, ?, ?)",
            )
            .bind("repo")
            .bind(term_key(wt, tab))
            .bind("/tmp/wt")
            .bind(format!("sess-{tab}"))
            .execute(&db)
            .await
            .unwrap();
        }

        remove_for_worktree(&db, "repo", "AK-1").await.unwrap();

        let tabs = list(&db, "repo").await.unwrap();
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].worktree_id, "AK-2");
        let keys: Vec<(String,)> =
            sqlx::query_as("SELECT term_key FROM terminal_sessions WHERE repo = 'repo'")
                .fetch_all(&db)
                .await
                .unwrap();
        assert_eq!(keys, vec![(term_key("AK-2", "tab-b"),)]);
    }
}
