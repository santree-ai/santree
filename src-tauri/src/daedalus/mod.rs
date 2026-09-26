//! Daedalus — the user's home server, where Daedalus projects live and run
//! (docs/remote.md). This module is the REST side: the saved connection, the API
//! token, reachability, the server's workspace list and registering one of them
//! as a santree project. [`host`] is the live ssh link to `santree-remote`
//! (over `crates/remote`) and the hook relay; [`health`] checks each stage of
//! reaching the server in order.
//!
//! Unreachable is normal. Every read here answers with a [`DaedalusReach`] as a
//! plain value; only genuinely broken local state (the database, the keychain)
//! is an `Err`, because an `Err` becomes a red toast.

pub mod api;
pub mod health;
pub mod host;

use std::path::{Component, Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};

use santree_core::domain::{DaedalusConfig, DaedalusReach, DaedalusWorkspaceList, Repo};

use crate::db::Db;
use crate::oauth::{keychain_err, KEYCHAIN_SERVICE};
use crate::repo;

/// The keychain account the API token is stored under (service
/// [`KEYCHAIN_SERVICE`]).
const KEYCHAIN_ACCOUNT: &str = "daedalus";

// ── The saved connection ─────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct Row {
    url: String,
    ssh_user: Option<String>,
    ssh_host: Option<String>,
    ssh_port: Option<i64>,
    projects_root: Option<String>,
    identity_file: Option<String>,
    fetched_at: Option<String>,
    hook_cursor: Option<i64>,
    boot_id: Option<String>,
}

async fn load(db: &Db) -> Result<Option<Row>> {
    Ok(sqlx::query_as::<_, Row>(
        "SELECT url, ssh_user, ssh_host, ssh_port, projects_root,
                identity_file, fetched_at, hook_cursor, boot_id
         FROM daedalus_connection WHERE id = 1",
    )
    .fetch_optional(db)
    .await?)
}

/// Save the URL. A different URL is a different server, so what was fetched from
/// the old one — and where the app was in its hook queue — is cleared; the
/// identity file is the user's and survives.
async fn save_url(db: &Db, url: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO daedalus_connection (id, url) VALUES (1, ?1)
         ON CONFLICT(id) DO UPDATE SET
            ssh_user      = CASE WHEN url = ?1 THEN ssh_user END,
            ssh_host      = CASE WHEN url = ?1 THEN ssh_host END,
            ssh_port      = CASE WHEN url = ?1 THEN ssh_port END,
            projects_root = CASE WHEN url = ?1 THEN projects_root END,
            fetched_at    = CASE WHEN url = ?1 THEN fetched_at END,
            hook_cursor   = CASE WHEN url = ?1 THEN hook_cursor END,
            boot_id       = CASE WHEN url = ?1 THEN boot_id END,
            url           = ?1",
    )
    .bind(url)
    .execute(db)
    .await?;
    Ok(())
}

/// Record the connection info Daedalus just reported, for the URL it came from
/// (a disconnect or a new URL in between leaves nothing to update).
async fn save_connection(db: &Db, url: &str, conn: &api::Connection) -> Result<()> {
    sqlx::query(
        "UPDATE daedalus_connection
         SET ssh_user = ?, ssh_host = ?, ssh_port = ?, projects_root = ?,
             fetched_at = ?
         WHERE id = 1 AND url = ?",
    )
    .bind(&conn.ssh_user)
    .bind(&conn.ssh_host)
    .bind(conn.ssh_port.map(i64::from))
    .bind(&conn.projects_root)
    .bind(chrono::Utc::now().to_rfc3339())
    .bind(url)
    .execute(db)
    .await?;
    Ok(())
}

// ── The token (OS keychain) ──────────────────────────────────────────────────

fn keychain_entry() -> Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(keychain_err)
}

async fn load_token() -> Result<Option<String>> {
    tokio::task::spawn_blocking(|| match keychain_entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(keychain_err(e)),
    })
    .await
    .context("keychain read")?
}

async fn save_token(token: String) -> Result<()> {
    tokio::task::spawn_blocking(move || {
        keychain_entry()?.set_password(&token).map_err(keychain_err)
    })
    .await
    .context("keychain write")?
}

