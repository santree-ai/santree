//! The server's log: a `log` backend writing one line per record to a file it
//! rotates itself (or to stderr when it has none). In-crate rather than
//! tauri-plugin-log or a logging crate: the server runs without the app, and
//! every dependency is part of what its revision names.
//!
//! What is logged is santree-host's own audit (methods, ids, commands and
//! working directories, never env values, input bytes or output) and the
//! server's lifecycle; nothing here adds request data to it.

use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// A log file is rotated once it would grow past this.
pub const ROTATE_AT: u64 = 5 * 1024 * 1024;
/// Rotated files kept beside the live one: `<log>.1` (newest) … `<log>.3`.
pub const KEEP: usize = 3;

enum Sink {
    Stderr,
    File {
        path: PathBuf,
        file: File,
        size: u64,
    },
}

struct Logger {
    sink: Mutex<Sink>,
}

/// Install the logger: to `file` (appended to, 0600, its directory created
/// 0700 if missing), else to stderr.
pub fn init(file: Option<&Path>) -> anyhow::Result<()> {
    let sink = match file {
        None => Sink::Stderr,
        Some(path) => {
            if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
                if !dir.exists() {
                    DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
                }
            }
            let file = open(path)?;
            let size = file.metadata()?.len();
            Sink::File {
                path: path.to_path_buf(),
                file,
                size,
            }
        }
    };
    // Leaked: the logger lives as long as the process (without `log`'s `std`
    // feature there is no boxed setter to do it for us).
    log::set_logger(Box::leak(Box::new(Logger {
        sink: Mutex::new(sink),
    })))
    .map_err(|e| anyhow::anyhow!("{e}"))?;
    log::set_max_level(log::LevelFilter::Info);
    Ok(())
}

fn open(path: &Path) -> std::io::Result<File> {
    // O_NOFOLLOW: a symlink planted at the log's path would have the server
    // append to — and chmod — whatever it names.
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    // `mode` only applies to a file this call created; one left by an older
    // server (or a hand-made one) is tightened too.
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    Ok(file)
}

/// `<log>` → `<log>.1` → … → `<log>.KEEP`, the oldest dropped.
fn rotate(path: &Path) -> std::io::Result<File> {
    let numbered = |n: usize| {
        let mut name = path.as_os_str().to_owned();
        name.push(format!(".{n}"));
        PathBuf::from(name)
    };
    for n in (1..KEEP).rev() {
        let from = numbered(n);
        if from.exists() {
            fs::rename(&from, numbered(n + 1))?;
        }
    }
    fs::rename(path, numbered(1))?;
    open(path)
}

impl log::Log for Logger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::max_level()
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = format!(
            "{} {:5} {}: {}\n",
            timestamp(SystemTime::now()),
            record.level(),
            record.target(),
            record.args()
        );
        let mut sink = self.sink.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *sink {
            Sink::Stderr => {
                let _ = std::io::stderr().write_all(line.as_bytes());
            }
            Sink::File { path, file, size } => {
                if *size > 0 && *size + line.len() as u64 > ROTATE_AT {
                    // A failed rotation keeps writing to the file it has:
                    // a log that grows is better than one that stops.
                    if let Ok(fresh) = rotate(path) {
                        *file = fresh;
                        *size = 0;
                    }
                }
                if file.write_all(line.as_bytes()).is_ok() {
                    *size += line.len() as u64;
                }
            }
        }
    }

    fn flush(&self) {
        if let Sink::File { file, .. } = &mut *self.sink.lock().unwrap_or_else(|e| e.into_inner()) {
            let _ = file.flush();
        }
    }
}

/// `2026-10-06T12:34:56.789Z`.
fn timestamp(at: SystemTime) -> String {
    let since = at.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = since.as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        since.subsec_millis()
    )
}

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian (Howard
/// Hinnant's `civil_from_days`).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn timestamps_are_utc_rfc3339() {
        assert_eq!(timestamp(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        // 2024-02-29 (a leap day) 13:14:15.678 UTC.
        let at = UNIX_EPOCH + Duration::from_millis(1_709_212_455_678);
        assert_eq!(timestamp(at), "2024-02-29T13:14:15.678Z");
    }

    /// A log path that is a symlink — planted by anything running as this
    /// user — would have the server append to, and chmod, whatever it names.
    #[test]
    fn a_symlinked_log_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("elsewhere");
        fs::write(&target, "theirs").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();
        let log = dir.path().join("server.log");
        std::os::unix::fs::symlink(&target, &log).unwrap();
        assert!(open(&log).is_err(), "a symlinked log was opened");
        assert_eq!(fs::read_to_string(&target).unwrap(), "theirs");
        let mode = fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o644, "the link's target was chmodded");
    }

    #[test]
    fn rotation_keeps_three_old_files_and_starts_a_fresh_one() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("server.log");
        for round in 0..5 {
            fs::write(&log, format!("round {round}")).unwrap();
            drop(rotate(&log).unwrap());
        }
        let read = |name: &str| fs::read_to_string(dir.path().join(name)).unwrap();
        assert_eq!(read("server.log"), "");
        assert_eq!(read("server.log.1"), "round 4");
        assert_eq!(read("server.log.2"), "round 3");
        assert_eq!(read("server.log.3"), "round 2");
        assert!(!dir.path().join("server.log.4").exists());
        let mode = fs::metadata(&log).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
