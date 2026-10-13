//! A repo's ticket connection: the one Linear org or Jira site its tickets come
//! from, stored as a provider-qualified id (`linear:<slug>`, `jira:<cloud_id>`) in
//! `repos.connection`.
//!
//! The id, not the display name, is the identity: two Linear workspaces can share
//! a name, and a Linear team key can equal a Jira project key. Everything that
//! groups repos "by tracker" keys on this.
//!
//! There is no fallback. A repo reads the connection it is linked to, or none. The
//! migration froze what every repo used to resolve to, and the database links the
//! repos that are waiting when an install makes its first connection
//! (`0038_repo_connection.sql`); past that, with two connections to choose from,
//! the choice is the user's. [`adopt_sole`] is the same rule for a repo added
//! later.

use anyhow::{bail, Result};
use santree_core::domain::TicketProvider;

use crate::db::Db;

/// Every connection that exists, as ids. A new provider adds its table here.
const ALL: &str = "SELECT 'linear:' || slug AS id FROM linear_orgs
                   UNION ALL SELECT 'jira:' || cloud_id FROM jira_sites";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionRef {
    pub provider: TicketProvider,
    /// The provider's own key: a Linear org slug, a Jira cloud id.
    pub key: String,
}

impl ConnectionRef {
    pub fn linear(slug: impl Into<String>) -> Self {
        Self {
            provider: TicketProvider::Linear,
            key: slug.into(),
        }
    }

    pub fn jira(cloud_id: impl Into<String>) -> Self {
        Self {
            provider: TicketProvider::Jira,
            key: cloud_id.into(),
        }
    }

    pub fn parse(id: &str) -> Option<Self> {
        let (prefix, key) = id.split_once(':')?;
        if key.is_empty() {
            return None;
        }
        match prefix {
            "linear" => Some(Self::linear(key)),
            "jira" => Some(Self::jira(key)),
            _ => None,
        }
    }

    pub fn id(&self) -> String {
        let prefix = match self.provider {
            TicketProvider::Linear => "linear",
            TicketProvider::Jira => "jira",
        };
        format!("{prefix}:{}", self.key)
    }
}

/// The connection a repo is linked to, or `None` when it has none (or names one
/// this build can't read).
pub async fn of(db: &Db, repo: &str) -> Result<Option<ConnectionRef>> {
    let stored: Option<Option<String>> =
        sqlx::query_scalar("SELECT connection FROM repos WHERE name = ?")
            .bind(repo)
            .fetch_optional(db)
            .await?;
    Ok(stored.flatten().and_then(|id| ConnectionRef::parse(&id)))
}

async fn exists(db: &Db, connection: &ConnectionRef) -> Result<bool> {
    let found: Option<String> = sqlx::query_scalar(&format!("SELECT id FROM ({ALL}) WHERE id = ?"))
        .bind(connection.id())
        .fetch_optional(db)
        .await?;
    Ok(found.is_some())
}

/// Link a repo to a connection, replacing whatever it had. Updates the existing
/// repo row only, so a name that isn't registered can't mint a half-populated one.
pub async fn set(db: &Db, repo: &str, connection: &ConnectionRef) -> Result<()> {
    if !exists(db, connection).await? {
        bail!("{} isn't connected", connection.id());
    }
    let affected = sqlx::query("UPDATE repos SET connection = ? WHERE name = ?")
        .bind(connection.id())
        .bind(repo)
        .execute(db)
        .await?
        .rows_affected();
    if affected == 0 {
        bail!("repo '{repo}' is not registered");
    }
    Ok(())
}

/// Link a repo to the connection `id` names, or (with `None`) take it off its
/// tracker. The id crosses IPC, so it is parsed here and must name a connection
/// that exists.
pub async fn link(db: &Db, repo: &str, id: Option<&str>) -> Result<()> {
    match id {
        Some(id) => {
            let Some(connection) = ConnectionRef::parse(id) else {
                bail!("'{id}' isn't a ticket connection");
            };
            set(db, repo, &connection).await
        }
        None => {
            let affected = sqlx::query("UPDATE repos SET connection = NULL WHERE name = ?")
                .bind(repo)
                .execute(db)
                .await?
                .rows_affected();
            if affected == 0 {
                bail!("repo '{repo}' is not registered");
            }
            Ok(())
        }
    }
}

