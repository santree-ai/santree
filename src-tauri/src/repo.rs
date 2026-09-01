//! Repository registry: list the repos from the database, and add a new one by
//! validating that a chosen folder is a git work tree.
//!
//! Git is shelled out to (no third-party crate) — the same approach the santree
//! CLI uses. The repo's identity (name + tracker) is derived from its `origin`
//! remote when present, falling back to the folder name.

use std::path::Path;

use anyhow::{anyhow, bail, Result};

use santree_core::domain::Repo;

use crate::db::Db;
use crate::git;
use crate::linear;

/// Every registered repository, in insertion order. The displayed tracker
/// reflects the Linear org the repo actually resolves to (its explicit link, or
/// the only connected org) — so a GitHub-hosted repo whose issues live in Linear
/// reads "Linear · <workspace>", not "GitHub Issues". `agents` is a live count of
/// worktree links (one per issue with an active agent worktree) rather than a
/// stored column, so it always reflects reality.
pub async fn list(db: &Db) -> Result<Vec<Repo>> {
    let rows = sqlx::query_as::<_, (String, String, Option<String>, Option<String>, i64)>(
        "SELECT r.name, r.tracker, r.path, r.linear_org_slug,
                (SELECT COUNT(*) FROM worktree_links wl WHERE wl.repo_path = r.path)
         FROM repos r ORDER BY r.rowid",
    )
    .fetch_all(db)
    .await?;
    // The label has to name the org the repo's queries actually go to, so it comes
    // from the same resolver they do rather than a second copy of the fallback.
    let orgs = linear::orgs_by_name(db).await?;

    Ok(rows
        .into_iter()
        .map(|(name, tracker, path, linked_slug, agents)| {
            let org_name = linear::resolved_org(&orgs, linked_slug.as_deref())
                .map(|(_, org_name)| org_name.clone());
            Repo {
                name,
                tracker: match org_name {
                    Some(org) => format!("Linear · {org}"),
                    None => tracker,
                },
                agents: agents as u32,
                path,
            }
        })
        .collect())
}

/// Every registered repo's stored top-level path, in insertion order. Deliberately
/// not [`list`]: that one resolves Linear orgs to build display labels, and the
/// callers here are asking a filesystem question.
pub(crate) async fn paths(db: &Db) -> Result<Vec<String>> {
    Ok(sqlx::query_as::<_, (String,)>(
        "SELECT path FROM repos WHERE path IS NOT NULL ORDER BY rowid",
    )
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|(path,)| path)
    .collect())
}

/// The stored top-level path of a registered repo, if it has one.
pub async fn path(db: &Db, name: &str) -> Result<Option<String>> {
    let row: Option<(Option<String>,)> = sqlx::query_as("SELECT path FROM repos WHERE name = ?")
        .bind(name)
        .fetch_optional(db)
        .await?;
    Ok(row.and_then(|(p,)| p))
}

/// Validate that `path` is inside a git work tree and register it. The stored
/// path is the repo's top level (so adding a subdirectory still works). Adding
/// the same *path* twice just refreshes it — the call is idempotent.
///
/// A row is identified by its path, not by its derived `owner/repo` name: two
/// checkouts of the same GitHub repo derive the same name, and repointing the
/// existing row at the second one would orphan every `worktree_links` row keyed
/// on the first path — its worktrees would silently vanish from the sidebar. The
/// name is still what the rest of the app *calls* a repo (settings scope, IPC
/// args), so a colliding one is qualified rather than reused.
pub async fn add(db: &Db, path: String) -> Result<Repo> {
    // The folder check and both git calls block; run validation+identity off the
    // async runtime's worker threads before touching the db.
    let (toplevel, derived, tracker) =
        tokio::task::spawn_blocking(move || -> Result<(String, String, String)> {
            let dir = Path::new(&path);
            if !dir.is_dir() {
                bail!("That path isn't a folder.");
            }
            let toplevel = git::git(dir, &["rev-parse", "--show-toplevel"])
                .ok()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow!("That folder isn't a git repository."))?;
            let top = Path::new(&toplevel);
            let remote = git::git(top, &["remote", "get-url", "origin"])
                .ok()
                .filter(|s| !s.is_empty());
            let (name, tracker) = identity(remote.as_deref(), top);
            Ok((toplevel, name, tracker))
        })
        .await??;

    let registered: Option<(String,)> = sqlx::query_as("SELECT name FROM repos WHERE path = ?")
        .bind(&toplevel)
        .fetch_optional(db)
        .await?;

    let name = match registered {
        // Already registered: refresh the tracker but keep the stored name — a
        // rename (the remote moved) would strand its `repo:<name>` settings scope.
        Some((name,)) => {
            sqlx::query("UPDATE repos SET tracker = ? WHERE path = ?")
                .bind(&tracker)
                .bind(&toplevel)
                .execute(db)
                .await?;
            name
        }
        None => {
            let name = free_name(db, &derived, Path::new(&toplevel)).await?;
            sqlx::query("INSERT INTO repos (name, tracker, path) VALUES (?, ?, ?)")
                .bind(&name)
                .bind(&tracker)
                .bind(&toplevel)
                .execute(db)
                .await?;
            name
        }
    };

    // Usually 0 for a fresh repo, but re-adding an already-registered one
    // (the call is idempotent) can have existing worktree links.
    let (agents,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM worktree_links WHERE repo_path = ?")
            .bind(&toplevel)
            .fetch_one(db)
            .await?;

    log::info!("registered repository {name} at {toplevel}");
    Ok(Repo {
        name,
        tracker,
        agents: agents as u32,
        path: Some(toplevel),
    })
}

