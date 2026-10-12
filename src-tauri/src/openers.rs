//! "Open in app" targets for a worktree — the Conductor-style menu (Finder,
//! editors, terminals). Detection and launching go through macOS `open`.

use anyhow::{anyhow, bail, Result};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{LazyLock, Mutex};

use santree_core::domain::Opener;

/// A launchable app: the key the frontend sends back, its label, and the macOS
/// application name passed to `open -a`.
struct Candidate {
    key: &'static str,
    label: &'static str,
    app: &'static str,
}

const CANDIDATES: &[Candidate] = &[
    Candidate {
        key: "vscode",
        label: "VS Code",
        app: "Visual Studio Code",
    },
    Candidate {
        key: "cursor",
        label: "Cursor",
        app: "Cursor",
    },
    Candidate {
        key: "zed",
        label: "Zed",
        app: "Zed",
    },
    Candidate {
        key: "xcode",
        label: "Xcode",
        app: "Xcode",
    },
    Candidate {
        key: "ghostty",
        label: "Ghostty",
        app: "Ghostty",
    },
    Candidate {
        key: "terminal",
        label: "Terminal",
        app: "Terminal",
    },
];

/// Finder — always available.
fn file_browser() -> Opener {
    Opener {
        key: "finder".into(),
        label: "Finder".into(),
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
/// is given.
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
    run(Command::new("open").args(["-R", path]))
}

/// Open `dir` in the OS file browser.
///
/// Like [`reveal`], **no IPC value reaches here**: the caller derives the
/// directory in Rust (the app's own log dir). The checks kept are about argv
/// and shape, not trust: absolute (a relative one beginning with `-` would be
/// read as a flag) and an existing directory (`open` launches what
/// they are given, and a file here could be an app or a script).
pub(crate) fn open_dir(dir: &Path) -> Result<()> {
    if !dir.is_absolute() {
        bail!("directory to open must be absolute: {}", dir.display());
    }
    if !std::fs::metadata(dir).is_ok_and(|m| m.is_dir()) {
        bail!("{} is not a directory", dir.display());
    }
    let path = dir
        .to_str()
        .ok_or_else(|| anyhow!("path is not valid UTF-8: {}", dir.display()))?;
    open_file_browser(path)
}

/// Validate an IPC-supplied opener path down to the one domain this command is
/// ever meant to serve: a worktree directory.
///
/// `open` doesn't merely *reveal* what it's given, it **launches** it —
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

fn is_installed(c: &Candidate) -> bool {
    // `open -Ra <app>` resolves the app without launching it; success ⇒ present.
    Command::new("open")
        .args(["-Ra", c.app])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn open_file_browser(path: &str) -> Result<()> {
    run(Command::new("open").arg(path))
}

fn open_app(c: &Candidate, path: &str) -> Result<()> {
    run(Command::new("open").args(["-a", c.app, path]))
}

/// Spawn `cmd`, erroring if it can't start or exits non-zero.
fn run(cmd: &mut Command) -> Result<()> {
    let status = cmd.status().map_err(|e| anyhow!("failed to launch: {e}"))?;
    if !status.success() {
        bail!("opener exited with status {status}");
    }
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

#[cfg(test)]
mod open_dir_tests {
    use super::*;

    #[test]
    fn only_an_absolute_existing_directory_is_opened() {
        assert!(open_dir(Path::new("-a")).is_err(), "a flag-shaped path");
        assert!(open_dir(Path::new("relative/dir")).is_err());
        assert!(open_dir(Path::new("/definitely/not/here")).is_err());
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("f");
        std::fs::write(&file, b"x").unwrap();
        let err = open_dir(&file).unwrap_err();
        assert!(err.to_string().contains("not a directory"), "{err:#}");
    }
}
