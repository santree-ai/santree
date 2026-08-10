//! Backend for the hidden **Dev** tab — dogfooding santree development inside
//! santree (build a DMG from a checkout, install it over the running app, keep a
//! bug TODO list with pasted screenshots, hand items to a Claude session).
//!
//! Deliberately self-contained: the whole feature is this module, one migration
//! (`0017_dev_todos`), and `src/features/dev/` on the frontend, so it can be
//! deleted cleanly if it doesn't survive to a public release. Commands are
//! declared here and registered from `lib.rs` (the `terminal` module precedent).
//! The tab itself is gated in the frontend to the developer's GitHub login.

use std::path::{Path, PathBuf};
// Only the macOS-gated helpers (install/spawn_install_watcher/eject) shell
// out — on Linux this import would be unused and fail `-D warnings`.
#[cfg(target_os = "macos")]
use std::process::Command;
use std::time::UNIX_EPOCH;

use anyhow::{anyhow, bail, Result};
use base64::Engine;
use serde::Serialize;
use specta::Type;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use crate::db::{now_ms, Db};
use crate::error::CmdResult;
use crate::git;
use crate::stream::{self, StreamEvent};

/// One entry of the Dev tab's bug/task list. `screenshots` are absolute paths of
/// pasted images written under the app data dir (render via `dev_screenshot_src`,
/// hand to the agent as `Read <path>` lines).
#[derive(Clone, Debug, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DevTodo {
    pub id: String,
    pub body: String,
    pub done: bool,
    pub screenshots: Vec<String>,
    /// ms since epoch. `f64` (not `i64`) so Specta types it as `number`.
    pub created_at_ms: f64,
}

/// What the Dev tab's header shows: the running build vs the checkout's HEAD vs
/// the newest built DMG — enough to answer "am I running the latest code?".
#[derive(Clone, Debug, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DevInfo {
    /// The version of the *running* app (compile-time).
    pub app_version: String,
    /// True when this process runs from an installed `.app` bundle outside the
    /// dev checkout (vs `tauri dev` or a bundle still inside `target/`).
    pub running_installed: bool,
    pub head_sha: Option<String>,
    pub head_subject: Option<String>,
    /// HEAD's commit time, ms since epoch (`f64` for Specta `number`).
    pub head_committed_ms: Option<f64>,
    pub dirty_files: u32,
    pub dmg_path: Option<String>,
    /// The newest DMG's mtime, ms since epoch (`f64` for Specta `number`).
    pub dmg_built_ms: Option<f64>,
    /// True when a DMG exists but predates HEAD (or the tree is dirty) — i.e.
    /// installing it would not install the current code.
    pub dmg_stale: bool,
    pub log_path: Option<String>,
}

// ── Repo path ──────────────────────────────────────────────────────────────

/// Validate + normalize a picked folder to its git toplevel (the stored dev repo
/// path). Mirrors `repo::add`'s validation: absolute dir → `git rev-parse
/// --show-toplevel`, so a subdirectory pick still lands on the repo root.
#[tauri::command]
#[specta::specta]
pub async fn dev_normalize_repo(path: String) -> CmdResult<String> {
    Ok(tokio::task::spawn_blocking(move || repo_root(&path)).await??)
}

/// The validated git toplevel of an IPC-supplied path. Every dev command that
/// takes a repo path funnels through this before the path touches git or the
/// filesystem — the Dev tab's path is user-picked, but it still crosses IPC.
fn repo_root(path: &str) -> Result<String> {
    let dir = Path::new(path);
    if !dir.is_absolute() {
        bail!("repo path must be absolute: {path}");
    }
    if !dir.is_dir() {
        bail!("that path isn't a folder");
    }
    git::git(dir, &["rev-parse", "--show-toplevel"])
        .ok()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("that folder isn't a git repository"))
}

// ── Build / install status ─────────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub async fn dev_info(app: AppHandle, repo_path: String) -> CmdResult<DevInfo> {
    let log_path = app
        .path()
        .app_log_dir()
        .ok()
        .map(|d| d.join("santree.log"))
        .and_then(|p| p.to_str().map(String::from));
    Ok(tokio::task::spawn_blocking(move || info(&repo_path, log_path)).await??)
}

