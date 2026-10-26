//! Repository registry: list the repos from the database, and add a new one by
//! validating that a chosen folder is a git work tree.
//!
//! Git is shelled out to (no third-party crate) — the same approach the santree
//! CLI uses. The repo's identity (name + tracker) is derived from its `origin`
//! remote when present, falling back to the folder name.

use std::path::Path;

use anyhow::{anyhow, bail, Result};

use santree_core::domain::{Repo, RepoLocation, TicketProvider};

use crate::connection::{self, ConnectionRef};
use crate::daedalus::host::DaedalusHost;
use crate::db::Db;
use crate::git::{self, Checkout};
use crate::jira;
use crate::linear;
use crate::ticktick;
use crate::tracker;

/// Every registered repository, in insertion order. The displayed tracker
/// reflects the connected ticket provider the repo actually resolves to — so a
/// GitHub-hosted repo whose issues live in Linear reads "Linear · <workspace>",
/// one using Jira reads "Jira · <site>". `agents` is a live count of worktree
/// links (one per issue with an active agent worktree) rather than a stored
/// column, so it always reflects reality.
pub async fn list(db: &Db) -> Result<Vec<Repo>> {
    type RepoRow = (String, String, Option<String>, Option<String>, String);
    let rows = sqlx::query_as::<_, RepoRow>(
        "SELECT r.name, r.tracker, r.path, r.connection, r.location
         FROM repos r ORDER BY r.rowid",
    )
    .fetch_all(db)
    .await?;
    // Counted in Rust rather than as a correlated subquery so the review-checkout
    // rows go through the one predicate that excludes them everywhere else — they
    // are throwaway detached trees, not agents the user has working.
    let counts = worktree_counts(db).await?;
    // The label names the connection the repo's reads go to, so it comes from the
    // connections themselves rather than a copy of how they are resolved.
    let orgs = linear::orgs_by_name(db).await?;
    let sites = jira::sites_by_name(db).await?;
    let ticktick = ticktick::accounts_by_name(db).await?;

    Ok(rows
        .into_iter()
        .map(|(name, stored_tracker, path, stored, location)| {
            let linked = stored.as_deref().and_then(ConnectionRef::parse);
            let named = linked.as_ref().and_then(|c| {
                let known = match c.provider {
                    TicketProvider::Linear => &orgs,
                    TicketProvider::Jira => &sites,
                    TicketProvider::TickTick => &ticktick,
                };
                let display = &known.iter().find(|(key, _)| *key == c.key)?.1;
                // TickTick is one account per install: there is no name to add.
                let label = if display.is_empty() {
                    tracker::name(c.provider).to_string()
                } else {
                    format!("{} · {display}", tracker::name(c.provider))
                };
                Some((c.provider, c.id(), label))
            });
            let (provider, connection, label) = match named {
                Some((p, id, label)) => (Some(p), Some(id), Some(label)),
                None => (None, None, None),
            };
            Repo {
                agents: path
                    .as_deref()
                    .map_or(0, |path| worktrees_at(&counts, path)),
                name,
                tracker: label.unwrap_or(stored_tracker),
                provider,
                connection,
                path,
                location: RepoLocation::from_db(&location),
            }
        })
        .collect())
}

/// One registered repo, as [`list`] draws it.
async fn get(db: &Db, name: &str) -> Result<Repo> {
    list(db)
        .await?
        .into_iter()
        .find(|r| r.name == name)
        .ok_or_else(|| anyhow!("repo '{name}' is not registered"))
}

/// Every worktree link as `(repo path, issue id)` — the raw material both agent
/// counts are derived from.
/// Every `(repo_path, issue_id)` that counts as work the user started — the whole
/// link table minus the pull requests being reviewed, which have worktrees of
/// their own but are not tasks anyone opened.
async fn worktree_counts(db: &Db) -> Result<Vec<(String, String)>> {
    let mut links =
        sqlx::query_as::<_, (String, String)>("SELECT repo_path, issue_id FROM worktree_links")
            .fetch_all(db)
            .await?;
    let reviews = crate::reviews::all_review_ids(db).await?;
    links.retain(|link| !reviews.contains(link));
    Ok(links)
}

