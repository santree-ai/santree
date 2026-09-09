//! One file a user can send when something goes wrong.
//!
//! santree writes several logs in two directories — the app log (rotated, so
//! there can be a previous one) and `santree-hook-errors.log`, which is the only
//! trace a failed `santree-hook` write leaves behind (the binary is silent to
//! the agent by contract). Asking someone to find all of those, and to say which
//! version they are on, is asking them to do triage before they can report the
//! bug. This bundles the lot into a single text file with a header that answers
//! the first three questions any report starts with.
//!
//! **Plain text, not an archive.** The recipient reads it or greps it; an
//! archive would add a dependency and a step for both ends. The cost is size,
//! which is why each file is tail-capped: the newest [`PER_FILE_BUDGET`] bytes,
//! cut on a line boundary, with a line saying how much was dropped. Failures are
//! the last thing that happened, so the tail is the part worth sending.
//!
//! **No destination crosses IPC.** The command picks the path itself (the OS
//! download directory), so there is no caller-supplied path to validate against
//! the write — see `commands::export_logs`.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// How much of each log to carry, per file. Big enough that a session's whole
/// story survives, small enough that the result still attaches to a message.
const PER_FILE_BUDGET: usize = 4 * 1024 * 1024;

/// What one export produced, for the UI to name.
pub struct Export {
    pub path: PathBuf,
    pub bytes: u64,
    /// The logs that actually existed and went in, in bundle order.
    pub files: Vec<String>,
}

/// The longest **suffix** of `s` that fits in `budget` bytes and starts on a
/// line boundary — the newest lines, since logs grow by appending. Mirrors
/// `english_tutor::tail_within`; kept separate because that one is about a
/// prompt budget and this one about an attachment size, and collapsing them
/// would tie two unrelated limits together.
fn tail_within(s: &str, budget: usize) -> &str {
    if s.len() <= budget {
        return s;
    }
    let start = s.len() - budget;
    // Never split a UTF-8 character, then move forward to the next line start so
    // the bundle never opens mid-line.
    let start = (start..s.len())
        .find(|i| s.is_char_boundary(*i))
        .unwrap_or(s.len());
    match s[start..].find('\n') {
        Some(nl) => &s[start + nl + 1..],
        None => &s[start..],
    }
}

/// One log, as it appears in the bundle. Missing files are skipped by the
/// caller; an unreadable one is reported in place rather than dropped, because
/// "santree could not read its own log" is itself worth seeing.
fn section(path: &Path, out: &mut String) -> bool {
    let header = format!("===== {} =====", path.display());
    let Ok(raw) = std::fs::read(path) else {
        let _ = writeln!(out, "\n{header}\n(unreadable)\n");
        return false;
    };
    let text = String::from_utf8_lossy(&raw);
    let kept = tail_within(&text, PER_FILE_BUDGET);
    let dropped = text.len() - kept.len();
    let _ = writeln!(out, "\n{header}");
    let _ = writeln!(out, "size: {} bytes", raw.len());
    if dropped > 0 {
        let _ = writeln!(
            out,
            "note: oldest {dropped} bytes omitted — newest lines kept"
        );
    }
    let _ = writeln!(out);
    out.push_str(kept);
    if !kept.ends_with('\n') {
        out.push('\n');
    }
    true
}

/// Where the logs live: the app log directory (the current log plus whatever
/// rotation left beside it) and the app data directory's hook-error log.
/// Returned in the order they belong in the bundle — current log first, because
/// it is what the reader wants.
pub fn log_paths(log_dir: &Path, data_dir: &Path) -> Vec<PathBuf> {
    let current = log_dir.join("santree.log");
    let mut rotated: Vec<PathBuf> = std::fs::read_dir(log_dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p != &current)
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("santree") && n.ends_with(".log"))
                })
                .collect()
        })
        .unwrap_or_default();
    rotated.sort();
    let mut paths = vec![current];
    paths.extend(rotated);
    // The hook's own failure log — see `crates/hook`: a failed write is silent to
    // the agent, so this file is the only place it is recorded.
    paths.push(data_dir.join("santree-hook-errors.log"));
    paths
}

