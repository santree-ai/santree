//! User-configured environment for santree-spawned terminals.
//!
//! The Environment settings let the user define variables (and reference `.env`
//! files) that santree injects into every terminal it spawns — triage
//! investigations, worktree agents, the Terminal tab, and extra Claude tabs.
//! This is the user's *own* project environment (a `DATABASE_URL`, a service key
//! their code needs), exactly what an IDE's integrated terminal provides. It is
//! explicitly NOT a channel for an agent CLI's auth tokens — see COMPLIANCE.md.
//!
//! # Where a variable lives
//!
//! A variable is a *name* and a *value*, and they are stored apart:
//!
//! - the **names** (an ordered JSON array) go in the generic `settings` table
//!   under [`ENV_VARS_KEY`], scope `app` or `repo:<name>`, like every other
//!   preference;
//! - the **values** go in the **OS keychain**, one entry per scope, holding a
//!   `{name: value}` JSON map.
//!
//! The values are secrets — the settings UI masks them behind a padlock — and
//! CLAUDE.md's invariant is that a secret belongs in the keychain, never in
//! plaintext SQLite. santree hands the agent CLIs it spawns whatever the user
//! puts here, but a *different* process (an agent in another repo's scope, an
//! unrelated tool, a copy of the db lifted off a backup) has no business reading
//! them, and before this split it only had to open `santree.db`.
//!
//! Everything reads and writes them through one seam — [`settings::get`] /
//! [`settings::set`] dispatch [`ENV_VARS_KEY`] to [`vars_json`] / [`set_vars_json`]
//! here — so the IPC surface, the settings editor and [`resolve_env`] all see the
//! same `[{name, value}]` shape and nobody can accidentally write a plaintext
//! value back into the table. [`migrate_vars_to_keychain`] moves what older builds
//! stored in plaintext (called from `db::init`, which then VACUUMs the pages).

use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::db::Db;

/// Settings key holding the JSON array of variable *names* for a scope. Their
/// values live in the OS keychain — see the module docs.
pub const ENV_VARS_KEY: &str = "env_vars";
/// Settings key holding the JSON array of `.env` file paths for a scope.
pub const ENV_FILES_KEY: &str = "env_files";

/// A `.env` file bigger than this isn't one — refuse it rather than pull it into
/// memory on a terminal spawn.
const MAX_ENV_FILE_BYTES: u64 = 1 << 20;

/// One variable as the settings UI knows it: the JSON shape crossing IPC, and the
/// shape older builds stored (values and all) in the `settings` table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct EnvVar {
    name: String,
    value: String,
}

// ── The value store (OS keychain) ─────────────────────────────────────────────

/// Keychain service name (the app's bundle id), shared with the Linear token
/// store in `linear.rs`; the account namespaces this store apart from it.
#[cfg(not(test))]
const KEYCHAIN_SERVICE: &str = "com.santree.desktop";

/// The keychain account holding one scope's variable values.
#[cfg(not(test))]
fn account(_db: &Db, scope: &str) -> String {
    format!("env:{scope}")
}

/// Tests run against an in-process double (see [`store`]) rather than the
/// developer's real keychain. The account is namespaced by the test's own
/// database file so parallel tests stay isolated the way their databases are —
/// several of them write the `app` scope.
#[cfg(test)]
fn account(db: &Db, scope: &str) -> String {
    format!(
        "{}:env:{scope}",
        db.connect_options().get_filename().display()
    )
}

#[cfg(not(test))]
mod store {
    use anyhow::Result;

    use super::KEYCHAIN_SERVICE;

    fn entry(account: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(err)
    }

    /// A keychain failure (locked keychain, no Secret Service on a headless box)
    /// is a real error, never a silent fallback to plaintext — that fallback is
    /// exactly what this store exists to prevent.
    fn err(e: keyring::Error) -> anyhow::Error {
        anyhow::Error::new(e).context(
            "the OS keychain is unavailable (santree keeps environment variable values there)",
        )
    }