/// How many of those a repo path has.
fn worktrees_at(links: &[(String, String)], repo_path: &str) -> u32 {
    links.iter().filter(|(path, _)| path == repo_path).count() as u32
}

/// Every registered *local* repo as `(registry name, stored top-level path)`, in
/// insertion order. Deliberately not [`list`]: that one resolves Linear orgs to
/// build display labels, and the callers here are asking a filesystem question —
/// they just need to say which project the answer came from. A Daedalus repo's
/// path is a path on the server, so it is no answer to a question about this
/// machine's filesystem and is left out.
pub(crate) async fn registered(db: &Db) -> Result<Vec<(String, String)>> {
    Ok(sqlx::query_as::<_, (String, String)>(
        "SELECT name, path FROM repos
         WHERE path IS NOT NULL AND location = 'local' ORDER BY rowid",
    )
    .fetch_all(db)
    .await?)
}

/// Every registered repo's stored top-level path, in insertion order.
pub(crate) async fn paths(db: &Db) -> Result<Vec<String>> {
    Ok(registered(db)
        .await?
        .into_iter()
        .map(|(_, path)| path)
        .collect())
}

/// The stored top-level path of a registered repo's checkout **on this machine**,
/// if it has one. Every caller hands the answer to `std::fs`, `git` or a PTY cwd,
/// so a Daedalus repo — whose path is on the server — answers `None`, and each of
/// those callers already treats "no local path" as real-but-empty. What runs
/// wherever the repo lives resolves it through [`checkout`] instead.
pub async fn path(db: &Db, name: &str) -> Result<Option<String>> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT path FROM repos WHERE name = ? AND location = 'local'")
            .bind(name)
            .fetch_optional(db)
            .await?;
    Ok(row.and_then(|(p,)| p))
}

/// A registered repo's stored top-level path, wherever its checkout lives — the
/// key its worktree rows are filed under, for bookkeeping that opens nothing.
/// Anything that runs or reads there resolves [`checkout`] instead.
pub(crate) async fn stored_path(db: &Db, name: &str) -> Result<Option<String>> {
    let row: Option<(Option<String>,)> = sqlx::query_as("SELECT path FROM repos WHERE name = ?")
        .bind(name)
        .fetch_optional(db)
        .await?;
    Ok(row.and_then(|(p,)| p))
}

/// Where a registered repo's checkout lives, as the [`Checkout`] its git runs
/// in — the one resolution every repo read that runs git or reads the tree goes
/// through (docs/remote.md, "How santree dispatches"). `None` when no repo has
/// that name or it has no path. A Daedalus repo is reached through `daedalus`,
/// waiting out a link that is still coming up; while it is down this is the
/// error saying so, never a fall back to this machine.
pub async fn checkout(db: &Db, daedalus: &DaedalusHost, name: &str) -> Result<Option<Checkout>> {
    let row: Option<(Option<String>, String)> =
        sqlx::query_as("SELECT path, location FROM repos WHERE name = ?")
            .bind(name)
            .fetch_optional(db)
            .await?;
    let Some((Some(path), location)) = row else {
        return Ok(None);
    };
    Ok(Some(match RepoLocation::from_db(&location) {
        RepoLocation::Local => Checkout::local(path),
        RepoLocation::Daedalus => Checkout::daedalus(
            daedalus
                .client_within(crate::sessions::CONNECT_WAIT)
                .await?,
            path,
        ),
    }))
}

/// Where a registered repo's checkout lives; `None` when no repo has that name.
pub async fn location(db: &Db, name: &str) -> Result<Option<RepoLocation>> {
    let row: Option<String> = sqlx::query_scalar("SELECT location FROM repos WHERE name = ?")
        .bind(name)
        .fetch_optional(db)
        .await?;
    Ok(row.as_deref().map(RepoLocation::from_db))
}

