//! Where every agent's hook finds `santree-hook`.
//!
//! The binary is a resource of the app bundle, and the updater replaces the
//! bundle by renaming the old one away. A hook command that named the bundle path
//! therefore broke in every agent still running across an update (and in an AI
//! review's MCP config, and in the user's global status-line wrapper): their
//! next event ran a path that no longer exists. Terminals outlive the app now, so
//! agents routinely do.
//!
//! So each launch copies it to `<app_data>/bin/santree-hook` once the database
//! is open ([`prepare`]) and every command santree writes names that path
//! ([`resolve`]). The copy is replaced atomically and only when its bytes
//! differ, never written in place, so a hook running during the swap executes
//! either the old file or the new one.
//!
//! **What this does and does not guard.** The stable copy lives in the user's own
//! data dir, which a process with the user's uid (an agent in a terminal) can
//! write to — as it can the user-owned app bundle. Every time a path is about to
//! be written into a hook command, a status line or an MCP config, [`resolve`]
//! re-compares the copy with the bundle and heals it. That is a **freshness
//! check, not integrity**: it keeps the copy equal to the bundle at those moments
//! and says nothing about what the bundle itself is (no code signature is checked
//! here: the shipped hook is signed with an identifier that carries a hash, and
//! nothing in the app can say what it should be). The window that remains is
//! real: a swap *between* two emissions persists until the next one, and a path
//! already written into a running agent's hooks is a live channel into that agent
//! until then. That is no worse than a swapped bundle, which the same uid can do
//! too; it is not better either.
//!
//! **Compatibility rule.** A running agent keeps calling whichever `santree-hook`
//! sits at that path, which is always the newest installed — against a database
//! the newest app has migrated. And a hook installed by an *older* app can run
//! against a *newer* schema until it is replaced. Either way the tables
//! `santree-hook` writes (`session_state`, `session_usage_live`,
//! `terminal_sessions`, `claude_rate_limits`, …) are a compatibility surface:
//! migrations that touch them are additive only (new nullable or defaulted
//! columns, new tables); never rename, retype or drop what a hook writes.
//! docs/server.md, "Hooks".

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{Context, Result};
use tauri::{AppHandle, Manager};

use crate::bundled_bin::{self, Installed};

/// The directory under the app data dir the stable copy lives in.
const DIR: &str = "bin";

/// The binary's name, here and in the bundle.
const NAME: &str = "santree-hook";

/// Where the stable copy lives. Set by [`prepare`]; unset (a dev build) means
/// commands name the bundled binary, as they always did.
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// `<data_dir>/bin/santree-hook`.
pub fn stable_path(data_dir: &Path) -> PathBuf {
    data_dir.join(DIR).join(NAME)
}

/// The path hook commands should name, made fresh now: the stable copy, compared
/// byte for byte with the bundle and healed if it differs (a freshness check, not
/// integrity: see the module doc); else the bundled binary (the resource dir in a
/// bundled build, a sibling of the running executable in a debug one). A stable
/// copy that can't be made falls back to the bundle path, logged.
/// `None` if there is no bundled binary.
///
/// Called every time a path is about to be written or emitted, not once per
/// launch: a few milliseconds, and it is what bounds how long a swapped copy
/// can stand.
pub fn resolve(app: &AppHandle) -> Option<PathBuf> {
    let bundled = bundled(app)?;
    let Some(data_dir) = DATA_DIR.get() else {
        return Some(bundled);
    };
    match ensure(data_dir, &bundled) {
        Ok(stable) => Some(stable),
        Err(e) => {
            log::warn!(
                "the stable santree-hook can't be made ({e:#}); hooks will name the bundle path, \
                 which an update moves"
            );
            Some(bundled)
        }
    }
}

/// The stable copy, made equal to `bundled`: byte-compared and rewritten
/// atomically if it differs ([`install`]). `Err` when it can't be made: the
/// caller must not reference it.
pub fn ensure(data_dir: &Path, bundled: &Path) -> Result<PathBuf> {
    install(data_dir, bundled)?;
    Ok(stable_path(data_dir))
}

