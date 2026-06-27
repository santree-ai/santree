//! Repository registry: list the repos from the database, and add a new one by
//! validating that a chosen folder is a git work tree.
//!
//! Git is shelled out to (no third-party crate) — the same approach the santree
//! CLI uses. The repo's identity (name + tracker) is derived from its `origin`
//! remote when present, falling back to the folder name.

use std::path::Path;
use std::process::Command;

use anyhow::{anyhow, bail, Result};

use santree_core::domain::Repo;

use crate::db::Db;

/// Every registered repository, in insertion order. The displayed tracker
/// reflects the Linear org the repo actually resolves to (its explicit link, or
/// the only connected org) — so a GitHub-hosted repo whose issues live in Linear
/// reads "Linear · <workspace>", not "GitHub Issues".
pub async fn list(db: &Db) -> Result<Vec<Repo>> {
    let rows = sqlx::query_as::<_, (String, String, i64, Option<String>, Option<String>)>(
        "SELECT name, tracker, agents, path, linear_org_slug FROM repos ORDER BY rowid",
    )
    .fetch_all(db)
    .await?;
    let orgs =
        sqlx::query_as::<_, (String, String)>("SELECT slug, name FROM linear_orgs ORDER BY name")
            .fetch_all(db)
            .await?;
    let first_org = orgs.first();

    Ok(rows
        .into_iter()
        .map(|(name, tracker, agents, path, linked_slug)| {
            // The org the repo resolves to: explicit link, else the only/first org.
            let org_name = linked_slug
                .and_then(|slug| orgs.iter().find(|(s, _)| *s == slug))
                .or(first_org)
                .map(|(_, n)| n.clone());
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
/// the same repo twice just refreshes it — the call is idempotent.
pub async fn add(db: &Db, path: String) -> Result<Repo> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        bail!("That path isn't a folder.");
    }
    let toplevel = git(dir, &["rev-parse", "--show-toplevel"])
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("That folder isn't a git repository."))?;
    let top = Path::new(&toplevel);

    let remote = git(top, &["remote", "get-url", "origin"]).filter(|s| !s.is_empty());
    let (name, tracker) = identity(remote.as_deref(), top);

    sqlx::query(
        "INSERT INTO repos (name, tracker, agents, path) VALUES (?, ?, 0, ?)
         ON CONFLICT(name) DO UPDATE SET tracker = excluded.tracker, path = excluded.path",
    )
    .bind(&name)
    .bind(&tracker)
    .bind(&toplevel)
    .execute(db)
    .await?;

    tracing::info!(name = %name, path = %toplevel, "registered repository");
    Ok(Repo {
        name,
        tracker,
        agents: 0,
        path: Some(toplevel),
    })
}

/// Run `git -C <dir> <args>`, returning trimmed stdout on success.
fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
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
fn github_slug(url: &str) -> Option<String> {
    let url = url.trim();
    let rest = [
        "git@github.com:",
        "https://github.com/",
        "ssh://git@github.com/",
    ]
    .iter()
    .find_map(|p| url.strip_prefix(p))?;
    let slug = rest.strip_suffix(".git").unwrap_or(rest).trim_matches('/');
    slug.contains('/').then(|| slug.to_string())
}

#[cfg(test)]
mod tests {
    use super::github_slug;

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
    }
}