    pub(super) fn read(account: &str) -> Result<Option<String>> {
        match entry(account)?.get_password() {
            Ok(blob) => Ok(Some(blob)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(err(e)),
        }
    }

    pub(super) fn write(account: &str, blob: &str) -> Result<()> {
        entry(account)?.set_password(blob).map_err(err)
    }

    /// Deleting what isn't there is a no-op, not a failure.
    pub(super) fn delete(account: &str) -> Result<()> {
        match entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(err(e)),
        }
    }
}

/// The test double for the OS keychain: an in-process map. `cargo test` must
/// never write to the developer's login keychain (it would prompt), and CI has
/// no Secret Service to write to at all.
#[cfg(test)]
mod store {
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex};

    use anyhow::Result;

    static ITEMS: LazyLock<Mutex<HashMap<String, String>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    fn items() -> std::sync::MutexGuard<'static, HashMap<String, String>> {
        ITEMS.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(super) fn read(account: &str) -> Result<Option<String>> {
        Ok(items().get(account).cloned())
    }

    pub(super) fn write(account: &str, blob: &str) -> Result<()> {
        items().insert(account.to_string(), blob.to_string());
        Ok(())
    }

    pub(super) fn delete(account: &str) -> Result<()> {
        items().remove(account);
        Ok(())
    }
}

/// The values stored for a scope. Keychain calls block (they can even prompt), so
/// they run off the async runtime — this is on the terminal-spawn path.
async fn load_values(db: &Db, scope: &str) -> Result<HashMap<String, String>> {
    let account = account(db, scope);
    let blob = tokio::task::spawn_blocking(move || store::read(&account))
        .await
        .context("keychain read")??;
    match blob {
        Some(blob) => serde_json::from_str(&blob).context(
            "the stored environment variables aren't in the expected format — re-enter them in \
             Settings → Environment",
        ),
        None => Ok(HashMap::new()),
    }
}

async fn save_values(db: &Db, scope: &str, values: &HashMap<String, String>) -> Result<()> {
    if values.is_empty() {
        return delete_values(db, scope).await;
    }
    let account = account(db, scope);
    let blob = serde_json::to_string(values)?;
    tokio::task::spawn_blocking(move || store::write(&account, &blob))
        .await
        .context("keychain write")?
}

async fn delete_values(db: &Db, scope: &str) -> Result<()> {
    let account = account(db, scope);
    tokio::task::spawn_blocking(move || store::delete(&account))
        .await
        .context("keychain delete")?
}

// ── Reading and writing the variables ─────────────────────────────────────────

/// The variable names a scope's [`ENV_VARS_KEY`] blob holds, in UI order. Tolerates
/// the pre-keychain shape (`[{name, value}]`) so a database whose values couldn't be
/// moved yet — a locked keychain at startup — still resolves; see [`legacy_values`].
fn stored_names(blob: &str) -> Vec<String> {
    if let Ok(names) = serde_json::from_str::<Vec<String>>(blob) {
        return names;
    }
    serde_json::from_str::<Vec<EnvVar>>(blob)
        .unwrap_or_default()
        .into_iter()
        .map(|v| v.name)
        .collect()
}

/// The plaintext values still sitting in a pre-keychain blob. Empty for every blob
/// this build writes — it only ever fills in for a scope [`migrate_vars_to_keychain`]
/// could not move (it refuses to *drop* a value it can't store, so nothing the user
/// typed is ever lost to an unavailable keychain; the next launch retries).
fn legacy_values(blob: &str) -> HashMap<String, String> {
    serde_json::from_str::<Vec<EnvVar>>(blob)
        .unwrap_or_default()
        .into_iter()
        .filter(|v| !v.value.is_empty())
        .map(|v| (v.name, v.value))
        .collect()
}