/// Whether `name` is a registered Daedalus repo — the question every local-only
/// read asks before answering real-but-empty instead of failing on a path that
/// isn't on this machine.
pub async fn is_daedalus(db: &Db, name: &str) -> Result<bool> {
    Ok(location(db, name).await? == Some(RepoLocation::Daedalus))
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
            let toplevel = git::git(&Checkout::local(dir), &["rev-parse", "--show-toplevel"])
                .ok()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow!("That folder isn't a git repository."))?;
            let top = Path::new(&toplevel);
            let remote = git::git(&Checkout::local(top), &["remote", "get-url", "origin"])
                .ok()
                .filter(|s| !s.is_empty());
            let (name, tracker) = identity(remote.as_deref(), top);
            Ok((toplevel, name, tracker))
        })
        .await??;

    let registered: Option<(String, String)> =
        sqlx::query_as("SELECT name, location FROM repos WHERE path = ?")
            .bind(&toplevel)
            .fetch_optional(db)
            .await?;

    let name = match registered {
        // `path` is unique across both locations, and a server checkout can share
        // its spelling with a local folder. Refreshing that row would relabel a
        // Daedalus project as this folder.
        Some((name, location)) if RepoLocation::from_db(&location) != RepoLocation::Local => {
            bail!("{name} is already registered at that path as a Daedalus project.")
        }
        // Already registered: refresh the tracker but keep the stored name — a
        // rename (the remote moved) would strand its `repo:<name>` settings scope.
        Some((name, _)) => {
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

    // A repo added while there is exactly one connection takes it; with several
    // it waits to be told which.
    connection::adopt_sole(db, &name).await?;

    log::info!("registered repository {name} at {toplevel}");
    get(db, &name).await
}

/// Register a checkout that lives on Daedalus. Nothing here touches this
/// machine's filesystem: `server_path` and `remote` come from Daedalus's own
/// workspace listing (the caller re-reads it rather than trusting IPC), and the
/// identity is derived from the remote URL the same way [`add`] derives it from
/// `git remote get-url origin`. Idempotent like [`add`]: the same server path
/// again returns the existing row.
pub async fn add_daedalus(db: &Db, server_path: &str, remote: Option<&str>) -> Result<Repo> {
    let top = Path::new(server_path);
    let (derived, tracker) = match remote.and_then(github_slug) {
        Some(slug) => (slug, "GitHub Issues".to_string()),
        None => (identity(None, top).0, "Daedalus".to_string()),
    };

    let registered: Option<(String, String)> =
        sqlx::query_as("SELECT name, location FROM repos WHERE path = ?")
            .bind(server_path)
            .fetch_optional(db)
            .await?;
    let name = match registered {
        Some((name, location)) if RepoLocation::from_db(&location) != RepoLocation::Daedalus => {
            bail!("{name} is already registered at that path as a local project.")
        }
        Some((name, _)) => {
            sqlx::query("UPDATE repos SET tracker = ? WHERE path = ?")
                .bind(&tracker)
                .bind(server_path)
                .execute(db)
                .await?;
            name
        }
        None => {
            let name = free_name(db, &derived, top).await?;
            sqlx::query("INSERT INTO repos (name, tracker, path, location) VALUES (?, ?, ?, ?)")
                .bind(&name)
                .bind(&tracker)
                .bind(server_path)
                .bind(RepoLocation::Daedalus.as_db())
                .execute(db)
                .await?;
            name
        }
    };

    connection::adopt_sole(db, &name).await?;
    log::info!("registered Daedalus repository {name}");
    get(db, &name).await
}

/// App-scoped settings whose *value* is a registry name (`src/lib/queries.ts`:
/// `TRIAGE_DEFAULT_REPO_KEY`, `WORK_DEFAULT_REPO_KEY`, `triageRepoKey`).
const REPO_VALUED_KEYS: [&str; 2] = ["triage_default_repo", "work_default_repo"];
const TRIAGE_REPO_KEY_PREFIX: &str = "triage_repo:";

/// The registered repo `name`'s stored path and where it lives; `None` when no
/// repo has that name.
pub(crate) async fn registration(
    db: &Db,
    name: &str,
) -> Result<Option<(Option<String>, RepoLocation)>> {
    let row: Option<(Option<String>, String)> =
        sqlx::query_as("SELECT path, location FROM repos WHERE name = ?")
            .bind(name)
            .fetch_optional(db)
            .await?;
    Ok(row.map(|(path, location)| (path, RepoLocation::from_db(&location))))
}

/// Forget a registered repo: its row and every row filed under it, in one
/// transaction, so a failure leaves it registered exactly as it was. Nothing on
/// disk (or on Daedalus) is touched, which is what lets the same path be added
/// again later as a fresh project.
///
/// The PR-keyed review tables (`reviewed_files`, `review_briefs`,
/// `review_drafts`, `review_work_items`) stay: they are keyed by GitHub's
/// `owner/name`, which every clone of the repo shares and the Reviews inbox
/// reaches across the org, and each has its own sweep.
pub async fn remove(db: &Db, name: &str) -> Result<()> {
    let mut tx = db.begin().await?;
    let row: Option<(Option<String>,)> = sqlx::query_as("SELECT path FROM repos WHERE name = ?")
        .bind(name)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((path,)) = row else {
        bail!("repo '{name}' is not registered");
    };
    let scope = format!("repo:{name}");
    let has_env: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM settings WHERE scope = ? AND key = ?")
            .bind(&scope)
            .bind(crate::env::ENV_VARS_KEY)
            .fetch_optional(&mut *tx)
            .await?;

    // The conversations bound to its surfaces, before the bindings go: left
    // behind, `session_states` would draw them as agents nobody can place.
    for table in ["session_usage_live", "session_state"] {
        sqlx::query(&format!(
            "DELETE FROM {table} WHERE session_id IN
                (SELECT session_id FROM terminal_sessions WHERE repo = ?)"
        ))
        .bind(name)
        .execute(&mut *tx)
        .await?;
    }
    for table in [
        "terminal_sessions",
        "worktree_tabs",
        "task_notes",
        "commit_drafts",
    ] {
        sqlx::query(&format!("DELETE FROM {table} WHERE repo = ?"))
            .bind(name)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(path) = &path {
        for table in [
            "worktree_links",
            "review_worktrees",
            "split_stacks",
            "worktree_moves",
        ] {
            sqlx::query(&format!("DELETE FROM {table} WHERE repo_path = ?"))
                .bind(path)
                .execute(&mut *tx)
                .await?;
        }
    }
    sqlx::query("DELETE FROM settings WHERE scope = ?")
        .bind(&scope)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "DELETE FROM settings WHERE scope = 'app' AND value = ?
           AND (key IN (?, ?) OR substr(key, 1, length(?)) = ?)",
    )
    .bind(name)
    .bind(REPO_VALUED_KEYS[0])
    .bind(REPO_VALUED_KEYS[1])
    .bind(TRIAGE_REPO_KEY_PREFIX)
    .bind(TRIAGE_REPO_KEY_PREFIX)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM repos WHERE name = ?")
        .bind(name)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    // The repo scope's environment values live in the keychain, outside the
    // transaction; a leftover there is unreachable, so failing to drop it only
    // costs a log line. Asked only when it had some: a keychain call can prompt.
    if has_env.is_some() {
        if let Err(e) = crate::env::forget_scope(db, &scope).await {
            log::warn!("forgetting {name}'s environment values failed: {e:#}");
        }
    }
    log::info!("forgot repository {name}");
    Ok(())
}

/// How many of `cwds` lie inside the checkout at `root` (its main checkout or a
/// worktree under it) and not inside one of `others` nested deeper in it.
pub(crate) fn panes_inside(cwds: &[String], root: &str, others: &[String]) -> usize {
    let root = Path::new(root);
    let nested: Vec<&Path> = others
        .iter()
        .map(Path::new)
        .filter(|other| *other != root && other.starts_with(root))
        .collect();
    cwds.iter()
        .map(Path::new)
        .filter(|cwd| cwd.starts_with(root) && !nested.iter().any(|n| cwd.starts_with(n)))
        .count()
}

/// The server paths of every registered Daedalus repo — what the workspace
/// listing marks as already added.
pub(crate) async fn daedalus_paths(db: &Db) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar::<_, String>(
        "SELECT path FROM repos WHERE path IS NOT NULL AND location = 'daedalus'",
    )
    .fetch_all(db)
    .await?)
}