fn info(repo_path: &str, log_path: Option<String>) -> Result<DevInfo> {
    let root = repo_root(repo_path)?;
    let rootp = Path::new(&root);

    // `%x1f` (unit separator) can't appear in a commit subject, unlike any
    // human-readable delimiter.
    let head = git::git(rootp, &["log", "-1", "--format=%h\u{1f}%s\u{1f}%ct"]).ok();
    let mut head_sha = None;
    let mut head_subject = None;
    let mut head_committed_ms = None;
    if let Some(line) = head {
        let mut parts = line.split('\u{1f}');
        head_sha = parts.next().map(str::to_string);
        head_subject = parts.next().map(str::to_string);
        head_committed_ms = parts
            .next()
            .and_then(|s| s.trim().parse::<i64>().ok())
            .map(|secs| (secs * 1000) as f64);
    }
    let dirty_files = git::git_output(rootp, &["status", "--porcelain"])
        .map(|out| out.lines().filter(|l| !l.trim().is_empty()).count() as u32)
        .unwrap_or(0);

    let dmg = newest_dmg(rootp);
    let (dmg_path, dmg_built_ms) = match &dmg {
        Some((p, ms)) => (p.to_str().map(String::from), Some(*ms)),
        None => (None, None),
    };
    let dmg_stale = match (dmg_built_ms, head_committed_ms) {
        (Some(built), Some(committed)) => built < committed || dirty_files > 0,
        _ => false,
    };

    Ok(DevInfo {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        running_installed: is_running_installed(rootp),
        head_sha,
        head_subject,
        head_committed_ms,
        dirty_files,
        dmg_path,
        dmg_built_ms,
        dmg_stale,
        log_path,
    })
}

/// The newest `*.dmg` under the checkout's Tauri bundle output, with its mtime
/// in ms. `None` when none was ever built.
fn newest_dmg(root: &Path) -> Option<(PathBuf, f64)> {
    let dir = root.join("target/release/bundle/dmg");
    let mut best: Option<(PathBuf, f64)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "dmg") {
            continue;
        }
        let Some(ms) = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as f64)
        else {
            continue;
        };
        if best.as_ref().is_none_or(|(_, b)| ms > *b) {
            best = Some((path, ms));
        }
    }
    best
}

/// The `.app` bundle this process runs from, if any (`tauri dev` runs a bare
/// binary in `target/debug`, which has no bundle ancestor).
fn app_bundle_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .map(Path::to_path_buf)
}

/// Running from an installed bundle — i.e. one *outside* the dev checkout. A
/// bundle still sitting in `target/release/bundle` is a build artifact being
/// test-driven, not an install, and must not trigger the quit-for-install flow.
fn is_running_installed(dev_root: &Path) -> bool {
    app_bundle_root().is_some_and(|b| !b.starts_with(dev_root))
}

// ── Build ──────────────────────────────────────────────────────────────────

/// The command the Build button runs. `--verbose` because the DMG bundler's
/// failures are otherwise a bare "error running bundle_dmg.sh" with no cause
/// (see the stale-volume gotcha in CLAUDE.md).
const BUILD_COMMAND: &str = "pnpm tauri build --verbose";

/// The run key for a checkout's build. Keyed by path, so two checkouts can build
/// at once but one checkout can't build twice (they'd fight over `target/`).
fn build_key(root: &str) -> String {
    format!("dev-build:{root}")
}

/// Build the production DMG, streaming the output to a read-only pane.
///
/// Deliberately not a terminal session: the build is a background process the app
/// owns, so it survives leaving the Dev tab, can't be typed into, and can't be
/// re-triggered by a pane remount re-seeding a shell. The frontend keeps the
/// transcript after it exits — see `stream`.
#[tauri::command]
#[specta::specta]
pub async fn dev_build(repo_path: String, on_event: Channel<StreamEvent>) -> CmdResult<()> {
    let root = repo_root(&repo_path)?;
    let Some(slot) = stream::RUNS.reserve(&build_key(&root)) else {
        return Err("a build is already running for this checkout".into());
    };
    log::info!("dev build starting in {root}");
    let ev = on_event.clone();
    let ok = tokio::task::spawn_blocking(move || {
        stream::run(
            stream::Spec {
                command: BUILD_COMMAND.to_string(),
                cwd: Path::new(&root),
                env: Vec::new(),
            },
            slot,
            &ev,
        )
    })
    .await
    .unwrap_or(false);
    log::info!("dev build {}", if ok { "succeeded" } else { "failed" });
    let _ = on_event.send(StreamEvent::Done { ok });
    Ok(())
}

