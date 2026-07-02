//! The local SQLite database: connection pool and migrations.
//!
//! Structured app state (Linear tokens, repo↔org links, settings) lives here.
//! On-disk `.santree/` files (worktree scripts, etc.) are left as files.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
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
        // The db holds plaintext Linear OAuth tokens (access + refresh); lock the
        // dir down to the owner before anything is written into it. Mitigation
        // until the tokens move to the OS keychain — a default 0755 dir exposes
        // the db (and its -wal/-shm sidecars) to any other local user on distros
        // where ~/.local/share isn't already 700.
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

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("running migrations")?;

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
}