/// Zip a scope's stored names back together with their values.
fn zip_values(
    names: Vec<String>,
    mut values: HashMap<String, String>,
    legacy: HashMap<String, String>,
) -> Vec<(String, String)> {
    names
        .into_iter()
        .map(|name| {
            let value = values
                .remove(&name)
                .or_else(|| legacy.get(&name).cloned())
                .unwrap_or_default();
            (name, value)
        })
        .collect()
}

/// A scope's variables as the `[{name, value}]` JSON the settings editor reads
/// (`None` when the scope has never stored any). Routed here from
/// [`settings::get`](crate::settings::get) so the UI is the only place a value is
/// ever reassembled. A keychain failure is an error, not an empty value — showing
/// blanks would invite the user to save over their own secrets.
pub async fn vars_json(db: &Db, scope: &str) -> Result<Option<String>> {
    let Some(blob) = crate::settings::get_raw(db, scope, ENV_VARS_KEY).await? else {
        return Ok(None);
    };
    let names = stored_names(&blob);
    if names.is_empty() {
        return Ok(Some("[]".to_string()));
    }
    let vars: Vec<EnvVar> = zip_values(names, load_values(db, scope).await?, legacy_values(&blob))
        .into_iter()
        .map(|(name, value)| EnvVar { name, value })
        .collect();
    Ok(Some(serde_json::to_string(&vars)?))
}

/// Store a scope's variables from the `[{name, value}]` JSON the settings editor
/// writes (`None` clears the scope). Routed here from
/// [`settings::set`](crate::settings::set): it is the single seam every writer —
/// IPC, tests, future callers — crosses, so a plaintext value can't get back into
/// the table by some other door.
///
/// The keychain is written *first*: a names row we couldn't back with values would
/// read as a list of variables that are all mysteriously empty.
pub async fn set_vars_json(db: &Db, scope: &str, json: Option<String>) -> Result<()> {
    let Some(json) = json else {
        delete_values(db, scope).await?;
        return crate::settings::set_raw(db, scope, ENV_VARS_KEY, None).await;
    };

    let vars: Vec<EnvVar> = serde_json::from_str(&json)
        .context("the environment variables aren't in the expected {name, value} shape")?;
    let values: HashMap<String, String> = vars
        .iter()
        .map(|v| (v.name.clone(), v.value.clone()))
        .collect();
    save_values(db, scope, &values).await?;

    let names: Vec<&str> = vars.iter().map(|v| v.name.as_str()).collect();
    crate::settings::set_raw(
        db,
        scope,
        ENV_VARS_KEY,
        Some(serde_json::to_string(&names)?),
    )
    .await
}

/// Move the variable values an older build stored in plaintext in the `settings`
/// table into the OS keychain, leaving the names behind. Called once at startup
/// (`db::init`, which then VACUUMs the pages the values were freed from — a
/// dropped value lingers on the freelist and in the `-wal` sidecar). Idempotent:
/// a blob that is already names-only is skipped, so this is a no-op on a fresh
/// install and on every launch after the first.
///
/// Returns whether any *secret* was moved, so the caller can decide to scrub.
///
/// Unlike the Linear tokens — one click to re-issue — a value here is the user's
/// own and may exist nowhere else, so a keychain that refuses the write leaves the
/// row exactly as it was (loud log, still resolves, retried next launch) rather
/// than dropping it.
pub(crate) async fn migrate_vars_to_keychain(db: &Db) -> Result<bool> {
    // Runs before the migrations, so on a fresh install there is no table yet.
    let has_settings: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?")
            .bind("settings")
            .fetch_one(db)
            .await?;
    if has_settings == 0 {
        return Ok(false);
    }

    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT scope, value FROM settings WHERE key = ?")
            .bind(ENV_VARS_KEY)
            .fetch_all(db)
            .await?;

    let mut moved_a_secret = false;
    for (scope, blob) in rows {
        // Already names-only (`["FOO"]`), or empty: nothing to move.
        let Ok(legacy) = serde_json::from_str::<Vec<EnvVar>>(&blob) else {
            continue;
        };
        if legacy.is_empty() {
            continue;
        }

        let values: HashMap<String, String> = legacy
            .iter()
            .map(|v| (v.name.clone(), v.value.clone()))
            .collect();
        if let Err(e) = save_values(db, &scope, &values).await {
            log::error!(
                "couldn't move the environment variable values for scope {scope} into the OS \
                 keychain ({e:#}); leaving them where they are rather than losing them — santree \
                 will try again on the next launch"
            );
            continue;
        }

        let names: Vec<&str> = legacy.iter().map(|v| v.name.as_str()).collect();
        crate::settings::set_raw(
            db,
            &scope,
            ENV_VARS_KEY,
            Some(serde_json::to_string(&names)?),
        )
        .await?;
        moved_a_secret |= legacy.iter().any(|v| !v.value.is_empty());
        log::info!(
            "moved {} environment variable value(s) for scope {scope} into the OS keychain",
            legacy.len()
        );
    }
    Ok(moved_a_secret)
}

