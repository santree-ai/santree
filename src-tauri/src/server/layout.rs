//! Where the local santree server lives on disk (docs/server.md).
//!
//! ```text
//! <app data>/server[-optin]/        the trust mode's own root, 0700
//!     r<REV>/santree-server         the copy of the bundled binary this revision runs
//!     run/server-r<REV>.{sock,lock} the endpoint, 0700 dir
//! <app log dir>/santree-server[-dev].log    beside the app's own log
//! ```
//!
//! The root is keyed by *trust mode*, never by build profile: a signed server
//! admits only santree.app, an opted-in one admits any process of this uid, and
//! the two must never share a socket path — a dev build's opt-in server would
//! otherwise be the one an installed app finds.
//!
//! A unix socket path holds ~100 bytes. The app-data path is long on a home
//! with a long user name, so [`Layout::resolve`] moves just the `run/` dir to
//! `$TMPDIR/santree-<uid>/run` when the socket would not fit, and discovery of
//! older servers scans both places.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

use santree_server::endpoint;

use crate::sessions::Mode;

/// The longest socket file name a run dir will hold: `server-r<u32>.sock` at
/// the largest revision. Sizing the budget for it keeps the chosen run dir
/// stable across revisions — a dir that fits r1 and not r1000 would strand the
/// older server when the newer one's path no longer fits.
const LONGEST_SOCKET_NAME: &str = "server-r4294967295.sock";

/// Every path the server's lifecycle touches, resolved once at startup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    /// `<app data>/server` (signed) or `<app data>/server-optin`.
    pub root: PathBuf,
    /// Where the endpoint (socket + lock) lives: `<root>/run`, or the
    /// `$TMPDIR` fallback when that would not fit a socket path.
    pub run: PathBuf,
    /// `<root>/r<REV>`.
    pub rev_dir: PathBuf,
    /// `<rev_dir>/santree-server`: the binary the app runs, a copy of the
    /// bundled one.
    pub bin: PathBuf,
    /// The server's own rotated log, beside the app's.
    pub log: PathBuf,
    /// The run dir this layout did not choose (app data vs the `$TMPDIR`
    /// fallback), scanned for older servers too: a server started before the
    /// path got long, or after it got short, is still the user's.
    pub other_run: Option<PathBuf>,
    /// The `$TMPDIR/santree-<uid>` dir that holds the fallback run dir, when
    /// it is in use or a candidate. Prepared (0700, owned) before the run dir.
    fallback_parent: PathBuf,
}

impl Layout {
    /// The layout for `mode` under the Tauri app data dir, logging into
    /// `logs_dir` (the app's own log dir, so one place has both logs).
    pub fn resolve(app_data_dir: &Path, mode: Mode, logs_dir: &Path) -> Result<Self> {
        Self::resolve_in(app_data_dir, mode, logs_dir, &std::env::temp_dir(), euid())
    }

    /// [`Layout::resolve`] with its three environmental inputs named, so the
    /// fallback can be tested with a long fake home.
    fn resolve_in(
        app_data_dir: &Path,
        mode: Mode,
        logs_dir: &Path,
        tmp_dir: &Path,
        uid: u32,
    ) -> Result<Self> {
        let (root_name, log_name, tmp_name) = match mode {
            Mode::Signed { .. } => ("server", "santree-server.log", format!("santree-{uid}")),
            Mode::OptIn => (
                "server-optin",
                "santree-server-dev.log",
                format!("santree-{uid}-optin"),
            ),
            // Nothing is spawned in `Off`; the paths are placeholders so the
            // status of a build without a server can still be asked for.
            Mode::Off => (
                "server-off",
                "santree-server-off.log",
                format!("santree-{uid}-off"),
            ),
        };
        let root = app_data_dir.join(root_name);
        let preferred = root.join("run");
        let fallback_parent = tmp_dir.join(tmp_name);
        let fallback = fallback_parent.join("run");
        let (run, other) = if fits(&preferred) {
            (preferred, fallback)
        } else if fits(&fallback) {
            (fallback, preferred)
        } else {
            bail!(
                "no run dir is short enough for a unix socket: neither {} nor {} leaves room \
                 (the limit is {} bytes)",
                preferred.display(),
                fallback.display(),
                endpoint::max_socket_path()
            );
        };
        let rev_dir = root.join(format!("r{}", santree_server::REVISION));
        Ok(Self {
            bin: rev_dir.join("santree-server"),
            rev_dir,
            root,
            run,
            log: logs_dir.join(log_name),
            other_run: Some(other),
            fallback_parent,
        })
    }

