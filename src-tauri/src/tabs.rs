//! Persisted extra main-area tabs for Trees (the "+" menu): Claude agent tabs
//! and plain terminal tabs, stored in `worktree_tabs` so they come back after
//! an app restart. A Claude tab's conversation lives in the shared session
//! registry (`terminal_sessions`) under [`term_key`], so reopening it resumes
//! the same conversation; a terminal tab just reopens a fresh shell (a dead
//! shell's history can't be restored).

use anyhow::{bail, Result};
use santree_core::domain::{AgentKind, TabKind, TabPr, WorktreeTab};

use crate::db::Db;

/// A tab on its way into the table. Grouped rather than passed as eight positional
/// arguments because `kind`, `agent_kind` and `pr` are interdependent — see the
/// validation in [`add`].
pub struct NewTab<'a> {
    pub worktree_id: &'a str,
    pub id: &'a str,
    pub kind: TabKind,
    pub agent_kind: Option<AgentKind>,
    pub title: &'a str,
    /// The pull request a review tab relaunches from. Required for (and only for)
    /// the review kinds.
    pub pr: Option<TabPr>,
}

/// The session-registry key for a Claude tab — the same key the frontend uses
/// as the PTY `refId`, so the two sides always name one logical terminal the
/// same way.
pub fn term_key(worktree_id: &str, tab_id: &str) -> String {
    format!("tree:{worktree_id}:tab:{tab_id}")
}

/// The columns every read selects, in the order [`row_to_tab`] destructures them.
const COLUMNS: &str = "id, worktree_id, kind, agent_kind, title, pr_repo, pr_number";

type Row = (
    String,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<u32>,
);

fn row_to_tab(row: Row) -> Result<WorktreeTab> {
    let (id, worktree_id, raw_kind, raw_agent, title, pr_repo, pr_number) = row;
    let kind = TabKind::from_db_str(&raw_kind);
    let agent_kind = match kind {
        TabKind::Terminal => None,
        TabKind::Agent | TabKind::FixCi | TabKind::AiReview => Some(
            raw_agent
                .ok_or_else(|| anyhow::anyhow!("agent tab {id:?} has no provider"))?
                .parse()?,
        ),
    };
    Ok(WorktreeTab {
        id,
        worktree_id,
        kind,
        agent_kind,
        title,
        // The column pair is written and checked together, so `zip` can only drop a
        // half that the schema forbids from existing.
        pr: pr_repo
            .zip(pr_number)
            .map(|(repo, number)| TabPr { repo, number }),
    })
}

/// All extra tabs for the repo (every worktree), in open order.
pub async fn list(db: &Db, repo: &str) -> Result<Vec<WorktreeTab>> {
    let sql = format!(
        "SELECT {COLUMNS} FROM worktree_tabs WHERE repo = ? ORDER BY worktree_id, position"
    );
    let rows: Vec<Row> = sqlx::query_as(&sql).bind(repo).fetch_all(db).await?;
    rows.into_iter().map(row_to_tab).collect()
}

/// One tab by id, or `None` when it's gone (a tab closed in another window, a row
/// this repo never had). Used by the resume path, which needs the persisted `kind`
/// and PR to re-derive what the tab launches with.
pub async fn get(db: &Db, repo: &str, id: &str) -> Result<Option<WorktreeTab>> {
    let sql = format!("SELECT {COLUMNS} FROM worktree_tabs WHERE repo = ? AND id = ?");
    let row: Option<Row> = sqlx::query_as(&sql)
        .bind(repo)
        .bind(id)
        .fetch_optional(db)
        .await?;
    row.map(row_to_tab).transpose()
}