// ── Resolution (the terminal-spawn path) ──────────────────────────────────────

/// The final environment to inject for a spawn in `cwd`: the app-scoped config
/// merged with the config of the repo `cwd` belongs to (repo wins), with explicit
/// variables taking precedence over `.env` file contents. Never errors — a bad
/// value or unreadable file just contributes nothing, so it can't block a spawn.
///
/// Precedence, lowest → highest (later overrides earlier on a name clash):
/// app env files → repo env files → app variables → repo variables.
pub async fn resolve_env(db: &Db, cwd: Option<&str>) -> Vec<(String, String)> {
    let repo = match cwd {
        Some(c) => repo_scope_for_cwd(db, c).await,
        None => None,
    };

    // All four settings blobs (both keys × both scopes) in one round-trip — this runs
    // on every terminal spawn. When there's no repo the scope binding collapses onto
    // `app`, which just yields the app rows.
    let repo_scope = repo.as_deref().unwrap_or("app");
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT scope, key, value FROM settings WHERE key IN (?, ?) AND scope IN ('app', ?)",
    )
    .bind(ENV_VARS_KEY)
    .bind(ENV_FILES_KEY)
    .bind(repo_scope)
    .fetch_all(db)
    .await
    .unwrap_or_default();
    let blob = |scope: &str, key: &str| {
        rows.iter()
            .find(|(s, k, _)| s == scope && k == key)
            .map(|(_, _, v)| v.as_str())
    };

    // Built in precedence order, then folded so a later layer overrides an earlier one.
    let mut layers = vec![files_env(blob("app", ENV_FILES_KEY)).await];
    if repo.is_some() {
        layers.push(files_env(blob(repo_scope, ENV_FILES_KEY)).await);
    }
    layers.push(scope_vars(db, "app", blob("app", ENV_VARS_KEY)).await);
    if repo.is_some() {
        layers.push(scope_vars(db, repo_scope, blob(repo_scope, ENV_VARS_KEY)).await);
    }

    let mut merged: HashMap<String, String> = HashMap::new();
    for (name, value) in layers.into_iter().flatten() {
        merged.insert(name, value);
    }

    // Sorted for a deterministic order (env order is otherwise irrelevant).
    let mut out: Vec<(String, String)> = merged.into_iter().collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// The `repo:<name>` settings scope for the repo whose local path is the longest
/// prefix of `cwd` (a worktree lives at `<repo>/.santree/worktrees/<id>`, so its
/// cwd is always under the repo path). `None` when no registered repo contains it.
async fn repo_scope_for_cwd(db: &Db, cwd: &str) -> Option<String> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT name, path FROM repos WHERE path IS NOT NULL")
            .fetch_all(db)
            .await
            .ok()?;

    let cwd = Path::new(cwd);
    let mut best: Option<(usize, String)> = None;
    for (name, path) in rows {
        // `starts_with` is component-wise, so `/a/b` doesn't match `/a/bc`.
        if cwd.starts_with(Path::new(&path)) {
            let len = path.len();
            if best.as_ref().is_none_or(|(l, _)| len > *l) {
                best = Some((len, name));
            }
        }
    }
    best.map(|(_, name)| format!("repo:{name}"))
}

