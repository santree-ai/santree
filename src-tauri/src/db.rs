//! The local SQLite database: connection pool and migrations.
//!
//! Structured app state (Linear tokens, repo↔org links, settings) lives here.
//! On-disk `.santree/` files (worktree scripts, etc.) are left as files.

use std::path::PathBuf;

use anyhow::{Context, Result};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

/// The app-wide database handle (cheap to clone; backed by a pool).
pub type Db = SqlitePool;

/// Open (creating if needed) the database and run migrations.
pub async fn init(db_path: PathBuf) -> Result<Db> {
    if let Some(dir) = db_path.parent() {
        std::fs::create_dir_all(dir).context("creating data dir")?;
    }
    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true);
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
