//! "Open in app" targets for a worktree — the Conductor-style menu (Finder,
//! editors, terminals). Detection and launching are platform-specific; macOS
//! uses `open`, other platforms fall back to `xdg-open` + PATH lookups.

use anyhow::{anyhow, bail, Result};
use std::process::Command;
use std::sync::{LazyLock, Mutex};

use santree_core::domain::Opener;

/// A launchable app: the key the frontend sends back, its label, and the macOS
/// application name passed to `open -a` (also the PATH binary on other OSes).
/// `app` (macOS) and `bin` (other OSes) are each used on only one platform.
#[allow(dead_code)]
struct Candidate {
    key: &'static str,
    label: &'static str,
    /// macOS `.app` name (for `open -a`).
    app: &'static str,
    /// PATH binary used on non-macOS and for CLI detection.
    bin: &'static str,
}

const CANDIDATES: &[Candidate] = &[
    Candidate {
        key: "vscode",
        label: "VS Code",
        app: "Visual Studio Code",
        bin: "code",
    },
    Candidate {
        key: "cursor",
        label: "Cursor",
        app: "Cursor",
        bin: "cursor",
    },
    Candidate {
        key: "zed",
        label: "Zed",
        app: "Zed",
        bin: "zed",
    },
    Candidate {
        key: "xcode",
        label: "Xcode",
        app: "Xcode",
        bin: "xcodebuild",
    },
    Candidate {
        key: "ghostty",
        label: "Ghostty",
        app: "Ghostty",
        bin: "ghostty",
    },
    Candidate {
        key: "terminal",
        label: "Terminal",
        app: "Terminal",
        bin: "x-terminal-emulator",
    },
];

/// The file-browser opener for this platform (Finder on macOS, the default file
/// manager elsewhere) — always available.
fn file_browser() -> Opener {
    Opener {
        key: "finder".into(),
        label: if cfg!(target_os = "macos") {
            "Finder"
        } else {
            "Files"
        }
        .into(),
        available: true,
    }
}

/// Memoised opener list. Detection spawns `open -Ra` once per candidate (~6
/// subprocesses); installed apps don't come and go during a session, so the
/// result is cached for the app's lifetime (mirrors `settings::discover_binary`).
static DETECTED: LazyLock<Mutex<Option<Vec<Opener>>>> = LazyLock::new(|| Mutex::new(None));

/// The openers offered for a worktree, each flagged with whether its app was
/// found installed. The file browser is always present. Memoised (see [`DETECTED`]).
pub fn detect() -> Vec<Opener> {
    if let Some(cached) = DETECTED.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return cached;
    }
    let mut out = vec![file_browser()];
    for c in CANDIDATES {
        out.push(Opener {
            key: c.key.into(),
            label: c.label.into(),
            available: is_installed(c),
        });
    }
    *DETECTED.lock().unwrap_or_else(|e| e.into_inner()) = Some(out.clone());
    out
}

/// Open `path` in the app identified by `key`.
pub fn open(path: &str, key: &str) -> Result<()> {
    // `path` is an absolute worktree path; require that explicitly so a value
    // starting with `-` can never be misparsed as a flag by the launched tool.
    if !std::path::Path::new(path).is_absolute() {
        bail!("opener path must be absolute: {path}");
    }
    if key == "finder" {
        return open_file_browser(path);
    }
    let c = CANDIDATES
        .iter()
        .find(|c| c.key == key)
        .ok_or_else(|| anyhow!("unknown opener: {key}"))?;
    open_app(c, path)
}

#[cfg(target_os = "macos")]
fn is_installed(c: &Candidate) -> bool {
    // `open -Ra <app>` resolves the app without launching it; success ⇒ present.
    Command::new("open")
        .args(["-Ra", c.app])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn open_file_browser(path: &str) -> Result<()> {
    run(Command::new("open").arg(path))
}

#[cfg(target_os = "macos")]
fn open_app(c: &Candidate, path: &str) -> Result<()> {
    run(Command::new("open").args(["-a", c.app, path]))
}

#[cfg(not(target_os = "macos"))]
fn is_installed(c: &Candidate) -> bool {
    Command::new("sh")
        .args(["-c", &format!("command -v {}", c.bin)])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn open_file_browser(path: &str) -> Result<()> {
    run(Command::new("xdg-open").arg(path))
}

#[cfg(not(target_os = "macos"))]
fn open_app(c: &Candidate, path: &str) -> Result<()> {
    run(Command::new(c.bin).arg(path))
}

/// Spawn `cmd`, erroring if it can't start or exits non-zero.
fn run(cmd: &mut Command) -> Result<()> {
    let status = cmd.status().map_err(|e| anyhow!("failed to launch: {e}"))?;
    if !status.success() {
        bail!("opener exited with status {status}");
    }
    Ok(())
}