/// Link a repo that has no connection to the only one there is. A no-op with none
/// to take or with several to choose between.
pub async fn adopt_sole(db: &Db, repo: &str) -> Result<()> {
    sqlx::query(&format!(
        "UPDATE repos SET connection = (SELECT id FROM ({ALL}))
         WHERE name = ? AND connection IS NULL AND (SELECT COUNT(*) FROM ({ALL})) = 1"
    ))
    .bind(repo)
    .execute(db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_db(label: &str) -> (std::path::PathBuf, Db) {
        let dir =
            std::env::temp_dir().join(format!("santree-connection-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let db = crate::db::init(dir.join("test.db")).await.unwrap();
        (dir, db)
    }

    async fn add_repo(db: &Db, name: &str) {
        sqlx::query("INSERT INTO repos (name, tracker, path) VALUES (?, 'GitHub Issues', ?)")
            .bind(name)
            .bind(format!("/tmp/{name}"))
            .execute(db)
            .await
            .unwrap();
    }

    async fn add_org(db: &Db, slug: &str) {
        sqlx::query("INSERT INTO linear_orgs (slug, name, expires_at) VALUES (?, ?, 0)")
            .bind(slug)
            .bind(slug.to_uppercase())
            .execute(db)
            .await
            .unwrap();
    }

    async fn add_site(db: &Db, cloud_id: &str) {
        sqlx::query(
            "INSERT INTO jira_sites (cloud_id, site_name, site_url, expires_at)
             VALUES (?, ?, 'https://x.atlassian.net', 0)",
        )
        .bind(cloud_id)
        .bind(cloud_id)
        .execute(db)
        .await
        .unwrap();
    }

    async fn stored(db: &Db, repo: &str) -> Option<String> {
        sqlx::query_scalar("SELECT connection FROM repos WHERE name = ?")
            .bind(repo)
            .fetch_one(db)
            .await
            .unwrap()
    }

    #[test]
    fn an_id_round_trips_and_refuses_what_it_cannot_read() {
        for c in [ConnectionRef::linear("acme"), ConnectionRef::jira("c-1")] {
            assert_eq!(ConnectionRef::parse(&c.id()), Some(c));
        }
        for bad in ["", "linear", "linear:", "ticktick:x", ":x"] {
            assert_eq!(ConnectionRef::parse(bad), None, "{bad}");
        }
    }

    /// The first connection an install makes takes every waiting repo; the second
    /// takes none, and a repo that picked is never moved by either.
    #[tokio::test]
    async fn only_the_first_connection_adopts_waiting_repos() {
        let (dir, db) = test_db("adopt").await;
        add_repo(&db, "waiting").await;
        add_repo(&db, "picked").await;

        add_org(&db, "acme").await;
        assert_eq!(stored(&db, "waiting").await.as_deref(), Some("linear:acme"));

        add_site(&db, "site-1").await;
        add_repo(&db, "later").await;
        adopt_sole(&db, "later").await.unwrap();
        assert_eq!(stored(&db, "later").await, None, "two to choose from");

        set(&db, "picked", &ConnectionRef::jira("site-1"))
            .await
            .unwrap();
        add_org(&db, "beta").await;
        assert_eq!(stored(&db, "picked").await.as_deref(), Some("jira:site-1"));
        assert_eq!(stored(&db, "later").await, None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Disconnecting unlinks, and the sole connection left is not guessed at.
    #[tokio::test]
    async fn disconnecting_unlinks_its_repos_and_nothing_falls_back() {
        let (dir, db) = test_db("unlink").await;
        add_org(&db, "acme").await;
        add_site(&db, "site-1").await;
        add_repo(&db, "app").await;
        set(&db, "app", &ConnectionRef::linear("acme"))
            .await
            .unwrap();

        sqlx::query("DELETE FROM linear_orgs WHERE slug = 'acme'")
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(of(&db, "app").await.unwrap(), None);

        assert!(set(&db, "app", &ConnectionRef::linear("acme"))
            .await
            .is_err());
        assert!(set(&db, "ghost", &ConnectionRef::jira("site-1"))
            .await
            .is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// What the Settings picker and the add-project prompt send: an id from the
    /// wire, or `None` for "no tracker".
    #[tokio::test]
    async fn linking_by_id_refuses_what_it_cannot_read_and_none_unlinks() {
        let (dir, db) = test_db("link").await;
        add_org(&db, "acme").await;
        add_site(&db, "site-1").await;
        add_repo(&db, "app").await;

        link(&db, "app", Some("jira:site-1")).await.unwrap();
        assert_eq!(stored(&db, "app").await.as_deref(), Some("jira:site-1"));
        link(&db, "app", Some("linear:acme")).await.unwrap();
        assert_eq!(stored(&db, "app").await.as_deref(), Some("linear:acme"));

        for bad in ["", "acme", "ticktick:x", "linear:ghost", "jira:"] {
            assert!(link(&db, "app", Some(bad)).await.is_err(), "{bad}");
        }
        assert_eq!(stored(&db, "app").await.as_deref(), Some("linear:acme"));

        link(&db, "app", None).await.unwrap();
        assert_eq!(stored(&db, "app").await, None);
        assert!(link(&db, "ghost", None).await.is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
