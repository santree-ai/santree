//! "Open in app" targets for a worktree — the Conductor-style menu (Finder,
//! editors, terminals). Detection and launching are platform-specific; macOS
//! uses `open`, other platforms fall back to `xdg-open` + PATH lookups.

use anyhow::{anyhow, bail, Result};
use std::path::{Path, PathBuf};
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
    let dir = worktree_dir(path)?;
    let dir = dir
        .to_str()
        .ok_or_else(|| anyhow!("opener path is not valid UTF-8: {path}"))?;
    if key == "finder" {
        return open_file_browser(dir);
    }
    let c = CANDIDATES
        .iter()
        .find(|c| c.key == key)
        .ok_or_else(|| anyhow!("unknown opener: {key}"))?;
    open_app(c, dir)
}

/// Show `file` in the OS file browser, selected rather than opened.
///
/// Deliberately not routed through [`open`]'s validation: **no IPC value reaches
/// here**. Every caller derives the path in Rust from a record santree itself
/// located (a session transcript under the Claude projects root), so there is no
/// untrusted string to gate — and the gate that exists, `worktree_dir`, would
/// reject a file anyway. `open -R` reveals in Finder without launching what it
/// is given, which the fallback path can't promise, so elsewhere the *parent
/// directory* is what opens.
///
/// The one check kept from `worktree_dir` is absoluteness, and it is about argv
/// rather than trust: the projects root is built from `CLAUDE_CONFIG_DIR` when
/// the user sets one, and a relative value beginning with `-` would reach `open`
/// as a flag instead of a path.
pub(crate) fn reveal(file: &Path) -> Result<()> {
    if !file.is_absolute() {
        bail!("path to reveal must be absolute: {}", file.display());
    }
    let path = file
        .to_str()
        .ok_or_else(|| anyhow!("path is not valid UTF-8: {}", file.display()))?;
    #[cfg(target_os = "macos")]
    {
        run(Command::new("open").args(["-R", path]))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let dir = file
            .parent()
            .and_then(Path::to_str)
            .ok_or_else(|| anyhow!("path has no parent directory: {path}"))?;
        open_file_browser(dir)
    }
}

/// Validate an IPC-supplied opener path down to the one domain this command is
/// ever meant to serve: a worktree directory.
///
/// `open`/`xdg-open` don't merely *reveal* what they're given, they **launch** it —
/// an `.app` bundle, an installer, a script. "Is it absolute?" is nowhere near a
/// strong enough gate for a value that crosses IPC. Everything this command is
/// asked to open is a worktree root: either a linked worktree (`git worktree add`
/// leaves a `.git` **file** there) or, for the base worktree, the repo root itself
/// (a `.git` **directory**) — so require exactly that shape and reject the rest.
///
/// Symlinks are resolved first, so a link planted inside a worktree can't smuggle
/// in a target that isn't one. Canonicalizing also keeps the result absolute, so
/// it can never be misparsed as a flag by the launched tool.
fn worktree_dir(path: &str) -> Result<PathBuf> {
    if !Path::new(path).is_absolute() {
        bail!("opener path must be absolute: {path}");
    }
    let real = std::fs::canonicalize(path)
        .map_err(|e| anyhow!("opener path does not resolve: {path} ({e})"))?;
    if !real.is_dir() {
        bail!("opener path is not a directory: {path}");
    }
    if !real.join(".git").exists() {
        bail!("opener path is not a git worktree: {path}");
    }
    Ok(real)
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
    // Unlike macOS `open` (a launcher that hands off to LaunchServices and
    // returns immediately), this execs the target application binary
    // directly — for apps that don't fork-and-exit, `.status()` would block
    // for the app's entire lifetime. Detach instead: only report spawn
    // errors, never wait for exit.
    run_detached(Command::new(c.bin).arg(path))
}

/// Spawn `cmd`, erroring if it can't start or exits non-zero.
fn run(cmd: &mut Command) -> Result<()> {
    let status = cmd.status().map_err(|e| anyhow!("failed to launch: {e}"))?;
    if !status.success() {
        bail!("opener exited with status {status}");
    }
    Ok(())
}

/// Spawn `cmd` and detach without waiting for it to exit — for launchers that
/// exec the target app directly rather than handing off to a fast-returning
/// session launcher (see `open_app` above). Only spawn errors are reported.
#[cfg(not(target_os = "macos"))]
fn run_detached(cmd: &mut Command) -> Result<()> {
    cmd.spawn().map_err(|e| anyhow!("failed to launch: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway directory, uniquely named per test (no tempfile dep in
    /// src-tauri — mirrors `hooks.rs`'s tests).
    fn scratch(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("santree-openers-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ok(p: &Path) -> bool {
        worktree_dir(p.to_str().unwrap()).is_ok()
    }

    #[test]
    fn accepts_a_linked_worktree_and_a_repo_root() {
        let root = scratch("accept");
        // A linked worktree: `git worktree add` leaves a `.git` *file*.
        let wt = root.join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), "gitdir: /repo/.git/worktrees/wt").unwrap();
        assert!(ok(&wt));

        // The base worktree is the repo root itself: a `.git` *directory*.
        let repo = root.join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        assert!(ok(&repo));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_anything_that_is_not_a_worktree() {
        let root = scratch("reject");

        assert!(!ok(Path::new("relative/path")), "relative");
        assert!(!ok(&root.join("nope")), "nonexistent");

        // The finding's case: `open` *launches* an app bundle. It is an absolute,
        // existing directory — and must still be refused, because it isn't a worktree.
        let app = root.join("Evil.app");
        std::fs::create_dir_all(app.join("Contents")).unwrap();
        assert!(!ok(&app), "app bundle");

        // A plain directory (no `.git`), and a plain file.
        let plain = root.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(!ok(&plain), "non-repo directory");
        let file = root.join("script.sh");
        std::fs::write(&file, "#!/bin/sh\n").unwrap();
        assert!(!ok(&file), "file, not a directory");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_a_worktree_is_resolved_before_the_check() {
        let root = scratch("symlink");
        // A worktree containing a symlink that points at a non-worktree directory:
        // the link sits at a legitimate-looking path, so the check must follow it.
        let wt = root.join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), "gitdir: /repo/.git/worktrees/wt").unwrap();
        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();

        let link = wt.join("escape");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(
            !ok(&link),
            "symlink escaping to a non-worktree must be refused"
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}