/// The binary as the bundle ships it. What the smoke run asserts, because that
/// is what the release must contain.
pub fn bundled(app: &AppHandle) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok();
    pick_bundled(
        app.path().resource_dir().ok().as_deref(),
        exe.as_deref().and_then(Path::parent),
        cfg!(debug_assertions),
    )
}

/// [`bundled`]'s choice over the two places it looks, and whether the second is
/// allowed at all: only a debug build runs the binary cargo put beside it; a
/// release resolving a `santree-hook` from `Contents/MacOS` would run whatever
/// sits there.
fn pick_bundled(
    resources: Option<&Path>,
    beside_exe: Option<&Path>,
    allow_beside_exe: bool,
) -> Option<PathBuf> {
    let found = |dir: &Path| {
        let p = dir.join(NAME);
        p.exists().then_some(p)
    };
    resources
        .and_then(found)
        .or_else(|| beside_exe.filter(|_| allow_beside_exe).and_then(found))
}

/// Put the stable copy in place. Call after the database is open. A release
/// build only: a dev build keeps running the binary cargo just built, which
/// nothing renames away. Best effort — a failure is logged and commands fall
/// back to the bundled path, which works until the next update.
pub fn prepare(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let (Ok(data_dir), Some(bundled)) = (app.path().app_data_dir(), bundled(app)) else {
        log::warn!("no bundled santree-hook to install; hooks will name the bundle path");
        return;
    };
    if let Ok(dir) = fs::symlink_metadata(data_dir.join(DIR)) {
        if dir.is_dir() {
            bundled_bin::sweep_stale_tmp(&data_dir.join(DIR), NAME, bundled_bin::STALE_TMP);
        }
    }
    // Emissions re-run this; doing it here makes a launch fail loudly in the log
    // and not on the first agent.
    match ensure(&data_dir, &bundled) {
        Ok(stable) => log::info!("santree-hook at {}", stable.display()),
        Err(e) => log::warn!(
            "couldn't install santree-hook under {}: {e:#}; hooks will name the bundle path, \
             which an update moves",
            data_dir.display()
        ),
    }
    let _ = DATA_DIR.set(data_dir);
}