/// Stop a running build. Returns whether one was running. The kill closes the PTY,
/// so the streaming run finishes on its own and reports failure — there's no
/// separate teardown path to keep in sync.
#[tauri::command]
#[specta::specta]
pub async fn dev_cancel_build(repo_path: String) -> CmdResult<bool> {
    let root = repo_root(&repo_path)?;
    Ok(stream::RUNS.cancel(&build_key(&root)))
}

/// Re-grid a running build's PTY to the pane showing it, so the tool wraps its
/// remaining output — and sizes its progress bars — to the width you're actually
/// looking at. Returns whether a build was running to re-grid.
#[tauri::command]
#[specta::specta]
pub async fn dev_resize_build(repo_path: String, cols: u16, rows: u16) -> CmdResult<bool> {
    let root = repo_root(&repo_path)?;
    Ok(stream::RUNS.resize(&build_key(&root), cols, rows))
}

// ── Install / eject (macOS) ────────────────────────────────────────────────

/// Open the newest built DMG for the drag-and-drop install. When the app runs
/// from an installed bundle it also spawns a detached helper that waits for the
/// app to quit and be replaced, then relaunches it and ejects the DMG volume —
/// and schedules this process's exit so the bundle isn't replaced under a
/// running binary. Returns `true` when the app is about to quit for the install.
#[tauri::command]
#[specta::specta]
pub async fn dev_install(app: AppHandle, repo_path: String) -> CmdResult<bool> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, repo_path);
        Err("DMG install is only supported on macOS".into())
    }
    #[cfg(target_os = "macos")]
    {
        let quitting = tokio::task::spawn_blocking(move || install(&repo_path)).await??;
        if quitting {
            // Exit *after* this command's response has reached the webview, so
            // the frontend can show what's happening before the window goes.
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(900)).await;
                app.exit(0);
            });
        }
        Ok(quitting)
    }
}

#[cfg(target_os = "macos")]
fn install(repo_path: &str) -> Result<bool> {
    let root = repo_root(repo_path)?;
    let (dmg, _) = newest_dmg(Path::new(&root))
        .ok_or_else(|| anyhow!("no DMG found under target/release/bundle/dmg — build one first"))?;
    let status = Command::new("open")
        .arg(&dmg)
        .status()
        .map_err(|e| anyhow!("failed to open the DMG: {e}"))?;
    if !status.success() {
        bail!("`open` exited with {status} for {}", dmg.display());
    }
    match app_bundle_root().filter(|b| !b.starts_with(&root)) {
        Some(bundle) => {
            spawn_install_watcher(&bundle)?;
            Ok(true)
        }
        None => Ok(false), // dev build: just show the DMG, keep running
    }
}

/// Detached helper for the "drag and drop, it reopens" install flow: wait for
/// this process to exit, then for the bundle to be *replaced* (its inode
/// changes when Finder drops the new app in), then relaunch it and eject any
/// mounted santree DMG volume. Fully detached (own process group, no stdio) so
/// our exit can't take it down; gives up quietly after ~10 minutes.
#[cfg(target_os = "macos")]
fn spawn_install_watcher(bundle: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;

    let pid = std::process::id();
    let inode = std::fs::metadata(bundle)?.ino();
    // The bundle path reaches the script as the positional `$1` — never
    // interpolated into the script text, so no character in it (quote, `$`,
    // backtick) can re-parse as shell. Only the numeric pid/inode are inlined.
    let script = format!(
        r#"
i=0; while kill -0 {pid} 2>/dev/null && [ "$i" -lt 120 ]; do sleep 1; i=$((i+1)); done
i=0
while [ "$i" -lt 600 ]; do
  now=$(stat -f %i "$1" 2>/dev/null || echo gone)
  if [ "$now" != "{inode}" ] && [ "$now" != "gone" ]; then
    sleep 1
    open "$1"
    sleep 3
    for v in /Volumes/santree*; do
      [ -d "$v/santree.app" ] && hdiutil detach "$v" >/dev/null 2>&1
    done
    exit 0
  fi
  sleep 1; i=$((i+1))
done
"#
    );
    Command::new("/bin/sh")
        .arg("-c")
        .arg(&script)
        .arg("santree-install-watcher") // $0
        .arg(bundle) // $1
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| anyhow!("failed to spawn the install watcher: {e}"))?;
    Ok(())
}