    /// `<run>/server-r<rev>.sock`.
    pub fn socket_for(&self, revision: u32) -> PathBuf {
        self.run.join(endpoint::socket_name(revision))
    }

    /// The run dirs to look for servers in, the chosen one first.
    pub fn run_dirs(&self) -> Vec<&Path> {
        std::iter::once(self.run.as_path())
            .chain(self.other_run.as_deref())
            .collect()
    }

    /// Create what the server needs and refuse what is not ours: every dir the
    /// endpoint or the binary sits in is 0700 and owned by this user, or this
    /// fails. The socket is a shell as the user (and carries project
    /// secrets), and a binary the app is about to execute is only as private
    /// as its directory.
    pub fn prepare(&self) -> Result<()> {
        if self.run.starts_with(&self.fallback_parent) {
            endpoint::prepare_run_dir(&self.fallback_parent)?;
        }
        for dir in [&self.root, &self.run, &self.rev_dir] {
            endpoint::prepare_run_dir(dir)?;
        }
        if let Some(logs) = self.log.parent() {
            fs::create_dir_all(logs)
                .with_context(|| format!("can't create the log dir {}", logs.display()))?;
        }
        Ok(())
    }

    /// A layout for a test under `dir` (kept short: sun_path).
    #[cfg(test)]
    pub fn in_dir(dir: &Path, mode: Mode) -> Self {
        Self::resolve_in(dir, mode, &dir.join("logs"), &dir.join("tmp"), euid())
            .expect("a short test dir fits a socket path")
    }
}

/// Whether the longest socket name fits `run`.
fn fits(run: &Path) -> bool {
    run.join(LONGEST_SOCKET_NAME).as_os_str().len() <= endpoint::max_socket_path()
}