/// The bundle's opening block: what a bug report has to state before anything in
/// the log means anything.
pub fn header(version: &str, now: &str) -> String {
    let mut s = String::new();
    let _ = writeln!(s, "santree diagnostics");
    let _ = writeln!(s, "exported: {now}");
    let _ = writeln!(s, "version:  {version}");
    let _ = writeln!(
        s,
        "os:       {} {}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    s
}

/// Build the bundle and write it to `dest`. Returns what went in, so the caller
/// can say where it landed and what it covers.
pub fn write_bundle(dest: &Path, version: &str, now: &str, paths: &[PathBuf]) -> Result<Export> {
    let mut out = header(version, now);
    let mut files = Vec::new();
    for path in paths {
        if !path.exists() {
            continue;
        }
        if section(path, &mut out) {
            files.push(path.display().to_string());
        }
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    std::fs::write(dest, out.as_bytes()).with_context(|| format!("writing {}", dest.display()))?;
    Ok(Export {
        path: dest.to_path_buf(),
        bytes: out.len() as u64,
        files,
    })
}

/// `santree-logs-<yyyymmdd-hhmmss>.log` — sorts chronologically, and says what
/// it is to whoever receives it out of context.
pub fn file_name(now: &str) -> String {
    let stamp: String = now
        .chars()
        .filter(|c| c.is_ascii_digit())
        .take(14)
        .collect();
    format!("santree-logs-{stamp}.log")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_keeps_the_newest_whole_lines() {
        let s = "one\ntwo\nthree\nfour\n";
        // A budget that lands mid-"two" must not open the bundle mid-line.
        assert_eq!(tail_within(s, 12), "three\nfour\n");
        assert_eq!(tail_within(s, 1000), s);
    }

    /// The cut is by bytes, and a log carries agent output — so the budget can
    /// land inside a multi-byte character. Slicing there would panic.
    #[test]
    fn tail_never_splits_a_utf8_character() {
        let s = "aaaa\né—ok\n";
        for budget in 1..s.len() {
            let kept = tail_within(s, budget);
            assert!(s.ends_with(kept), "budget {budget} produced a non-suffix");
        }
    }

    #[test]
    fn the_current_log_leads_and_the_hook_log_trails() {
        let dir = std::env::temp_dir().join("santree-diag-order");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        for name in ["santree.log", "santree_2026-01-01.log"] {
            std::fs::write(dir.join(name), b"x").expect("write");
        }
        let paths = log_paths(&dir, &dir);
        assert!(paths[0].ends_with("santree.log"));
        assert!(paths[1].ends_with("santree_2026-01-01.log"));
        assert!(paths
            .last()
            .expect("last")
            .ends_with("santree-hook-errors.log"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A log that is not there is not an error — a machine that never hit a hook
    /// failure has no hook-error log, and the export must still be sendable.
    #[test]
    fn a_missing_log_is_skipped_not_failed() {
        let dir = std::env::temp_dir().join("santree-diag-missing");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(dir.join("santree.log"), b"hello\n").expect("write");
        let dest = dir.join("out.log");
        let export = write_bundle(
            &dest,
            "0.1.6",
            "2026-09-08T12:00:00Z",
            &log_paths(&dir, &dir),
        )
        .expect("bundle");
        assert_eq!(export.files.len(), 1, "only the log that exists goes in");
        let text = std::fs::read_to_string(&dest).expect("read back");
        assert!(text.contains("version:  0.1.6"));
        assert!(text.contains("hello"));
        assert!(!text.contains("santree-hook-errors.log"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_name_carries_a_sortable_stamp() {
        assert_eq!(
            file_name("2026-09-08T17:04:31.123Z"),
            "santree-logs-20260908170431.log"
        );
    }
}
