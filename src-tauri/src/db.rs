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

    Ok(pool)
}