/// Eject any mounted santree DMG volume (the disk left on the desktop after an
/// install). Only volumes that actually contain a `santree.app` are touched.
/// Returns how many were detached.
#[tauri::command]
#[specta::specta]
pub async fn dev_eject() -> CmdResult<u32> {
    #[cfg(not(target_os = "macos"))]
    {
        Err("DMG eject is only supported on macOS".into())
    }
    #[cfg(target_os = "macos")]
    {
        Ok(tokio::task::spawn_blocking(eject).await??)
    }
}

#[cfg(target_os = "macos")]
fn eject() -> Result<u32> {
    let mut detached = 0;
    for entry in std::fs::read_dir("/Volumes")?.flatten() {
        if !entry.file_name().to_string_lossy().starts_with("santree") {
            continue;
        }
        let vol = entry.path();
        if !vol.join("santree.app").is_dir() {
            continue;
        }
        let ok = Command::new("hdiutil")
            .arg("detach")
            .arg(&vol)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            detached += 1;
        }
    }
    Ok(detached)
}

// ── TODO list ──────────────────────────────────────────────────────────────

/// Every dev TODO, newest first.
#[tauri::command]
#[specta::specta]
pub async fn dev_todos(db: State<'_, Db>) -> CmdResult<Vec<DevTodo>> {
    let rows: Vec<(String, String, i64, String, i64)> = sqlx::query_as(
        "SELECT id, body, done, screenshots, created_at FROM dev_todos
         ORDER BY created_at DESC, id",
    )
    .fetch_all(&*db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, body, done, shots, created)| DevTodo {
            id,
            body,
            done: done != 0,
            screenshots: serde_json::from_str(&shots).unwrap_or_default(),
            created_at_ms: created as f64,
        })
        .collect())
}

