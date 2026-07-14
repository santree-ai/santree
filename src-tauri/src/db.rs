//! The local SQLite database: connection pool and migrations.
//!
//! Structured app state (repo↔org links, settings) lives here. Secrets do not —
//! the Linear OAuth tokens live in the OS keychain (`linear.rs`). On-disk
//! `.santree/` files (worktree scripts, etc.) are left as files.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use sqlx::migrate::{MigrateError, Migrator};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;

/// The migration set, embedded at compile time. Named so [`init`] can ask it what's
/// pending *before* running it (see [`backup_before_migrations`]).
///
/// **A migration file is immutable once it has shipped.** sqlx stores a checksum of
/// each one in `_sqlx_migrations` and refuses to open a database whose stored checksum
/// no longer matches (`MigrateError::VersionMismatch`) — so editing an applied file,
/// *even to reword a comment*, locks every existing user out of their own data. Correct
/// a mistake with a new migration, never by rewriting an old one.
///
/// One such mistake is on the books: 0010's header claims `session_state` "stays
/// bounded without pruning". It does not — it gains a row per Claude session and drops
/// none, as does `session_usage_live` (0011). What actually bounds both is
/// `hooks::prune_stale_sessions`, which sweeps rows gone quiet for a week.
static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

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

    // Same story for the values of the user's own environment variables (Settings →
    // Environment): the names stay in `settings`, the values belong in the keychain.
    // No column to drop, so this one rewrites the rows itself — see `env`'s docs.
    let had_plaintext_env = crate::env::migrate_vars_to_keychain(&pool)
        .await
        .context("moving the environment variable values into the OS keychain")?;

    // Snapshot before anything destructive runs. Migrations rewrite the only copy of
    // the db (0003/0015 DELETE rows, 0008/0014 DROP COLUMN, 0013 rebuilds a table), so
    // a half-applied or wrong migration used to leave "move it aside" — i.e. lose every
    // repo link, setting and note — as the only way out.
    let backup = backup_before_migrations(&pool, &db_path).await;

    if let Err(e) = MIGRATOR.run(&pool).await {
        let err = migrate_error(e, &db_path, backup.as_deref());
        log::error!("{err:#}");
        return Err(err);
    }

    if had_plaintext_tokens || had_plaintext_env {
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

/// Dropping a column (or overwriting a row) doesn't erase its bytes: the old pages
/// land on the freelist and linger in the `-wal` sidecar. After a one-time secret
/// migration, rewrite the file and truncate the WAL so the plaintext is actually gone
/// from disk. Hygiene, not correctness — a failure here isn't worth failing startup.
async fn scrub_freed_pages(pool: &SqlitePool) {
    if let Err(e) = sqlx::query("VACUUM").execute(pool).await {
        log::warn!("couldn't vacuum the database after the secret migration: {e}");
    }
    if let Err(e) = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(pool)
        .await
    {
        log::warn!("couldn't truncate the write-ahead log after the secret migration: {e}");
    }
}

/// How many pre-migration snapshots to keep. One is written per schema upgrade, and
/// upgrades are rare, so a handful is enough to roll back a bad release without
/// letting copies of the db pile up in the user's data dir.
const MAX_BACKUPS: usize = 3;

/// Snapshot the database into `<data dir>/backups/` iff migrations are about to
/// change it. Returns where it landed, or `None` when there was nothing to do (a
/// fresh db, an up-to-date one) or the snapshot failed.
///
/// Best-effort by design: a backup that can't be written is a worse outcome than a
/// missing backup only if it also stops the app from starting, so every failure here
/// is logged and swallowed.
async fn backup_before_migrations(pool: &SqlitePool, db_path: &Path) -> Option<PathBuf> {
    if !has_pending_migrations(pool).await {
        return None;
    }
    let dir = db_path.parent()?.join("backups");
    // Same discipline as the data dir itself: the db holds the user's tickets, prompts
    // and repo layout, so a copy of it must not be world-readable either.
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::warn!("couldn't create {}: {e}", dir.display());
        return None;
    }
    if let Err(e) = chmod(&dir, 0o700) {
        log::warn!("couldn't lock down {}: {e:#}", dir.display());
        return None;
    }

    let dest = dir.join(format!(
        "santree-{}.db",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    ));
    if let Err(e) = snapshot(pool, &dest).await {
        log::warn!("pre-migration backup failed: {e:#}");
        return None;
    }
    log::info!("pre-migration backup written to {}", dest.display());
    prune_backups(&dir, MAX_BACKUPS);
    Some(dest)
}