/// Copy `bundled` to [`stable_path`] ([`bundled_bin::install_copy`]: atomic,
/// 0755, only when the bytes differ). The directory is created 0700 and must be
/// this user's and closed to other users. That keeps other *users* out; it does
/// not keep out a process running as this user (an agent in a terminal can
/// write here, as it can write the bundle), which is why [`resolve`] re-checks
/// the copy at every emission rather than trusting where it sits.
pub fn install(data_dir: &Path, bundled: &Path) -> Result<Installed> {
    let dir = data_dir.join(DIR);
    santree_server::endpoint::prepare_run_dir(&dir).with_context(|| {
        format!(
            "the hook binary's folder {} isn't safe to use",
            dir.display()
        )
    })?;
    bundled_bin::install_copy(bundled, &dir, NAME)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Read;
    use std::os::unix::fs::PermissionsExt;
    use std::time::Duration;

    fn scratch() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn write_exec(path: &Path, bytes: &[u8]) {
        fs::write(path, bytes).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o7777
    }

    #[test]
    fn the_first_install_copies_the_binary_executable_into_a_private_dir() {
        let dir = scratch();
        let bundled = dir.path().join("bundled");
        write_exec(&bundled, b"hook v1");
        let data = dir.path().join("data");
        fs::create_dir(&data).unwrap();

        assert_eq!(install(&data, &bundled).unwrap(), Installed::Replaced);
        let stable = stable_path(&data);
        assert_eq!(fs::read(&stable).unwrap(), b"hook v1");
        assert_eq!(mode(&stable), 0o755);
        assert_eq!(mode(stable.parent().unwrap()), 0o700);
        // Nothing else is left beside it.
        let names: Vec<_> = fs::read_dir(stable.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, [std::ffi::OsString::from(NAME)]);
    }

    #[test]
    fn identical_bytes_are_left_alone_and_different_ones_replace_atomically() {
        use std::os::unix::fs::MetadataExt;
        let dir = scratch();
        let bundled = dir.path().join("bundled");
        write_exec(&bundled, b"hook v1");
        let data = dir.path().join("data");
        fs::create_dir(&data).unwrap();
        install(&data, &bundled).unwrap();
        let stable = stable_path(&data);
        let inode = fs::metadata(&stable).unwrap().ino();

        assert_eq!(install(&data, &bundled).unwrap(), Installed::Unchanged);
        assert_eq!(fs::metadata(&stable).unwrap().ino(), inode, "rewritten");

        // An update ships new bytes: a new file replaces it (a new inode — the
        // old one is never modified, so a running hook keeps its own).
        write_exec(&bundled, b"hook v2, longer");
        let running = File::open(&stable).unwrap();
        assert_eq!(install(&data, &bundled).unwrap(), Installed::Replaced);
        assert_eq!(fs::read(&stable).unwrap(), b"hook v2, longer");
        assert_ne!(fs::metadata(&stable).unwrap().ino(), inode);
        let mut old = String::new();
        (&running).read_to_string(&mut old).unwrap();
        assert_eq!(
            old, "hook v1",
            "the file a running hook has open was changed"
        );

        // Same length, different bytes: still replaced.
        write_exec(&bundled, b"hook v2, LONGER");
        assert_eq!(install(&data, &bundled).unwrap(), Installed::Replaced);
        assert_eq!(fs::read(&stable).unwrap(), b"hook v2, LONGER");
    }

    #[test]
    fn a_wrong_mode_or_a_symlink_at_the_target_is_replaced_not_followed() {
        let dir = scratch();
        let bundled = dir.path().join("bundled");
        write_exec(&bundled, b"hook");
        let data = dir.path().join("data");
        fs::create_dir(&data).unwrap();
        install(&data, &bundled).unwrap();
        let stable = stable_path(&data);

        fs::set_permissions(&stable, fs::Permissions::from_mode(0o777)).unwrap();
        assert_eq!(install(&data, &bundled).unwrap(), Installed::Replaced);
        assert_eq!(mode(&stable), 0o755);

        let victim = dir.path().join("victim");
        fs::write(&victim, b"hook").unwrap();
        fs::remove_file(&stable).unwrap();
        std::os::unix::fs::symlink(&victim, &stable).unwrap();
        assert_eq!(install(&data, &bundled).unwrap(), Installed::Replaced);
        assert!(!fs::symlink_metadata(&stable)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(&victim).unwrap(), b"hook", "written through");
    }

    #[test]
    fn a_directory_other_users_could_enter_or_a_symlinked_one_is_refused() {
        let dir = scratch();
        let bundled = dir.path().join("bundled");
        write_exec(&bundled, b"hook");

        let open = dir.path().join("open");
        fs::create_dir_all(open.join(DIR)).unwrap();
        fs::set_permissions(open.join(DIR), fs::Permissions::from_mode(0o755)).unwrap();
        let err = install(&open, &bundled).unwrap_err();
        assert!(format!("{err:#}").contains("0700"), "{err:#}");
        assert!(!stable_path(&open).exists());

        let real = dir.path().join("real");
        fs::create_dir(&real).unwrap();
        let linked = dir.path().join("linked");
        fs::create_dir(&linked).unwrap();
        std::os::unix::fs::symlink(&real, linked.join(DIR)).unwrap();
        assert!(install(&linked, &bundled).is_err());
        assert!(!real.join(NAME).exists(), "installed through a symlink");
    }

    #[test]
    fn a_missing_or_unreadable_source_is_an_error_and_leaves_nothing() {
        let dir = scratch();
        let data = dir.path().join("data");
        fs::create_dir(&data).unwrap();
        assert!(install(&data, &dir.path().join("nope")).is_err());
        assert!(!stable_path(&data).exists());
        // A directory is not a binary.
        assert!(install(&data, dir.path()).is_err());
    }

    /// A failed install (here: no write access to the dir) leaves the previous
    /// copy as it was, with no temp file left behind.
    #[test]
    fn a_failed_install_keeps_the_previous_copy_and_leaves_no_temp_file() {
        // Root ignores directory modes, so the failure can't be provoked.
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let dir = scratch();
        let bundled = dir.path().join("bundled");
        write_exec(&bundled, b"hook v1");
        let data = dir.path().join("data");
        fs::create_dir(&data).unwrap();
        install(&data, &bundled).unwrap();
        let bin = data.join(DIR);

        write_exec(&bundled, b"hook v2");
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o500)).unwrap();
        assert!(install(&data, &bundled).is_err());
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(fs::read(stable_path(&data)).unwrap(), b"hook v1");
        assert_eq!(fs::read_dir(&bin).unwrap().count(), 1, "a temp file leaked");
    }

    fn data_with(bundled_bytes: &[u8]) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = scratch();
        let bundled = dir.path().join("bundled");
        write_exec(&bundled, bundled_bytes);
        let data = dir.path().join("data");
        fs::create_dir(&data).unwrap();
        (dir, bundled, data)
    }

    /// Every emission goes through `ensure`: a copy that was swapped between two
    /// emissions is healed at the next, and the path handed out is the stable one.
    #[test]
    fn a_tampered_stable_copy_is_healed_at_the_next_emission() {
        let (_dir, bundled, data) = data_with(b"the real hook");
        let stable = ensure(&data, &bundled).unwrap();
        assert_eq!(stable, stable_path(&data));

        // Same length, so only the bytes give it away.
        let planted = b"the evil hook";
        fs::write(&stable, planted).unwrap();
        assert_eq!(fs::read(&stable).unwrap(), planted);
        assert_eq!(ensure(&data, &bundled).unwrap(), stable);
        assert_eq!(fs::read(&stable).unwrap(), b"the real hook");
        assert_eq!(mode(&stable), 0o755);

        // Deleted, replaced by a symlink: healed the same.
        fs::remove_file(&stable).unwrap();
        std::os::unix::fs::symlink("/bin/sh", &stable).unwrap();
        ensure(&data, &bundled).unwrap();
        assert!(!fs::symlink_metadata(&stable)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(&stable).unwrap(), b"the real hook");
    }

    /// A release never takes the hook from beside its executable.
    #[test]
    fn a_release_never_takes_a_hook_from_beside_its_executable() {
        let dir = scratch();
        let (resources, beside) = (dir.path().join("Resources"), dir.path().join("MacOS"));
        fs::create_dir_all(&resources).unwrap();
        fs::create_dir_all(&beside).unwrap();
        fs::write(beside.join(NAME), b"planted").unwrap();

        assert_eq!(pick_bundled(Some(&resources), Some(&beside), false), None);
        assert_eq!(
            pick_bundled(Some(&resources), Some(&beside), true),
            Some(beside.join(NAME))
        );
        fs::write(resources.join(NAME), b"bundled").unwrap();
        for allow in [false, true] {
            assert_eq!(
                pick_bundled(Some(&resources), Some(&beside), allow),
                Some(resources.join(NAME))
            );
        }
    }

    #[test]
    fn stale_temp_files_are_swept_and_everything_else_is_left() {
        let (_dir, bundled, data) = data_with(b"hook");
        install(&data, &bundled).unwrap();
        let bin = data.join(DIR);
        let make = |name: &str, old: bool| {
            let path = bin.join(name);
            fs::write(&path, b"x").unwrap();
            if old {
                let when = std::time::SystemTime::now() - Duration::from_secs(3600);
                File::open(&path).unwrap().set_modified(when).unwrap();
            }
            path
        };
        let stale = make(".santree-hook.abc.tmp", true);
        let fresh = make(".santree-hook.def.tmp", false);
        let other = make("notes.tmp", true);

        bundled_bin::sweep_stale_tmp(&bin, NAME, Duration::from_secs(600));
        assert!(!stale.exists(), "an old temp file was left");
        assert!(fresh.exists(), "a copy in flight was removed");
        assert!(other.exists(), "an unrelated file was removed");
        assert!(stable_path(&data).exists());
    }

    #[test]
    fn the_stable_path_is_under_the_data_dir() {
        assert_eq!(
            stable_path(Path::new("/d")),
            PathBuf::from("/d/bin/santree-hook")
        );
    }
}