/// Add a TODO. `id` is a frontend-minted UUID (so the cache can be patched
/// without the round-trip); `screenshots` are pasted images as
/// `data:image/(png|jpeg);base64,…` URLs, written to files under the app data
/// dir so the agent can `Read` them later.
#[tauri::command]
#[specta::specta]
pub async fn dev_add_todo(
    app: AppHandle,
    id: String,
    body: String,
    screenshots: Vec<String>,
    db: State<'_, Db>,
) -> CmdResult<DevTodo> {
    // The id becomes a filename component and a primary key — accept only a
    // real UUID (single normal path component by construction).
    Uuid::parse_str(&id).map_err(|_| "todo id must be a UUID")?;
    let body = body.trim().to_string();
    if body.is_empty() && screenshots.is_empty() {
        return Err("the todo is empty".into());
    }
    if screenshots.len() > 12 {
        return Err("too many screenshots (max 12)".into());
    }
    // Sanity cap (mirrors the screenshot limits): the body is stored verbatim
    // and rendered into a prompt file, so keep it todo-sized.
    if body.len() > 20_000 {
        return Err("the todo body is too long".into());
    }

    let paths = if screenshots.is_empty() {
        Vec::new()
    } else {
        let dir = shots_dir(&app)?;
        let id = id.clone();
        tokio::task::spawn_blocking(move || write_shots(&dir, &id, &screenshots)).await??
    };

    let created = now_ms();
    sqlx::query(
        "INSERT INTO dev_todos (id, body, done, screenshots, created_at) VALUES (?, ?, 0, ?, ?)",
    )
    .bind(&id)
    .bind(&body)
    .bind(serde_json::to_string(&paths)?)
    .bind(created)
    .execute(&*db)
    .await?;

    Ok(DevTodo {
        id,
        body,
        done: false,
        screenshots: paths,
        created_at_ms: created as f64,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn dev_set_todo_done(id: String, done: bool, db: State<'_, Db>) -> CmdResult<()> {
    sqlx::query("UPDATE dev_todos SET done = ? WHERE id = ?")
        .bind(done as i64)
        .bind(&id)
        .execute(&*db)
        .await?;
    Ok(())
}

/// Delete a TODO and its screenshot files (best-effort — a missing file is fine).
#[tauri::command]
#[specta::specta]
pub async fn dev_delete_todo(app: AppHandle, id: String, db: State<'_, Db>) -> CmdResult<()> {
    let row: Option<(String,)> = sqlx::query_as("SELECT screenshots FROM dev_todos WHERE id = ?")
        .bind(&id)
        .fetch_optional(&*db)
        .await?;
    if let Some((shots,)) = row {
        let paths: Vec<String> = serde_json::from_str(&shots).unwrap_or_default();
        let dir = shots_dir(&app)?;
        tokio::task::spawn_blocking(move || {
            for p in paths {
                // Only ever delete inside our own shots dir, wherever the DB
                // row claims the file lives.
                if let Ok(real) = std::fs::canonicalize(&p) {
                    if let Ok(dir_real) = std::fs::canonicalize(&dir) {
                        if real.starts_with(&dir_real) {
                            let _ = std::fs::remove_file(real);
                        }
                    }
                }
            }
        })
        .await?;
    }
    sqlx::query("DELETE FROM dev_todos WHERE id = ?")
        .bind(&id)
        .execute(&*db)
        .await?;
    Ok(())
}

/// Render a TODO into an on-disk prompt file for the Dev Claude session and
/// return its path — the terminal is seeded (or handed via clipboard) a short
/// `Read <path>` line, mirroring how work/fix-CI prompts avoid typing large
/// content into a PTY.
#[tauri::command]
#[specta::specta]
pub async fn dev_todo_prompt(
    app: AppHandle,
    repo_path: String,
    id: String,
    db: State<'_, Db>,
) -> CmdResult<String> {
    Uuid::parse_str(&id).map_err(|_| "todo id must be a UUID")?;
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT body, screenshots FROM dev_todos WHERE id = ?")
            .bind(&id)
            .fetch_optional(&*db)
            .await?;
    let Some((body, shots)) = row else {
        return Err("todo not found".into());
    };
    let screenshots: Vec<String> = serde_json::from_str(&shots).unwrap_or_default();
    let prompts =
        crate::worktree::prompts_root(&app).ok_or("no writable data dir for prompt file")?;

    Ok(tokio::task::spawn_blocking(move || -> Result<String> {
        let root = repo_root(&repo_path)?;
        let dir = prompts.join("dev");
        std::fs::create_dir_all(&dir)?;
        let shots_block = if screenshots.is_empty() {
            String::new()
        } else {
            let list = screenshots
                .iter()
                .map(|p| format!("- {p}"))
                .collect::<Vec<_>>()
                .join("\n");
            format!("\n\nScreenshots (open each with the Read tool):\n{list}\n")
        };
        let content = format!(
            "You are working on **santree** itself — the desktop app whose Dev tab wrote this \
             prompt. Work in the checkout at `{root}` (your current directory).\n\n\
             A bug/task from the developer's TODO list:\n\n{body}\n{shots_block}\n\
             Investigate it in this codebase and implement the fix or change. Follow the repo's \
             CLAUDE.md, and run its checks before finishing.\n"
        );
        let path = dir.join(format!("{id}.md"));
        std::fs::write(&path, content)?;
        path.to_str()
            .map(String::from)
            .ok_or_else(|| anyhow!("prompt path is not valid UTF-8"))
    })
    .await??)
}

/// A pasted screenshot as a `data:` URI for inline display. The path must
/// resolve inside the app's own dev-shots dir — it round-trips through the
/// frontend, so it's untrusted by the time it comes back.
#[tauri::command]
#[specta::specta]
pub async fn dev_screenshot_src(app: AppHandle, path: String) -> CmdResult<String> {
    let dir = shots_dir(&app)?;
    Ok(tokio::task::spawn_blocking(move || -> Result<String> {
        let real = std::fs::canonicalize(&path)
            .map_err(|e| anyhow!("screenshot does not resolve: {path} ({e})"))?;
        let dir_real = std::fs::canonicalize(&dir)?;
        if !real.starts_with(&dir_real) {
            bail!("screenshot path escapes the dev-shots dir");
        }
        let mime = match real.extension().and_then(|e| e.to_str()) {
            Some("jpg") => "image/jpeg",
            _ => "image/png",
        };
        let bytes = std::fs::read(&real)?;
        Ok(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    })
    .await??)
}

/// Where pasted screenshots live: `<app-data>/dev-shots/`.
fn shots_dir(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow!("no app data dir: {e}"))?
        .join("dev-shots"))
}

/// Decode `data:image/…;base64,` URLs and write them as `<todo-id>-<n>.<ext>`.
fn write_shots(dir: &Path, id: &str, shots: &[String]) -> Result<Vec<String>> {
    /// Decoded size cap per image — a pasted retina screenshot is a few MB;
    /// anything bigger than this isn't a screenshot.
    const MAX_BYTES: usize = 20 * 1024 * 1024;
    std::fs::create_dir_all(dir)?;
    let mut paths = Vec::with_capacity(shots.len());
    for (i, url) in shots.iter().enumerate() {
        let (ext, b64) = if let Some(rest) = url.strip_prefix("data:image/png;base64,") {
            ("png", rest)
        } else if let Some(rest) = url.strip_prefix("data:image/jpeg;base64,") {
            ("jpg", rest)
        } else {
            bail!("screenshot {} is not a PNG/JPEG data URL", i + 1);
        };
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| anyhow!("screenshot {} is not valid base64: {e}", i + 1))?;
        if bytes.len() > MAX_BYTES {
            bail!("screenshot {} is too large", i + 1);
        }
        let path = dir.join(format!("{id}-{i}.{ext}"));
        std::fs::write(&path, bytes)?;
        paths.push(
            path.to_str()
                .map(String::from)
                .ok_or_else(|| anyhow!("screenshot path is not valid UTF-8"))?,
        );
    }
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("santree-dev-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn repo_root_rejects_relative_and_non_repo_paths() {
        assert!(repo_root("relative/path").is_err());
        let dir = scratch("nonrepo");
        assert!(repo_root(dir.to_str().unwrap()).is_err(), "not a git repo");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn repo_root_normalizes_a_subdir_to_the_toplevel() {
        let dir = scratch("repo");
        assert!(std::process::Command::new("git")
            .current_dir(&dir)
            .args(["init", "-b", "main"])
            .status()
            .unwrap()
            .success());
        let sub = dir.join("src/nested");
        std::fs::create_dir_all(&sub).unwrap();
        let top = repo_root(sub.to_str().unwrap()).unwrap();
        // Compare canonicalized: /tmp is a symlink to /private/tmp on macOS.
        assert_eq!(
            std::fs::canonicalize(&top).unwrap(),
            std::fs::canonicalize(&dir).unwrap()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_shots_decodes_data_urls_and_rejects_other_schemes() {
        let dir = scratch("shots");
        // A 1x1 PNG.
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let urls = vec![format!("data:image/png;base64,{png}")];
        let paths = write_shots(&dir, "11111111-1111-1111-1111-111111111111", &urls).unwrap();
        assert_eq!(paths.len(), 1);
        assert!(paths[0].ends_with("11111111-1111-1111-1111-111111111111-0.png"));
        assert!(std::fs::metadata(&paths[0]).unwrap().len() > 0);

        for bad in [
            "data:text/html;base64,PGI+",         // wrong mime
            "https://example.com/x.png",          // not a data URL
            "data:image/png;base64,not-base64!!", // invalid payload
        ] {
            assert!(
                write_shots(&dir, "11111111-1111-1111-1111-111111111111", &[bad.into()]).is_err(),
                "should reject {bad}"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn newest_dmg_picks_the_most_recent() {
        let root = scratch("dmg");
        let dmg_dir = root.join("target/release/bundle/dmg");
        std::fs::create_dir_all(&dmg_dir).unwrap();
        assert!(newest_dmg(&root).is_none(), "empty dir");
        std::fs::write(dmg_dir.join("santree_0.1.0_aarch64.dmg"), "old").unwrap();
        // A later write wins on mtime (same-second mtimes tie-break arbitrarily,
        // so nudge the clock apart via filetimes on the first file).
        std::fs::write(dmg_dir.join("ignore.txt"), "not a dmg").unwrap();
        let (path, _) = newest_dmg(&root).unwrap();
        assert!(path.to_string_lossy().ends_with(".dmg"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