/// The registered Daedalus repo whose checkout holds `path` — a directory on
/// the server, whatever this machine happens to have at the same spelling —
/// by name; the innermost, should one checkout sit inside another.
pub(crate) async fn daedalus_repo_at(db: &Db, path: &Path) -> Result<Option<String>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT name, path FROM repos WHERE path IS NOT NULL AND location = 'daedalus'",
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter(|(_, root)| path.starts_with(root))
        .max_by_key(|(_, root)| root.len())
        .map(|(name, _)| name))
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

    /// Removing a repo clears every row filed under it — by name, by path, by
    /// settings scope, by a session it bound, and app settings naming it — and
    /// leaves another repo's rows exactly as they were.
    #[tokio::test]
    async fn remove_forgets_only_that_repos_rows() {
        let base = std::env::temp_dir().join(format!("santree-repo-rm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let db = crate::db::init(base.join("test.db")).await.unwrap();

        let seed = [
            "INSERT INTO repos (name, tracker, path) VALUES (?1, '', ?2)",
            "INSERT INTO settings (scope, key, value) VALUES ('repo:' || ?1, 'work_model', 'x')",
            "INSERT INTO settings (scope, key, value) VALUES ('app', 'triage_repo:' || ?1, ?1)",
            "INSERT INTO task_notes (repo, task_id, body, updated_at) VALUES (?1, 'T', 'n', 0)",
            "INSERT INTO commit_drafts (repo, issue_id, message, updated_at) VALUES (?1, 'T', 'm', 0)",
            "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id) VALUES (?1, 'tree:T:tab:' || ?1, ?2, ?3)",
            "INSERT INTO worktree_tabs (id, repo, worktree_id, kind, title, position) VALUES (?1, ?1, 'T', 'terminal', 't', 0)",
            "INSERT INTO worktree_links (repo_path, issue_id, branch, worktree_path, base_branch) VALUES (?2, 'T', 't', ?2 || '/wt', 'main')",
            "INSERT INTO review_worktrees (repo_path, issue_id, pr_repo, number) VALUES (?2, 'T', 'o/n', 1)",
            "INSERT INTO split_stacks (id, repo_path, source_id, data) VALUES (?1, ?2, 'T', '{}')",
            "INSERT INTO worktree_moves (id, repo_path, source_id, data) VALUES (?1, ?2, 'T', '{}')",
            "INSERT INTO session_state (session_id, state, event, updated_at_ms) VALUES (?3, 'idle', 'Stop', 0)",
            "INSERT INTO session_usage_live (session_id, used_pct, input_tokens, context_size, model, cost_usd, updated_at_ms) VALUES (?3, 0, 0, 0, 'm', 0, 0)",
        ];
        for (name, path, session) in [("gone", "/r/gone", "s-gone"), ("kept", "/r/kept", "s-kept")]
        {
            for sql in seed {
                sqlx::query(sql)
                    .bind(name)
                    .bind(path)
                    .bind(session)
                    .execute(&db)
                    .await
                    .unwrap();
            }
        }
        for (key, value) in [
            ("triage_default_repo", "gone"),
            ("work_default_repo", "kept"),
        ] {
            sqlx::query("INSERT INTO settings (scope, key, value) VALUES ('app', ?, ?)")
                .bind(key)
                .bind(value)
                .execute(&db)
                .await
                .unwrap();
        }

        remove(&db, "gone").await.unwrap();

        let checks = [
            ("repos", "name = ?1"),
            (
                "settings",
                "scope = 'repo:' || ?1 OR (scope = 'app' AND value = ?1)",
            ),
            ("task_notes", "repo = ?1"),
            ("commit_drafts", "repo = ?1"),
            ("terminal_sessions", "repo = ?1"),
            ("worktree_tabs", "repo = ?1"),
            ("worktree_links", "repo_path = ?2"),
            ("review_worktrees", "repo_path = ?2"),
            ("split_stacks", "repo_path = ?2"),
            ("worktree_moves", "repo_path = ?2"),
            ("session_state", "session_id = ?3"),
            ("session_usage_live", "session_id = ?3"),
        ];
        for (name, path, session, want) in [
            ("gone", "/r/gone", "s-gone", 0),
            ("kept", "/r/kept", "s-kept", 1),
        ] {
            for (table, filter) in checks {
                let n: i64 =
                    sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table} WHERE {filter}"))
                        .bind(name)
                        .bind(path)
                        .bind(session)
                        .fetch_one(&db)
                        .await
                        .unwrap();
                let want = if name == "kept" && table == "settings" {
                    3
                } else {
                    want
                };
                assert_eq!(n, want, "{table} rows for {name}");
            }
        }
        assert!(
            remove(&db, "gone").await.is_err(),
            "a second remove names nothing"
        );

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
