//! The local SQLite database: connection pool, migrations, and one-time seeding.
//!
//! Structured app state (Linear tokens, repo↔org links, settings) lives here.
//! On-disk `.santree/` files (worktree scripts, etc.) are left as files.

use std::path::PathBuf;

use anyhow::{Context, Result};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

/// The app-wide database handle (cheap to clone; backed by a pool).
pub type Db = SqlitePool;

/// Open (creating if needed) the database, run migrations, and seed initial data.
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

    import_legacy_linear_auth(&pool).await?;

    Ok(pool)
}

/// One-time import of the CLI's `~/.config/santree/auth.json` Linear tokens, so
/// an existing CLI login carries over. Runs only when no orgs are stored yet.
async fn import_legacy_linear_auth(pool: &Db) -> Result<()> {
    let existing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM linear_orgs")
        .fetch_one(pool)
        .await?;
    if existing > 0 {
        return Ok(());
    }

    let Some(path) = legacy_auth_path() else {
        return Ok(());
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Ok(());
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Ok(());
    };
    let Some(orgs) = json.get("linear").and_then(|v| v.as_object()) else {
        return Ok(());
    };

    for (slug, tokens) in orgs {
        let get = |k: &str| {
            tokens
                .get(k)
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string()
        };
        let expires_at = tokens
            .get("expires_at")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        sqlx::query(
            "INSERT OR IGNORE INTO linear_orgs (slug, name, access_token, refresh_token, expires_at)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(slug)
        .bind(get("org_name"))
        .bind(get("access_token"))
        .bind(get("refresh_token"))
        .bind(expires_at)
        .execute(pool)
        .await?;
        tracing::info!(slug = %slug, "imported Linear org from CLI auth.json");
    }
    Ok(())
}

fn legacy_auth_path() -> Option<PathBuf> {
    let base = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .map(|h| PathBuf::from(h).join(".config"))
        })?;
    Some(base.join("santree").join("auth.json"))
}