fn euid() -> u32 {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

/// A revision as file names spell it: plain decimal digits and nothing else
/// (no sign, no leading zeros, no whitespace), fitting a `u32`.
pub(super) fn plain_u32(digits: &str) -> Option<u32> {
    let plain = !digits.is_empty()
        && digits.bytes().all(|b| b.is_ascii_digit())
        && (digits == "0" || !digits.starts_with('0'));
    if plain {
        digits.parse().ok()
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::testkit::scratch;
    use std::os::unix::fs::PermissionsExt;

    const SIGNED: Mode = Mode::Signed { team: "TEAM123456" };

    #[test]
    fn each_trust_mode_has_its_own_root_run_dir_and_log() {
        let tmp = scratch();
        let app = tmp.path().join("app");
        let logs = tmp.path().join("logs");
        let signed = Layout::resolve_in(&app, SIGNED, &logs, tmp.path(), 501).unwrap();
        let opt_in = Layout::resolve_in(&app, Mode::OptIn, &logs, tmp.path(), 501).unwrap();

        assert_eq!(signed.root, app.join("server"));
        assert_eq!(opt_in.root, app.join("server-optin"));
        assert_eq!(signed.run, app.join("server/run"));
        assert_eq!(
            signed.bin,
            app.join(format!(
                "server/r{}/santree-server",
                santree_server::REVISION
            ))
        );
        assert_eq!(signed.log, logs.join("santree-server.log"));
        assert_eq!(opt_in.log, logs.join("santree-server-dev.log"));
        // An opted-in dev server can never be the one a signed app dials.
        assert_ne!(signed.socket_for(1), opt_in.socket_for(1));
        assert_ne!(signed.fallback_parent, opt_in.fallback_parent);
    }

    #[test]
    fn a_short_app_data_dir_keeps_the_run_dir_in_it_and_scans_the_fallback_too() {
        let tmp = scratch();
        let layout = Layout::resolve_in(
            &tmp.path().join("app"),
            SIGNED,
            &tmp.path().join("logs"),
            tmp.path(),
            501,
        )
        .unwrap();
        assert_eq!(layout.run, tmp.path().join("app/server/run"));
        assert_eq!(
            layout.other_run.as_deref(),
            Some(tmp.path().join("santree-501/run").as_path())
        );
        assert_eq!(layout.run_dirs().len(), 2);
        assert_eq!(layout.run_dirs()[0], layout.run);
    }

    #[test]
    fn a_home_too_long_for_a_socket_path_falls_back_to_a_private_tmp_run_dir() {
        let tmp = scratch();
        let long_home = tmp.path().join("a".repeat(120));
        let layout = Layout::resolve_in(
            &long_home.join("Library/Application Support/com.santree.desktop"),
            SIGNED,
            &tmp.path().join("logs"),
            tmp.path(),
            501,
        )
        .unwrap();
        assert_eq!(layout.run, tmp.path().join("santree-501/run"));
        // The binary and the root stay in app data: only the socket is
        // length-limited.
        assert!(layout.root.starts_with(&long_home));
        // The discovery scan still looks where the long path would have been.
        assert!(layout
            .other_run
            .as_deref()
            .is_some_and(|p| p.starts_with(&long_home)));
        for rev in [1, 12, 4_000_000_000] {
            assert!(
                layout.socket_for(rev).as_os_str().len() <= endpoint::max_socket_path(),
                "r{rev}"
            );
        }

        layout.prepare().unwrap();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&tmp.path().join("santree-501")), 0o700);
        assert_eq!(mode(&layout.run), 0o700);
    }

    #[test]
    fn when_nothing_fits_the_layout_is_refused_not_truncated() {
        let tmp = scratch();
        let err = Layout::resolve_in(
            &tmp.path().join("a".repeat(120)),
            SIGNED,
            &tmp.path().join("logs"),
            &tmp.path().join("b".repeat(120)),
            501,
        )
        .unwrap_err();
        assert!(err.to_string().contains("short enough"), "{err}");
    }

    #[test]
    fn a_fallback_dir_someone_else_could_enter_is_refused() {
        let tmp = scratch();
        let layout = Layout::resolve_in(
            &tmp.path().join("a".repeat(120)),
            SIGNED,
            &tmp.path().join("logs"),
            tmp.path(),
            501,
        )
        .unwrap();
        // A squatter (or an old umask) left the parent world-readable.
        let parent = tmp.path().join("santree-501");
        fs::create_dir(&parent).unwrap();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o755)).unwrap();
        let err = layout.prepare().unwrap_err();
        assert!(err.to_string().contains("0700"), "{err}");
        // …and a symlink in its place is no directory at all.
        fs::remove_dir(&parent).unwrap();
        std::os::unix::fs::symlink(tmp.path(), &parent).unwrap();
        assert!(layout.prepare().is_err());
    }

    #[test]
    fn prepare_creates_private_dirs_and_the_log_dir() {
        let tmp = scratch();
        let layout = Layout::in_dir(tmp.path(), Mode::OptIn);
        layout.prepare().unwrap();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        for dir in [&layout.root, &layout.run, &layout.rev_dir] {
            assert_eq!(mode(dir), 0o700, "{}", dir.display());
        }
        assert!(layout.log.parent().unwrap().is_dir());
        // Idempotent.
        layout.prepare().unwrap();
    }
}
