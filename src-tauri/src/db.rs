//! The local SQLite database: connection pool and migrations.
//!
//! Structured app state (repo↔org links, settings) lives here. Secrets do not —
//! the Linear OAuth tokens live in the OS keychain (`linear.rs`). On-disk
//! `.santree/` files (worktree scripts, etc.) are left as files.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use sqlx::migrate::MigrateError;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;

/// The app-wide database handle (cheap to clone; backed by a pool).
pub type Db = SqlitePool;

/// Milliseconds since the Unix epoch — the `updated_at` / token-expiry stamp used
/// across the db-backed modules (0 if the clock is somehow before the epoch).
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Open (creating if needed) the database and run migrations.
pub async fn init(db_path: PathBuf) -> Result<Db> {
    if let Some(dir) = db_path.parent() {
        std::fs::create_dir_all(dir).context("creating data dir")?;
        // Secrets live in the keychain, not here — but the db still holds the
        // user's tickets, prompts and repo layout, so lock the dir to the owner
        // before anything is written into it. Defense in depth: a default 0755
        // dir exposes the db (and its -wal/-shm sidecars) to any other local user
        // on distros where ~/.local/share isn't already 700.
        chmod(dir, 0o700)?;
    }
    // WAL + a busy timeout so the concurrent commands this app issues (Issues,
    // Triage and worktree ops all writing at once) don't trip over SQLITE_BUSY
    // on the default rollback journal.
    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        // SQLite leaves FK enforcement off per-connection by default, so the
        // schema's ON DELETE SET NULL would silently no-op without this.
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await
        .context("opening database")?;

    // Hand any plaintext Linear tokens an older build stored here to the OS
    // keychain *before* the migration that drops those columns — SQL can't reach
    // a keychain, so this half of the move has to be Rust. No-op on a fresh
    // install and on every start after the first.
    let had_plaintext_tokens = crate::linear::migrate_tokens_to_keychain(&pool)
        .await
        .context("moving the Linear tokens into the OS keychain")?;

    if let Err(e) = sqlx::migrate!("./migrations").run(&pool).await {
        let err = migrate_error(e, &db_path);
        log::error!("{err:#}");
        return Err(err);
    }

    if had_plaintext_tokens {
        scrub_freed_pages(&pool).await;
    }

    // Re-lock the db file and its WAL sidecars now that they exist (a fresh
    // `create_if_missing` file starts at the process umask, e.g. 0644).
    for suffix in ["", "-wal", "-shm"] {
        let p = PathBuf::from(format!("{}{suffix}", db_path.display()));
        if p.exists() {
            chmod(&p, 0o600)?;
        }
    }

    Ok(pool)
}

/// Dropping a column doesn't erase its bytes: the old pages land on the freelist
/// and linger in the `-wal` sidecar. After the one-time token migration, rewrite
/// the file and truncate the WAL so the plaintext tokens are actually gone from
/// disk. Hygiene, not correctness — a failure here isn't worth failing startup.
async fn scrub_freed_pages(pool: &SqlitePool) {
    if let Err(e) = sqlx::query("VACUUM").execute(pool).await {
        log::warn!("couldn't vacuum the database after the Linear token migration: {e}");
    }
    if let Err(e) = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(pool)
        .await
    {
        log::warn!("couldn't truncate the write-ahead log after the Linear token migration: {e}");
    }
}

/// Turn a migration failure into something a human can act on. The one that
/// actually happens is a *downgrade*: manual DMG installs mean an older build can
/// open a db a newer one already stamped, and sqlx then reports migrations it has
/// never heard of. Everything else keeps sqlx's own message.
fn migrate_error(err: MigrateError, db_path: &Path) -> anyhow::Error {
    match err {
        MigrateError::VersionMissing(v) | MigrateError::VersionNotPresent(v) => anyhow!(
            "This database was created by a newer version of santree — it has migration {v}, \
             which this build doesn't know about. Install the latest santree, or quit and move \
             {} aside to start with a fresh database.",
            db_path.display()
        ),
        MigrateError::VersionMismatch(v) => anyhow!(
            "Migration {v} was already applied to this database but no longer matches this \
             build — the database and the app are out of step. Install the latest santree, or \
             quit and move {} aside to start with a fresh database.",
            db_path.display()
        ),
        other => anyhow::Error::new(other).context("running migrations"),
    }
}

#[cfg(unix)]
fn chmod(path: &std::path::Path, mode: u32) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .with_context(|| format!("chmod {path:?}"))
}

#[cfg(not(unix))]
fn chmod(_path: &std::path::Path, _mode: u32) -> Result<()> {
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    #[tokio::test]
    async fn init_locks_down_data_dir_and_db_file() {
        let base = std::env::temp_dir().join(format!("santree-db-perms-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let db_path = base.join("santree.db");

        let _pool = init(db_path.clone()).await.unwrap();

        let dir_mode = std::fs::metadata(&base).unwrap().permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o700, "data dir must be owner-only");

        let db_mode = std::fs::metadata(&db_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(db_mode, 0o600, "db file must be owner-only");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// A downgrade (older DMG opening a newer db) must say so, not surface sqlx's
    /// "migration N was previously applied but is missing" to the user.
    #[test]
    fn migrate_error_names_the_downgrade() {
        let err = migrate_error(
            MigrateError::VersionMissing(14),
            Path::new("/data/santree.db"),
        );
        let msg = format!("{err:#}");
        assert!(msg.contains("newer version of santree"), "{msg}");
        assert!(msg.contains("migration 14"), "{msg}");
        assert!(msg.contains("/data/santree.db"), "{msg}");
    }

    /// Anything that isn't a version skew is a genuine migration failure and must
    /// keep sqlx's own diagnosis rather than being retold as a downgrade.
    #[test]
    fn migrate_error_keeps_real_failures() {
        let err = migrate_error(MigrateError::Dirty(3), Path::new("/data/santree.db"));
        let msg = format!("{err:#}");
        assert!(msg.contains("running migrations"), "{msg}");
        assert!(msg.contains("partially applied"), "{msg}");
        assert!(!msg.contains("newer version"), "{msg}");
    }
}