/// Whether the embedded migration set has anything the db hasn't applied yet. A db
/// with no `_sqlx_migrations` table at all is brand new — there's nothing in it worth
/// backing up — so it counts as "no pending work".
async fn has_pending_migrations(pool: &SqlitePool) -> bool {
    let applied: Vec<(i64,)> = match sqlx::query_as("SELECT version FROM _sqlx_migrations")
        .fetch_all(pool)
        .await
    {
        Ok(rows) => rows,
        Err(_) => return false, // fresh database (no migrations table yet)
    };
    MIGRATOR
        .iter()
        .any(|m| !applied.iter().any(|(v,)| *v == m.version))
}

/// Copy the live database to `dest`.
///
/// `VACUUM INTO` rather than a file copy: it's SQLite's own consistent-snapshot
/// primitive, so it captures whatever is still sitting in the `-wal` sidecar and
/// writes a single self-contained file — a `fs::copy` of `santree.db` alone can miss
/// committed transactions entirely under WAL.
async fn snapshot(pool: &SqlitePool, dest: &Path) -> Result<()> {
    // VACUUM INTO refuses to overwrite; two upgrades in the same second would collide.
    if dest.exists() {
        std::fs::remove_file(dest).with_context(|| format!("replacing {}", dest.display()))?;
    }
    sqlx::query("VACUUM INTO ?")
        .bind(dest.to_string_lossy().as_ref())
        .execute(pool)
        .await
        .with_context(|| format!("snapshotting the database into {}", dest.display()))?;
    chmod(dest, 0o600)
}

/// Delete all but the newest `keep` snapshots. Filenames are `santree-<YYYYMMDD-HHMMSS>.db`,
/// so a lexicographic sort is a chronological one. Only ever touches files matching that
/// shape — never anything else a user may have parked in the folder.
fn prune_backups(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| Some(e.ok()?.file_name().to_str()?.to_string()))
        .filter(|n| n.starts_with("santree-") && n.ends_with(".db"))
        .collect();
    names.sort_unstable();
    let drop_count = names.len().saturating_sub(keep);
    for name in names.iter().take(drop_count) {
        if let Err(e) = std::fs::remove_file(dir.join(name)) {
            log::warn!("couldn't remove old backup {name}: {e}");
        }
    }
}