async fn delete_token() -> Result<()> {
    tokio::task::spawn_blocking(|| match keychain_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(keychain_err(e)),
    })
    .await
    .context("keychain delete")?
}

/// A token as the user pasted it: trimmed, non-empty, and nothing that could
/// break out of an `Authorization` header.
fn clean_token(token: &str) -> Result<String> {
    let token = token.trim();
    if token.is_empty() {
        bail!("Paste the API token Daedalus gave you.");
    }
    if token.len() > 4096 || !token.bytes().all(|b| b.is_ascii_graphic()) {
        bail!("That token has characters an API token can't have.");
    }
    Ok(token.to_string())
}

// ── Reads ────────────────────────────────────────────────────────────────────

/// The saved connection for Settings, or `None` when nothing is configured.
pub async fn config(db: &Db) -> Result<Option<DaedalusConfig>> {
    let Some(row) = load(db).await? else {
        return Ok(None);
    };
    let has_token = load_token().await?.is_some();
    Ok(Some(DaedalusConfig {
        url: row.url,
        ssh_user: row.ssh_user,
        ssh_host: row.ssh_host,
        ssh_port: row.ssh_port.and_then(|p| u16::try_from(p).ok()),
        projects_root: row.projects_root,
        identity_file: row.identity_file,
        has_token,
        fetched_at: row.fetched_at,
    }))
}

/// The saved URL and token, or `None` when nothing is configured.
async fn credentials(db: &Db) -> Result<Option<(String, Option<String>)>> {
    let Some(row) = load(db).await? else {
        return Ok(None);
    };
    Ok(Some((row.url, load_token().await?)))
}

/// Whether the API answers, by asking for the connection info — which is also
/// the moment to refresh the cached copy of it.
pub async fn status(db: &Db) -> Result<DaedalusReach> {
    let Some((url, token)) = credentials(db).await? else {
        return Ok(DaedalusReach::NotConfigured);
    };
    probe(db, &url, token.as_deref()).await
}

async fn probe(db: &Db, url: &str, token: Option<&str>) -> Result<DaedalusReach> {
    match api::connection(url, token).await {
        Ok(conn) => {
            save_connection(db, url, &conn).await?;
            Ok(DaedalusReach::ApiReachable)
        }
        Err(reach) => Ok(reach),
    }
}

/// The server's checkouts, each marked with whether santree has it registered.
/// Empty with the reach set whenever the API doesn't answer.
pub async fn workspaces(db: &Db) -> Result<DaedalusWorkspaceList> {
    let Some((url, token)) = credentials(db).await? else {
        return Ok(unanswered(DaedalusReach::NotConfigured));
    };
    let (listed, conn) = tokio::join!(
        api::workspaces(&url, token.as_deref()),
        api::connection(&url, token.as_deref())
    );
    // Opportunistic: the list is what was asked for, so a failed connection read
    // beside it changes nothing.
    if let Ok(conn) = conn {
        if let Err(e) = save_connection(db, &url, &conn).await {
            log::warn!("daedalus: caching the connection info failed: {e:#}");
        }
    }
    let listed = match listed {
        Ok(listed) => listed,
        Err(reach) => return Ok(unanswered(reach)),
    };
    let registered = repo::daedalus_paths(db).await?;
    let workspaces = listed
        .workspaces
        .into_iter()
        .map(|w| {
            let is_registered = registered.contains(&w.path);
            w.into_domain(is_registered)
        })
        .collect();
    Ok(DaedalusWorkspaceList {
        reach: DaedalusReach::ApiReachable,
        generated_at: listed.generated_at,
        workspaces,
    })
}

fn unanswered(reach: DaedalusReach) -> DaedalusWorkspaceList {
    DaedalusWorkspaceList {
        reach,
        generated_at: None,
        workspaces: vec![],
    }
}

// ── Writes ───────────────────────────────────────────────────────────────────