/// A free registry name for a checkout that isn't registered yet: its derived
/// `owner/repo`, or — when another checkout already holds that — the same name
/// qualified with the folder it lives in (`akamai/agent (agent-fork)`), so both
/// stay addressable. The name is the app's repo identity, so it must be unique;
/// the derived one isn't.
async fn free_name(db: &Db, derived: &str, top: &Path) -> Result<String> {
    if !name_taken(db, derived).await? {
        return Ok(derived.to_string());
    }
    let folder = top
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("checkout");
    let mut n = 1;
    loop {
        let candidate = if n == 1 {
            format!("{derived} ({folder})")
        } else {
            format!("{derived} ({folder} {n})")
        };
        if !name_taken(db, &candidate).await? {
            return Ok(candidate);
        }
        n += 1;
    }
}

async fn name_taken(db: &Db, name: &str) -> Result<bool> {
    let row: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM repos WHERE name = ?")
        .bind(name)
        .fetch_optional(db)
        .await?;
    Ok(row.is_some())
}

/// Derive `(name, tracker)` for a repo: prefer the GitHub `owner/repo` from the
/// origin remote, otherwise the folder name as a local checkout.
fn identity(remote: Option<&str>, top: &Path) -> (String, String) {
    if let Some(slug) = remote.and_then(github_slug) {
        return (slug, "GitHub Issues".into());
    }
    let name = top
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("repo")
        .to_string();
    (name, "Local git".into())
}

/// Parse `owner/repo` out of a GitHub remote URL (ssh or https forms).
pub(crate) fn github_slug(url: &str) -> Option<String> {
    let url = url.trim();
    let path = if let Some(rest) = url.strip_prefix("git@github.com:") {
        rest.to_string()
    } else {
        let parsed = reqwest::Url::parse(url).ok()?;
        if !matches!(parsed.scheme(), "https" | "ssh")
            || parsed.host_str() != Some("github.com")
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return None;
        }
        parsed.path().to_string()
    };
    let slug = path.strip_suffix(".git").unwrap_or(&path).trim_matches('/');
    let mut components = slug.split('/');
    let owner = components.next()?;
    let name = components.next()?;
    if components.next().is_some()
        || !valid_github_component(owner)
        || !valid_github_component(name)
    {
        return None;
    }
    Some(format!("{owner}/{name}"))
}

pub(crate) fn valid_github_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A git repo at `dir` with `remote` as its origin, returned as the path
    /// string the frontend would pass to [`add`].
    fn init_repo(dir: &Path, remote: &str) -> String {
        std::fs::create_dir_all(dir).unwrap();
        for args in [
            vec!["init", "-b", "main"],
            vec!["remote", "add", "origin", remote],
        ] {
            let ok = std::process::Command::new("git")
                .current_dir(dir)
                .args(&args)
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?} failed");
        }
        dir.to_string_lossy().to_string()
    }

    /// A second checkout of the same GitHub repo derives the same name — it must
    /// get its own row rather than repoint the first one's path, which would
    /// orphan every worktree linked to that path.
    #[tokio::test]
    async fn second_checkout_of_a_remote_never_repoints_the_first() {
        let base = std::env::temp_dir().join(format!("santree-repo-add-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        let remote = "git@github.com:akamai/agent.git";

        let first = add(&db, init_repo(&base.join("agent"), remote))
            .await
            .unwrap();
        assert_eq!(first.name, "akamai/agent");
        let first_path = first.path.clone().unwrap();

        // A worktree the user is actively working in, keyed on the first checkout.
        sqlx::query(
            "INSERT INTO worktree_links (repo_path, issue_id, branch, worktree_path, base_branch)
             VALUES (?, 'AK-1', 'ak-1', '/wt/AK-1', 'main')",
        )
        .bind(&first_path)
        .execute(&db)
        .await
        .unwrap();

        let second = add(&db, init_repo(&base.join("agent-fork"), remote))
            .await
            .unwrap();
        assert_eq!(
            second.name, "akamai/agent (agent-fork)",
            "the colliding name is qualified by the checkout's folder"
        );
        assert_ne!(second.path, first.path);

        // The first repo still points at its own checkout, and still owns its worktree.
        assert_eq!(path(&db, "akamai/agent").await.unwrap(), Some(first_path));
        let repos = list(&db).await.unwrap();
        assert_eq!(repos.len(), 2);
        assert_eq!(repos[0].agents, 1, "worktree link survived the second add");
        assert_eq!(repos[1].agents, 0);

        // Re-adding a registered path is still idempotent — no new row, same name.
        let again = add(&db, base.join("agent").to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(again.name, "akamai/agent");
        assert_eq!(list(&db).await.unwrap().len(), 2);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn parses_github_remotes() {
        assert_eq!(
            github_slug("git@github.com:akamai/agent.git").as_deref(),
            Some("akamai/agent")
        );
        assert_eq!(
            github_slug("https://github.com/akamai/web-dashboard").as_deref(),
            Some("akamai/web-dashboard")
        );
        assert_eq!(github_slug("https://gitlab.com/akamai/agent.git"), None);
        assert_eq!(
            github_slug("https://github.com.evil.test/akamai/agent.git"),
            None
        );
        assert_eq!(
            github_slug("https://github.com/akamai/agent/../../../victim"),
            None
        );
        assert_eq!(github_slug("git@github.com:akamai/agent/extra.git"), None);
        assert_eq!(github_slug("https://github.com/akamai/.."), None);
    }
}