/// Turn a migration failure into something a human can act on. The one that
/// actually happens is a *downgrade*: manual DMG installs mean an older build can
/// open a db a newer one already stamped, and sqlx then reports migrations it has
/// never heard of. Everything else keeps sqlx's own message. `backup` is the
/// snapshot [`backup_before_migrations`] just took, when it took one — the difference
/// between "start over" and "restore this".
fn migrate_error(err: MigrateError, db_path: &Path, backup: Option<&Path>) -> anyhow::Error {
    let restore = backup
        .map(|p| {
            format!(
                "\n\nYour data was backed up before the upgrade — you can restore it by copying\n{}\nover\n{}",
                p.display(),
                db_path.display()
            )
        })
        .unwrap_or_default();
    match err {
        MigrateError::VersionMissing(v) | MigrateError::VersionNotPresent(v) => anyhow!(
            "This database was created by a newer version of santree — it has migration {v}, \
             which this build doesn't know about. Install the latest santree, or quit and move \
             {} aside to start with a fresh database.{restore}",
            db_path.display()
        ),
        MigrateError::VersionMismatch(v) => anyhow!(
            "Migration {v} was already applied to this database but no longer matches this \
             build — the database and the app are out of step. Install the latest santree, or \
             quit and move {} aside to start with a fresh database.{restore}",
            db_path.display()
        ),
        other => anyhow::Error::new(other).context(format!("running migrations{restore}")),
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
            None,
        );
        let msg = format!("{err:#}");
        assert!(msg.contains("newer version of santree"), "{msg}");
        assert!(msg.contains("migration 14"), "{msg}");
        assert!(msg.contains("/data/santree.db"), "{msg}");
        assert!(!msg.contains("backed up"), "no backup was taken: {msg}");
    }

    /// Anything that isn't a version skew is a genuine migration failure and must
    /// keep sqlx's own diagnosis rather than being retold as a downgrade.
    #[test]
    fn migrate_error_keeps_real_failures() {
        let err = migrate_error(MigrateError::Dirty(3), Path::new("/data/santree.db"), None);
        let msg = format!("{err:#}");
        assert!(msg.contains("running migrations"), "{msg}");
        assert!(msg.contains("partially applied"), "{msg}");
        assert!(!msg.contains("newer version"), "{msg}");
    }

    /// The whole point of the pre-migration snapshot: when a migration blows up, the
    /// user is told how to get their data back rather than to throw it away.
    #[test]
    fn migrate_error_points_at_the_backup() {
        let err = migrate_error(
            MigrateError::Dirty(3),
            Path::new("/data/santree.db"),
            Some(Path::new("/data/backups/santree-20260713-120000.db")),
        );
        let msg = format!("{err:#}");
        assert!(msg.contains("backed up"), "{msg}");
        assert!(
            msg.contains("/data/backups/santree-20260713-120000.db"),
            "{msg}"
        );
    }

    /// A fresh db has nothing to lose, and an up-to-date one isn't about to change —
    /// neither should pay for a snapshot on every launch.
    #[tokio::test]
    async fn no_backup_without_pending_migrations() {
        let base = std::env::temp_dir().join(format!("santree-db-nobackup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let db_path = base.join("santree.db");

        // First open runs every migration against an empty file: nothing to back up.
        let pool = init(db_path.clone()).await.unwrap();
        assert!(!base.join("backups").exists(), "fresh db was backed up");
        assert!(!has_pending_migrations(&pool).await);
        pool.close().await;

        // Second open finds the schema already current: still nothing to back up.
        let _pool = init(db_path).await.unwrap();
        assert!(!base.join("backups").exists(), "current db was backed up");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The path that matters: an existing db that a new build is about to migrate gets
    /// snapshotted, owner-only, into `backups/` — *before* anything destructive runs.
    #[tokio::test]
    async fn backs_up_a_db_with_pending_migrations() {
        let base = std::env::temp_dir().join(format!("santree-db-backup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let db_path = base.join("santree.db");

        // A db stamped as if only migration 1 had ever been applied — i.e. exactly what
        // a user's db looks like the first time they open a build that adds migrations.
        let pool = SqlitePool::connect(&format!("sqlite:{}?mode=rwc", db_path.display()))
            .await
            .unwrap();
        sqlx::query("CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO _sqlx_migrations (version) VALUES (1)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE precious (v TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO precious (v) VALUES ('do not lose me')")
            .execute(&pool)
            .await
            .unwrap();

        assert!(has_pending_migrations(&pool).await);
        let backup = backup_before_migrations(&pool, &db_path)
            .await
            .expect("a db with pending migrations is backed up");

        assert_eq!(backup.parent().unwrap(), base.join("backups"));
        let dir_mode = std::fs::metadata(base.join("backups"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(dir_mode, 0o700);

        // The snapshot must be a real, openable db that still holds the data.
        let copy = SqlitePool::connect(&format!("sqlite:{}", backup.display()))
            .await
            .unwrap();
        let (v,): (String,) = sqlx::query_as("SELECT v FROM precious")
            .fetch_one(&copy)
            .await
            .unwrap();
        assert_eq!(v, "do not lose me");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// `VACUUM INTO` must produce a *usable* copy — the rows have to survive the
    /// round-trip — and it must land owner-only, like the db it came from.
    #[tokio::test]
    async fn snapshot_copies_the_data_and_stays_private() {
        let base = std::env::temp_dir().join(format!("santree-db-snap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let pool = init(base.join("santree.db")).await.unwrap();
        sqlx::query("INSERT INTO settings (scope, key, value) VALUES ('app', 'theme', 'dark')")
            .execute(&pool)
            .await
            .unwrap();

        let dest = base.join("santree-20260713-120000.db");
        snapshot(&pool, &dest).await.unwrap();
        // Overwriting an existing snapshot must work (VACUUM INTO alone refuses to).
        snapshot(&pool, &dest).await.unwrap();

        let mode = std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "a copy of the db is as sensitive as the db");

        let copy = SqlitePool::connect(&format!("sqlite:{}", dest.display()))
            .await
            .unwrap();
        let (value,): (String,) =
            sqlx::query_as("SELECT value FROM settings WHERE scope = 'app' AND key = 'theme'")
                .fetch_one(&copy)
                .await
                .unwrap();
        assert_eq!(value, "dark");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Keep the newest N, drop the rest, and never touch a file we didn't write.
    #[test]
    fn prune_backups_keeps_the_newest_and_only_ours() {
        let dir = std::env::temp_dir().join(format!("santree-db-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for name in [
            "santree-20260101-000000.db",
            "santree-20260201-000000.db",
            "santree-20260301-000000.db",
            "santree-20260401-000000.db",
            "notes.txt",
        ] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }

        prune_backups(&dir, 2);

        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [
                "notes.txt",
                "santree-20260301-000000.db",
                "santree-20260401-000000.db"
            ]
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