/// The explicit variables in a scope: the names from its [`ENV_VARS_KEY`] blob, the
/// values from the keychain. Empty when unset or malformed — a corrupt blob (or an
/// unavailable keychain) must not break spawning, so failures degrade to nothing.
async fn scope_vars(db: &Db, scope: &str, blob: Option<&str>) -> Vec<(String, String)> {
    let Some(blob) = blob else {
        return Vec::new();
    };
    let names = stored_names(blob);
    if names.is_empty() {
        return Vec::new();
    }
    let values = load_values(db, scope).await.unwrap_or_else(|e| {
        log::error!("couldn't read the environment variables for scope {scope}: {e:#}");
        HashMap::new()
    });
    zip_values(names, values, legacy_values(blob))
}

/// Every variable loaded from the `.env` files in a scope's [`ENV_FILES_KEY`] blob,
/// in list order (later files override earlier ones on a name clash). The reads are
/// blocking file I/O on a hot path (every terminal spawn, every setup-script run), so
/// they go to a blocking thread rather than stalling an async worker.
async fn files_env(json: Option<&str>) -> Vec<(String, String)> {
    let Some(json) = json else {
        return Vec::new();
    };
    let paths: Vec<String> = serde_json::from_str(json).unwrap_or_default();
    if paths.is_empty() {
        return Vec::new();
    }
    tokio::task::spawn_blocking(move || paths.iter().flat_map(|p| parse_env_file(p)).collect())
        .await
        .unwrap_or_default()
}

/// Whether `path` is a file santree is *configured* to read: one the user added to
/// some scope's env-file list. The list is the command's real domain — see
/// `commands::env_file_vars`, which won't parse anything else.
pub async fn is_registered_env_file(db: &Db, path: &str) -> bool {
    let blobs: Vec<(String,)> = sqlx::query_as("SELECT value FROM settings WHERE key = ?")
        .bind(ENV_FILES_KEY)
        .fetch_all(db)
        .await
        .unwrap_or_default();
    blobs.iter().any(|(blob,)| {
        serde_json::from_str::<Vec<String>>(blob)
            .unwrap_or_default()
            .iter()
            .any(|p| p == path)
    })
}

/// Parse a `.env` file into KEY=VALUE pairs *without* mutating our own process
/// env (`dotenvy::from_path_iter`, not `from_path`). Unreadable/malformed lines
/// are skipped; a missing file yields nothing.
///
/// Only ever a *regular* file, and never a big one: `dotenvy` reads to the end, so a
/// fifo or `/dev/zero` — which a path can point at as easily as a `.env` can — would
/// hang the blocking thread forever, and it's the terminal-spawn path that waits.
pub fn parse_env_file(path: &str) -> Vec<(String, String)> {
    let Ok(meta) = std::fs::metadata(path) else {
        return Vec::new();
    };
    if !meta.is_file() || meta.len() > MAX_ENV_FILE_BYTES {
        log::warn!("ignoring env file {path}: not a regular file, or larger than 1 MiB");
        return Vec::new();
    }
    match dotenvy::from_path_iter(path) {
        Ok(iter) => iter.flatten().collect(),
        Err(_) => Vec::new(),
    }
}