/// Save the URL and token — even when Daedalus can't be reached right now, since
/// configuring it away from home is expected — then try it. A blank token keeps
/// the stored one, but only for the server it was saved for (see
/// [`same_server`]): a new address has to be given its token again.
pub async fn connect(db: &Db, url: &str, token: &str) -> Result<DaedalusReach> {
    let url = api::normalize_url(url)?;
    let saved_url = load(db).await?.map(|row| row.url);
    let token = match (token.trim().is_empty(), load_token().await?) {
        (true, Some(stored)) if saved_url.as_deref().is_some_and(|s| same_server(s, &url)) => {
            stored
        }
        (true, Some(_)) => bail!(
            "Paste the API token for this address. The saved token is only sent to the \
             server it was saved for, and this URL points somewhere else."
        ),
        _ => {
            let token = clean_token(token)?;
            // Keychain first: a row without its token would read as configured
            // and answer Unauthorized forever.
            save_token(token.clone()).await?;
            token
        }
    };
    save_url(db, &url).await?;
    log::info!("daedalus: connection saved");
    probe(db, &url, Some(&token)).await
}

/// Whether two Daedalus URLs name the same server: the same scheme, host and
/// port, compared parsed (a default port written out or left off is the same
/// port). A path is the same server; anything that doesn't parse is not.
fn same_server(a: &str, b: &str) -> bool {
    match (reqwest::Url::parse(a), reqwest::Url::parse(b)) {
        (Ok(a), Ok(b)) => a.origin() == b.origin(),
        _ => false,
    }
}

/// Forget the connection and its token. Registered Daedalus projects stay: they
/// are the user's projects, and reconnecting brings them back to life.
pub async fn disconnect(db: &Db) -> Result<()> {
    delete_token().await?;
    sqlx::query("DELETE FROM daedalus_connection")
        .execute(db)
        .await?;
    log::info!("daedalus: disconnected");
    Ok(())
}

/// Set (or clear, with `None`) the ssh identity file.
pub async fn set_identity_file(db: &Db, path: Option<String>) -> Result<()> {
    let stored = match path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        None => None,
        Some(path) => {
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .ok_or_else(|| anyhow!("can't resolve the home directory"))?;
            let path = path.to_string();
            let real =
                tokio::task::spawn_blocking(move || validate_identity_file(&path, &home)).await??;
            Some(real.to_string_lossy().into_owned())
        }
    };
    let updated = sqlx::query("UPDATE daedalus_connection SET identity_file = ? WHERE id = 1")
        .bind(&stored)
        .execute(db)
        .await?;
    if updated.rows_affected() == 0 {
        bail!("Connect Daedalus first.");
    }
    Ok(())
}

/// An identity file has to be an absolute path to an existing regular file under
/// the user's home. Returns the resolved path, so a symlink is judged — and
/// stored — by where it really points.
fn validate_identity_file(path: &str, home: &Path) -> Result<PathBuf> {
    let candidate = Path::new(path);
    if !candidate.is_absolute() {
        bail!("Use the identity file's full path.");
    }
    if candidate
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        bail!("The identity file's path can't contain `..`.");
    }
    let real =
        std::fs::canonicalize(candidate).map_err(|_| anyhow!("There's no file at {path}."))?;
    let home = std::fs::canonicalize(home).context("resolving the home directory")?;
    if !real.starts_with(&home) {
        bail!("The identity file has to be inside your home folder.");
    }
    if !std::fs::metadata(&real)?.is_file() {
        bail!("{path} isn't a file.");
    }
    Ok(real)
}

/// Register one of the server's checkouts as a santree project. `name` only
/// selects: the path and remote come from a fresh read of the server's own list.
pub async fn add_repo(db: &Db, name: &str) -> Result<Repo> {
    validate_workspace_name(name)?;
    let Some((url, token)) = credentials(db).await? else {
        bail!("Connect Daedalus in Settings first.");
    };
    let listed = api::workspaces(&url, token.as_deref())
        .await
        .map_err(|reach| anyhow!(unreachable_message(&reach)))?;
    let workspace = listed
        .workspaces
        .into_iter()
        .find(|w| w.name == name)
        .ok_or_else(|| anyhow!("Daedalus has no project called {name}."))?;
    validate_server_path(&workspace.path, name)?;
    repo::add_daedalus(db, &workspace.path, workspace.remote.as_deref()).await
}

