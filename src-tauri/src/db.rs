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

    /// Every migration this build ships, pinned by version, name and content hash.
    ///
    /// sqlx records each applied migration's checksum in `_sqlx_migrations` and
    /// refuses to open a database whose stored checksum no longer matches. That is
    /// what the module note above means by *a migration file is immutable once it
    /// has shipped*: editing an applied file — even to reword a comment — is
    /// `MigrateError::VersionMismatch` on every existing install, which
    /// [`migrate_error`] reports as "the database and the app are out of step",
    /// i.e. the user is locked out of their own data. Deleting one is the same
    /// failure wearing `VersionMissing` (which is why `0017_dev_todos.sql` stays
    /// in the directory even though `0028` drops its table).
    ///
    /// Every other test in this module opens an *empty* file, where an edited
    /// migration is simply the new truth — so before this list, rewriting `0005`
    /// or deleting `0017` was green in CI and bricked every installed app on its
    /// next launch. This is the only thing standing between those two facts.
    ///
    /// **A red line here is not a row to update.** Restore the file you touched
    /// and put the change in a new migration. The one legitimate edit is appending
    /// the row for a migration you just added.
    const SHIPPED_MIGRATIONS: &[(i64, &str, &str)] = &[
    (1, "init", "9619413e75d97371411d3fcf6d0a56ad6187e684d5f6db005c476d210e35f5e6976d9781462630b262102510358abfd5"),
    (2, "repo path", "4682b72b1c4ef93f0485dbbc1e14b7f45d5b9bea05b92a555847840a819533019d2f7228a8b2c70277334762e2981d43"),
    (3, "drop seed repos", "e71f73ae31dc1f7deb30b2664e804fce8b55a3c8bd58829198395db39870ef40d987bc4fe117414b54b72cb00a72c7a0"),
    (4, "task notes", "568f119e840a1d0685e14141cf3020d4fc11e2e3b6721e2e2361c85846641e4ba131a602569fa644ab3919778c8ade27"),
    (5, "worktree links", "ff6b15aec3499c44c48696577b282597fad34a175e96e765b52a253b9ebc7489d98c0ea4f5145182ea6e613b21737d84"),
    (6, "commit drafts", "344e6767cc523b486a2ef29c40cebf38a0dfcd3e6ac76b2f69473cef055dc7425e0c5fbd2040abd4ae5f39511eb1847d"),
    (7, "terminal sessions", "c6b32873617548bc06da8b2505075d99b15bf9ea73d070aaf0df2bf423efd8c8cedced0d53975bf92065e07b6dd48cd8"),
    (8, "drop repos agents", "e359a8dd4b87b403f671b9481675f4f39086f108d42c8139cf52a78efec50b0d7d5ab9c8e008982e05c4371b56e1ed69"),
    (9, "worktree tabs", "dfe40b1deb692a0de84b5fb4332aef563e19d5d304de60be96265fe26cfc38475141aa2b1a2a48894e75e134b80184e4"),
    (10, "session state", "5210331cbd77d4abc2d30939a3e33d0109a72f5a093e29aa092cb45ad5ad2f9f8ac5ce0eec598007a94fda3eab081f7f"),
    (11, "session usage live", "da3596febc92c7e89921cdffe49deabd9990cde735d0fa5d5fd78e2cf2df778ed88bfb577147d9a6f98ee0b2c60ed0f8"),
    (12, "reviewed files", "a91eb22152b905ab8a6d00a681ef2c8b97d3242c7db77b9a9e8220271ba93a9a402c11ff84111d1381488c8e3d912725"),
    (13, "worktree tabs fixci", "86ce832d596f211d3d6af6d05e21b9ff82b80fe7b7cb1dbee652595d083394c8563ab468f0bedcccf661105657d65368"),
    (14, "linear tokens to keychain", "bf4fab62b4a1dc2213b34178d0b6801c009c14d4be1f9721beefb5ebc73fb75b25affc5cfc27607f44e8d22b15f6da21"),
    (15, "repos unique path", "83fd283049fdce09e98b9899546328745635af5c4f81969e149921bd086758eeb9d7f738ab545e8bdbd0d995a742b731"),
    (16, "orphaned repo rows", "b6a3b7c59f18356d03047178a5eec4580c82a83d57f3e114d5b4f193a98e1e99ed9c8190c0c57ba5f1ca0ca9048c039f"),
    (17, "dev todos", "5112dd642257ccedacc8326f8cdab6e1a9aeedd3ef8f2752a13cc3df65c54b35979c15a7d7a8d081269ec68c85a1aa51"),
    (18, "terminal sessions by session id", "2c5d8eb439e3efa6958a9bf2ab24369584d625bc0333faf9c2bc8845bc8da524a1f029b8100d8a0d4092258da74ee236"),
    (19, "review briefs", "f73d315804626ffdc03d6738ea76730818a900dec6e8f454385a368a54e9cfd816abfbbd64f1d38042a287cba0fea65f"),
    (20, "english analysis", "5526948b19f4fe1d79da15fec538bb52553194ed352796d9191915cfbc67f4a0bafb0eda08da385c947cfb33751c4d1d"),
    (21, "english analysis scope", "7ed37866a7915c78993af8ffd97a899dfdb136f4ce59ae217226d3c17e760863e9f5727662dadd2a18fcccb5349a0ac4"),
    (22, "linear scopes", "80ab449ceb97bea4ea6959de27cb1bb959b7ac1aaeab47f64aac36312ef578e7b03a1da29acbfed78879807c1bd8400d"),
    (23, "review drafts", "973a96e9441afe4c63fa3991984a7c31e7b70796997a9b4cc558367f8403ba035376024df32d14f7ce88da09eaf95286"),
    (24, "agent provenance", "0346b31f199026045e51c816971804270ab8ca1dd92b9fd0fe3ff7d100fec32b185e665e38371b00ecd3f27fa4d9efce"),
    (25, "provider sessions", "1af68cb28ce6746216ba595ddf4e21dd8ca846114fbbc8cfbc7ea047e46216e87a5c3f293ce3674ca2e527809d513c7d"),
    (26, "review work items", "b821afeee8e421ed3c9e04bff1f410f79e737f1e25a450221e9d3b3afd606806809dd9e901a2940c74fb2e65d69ba5b8"),
    (27, "claude rate limits", "fb932718d99d4df8db68a5778521bdfe0b378b10cc3958650885638535808f7c301dea22598cb0c7ba8a96c486fcf00d"),
    (28, "drop dev todos", "0b3033655395ed201a82301e741fc5c917a9e075e14c315398b070ce6ac4a6122fc184ca55a9df7bdc5556e087333dc1"),
    (29, "review work items check source", "6d0aa9c4560e7f5715a50798033b74849d0ca197b371f7cd2357f5558ca2e3d5e91fb84a4023cbe50f26b5a961f011c0"),
    (30, "worktree tabs review identity", "f5db006bd8efb71cfcfcc4873560c48b2fd6a1c060130d8028fd26e1d0641b13107eeb0d27367f93f627f32de83aea34"),
    ];

    /// See [`SHIPPED_MIGRATIONS`]. Checked against the embedded set, so it fails at
    /// `cargo test` rather than on a user's next launch.
    #[test]
    fn no_shipped_migration_has_been_edited_or_removed() {
        let actual: Vec<(i64, String, String)> = MIGRATOR
            .iter()
            .map(|m| {
                let checksum = m.checksum.iter().fold(String::new(), |mut acc, b| {
                    use std::fmt::Write;
                    let _ = write!(acc, "{b:02x}");
                    acc
                });
                (m.version, m.description.to_string(), checksum)
            })
            .collect();

        // Reported per-version rather than as one list diff, so the failure names
        // the file to restore.
        for (version, description, checksum) in SHIPPED_MIGRATIONS {
            let found = actual
                .iter()
                .find(|(v, _, _)| v == version)
                .unwrap_or_else(|| {
                    panic!(
                        "migration {version} ({description}) is gone from src-tauri/migrations/. \
                     Every database that applied it refuses to open without it — restore the \
                     file and drop what it created in a NEW migration instead."
                    )
                });
            assert_eq!(
                (found.1.as_str(), found.2.as_str()),
                (*description, *checksum),
                "migration {version} ({description}) has changed on disk. A shipped migration \
                 is immutable: every install that already applied it will refuse to open \
                 (VersionMismatch). Restore the file byte-for-byte and put the change in a \
                 NEW migration."
            );
        }

        // The other direction: a genuinely new migration is expected, and adding its
        // row here is the one edit this pin invites.
        let extra: Vec<i64> = actual
            .iter()
            .map(|(v, _, _)| *v)
            .filter(|v| !SHIPPED_MIGRATIONS.iter().any(|(p, _, _)| p == v))
            .collect();
        assert!(
            extra.is_empty(),
            "new migration(s) {extra:?} — add their (version, description, checksum) rows to \
             SHIPPED_MIGRATIONS. The test prints the checksum it computed above."
        );
    }

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