/// Persist a new tab. The frontend mints the id (so it can patch its cache and
/// focus the tab optimistically) and picks the initial title.
///
/// The next position is computed by a subquery *inside* the INSERT, not by a
/// separate SELECT: SQLite takes the write lock before executing a write
/// statement, so the `MAX(position)` read happens under it and concurrent adds
/// serialize onto distinct positions. Split into two statements and they'd race
/// (see `concurrent_adds_get_distinct_positions`).
pub async fn add(db: &Db, repo: &str, tab: NewTab<'_>) -> Result<()> {
    let NewTab {
        worktree_id,
        id,
        kind,
        agent_kind,
        title,
        pr,
    } = tab;
    let title = title.trim();
    if title.is_empty() {
        bail!("tab title can't be empty");
    }
    match (kind, agent_kind) {
        (TabKind::Terminal, Some(_)) => bail!("terminal tabs cannot have an agent provider"),
        (TabKind::Agent | TabKind::FixCi | TabKind::AiReview, None) => {
            bail!("agent tabs require a provider")
        }
        _ => {}
    }
    // A review tab's `--settings` and `--mcp-config` are re-derived from this pair
    // every time it opens, so a row without it would silently resume under the plain
    // no-git profile — no `gh` deny rules, no review tools. Storing one on a tab that
    // derives nothing from it is equally wrong: it would be an unread claim about
    // which PR the tab belongs to.
    if kind.is_review() != pr.is_some() {
        bail!("a review tab is stored with its pull request, and only a review tab is");
    }
    // The slug becomes a filename (`hooks::mcp_stem`) and is checked again there,
    // but a malformed one has no business reaching the table in the first place.
    if let Some(pr) = &pr {
        crate::github::split_slug(&pr.repo)?;
    }
    sqlx::query(
        "INSERT INTO worktree_tabs
             (id, repo, worktree_id, kind, agent_kind, title, pr_repo, pr_number, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?,
                 (SELECT COALESCE(MAX(position), 0) + 1 FROM worktree_tabs
                  WHERE repo = ? AND worktree_id = ?))",
    )
    .bind(id)
    .bind(repo)
    .bind(worktree_id)
    .bind(kind.as_db_str())
    .bind(agent_kind.map(AgentKind::as_str))
    .bind(title)
    .bind(pr.as_ref().map(|p| p.repo.as_str()))
    .bind(pr.as_ref().map(|p| p.number))
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

    /// A plain agent tab — the shape most of these tests only need to exist.
    fn agent<'a>(worktree_id: &'a str, id: &'a str, title: &'a str) -> NewTab<'a> {
        NewTab {
            worktree_id,
            id,
            kind: TabKind::Agent,
            agent_kind: Some(AgentKind::Claude),
            title,
            pr: None,
        }
    }

    fn review<'a>(worktree_id: &'a str, id: &'a str, kind: TabKind, title: &'a str) -> NewTab<'a> {
        NewTab {
            worktree_id,
            id,
            kind,
            agent_kind: Some(AgentKind::Claude),
            title,
            pr: Some(TabPr {
                repo: "acme/app".into(),
                number: 42,
            }),
        }
    }

    #[tokio::test]
    async fn add_list_rename_remove_roundtrip() {
        let db = test_db("crud").await;

        add(&db, "repo", agent("AK-1", "tab-a", "Claude"))
            .await
            .unwrap();
        add(
            &db,
            "repo",
            NewTab {
                worktree_id: "AK-1",
                id: "tab-b",
                kind: TabKind::Terminal,
                agent_kind: None,
                title: "Terminal 2",
                pr: None,
            },
        )
        .await
        .unwrap();
        add(&db, "repo", agent("AK-2", "tab-c", "Claude"))
            .await
            .unwrap();

        let tabs = list(&db, "repo").await.unwrap();
        assert_eq!(tabs.len(), 3);
        // Ordered by worktree then position (open order).
        assert_eq!(tabs[0].id, "tab-a");
        assert_eq!(tabs[0].kind, TabKind::Agent);
        assert_eq!(tabs[0].agent_kind, Some(AgentKind::Claude));
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
    async fn concurrent_adds_get_distinct_positions() {
        let db = test_db("race").await;
        // sqlx runs each pooled connection's statements on its own thread, so these
        // eight adds genuinely contend for the same `MAX(position) + 1`.
        let adds = (0..8).map(|i| {
            let db = db.clone();
            async move {
                let id = format!("tab-{i}");
                add(
                    &db,
                    "repo",
                    NewTab {
                        worktree_id: "AK-1",
                        id: &id,
                        kind: TabKind::Terminal,
                        agent_kind: None,
                        title: "Terminal",
                        pr: None,
                    },
                )
                .await
                .unwrap();
            }
        });
        futures::future::join_all(adds).await;

        let mut positions: Vec<i64> =
            sqlx::query_as("SELECT position FROM worktree_tabs WHERE repo = 'repo'")
                .fetch_all(&db)
                .await
                .unwrap()
                .into_iter()
                .map(|(p,): (i64,)| p)
                .collect();
        positions.sort_unstable();
        assert_eq!(
            positions,
            (1..=8).collect::<Vec<_>>(),
            "each add must claim its own position — duplicates make tab order nondeterministic"
        );
    }

    /// Migration 0013 widened the kind CHECK to include 'fixci' (the AK-84 bug) and
    /// 0030 added 'ai_review'; without either the INSERT fails the constraint.
    #[tokio::test]
    async fn accepts_both_review_kinds() {
        let db = test_db("review-kinds").await;
        add(
            &db,
            "repo",
            review("AK-1", "tab-fix", TabKind::FixCi, "Address review"),
        )
        .await
        .unwrap();
        add(
            &db,
            "repo",
            review("AK-1", "tab-ai", TabKind::AiReview, "AI review"),
        )
        .await
        .unwrap();
        let tabs = list(&db, "repo").await.unwrap();
        assert_eq!(
            tabs.iter().map(|t| t.kind).collect::<Vec<_>>(),
            [TabKind::FixCi, TabKind::AiReview]
        );
        assert_eq!(tabs[1].title, "AI review");
    }

    /// The H2 fix: the PR identity is what a resumed review tab re-derives its
    /// `--settings` and `--mcp-config` from, so it has to survive the round trip.
    #[tokio::test]
    async fn a_review_tab_round_trips_its_pull_request() {
        let db = test_db("review-pr").await;
        add(
            &db,
            "repo",
            review("AK-1", "tab-ai", TabKind::AiReview, "AI review"),
        )
        .await
        .unwrap();

        let tab = get(&db, "repo", "tab-ai").await.unwrap().unwrap();
        assert_eq!(
            tab.pr,
            Some(TabPr {
                repo: "acme/app".into(),
                number: 42
            })
        );
        assert!(tab.kind.is_review());
        assert_eq!(get(&db, "repo", "nope").await.unwrap(), None);
        // Another repo's row is not this repo's tab, even by the same id.
        assert_eq!(get(&db, "other", "tab-ai").await.unwrap(), None);
    }

    #[tokio::test]
    async fn provider_identity_is_required_exactly_for_agent_tabs() {
        let db = test_db("provider-invariant").await;
        assert!(add(
            &db,
            "repo",
            NewTab {
                agent_kind: None,
                ..agent("AK-1", "agent-without-provider", "Agent")
            },
        )
        .await
        .is_err());
        assert!(add(
            &db,
            "repo",
            NewTab {
                kind: TabKind::Terminal,
                ..agent("AK-1", "terminal-with-provider", "Terminal")
            },
        )
        .await
        .is_err());
    }

    /// The launch configuration is derived from the PR, so a review tab without one
    /// resumes under the wrong settings — and a PR on a tab that derives nothing
    /// from it is an unread claim about which PR the tab belongs to.
    #[tokio::test]
    async fn a_pull_request_is_stored_exactly_on_the_review_kinds() {
        let db = test_db("pr-invariant").await;
        assert!(add(
            &db,
            "repo",
            NewTab {
                kind: TabKind::AiReview,
                ..agent("AK-1", "ai-review-without-pr", "AI review")
            },
        )
        .await
        .is_err());
        assert!(add(
            &db,
            "repo",
            NewTab {
                kind: TabKind::Agent,
                ..review("AK-1", "agent-with-pr", TabKind::Agent, "Claude")
            },
        )
        .await
        .is_err());
        // A slug that can't name a repo can't name the MCP config file either.
        assert!(add(
            &db,
            "repo",
            NewTab {
                pr: Some(TabPr {
                    repo: "not-a-slug".into(),
                    number: 42
                }),
                ..review("AK-1", "bad-slug", TabKind::AiReview, "AI review")
            },
        )
        .await
        .is_err());
    }

    /// 0030 rebuilt the table, and `DROP TABLE` takes a table's indexes with it.
    /// The rebuild has to put every one back by hand (0029 paid for this once
    /// already, where a missing partial UNIQUE index broke `ON CONFLICT`).
    #[tokio::test]
    async fn the_table_rebuild_kept_every_index() {
        let db = test_db("indexes").await;
        let indexes: Vec<(String, Option<String>)> = sqlx::query_as(
            "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'worktree_tabs'
             ORDER BY name",
        )
        .fetch_all(&db)
        .await
        .unwrap();
        let named: Vec<&str> = indexes
            .iter()
            .filter(|(_, sql)| sql.is_some()) // skip the implicit PRIMARY KEY index
            .map(|(name, _)| name.as_str())
            .collect();
        assert_eq!(named, ["idx_worktree_tabs_repo"]);
        assert!(indexes.iter().any(|(_, sql)| sql
            .as_deref()
            .is_some_and(|s| s.contains("(repo, worktree_id, position)"))));
        // And no stale rebuild artefact was left behind.
        let leftovers: Vec<(String,)> =
            sqlx::query_as("SELECT name FROM sqlite_master WHERE name LIKE 'worktree_tabs_new%'")
                .fetch_all(&db)
                .await
                .unwrap();
        assert!(leftovers.is_empty(), "0030 left {leftovers:?} behind");
    }

    #[tokio::test]
    async fn removing_a_claude_tab_forgets_its_session() {
        let db = test_db("session").await;
        add(&db, "repo", agent("AK-1", "tab-a", "Claude"))
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
        add(&db, "repo", agent("AK-1", "tab-a", "Claude"))
            .await
            .unwrap();
        add(&db, "repo", agent("AK-2", "tab-b", "Claude"))
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