fn unreachable_message(reach: &DaedalusReach) -> String {
    match reach {
        DaedalusReach::NotConfigured => "Connect Daedalus in Settings first.".into(),
        DaedalusReach::Unauthorized => "Daedalus refused the token. Check it in Settings.".into(),
        DaedalusReach::ApiUnreachable { reason } => format!("Can't reach Daedalus. {reason}"),
        DaedalusReach::ApiReachable => "Daedalus answered, but not with a list.".into(),
    }
}

/// A workspace name is one directory under the projects root: a single normal
/// path component that can't be read as a flag.
fn validate_workspace_name(name: &str) -> Result<()> {
    let mut components = Path::new(name).components();
    let single = matches!(components.next(), Some(Component::Normal(c)) if c == name)
        && components.next().is_none();
    if !single
        || name.len() > 255
        || name.starts_with('-')
        || name.contains(['/', '\\'])
        || name.chars().any(char::is_control)
    {
        bail!("invalid Daedalus project name");
    }
    Ok(())
}

/// The server's own path for the workspace, checked before it is stored as the
/// repo's path (and so, later, used as a cwd on the server): absolute, no `..`,
/// and ending in the workspace's name.
fn validate_server_path(path: &str, name: &str) -> Result<()> {
    let p = Path::new(path);
    if !p.is_absolute()
        || p.components().any(|c| matches!(c, Component::ParentDir))
        || p.file_name().and_then(|n| n.to_str()) != Some(name)
    {
        bail!("Daedalus reported an unexpected path for {name}.");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_names_are_single_components() {
        for good in ["web", "santree-app", "my.project", "a_b"] {
            assert!(validate_workspace_name(good).is_ok(), "{good}");
        }
        for bad in [
            "", ".", "..", "a/b", "/abs", "../up", "-rf", "a\\b", "a\nb", "web/",
        ] {
            assert!(validate_workspace_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn server_paths_must_be_absolute_and_end_in_the_name() {
        assert!(validate_server_path("/srv/projects/web", "web").is_ok());
        assert!(validate_server_path("srv/projects/web", "web").is_err());
        assert!(validate_server_path("/srv/projects/../web", "web").is_err());
        assert!(validate_server_path("/srv/projects/other", "web").is_err());
    }

    /// The saved token follows the server, not the form: a blank token field
    /// reuses it only for the same scheme, host and port.
    #[test]
    fn a_saved_token_is_only_reused_for_the_same_server() {
        let saved = "https://daedalus.example";
        for same in [
            "https://daedalus.example",
            "https://daedalus.example:443",
            "https://DAEDALUS.example/api",
        ] {
            assert!(same_server(saved, same), "{same}");
        }
        for other in [
            "http://daedalus.example",
            "https://daedalus.example:8443",
            "https://evil.example",
            "https://daedalus.example.evil.example",
            "not a url",
        ] {
            assert!(!same_server(saved, other), "{other}");
        }
        assert!(same_server("http://10.0.0.2:8080", "http://10.0.0.2:8080/"));
        assert!(!same_server("http://10.0.0.2:8080", "http://10.0.0.3:8080"));
    }

    #[test]
    fn tokens_are_trimmed_and_header_safe() {
        assert_eq!(clean_token("  abc.def  ").unwrap(), "abc.def");
        assert!(clean_token("   ").is_err());
        assert!(clean_token("abc\r\nX-Evil: 1").is_err());
        assert!(clean_token("has space").is_err());
    }

    #[test]
    fn identity_files_must_be_real_files_under_home() {
        let base = std::env::temp_dir().join(format!("santree-daedalus-id-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");
        let ssh = home.join(".ssh");
        std::fs::create_dir_all(&ssh).unwrap();
        let key = ssh.join("id_ed25519");
        std::fs::write(&key, "key").unwrap();
        let outside = base.join("outside");
        std::fs::write(&outside, "key").unwrap();

        let ok = validate_identity_file(key.to_str().unwrap(), &home).unwrap();
        assert_eq!(ok, std::fs::canonicalize(&key).unwrap());

        // Relative, `..`, missing, a directory, outside home.
        assert!(validate_identity_file(".ssh/id_ed25519", &home).is_err());
        let dotdot = format!("{}/.ssh/../.ssh/id_ed25519", home.display());
        assert!(validate_identity_file(&dotdot, &home).is_err());
        let missing = ssh.join("nope");
        assert!(validate_identity_file(missing.to_str().unwrap(), &home).is_err());
        assert!(validate_identity_file(ssh.to_str().unwrap(), &home).is_err());
        assert!(validate_identity_file(outside.to_str().unwrap(), &home).is_err());

        // A symlink under home that points out of it is judged by its target.
        let link = ssh.join("escape");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(validate_identity_file(link.to_str().unwrap(), &home).is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Registering a Daedalus repo never touches the local filesystem, derives
    /// its identity from the remote, and is idempotent — and every local-only
    /// read then treats it as having no local path.
    #[tokio::test]
    async fn a_daedalus_repo_registers_without_a_local_checkout() {
        let base =
            std::env::temp_dir().join(format!("santree-daedalus-add-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let db = crate::db::init(base.join("test.db")).await.unwrap();

        let server_path = "/srv/does-not-exist-here/web";
        let repo = repo::add_daedalus(&db, server_path, Some("git@github.com:acme/web.git"))
            .await
            .unwrap();
        assert_eq!(repo.name, "acme/web");
        assert_eq!(repo.location, santree_core::domain::RepoLocation::Daedalus);
        assert_eq!(repo.path.as_deref(), Some(server_path));

        let again = repo::add_daedalus(&db, server_path, Some("git@github.com:acme/web.git"))
            .await
            .unwrap();
        assert_eq!(again.name, "acme/web");
        let listed = repo::list(&db).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(
            listed[0].location,
            santree_core::domain::RepoLocation::Daedalus
        );

        assert_eq!(repo::path(&db, "acme/web").await.unwrap(), None);
        assert!(repo::registered(&db).await.unwrap().is_empty());
        assert_eq!(
            repo::daedalus_paths(&db).await.unwrap(),
            vec![server_path.to_string()]
        );
        assert!(crate::worktree::list(&db, "acme/web")
            .await
            .unwrap()
            .is_empty());
        assert!(crate::worktree::base_worktree(&db, "acme/web")
            .await
            .unwrap()
            .is_none());
        assert!(
            !crate::worktree::init_script(&db, "acme/web")
                .await
                .unwrap()
                .exists
        );

        // No remote: named for its folder.
        let bare = repo::add_daedalus(&db, "/srv/x/notes", None).await.unwrap();
        assert_eq!(bare.name, "notes");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn a_url_change_forgets_what_the_old_server_reported() {
        let base =
            std::env::temp_dir().join(format!("santree-daedalus-url-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let db = crate::db::init(base.join("test.db")).await.unwrap();

        save_url(&db, "https://a.example").await.unwrap();
        let conn = api::Connection {
            ssh_user: Some("me".into()),
            ssh_host: Some("s2.example.org".into()),
            ssh_port: Some(22),
            projects_root: Some("/srv/projects".into()),
        };
        save_connection(&db, "https://a.example", &conn)
            .await
            .unwrap();
        sqlx::query("UPDATE daedalus_connection SET identity_file = '/k'")
            .execute(&db)
            .await
            .unwrap();

        // Same URL: kept.
        save_url(&db, "https://a.example").await.unwrap();
        let row = load(&db).await.unwrap().unwrap();
        assert_eq!(row.ssh_user.as_deref(), Some("me"));
        assert!(row.fetched_at.is_some());

        // New URL: cleared, identity file kept.
        save_url(&db, "https://b.example").await.unwrap();
        let row = load(&db).await.unwrap().unwrap();
        assert_eq!(row.url, "https://b.example");
        assert_eq!(row.ssh_user, None);
        assert_eq!(row.ssh_host, None);
        assert_eq!(row.ssh_port, None);
        assert_eq!(row.projects_root, None);
        assert_eq!(row.fetched_at, None);
        assert_eq!(row.identity_file.as_deref(), Some("/k"));

        // A stale response for the old URL updates nothing.
        save_connection(&db, "https://a.example", &conn)
            .await
            .unwrap();
        assert_eq!(load(&db).await.unwrap().unwrap().ssh_user, None);

        let _ = std::fs::remove_dir_all(&base);
    }
}