/// The variable names an `.env` file defines — for the settings UI's
/// "N variables loaded" readout. Empty when the file is missing/unreadable.
pub fn env_file_var_names(path: &str) -> Vec<String> {
    parse_env_file(path).into_iter().map(|(k, _)| k).collect()
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::*;
    use crate::settings;

    fn write_env(tag: &str, body: &str) -> String {
        let path =
            std::env::temp_dir().join(format!("santree-env-{}-{tag}.env", std::process::id()));
        std::fs::write(&path, body).unwrap();
        path.to_str().unwrap().to_string()
    }

    async fn test_db() -> Db {
        let dir = std::env::temp_dir().join(format!("santree-env-{}", Uuid::new_v4()));
        crate::db::init(dir.join("test.db")).await.unwrap()
    }

    #[test]
    fn parses_env_file_and_skips_comments() {
        let p = write_env(
            "basic",
            "# a comment\nFOO=bar\nBAZ=\"quoted value\"\n\nEMPTY=\n",
        );
        let vars = parse_env_file(&p);
        assert_eq!(vars.iter().find(|(k, _)| k == "FOO").unwrap().1, "bar");
        assert_eq!(
            vars.iter().find(|(k, _)| k == "BAZ").unwrap().1,
            "quoted value"
        );
        assert!(vars.iter().any(|(k, _)| k == "EMPTY"));
        assert_eq!(env_file_var_names(&p).len(), 3);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn missing_file_yields_nothing() {
        assert!(parse_env_file("/no/such/santree-env.env").is_empty());
    }

    /// `dotenvy` reads to EOF, and a character device never reaches one: parsing
    /// `/dev/zero` on the spawn path would wedge a blocking thread forever.
    #[test]
    fn refuses_anything_that_isnt_a_regular_file() {
        assert!(parse_env_file("/dev/zero").is_empty());
        assert!(parse_env_file("/dev/null").is_empty());
        assert!(parse_env_file("/tmp").is_empty());
    }

    /// The values never touch the `settings` table: it keeps the names, the keychain
    /// keeps the secrets. This is the invariant the whole module exists for.
    #[tokio::test]
    async fn values_are_kept_out_of_the_settings_table() {
        let db = test_db().await;

        settings::set(
            &db,
            "app",
            ENV_VARS_KEY,
            Some(r#"[{"name":"DATABASE_URL","value":"postgres://hunter2@db/prod"}]"#.into()),
        )
        .await
        .unwrap();

        let stored = settings::get_raw(&db, "app", ENV_VARS_KEY)
            .await
            .unwrap()
            .expect("the names row is still written");
        assert_eq!(stored, r#"["DATABASE_URL"]"#);
        assert!(
            !stored.contains("hunter2"),
            "a secret must never be readable from the database: {stored}"
        );
        // Nothing anywhere else in the table holds it either.
        let anywhere: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM settings WHERE value LIKE '%hunter2%'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(anywhere, 0);

        // …and it still round-trips through the settings surface the UI reads.
        assert_eq!(
            settings::get(&db, "app", ENV_VARS_KEY).await.unwrap(),
            Some(r#"[{"name":"DATABASE_URL","value":"postgres://hunter2@db/prod"}]"#.into())
        );

        // Clearing the scope takes the secret with it.
        settings::set(&db, "app", ENV_VARS_KEY, None).await.unwrap();
        assert_eq!(settings::get(&db, "app", ENV_VARS_KEY).await.unwrap(), None);
        assert!(load_values(&db, "app").await.unwrap().is_empty());
    }

    /// A database written by a build that stored values in plaintext: the values move
    /// to the keychain, the row is rewritten names-only, and nothing is lost.
    #[tokio::test]
    async fn migrate_moves_plaintext_values_out_of_the_database() {
        let db = test_db().await;

        // Exactly what an older build left behind (written past the dispatching seam).
        settings::set_raw(
            &db,
            "app",
            ENV_VARS_KEY,
            Some(r#"[{"name":"API_KEY","value":"sk-live-42"},{"name":"BLANK","value":""}]"#.into()),
        )
        .await
        .unwrap();

        assert!(
            migrate_vars_to_keychain(&db).await.unwrap(),
            "a secret moved"
        );

        let stored = settings::get_raw(&db, "app", ENV_VARS_KEY)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored, r#"["API_KEY","BLANK"]"#);
        assert!(!stored.contains("sk-live-42"));
        assert_eq!(
            settings::get(&db, "app", ENV_VARS_KEY).await.unwrap(),
            Some(r#"[{"name":"API_KEY","value":"sk-live-42"},{"name":"BLANK","value":""}]"#.into()),
            "the values are still there, just not in the database"
        );

        // Idempotent: a names-only row has nothing left to move.
        assert!(!migrate_vars_to_keychain(&db).await.unwrap());
    }

    /// The precedence the doc-comment promises, end to end:
    /// app files → repo files → app vars → repo vars.
    #[tokio::test]
    async fn resolve_env_layers_app_under_repo_and_files_under_vars() {
        let dir = std::env::temp_dir().join(format!("santree-env-{}", Uuid::new_v4()));
        let repo_dir = dir.join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();
        let repo_path = repo_dir.to_str().unwrap();
        let db = crate::db::init(dir.join("test.db")).await.unwrap();

        sqlx::query("INSERT INTO repos (name, path) VALUES ('acme', ?)")
            .bind(repo_path)
            .execute(&db)
            .await
            .unwrap();

        let env_file = dir.join("app.env");
        std::fs::write(&env_file, "FROM_FILE=file\nBOTH=file\n").unwrap();
        let files_json = serde_json::to_string(&[env_file.to_str().unwrap()]).unwrap();
        settings::set(&db, "app", ENV_FILES_KEY, Some(files_json))
            .await
            .unwrap();
        settings::set(
            &db,
            "app",
            ENV_VARS_KEY,
            Some(r#"[{"name":"BOTH","value":"app"},{"name":"SCOPED","value":"app"}]"#.into()),
        )
        .await
        .unwrap();
        settings::set(
            &db,
            "repo:acme",
            ENV_VARS_KEY,
            Some(r#"[{"name":"SCOPED","value":"repo"}]"#.into()),
        )
        .await
        .unwrap();

        // A cwd inside the repo picks up the repo scope on top of the app scope.
        let env: HashMap<_, _> = resolve_env(&db, Some(repo_path))
            .await
            .into_iter()
            .collect();
        assert_eq!(env.get("FROM_FILE").unwrap(), "file");
        assert_eq!(env.get("BOTH").unwrap(), "app", "vars override files");
        assert_eq!(env.get("SCOPED").unwrap(), "repo", "repo overrides app");

        // Outside any registered repo, only the app scope applies.
        let env: HashMap<_, _> = resolve_env(&db, Some("/elsewhere"))
            .await
            .into_iter()
            .collect();
        assert_eq!(env.get("SCOPED").unwrap(), "app");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A keychain that refused the migration leaves the plaintext row in place, so a
    /// spawn still gets the user's variables (and the next launch retries the move).
    #[tokio::test]
    async fn resolve_env_still_reads_a_scope_the_keychain_couldnt_take() {
        let db = test_db().await;
        settings::set_raw(
            &db,
            "app",
            ENV_VARS_KEY,
            Some(r#"[{"name":"LEGACY","value":"still-works"}]"#.into()),
        )
        .await
        .unwrap();

        let env: HashMap<_, _> = resolve_env(&db, None).await.into_iter().collect();
        assert_eq!(env.get("LEGACY").unwrap(), "still-works");
    }

    /// `env_file_vars` only reports on files the user actually added — the setting is
    /// the command's whole domain (see `commands::env_file_vars`).
    #[tokio::test]
    async fn only_registered_env_files_are_readable() {
        let db = test_db().await;
        let p = write_env("registered", "FOO=bar\n");

        assert!(!is_registered_env_file(&db, &p).await);
        assert!(!is_registered_env_file(&db, "/etc/passwd").await);

        settings::set(
            &db,
            "repo:acme",
            ENV_FILES_KEY,
            Some(serde_json::to_string(&[&p]).unwrap()),
        )
        .await
        .unwrap();

        assert!(is_registered_env_file(&db, &p).await);
        assert!(!is_registered_env_file(&db, "/etc/passwd").await);
        // An exact match, so a path that merely normalises to a registered one is out.
        assert!(!is_registered_env_file(&db, &format!("{p}/../{p}")).await);

        let _ = std::fs::remove_file(&p);
    }
}
