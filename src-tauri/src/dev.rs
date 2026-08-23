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
    /// The repo *name* this checkout is registered under, when it is. The Files
    /// pane reads the working tree through the shared `worktree_*` commands,
    /// which take a registered name rather than a path — so without this there's
    /// nothing to read, and the pane offers to add the checkout instead.
    pub repo_name: Option<String>,
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
pub async fn dev_info(app: AppHandle, repo_path: String, db: State<'_, Db>) -> CmdResult<DevInfo> {
    let log_path = app
        .path()
        .app_log_dir()
        .ok()
        .map(|d| d.join("santree.log"))
        .and_then(|p| p.to_str().map(String::from));
    // Queried here rather than through `repo::` so the Dev feature stays one
    // deletable module — it's a read against a table this module doesn't own,
    // and nothing else in `repo` needs a path→name lookup.
    let root = {
        let repo_path = repo_path.clone();
        tokio::task::spawn_blocking(move || repo_root(&repo_path)).await??
    };
    let repo_name: Option<String> = sqlx::query_scalar("SELECT name FROM repos WHERE path = ?")
        .bind(&root)
        .fetch_optional(&*db)
        .await?;
    Ok(tokio::task::spawn_blocking(move || info(&root, log_path, repo_name)).await??)
}

/// `root` is an already-resolved git toplevel (see [`repo_root`]).
fn info(root: &str, log_path: Option<String>, repo_name: Option<String>) -> Result<DevInfo> {
    let rootp = Path::new(root);

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
        repo_name,
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

// ── Version & release ──────────────────────────────────────────────────────

/// A santree release version: `MAJOR.MINOR.PATCH`, optionally `-beta.N`.
///
/// Deliberately narrower than semver. These are the only two shapes the release
/// workflow's channel split understands (a `-beta.N` tag publishes as a
/// pre-release, anything else as stable), and the string goes on to become a git
/// tag — so parsing this strictly is also what keeps `v{version}` from ever
/// carrying a leading `-` or anything but digits, dots and the literal "beta".
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct Version {
    major: u32,
    minor: u32,
    patch: u32,
    /// `None` for a stable release, `Some(n)` for `-beta.n`.
    beta: Option<u32>,
}

impl Version {
    /// Sort key. A beta sorts *below* the same stable version — that ordering is
    /// what rolls a beta user onto the next stable, and what stops the updater
    /// from ever moving someone backwards, so it can't be left to the derive
    /// (which would put `None` first).
    fn key(self) -> (u32, u32, u32, u32) {
        (
            self.major,
            self.minor,
            self.patch,
            self.beta.unwrap_or(u32::MAX),
        )
    }

    fn stable(major: u32, minor: u32, patch: u32) -> Self {
        Self {
            major,
            minor,
            patch,
            beta: None,
        }
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.key().cmp(&other.key())
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        match self.beta {
            Some(n) => write!(f, "-beta.{n}"),
            None => Ok(()),
        }
    }
}

impl std::str::FromStr for Version {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        let (base, beta) = match s.split_once('-') {
            Some((base, pre)) => {
                let n = pre
                    .strip_prefix("beta.")
                    .and_then(|n| n.parse::<u32>().ok())
                    .ok_or_else(|| anyhow!("'{s}': the only pre-release form is -beta.N"))?;
                (base, Some(n))
            }
            None => (s, None),
        };
        let mut parts = base.split('.');
        let mut next = || -> Result<u32> {
            parts
                .next()
                .and_then(|p| p.parse::<u32>().ok())
                .ok_or_else(|| anyhow!("'{s}' isn't MAJOR.MINOR.PATCH"))
        };
        let (major, minor, patch) = (next()?, next()?, next()?);
        if parts.next().is_some() {
            bail!("'{s}' isn't MAJOR.MINOR.PATCH");
        }
        Ok(Version {
            major,
            minor,
            patch,
            beta,
        })
    }
}

/// The version bump options offered for the current version.
#[derive(Clone, Debug, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DevNextVersions {
    /// Finish the beta that's running, or bump the patch when none is.
    pub release: String,
    pub minor: String,
    pub major: String,
    /// The next beta: `-beta.N+1` while one is running, otherwise the first beta
    /// of the next minor.
    pub beta: String,
}

fn next_versions(current: Version) -> DevNextVersions {
    let Version {
        major,
        minor,
        patch,
        beta,
    } = current;
    let release = match beta {
        // A beta's job is to become that exact stable version, not the one after.
        Some(_) => Version::stable(major, minor, patch),
        None => Version::stable(major, minor, patch + 1),
    };
    let next_beta = match beta {
        Some(n) => Version {
            major,
            minor,
            patch,
            beta: Some(n + 1),
        },
        None => Version {
            major,
            minor: minor + 1,
            patch: 0,
            beta: Some(1),
        },
    };
    DevNextVersions {
        release: release.to_string(),
        minor: Version::stable(major, minor + 1, 0).to_string(),
        major: Version::stable(major + 1, 0, 0).to_string(),
        beta: next_beta.to_string(),
    }
}

/// What the Release pane shows before anything is written: where the checkout's
/// declared version sits, what it could become, and every reason a release from
/// here would be refused — so the refusal is visible up front rather than after
/// the button.
#[derive(Clone, Debug, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DevVersion {
    /// The version declared in `package.json`.
    pub current: String,
    /// Files whose declared version disagrees with `current`. The release guard
    /// fails the tag on any disagreement, so this has to be visible before the
    /// bump, not after CI rejects it.
    pub mismatched: Vec<String>,
    /// Newest `v*` tag in the checkout, by release order (not commit date).
    pub latest_tag: Option<String>,
    pub next: DevNextVersions,
    /// Versions that already have a `## <version>` section in CHANGELOG.md.
    pub changelog_versions: Vec<String>,
    pub branch: String,
    /// Uncommitted files. A release commit takes only the version files, so this
    /// doesn't block one — it's shown because releasing off a dirty tree usually
    /// means something was meant to go in.
    pub dirty_files: u32,
}

/// A finished release: what was written, committed, tagged and pushed. Every
/// field is what actually happened, so a partial run reports the truth.
#[derive(Clone, Debug, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DevRelease {
    pub version: String,
    pub tag: String,
    /// Paths whose contents changed (empty when the checkout already declared
    /// this version — re-running after a failed tag is expected to write nothing).
    pub written: Vec<String>,
    /// The release commit, or `None` when there was nothing left to commit.
    pub commit: Option<String>,
    pub pushed: bool,
}

/// The files that declare the version, in the order the release guard reads them.
const VERSION_FILES: [&str; 4] = [
    "package.json",
    "src-tauri/tauri.conf.json",
    "Cargo.toml",
    "Cargo.lock",
];
const CHANGELOG: &str = "CHANGELOG.md";

/// The quoted value a `<prefix>"…"` line declares, and whatever trails the
/// closing quote (a comma, a comment). Both writers and both readers below go
/// through this, so what one recognizes the other can always rewrite.
fn quoted_value<'a>(line: &'a str, prefix: &str) -> Option<(&'a str, &'a str)> {
    let rest = line.strip_prefix(prefix)?;
    let close = rest.find('"')?;
    Some((&rest[..close], &rest[close + 1..]))
}

const JSON_VERSION: &str = "  \"version\": \"";
const TOML_VERSION: &str = "version = \"";

/// Replace the top-level `"version"` of a 2-space-indented JSON file.
///
/// Matched on the exact two-space indent rather than the first `"version"`
/// anywhere: a dependency's version nested deeper must never be the one that
/// moves, and a reformat that breaks the assumption should fail loudly here
/// rather than write the wrong line.
fn set_json_version(text: &str, version: &str) -> Result<String> {
    let mut out = String::with_capacity(text.len());
    let mut done = false;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        match quoted_value(trimmed, JSON_VERSION) {
            // The tail is kept verbatim: `"version"` is the last property in some
            // of these files and carries no comma.
            Some((_, tail)) if !done => {
                out.push_str(&format!("{JSON_VERSION}{version}\"{tail}"));
                out.push_str(&line[trimmed.len()..]);
                done = true;
            }
            _ => out.push_str(line),
        }
    }
    if !done {
        bail!("no top-level \"version\" line to update");
    }
    Ok(out)
}

/// Replace `version` under `[workspace.package]` in Cargo.toml — the one the
/// workspace crates inherit.
fn set_cargo_toml_version(text: &str, version: &str) -> Result<String> {
    let mut out = String::with_capacity(text.len());
    let mut in_workspace_package = false;
    let mut done = false;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed.starts_with('[') {
            in_workspace_package = trimmed == "[workspace.package]";
        }
        match quoted_value(trimmed, TOML_VERSION) {
            Some((_, tail)) if !done && in_workspace_package => {
                out.push_str(&format!("{TOML_VERSION}{version}\"{tail}"));
                out.push_str(&line[trimmed.len()..]);
                done = true;
            }
            _ => out.push_str(line),
        }
    }
    if !done {
        bail!("no [workspace.package] version to update");
    }
    Ok(out)
}

/// Replace the version of every `santree*` package in Cargo.lock — the lock
/// mirrors `[workspace.package]` for the workspace crates, and a stale one is a
/// dirty tree on the release commit.
fn set_cargo_lock_version(text: &str, version: &str) -> Result<String> {
    let mut out = String::with_capacity(text.len());
    let mut pending = false;
    let mut changed = 0;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed == "name = \"santree\"" || trimmed.starts_with("name = \"santree-") {
            pending = true;
            out.push_str(line);
            continue;
        }
        if pending {
            if let Some((_, tail)) = quoted_value(trimmed, TOML_VERSION) {
                out.push_str(&format!("{TOML_VERSION}{version}\"{tail}"));
                out.push_str(&line[trimmed.len()..]);
                pending = false;
                changed += 1;
                continue;
            }
        }
        // Only the `version` immediately under a santree `name` is ours; anything
        // else ends the window rather than letting it run into the next package.
        if pending && trimmed.starts_with('[') {
            pending = false;
        }
        out.push_str(line);
    }
    if changed == 0 {
        bail!("no santree package versions in Cargo.lock");
    }
    Ok(out)
}

/// Every version with a `## <version>` section, in file order.
fn changelog_versions(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|l| l.strip_prefix("## "))
        .filter_map(|rest| rest.split_whitespace().next())
        .map(str::to_string)
        .collect()
}

/// Insert a `## <version> — <date>` section above the newest existing one
/// (the file is newest-first). Returns `None` when the version already has a
/// section — an existing entry is the author's, and is never rewritten.
fn insert_changelog(text: &str, version: &str, notes: &str, date: &str) -> Option<String> {
    if changelog_versions(text).iter().any(|v| v == version) {
        return None;
    }
    let entry = format!("## {version} — {date}\n\n{}\n\n", notes.trim());
    match text.find("\n## ") {
        // Keep everything above the first section (the file's own preamble).
        Some(at) => Some(format!("{}\n{entry}{}", &text[..at], &text[at + 1..])),
        None => Some(format!("{}\n{entry}", text.trim_end())),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn dev_version(repo_path: String) -> CmdResult<DevVersion> {
    Ok(tokio::task::spawn_blocking(move || version_info(&repo_path)).await??)
}

fn version_info(repo_path: &str) -> Result<DevVersion> {
    let root = repo_root(repo_path)?;
    let rootp = Path::new(&root);
    let read = |rel: &str| std::fs::read_to_string(rootp.join(rel)).unwrap_or_default();

    let pkg = read("package.json");
    let current = declared_json_version(&pkg)
        .ok_or_else(|| anyhow!("package.json declares no top-level version"))?;

    // Compare by *text*: the guard in release.yml does a string comparison too,
    // so "0.1.1" vs "0.1.01" has to read as a mismatch here as well.
    let mut mismatched = Vec::new();
    if declared_json_version(&read("src-tauri/tauri.conf.json")).as_deref() != Some(&current) {
        mismatched.push("src-tauri/tauri.conf.json".to_string());
    }
    if declared_cargo_version(&read("Cargo.toml")).as_deref() != Some(&current) {
        mismatched.push("Cargo.toml".to_string());
    }

    let parsed: Version = current.parse()?;
    let latest_tag = git::git_output(rootp, &["tag", "--list", "v*"])
        .unwrap_or_default()
        .lines()
        .filter_map(|t| t.trim().strip_prefix('v')?.parse::<Version>().ok())
        .max()
        .map(|v| format!("v{v}"));

    Ok(DevVersion {
        next: next_versions(parsed),
        current,
        mismatched,
        latest_tag,
        changelog_versions: changelog_versions(&read(CHANGELOG)),
        branch: git::git(rootp, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default(),
        dirty_files: git::git_output(rootp, &["status", "--porcelain"])
            .map(|out| out.lines().filter(|l| !l.trim().is_empty()).count() as u32)
            .unwrap_or(0),
    })
}

fn declared_json_version(text: &str) -> Option<String> {
    text.lines()
        .find_map(|l| quoted_value(l.trim_end(), JSON_VERSION))
        .map(|(v, _)| v.to_string())
}

fn declared_cargo_version(text: &str) -> Option<String> {
    let mut in_workspace_package = false;
    for line in text.lines() {
        let trimmed = line.trim_end();
        if trimmed.starts_with('[') {
            in_workspace_package = trimmed == "[workspace.package]";
        }
        if in_workspace_package {
            if let Some((v, _)) = quoted_value(trimmed, TOML_VERSION) {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// Bump the checkout to `version`, commit just the version files, tag it and
/// push the tag — which is what starts the signed, notarized release in CI.
///
/// Every refusal happens *before* anything is written, so a rejected release
/// leaves the checkout exactly as it was. The steps after that are idempotent:
/// re-running after a push that failed rewrites the same values, skips a
/// CHANGELOG section that already exists, finds nothing to commit, and gets as
/// far as it can — so recovery is the same button, not a manual cleanup.
#[tauri::command]
#[specta::specta]
pub async fn dev_release(
    repo_path: String,
    version: String,
    notes: String,
) -> CmdResult<DevRelease> {
    Ok(tokio::task::spawn_blocking(move || release(&repo_path, &version, &notes)).await??)
}

fn release(repo_path: &str, version: &str, notes: &str) -> Result<DevRelease> {
    let root = repo_root(repo_path)?;
    let rootp = Path::new(&root);
    // Parsing is the gate: `v{version}` becomes a git argv, and only digits,
    // dots and "beta" survive this — so it can never be read as a flag.
    let parsed: Version = version.parse()?;
    let version = parsed.to_string();
    let tag = format!("v{version}");

    let changelog = std::fs::read_to_string(rootp.join(CHANGELOG)).unwrap_or_default();
    let has_entry = changelog_versions(&changelog).contains(&version);
    if parsed.beta.is_none() && !has_entry && notes.trim().is_empty() {
        bail!("a stable release needs CHANGELOG notes: the guard fails the tag without them");
    }

    // An existing tag is either a mistake or the tail of a run whose push failed.
    // The checkout's own declared version tells them apart: if it doesn't already
    // say this version, the tag belongs to something else and going ahead would
    // publish a second, different release under one name.
    let pkg = std::fs::read_to_string(rootp.join("package.json"))?;
    let resuming = git::git(
        rootp,
        &["rev-parse", "-q", "--verify", &format!("refs/tags/{tag}")],
    )
    .is_ok();
    if resuming && declared_json_version(&pkg).as_deref() != Some(version.as_str()) {
        bail!("{tag} already exists");
    }
    // Skipped while resuming — the newest tag *is* this one by then.
    if !resuming {
        if let Some(latest) = git::git_output(rootp, &["tag", "--list", "v*"])
            .unwrap_or_default()
            .lines()
            .filter_map(|t| t.trim().strip_prefix('v')?.parse::<Version>().ok())
            .max()
        {
            if parsed <= latest {
                bail!("{version} isn't newer than v{latest}. The updater never moves anyone back");
            }
        }
    }

    // ── past every refusal; start writing ──
    let mut written = Vec::new();
    let mut write = |rel: &str, next: String| -> Result<()> {
        let path = rootp.join(rel);
        if std::fs::read_to_string(&path).unwrap_or_default() != next {
            std::fs::write(&path, next)?;
            written.push(rel.to_string());
        }
        Ok(())
    };
    write("package.json", set_json_version(&pkg, &version)?)?;
    let conf = std::fs::read_to_string(rootp.join("src-tauri/tauri.conf.json"))?;
    write(
        "src-tauri/tauri.conf.json",
        set_json_version(&conf, &version)?,
    )?;
    let toml = std::fs::read_to_string(rootp.join("Cargo.toml"))?;
    write("Cargo.toml", set_cargo_toml_version(&toml, &version)?)?;
    let lock = std::fs::read_to_string(rootp.join("Cargo.lock"))?;
    write("Cargo.lock", set_cargo_lock_version(&lock, &version)?)?;
    if let Some(next) = insert_changelog(
        &changelog,
        &version,
        notes,
        &chrono::Local::now().format("%Y-%m-%d").to_string(),
    ) {
        write(CHANGELOG, next)?;
    }

    let mut paths: Vec<&str> = VERSION_FILES.to_vec();
    paths.push(CHANGELOG);
    // By pathspec: whatever else is in the tree or the index is someone's work in
    // progress, and sweeping it into a release commit is how an unreviewed change
    // ships. `None` means it was already committed — the expected case when
    // re-running after the tag or the push failed.
    // `release: <version>` is what this repo's history calls a release commit.
    let commit = git::commit_paths(rootp, &format!("release: {version}"), &paths)?;

    if resuming {
        // The tag was made by the earlier run; it must still be the commit we'd
        // publish. If the bump moved HEAD after it, the tag is now behind — which
        // would ship the *previous* code under this version.
        let at = git::git(rootp, &["rev-parse", &format!("{tag}^{{commit}}")])?;
        let head = git::git(rootp, &["rev-parse", "HEAD"])?;
        if at != head {
            bail!("{tag} already exists, on an earlier commit than this release");
        }
    } else {
        // Annotated, with a message. A bare `git tag <name>` is lightweight and
        // needs none — until `tag.gpgsign` is set, which turns it into a signed
        // annotated tag and then fails with "no tag message?". Passing one works
        // either way, and an annotated release tag records who cut it.
        git::git(rootp, &["tag", "-m", &format!("santree {version}"), &tag])?;
    }
    git::git(rootp, &["push", "origin", &tag])?;

    Ok(DevRelease {
        version,
        tag,
        written,
        commit,
        pushed: true,
    })
}

#[cfg(test)]
mod tests {
    // ── Version parsing & ordering ─────────────────────────────────────────

    fn v(s: &str) -> Version {
        s.parse().unwrap()
    }

    #[test]
    fn parses_the_two_shapes_and_rejects_everything_else() {
        assert_eq!(v("1.2.3").to_string(), "1.2.3");
        assert_eq!(v("0.2.0-beta.11").to_string(), "0.2.0-beta.11");
        for bad in [
            "1.2",
            "1.2.3.4",
            "v1.2.3",     // the `v` belongs to the tag, not the version
            "1.2.3-rc.1", // release.yml only splits on -beta
            "1.2.3-beta",
            "1.2.3-beta.x",
            "-1.2.3", // would become a git flag
            "1.2.3 --force",
            "",
        ] {
            assert!(bad.parse::<Version>().is_err(), "{bad} must not parse");
        }
    }

    #[test]
    fn a_beta_sorts_below_its_own_stable_release() {
        // The load-bearing rule: this ordering is what rolls a beta user onto the
        // next stable, and what stops the updater moving anyone backwards.
        assert!(v("0.2.0-beta.1") < v("0.2.0"));
        assert!(v("0.2.0-beta.1") < v("0.2.0-beta.2"));
        assert!(v("0.1.9") < v("0.2.0-beta.1"));
        assert!(v("0.9.0") < v("1.0.0"));
        let mut all = [v("0.2.0"), v("0.2.0-beta.2"), v("0.1.1"), v("0.2.0-beta.1")];
        all.sort();
        let ordered: Vec<String> = all.iter().map(Version::to_string).collect();
        assert_eq!(ordered, ["0.1.1", "0.2.0-beta.1", "0.2.0-beta.2", "0.2.0"]);
    }

    #[test]
    fn a_running_beta_offers_to_become_its_own_stable() {
        let n = next_versions(v("0.2.0-beta.3"));
        assert_eq!(
            n.release, "0.2.0",
            "a beta finishes as that version, not the next"
        );
        assert_eq!(n.beta, "0.2.0-beta.4");
        let n = next_versions(v("0.1.1"));
        assert_eq!(n.release, "0.1.2");
        assert_eq!(n.beta, "0.2.0-beta.1");
        assert_eq!(n.minor, "0.2.0");
        assert_eq!(n.major, "1.0.0");
    }

    // ── The version files ──────────────────────────────────────────────────

    const PKG: &str = "{\n  \"name\": \"santree-app\",\n  \"version\": \"0.1.1\",\n  \"deps\": {\n    \"version\": \"9.9.9\"\n  }\n}\n";

    #[test]
    fn json_bump_takes_the_top_level_version_only() {
        let out = set_json_version(PKG, "0.2.0").unwrap();
        assert!(out.contains("  \"version\": \"0.2.0\","));
        // A nested `version` is a dependency's, and moving it would be silent damage.
        assert!(out.contains("    \"version\": \"9.9.9\""));
        assert_eq!(declared_json_version(&out).as_deref(), Some("0.2.0"));
    }

    #[test]
    fn json_bump_keeps_whatever_trails_the_value() {
        // `"version"` is the last property in some of these files, so it carries
        // no comma — requiring one silently skipped the line.
        let last = "{\n  \"name\": \"x\",\n  \"version\": \"0.1.1\"\n}\n";
        let out = set_json_version(last, "0.2.0").unwrap();
        assert!(out.contains("  \"version\": \"0.2.0\"\n"));
        assert_eq!(declared_json_version(&out).as_deref(), Some("0.2.0"));
        // …and a comma is still a comma.
        assert!(set_json_version(PKG, "0.2.0")
            .unwrap()
            .contains("\"0.2.0\","));
    }

    #[test]
    fn json_bump_fails_loudly_when_the_line_is_gone() {
        assert!(set_json_version("{\n  \"name\": \"x\"\n}\n", "0.2.0").is_err());
    }

    const TOML: &str = "[workspace]\nmembers = [\"a\"]\n\n[workspace.package]\nedition = \"2021\"\nversion = \"0.1.1\"\n\n[workspace.dependencies]\nserde = { version = \"1\" }\n";

    #[test]
    fn cargo_toml_bump_takes_the_workspace_package_version() {
        let out = set_cargo_toml_version(TOML, "0.2.0").unwrap();
        assert_eq!(declared_cargo_version(&out).as_deref(), Some("0.2.0"));
        // The dependency table's own `version` must not move.
        assert!(out.contains("serde = { version = \"1\" }"));
        assert!(set_cargo_toml_version("[package]\nversion = \"1\"\n", "0.2.0").is_err());
    }

    const LOCK: &str = "[[package]]\nname = \"other\"\nversion = \"3.0.0\"\n\n[[package]]\nname = \"santree\"\nversion = \"0.1.1\"\ndependencies = [\n \"other\",\n]\n\n[[package]]\nname = \"santree-core\"\nversion = \"0.1.1\"\n\n[[package]]\nname = \"santreeish\"\nversion = \"7.7.7\"\n";

    #[test]
    fn cargo_lock_bump_takes_every_workspace_crate_and_nothing_else() {
        let out = set_cargo_lock_version(LOCK, "0.2.0").unwrap();
        assert_eq!(out.matches("version = \"0.2.0\"").count(), 2);
        assert!(out.contains("name = \"other\"\nversion = \"3.0.0\""));
        // `santreeish` isn't ours — the prefix match must require the hyphen.
        assert!(out.contains("name = \"santreeish\"\nversion = \"7.7.7\""));
        assert!(set_cargo_lock_version(
            "[[package]]\nname = \"other\"\nversion = \"1\"\n",
            "0.2.0"
        )
        .is_err());
    }

    // ── CHANGELOG ──────────────────────────────────────────────────────────

    const LOG: &str = "# Changelog\n\nNotes for each release, newest first.\n\n## 0.1.1 — 2026-08-20\n\n- something\n\n## 0.1.0 — 2026-08-01\n\n- first\n";

    #[test]
    fn changelog_entry_lands_above_the_newest_section() {
        let out = insert_changelog(LOG, "0.2.0", "- new thing\n", "2026-08-23").unwrap();
        assert!(out.starts_with("# Changelog\n\nNotes for each release, newest first.\n"));
        let heads = changelog_versions(&out);
        assert_eq!(heads, ["0.2.0", "0.1.1", "0.1.0"]);
        // The heading shape the release guard greps for (`$1=="##" && $2==v`).
        assert!(out.contains("## 0.2.0 — 2026-08-23\n\n- new thing\n"));
    }

    #[test]
    fn an_existing_changelog_entry_is_never_rewritten() {
        // Re-running a release after a failed push must not duplicate or replace
        // what the author already wrote.
        assert!(insert_changelog(LOG, "0.1.1", "- clobber", "2026-08-23").is_none());
    }

    /// The writers make format assumptions (a two-space indent, a
    /// `[workspace.package]` table, `name`-then-`version` in the lock). Run them
    /// against *this* repo's real files so a reformat that quietly breaks one is
    /// a red test rather than a release commit that changes nothing.
    #[test]
    fn the_writers_still_match_the_repo_they_bump() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let read = |rel: &str| std::fs::read_to_string(root.join(rel)).unwrap();

        for rel in ["package.json", "src-tauri/tauri.conf.json"] {
            let text = read(rel);
            let declared = declared_json_version(&text);
            assert!(declared.is_some(), "{rel} has no readable version");
            let out = set_json_version(&text, "9.9.9").unwrap();
            assert_eq!(
                declared_json_version(&out).as_deref(),
                Some("9.9.9"),
                "{rel}"
            );
        }

        let toml = read("Cargo.toml");
        assert!(declared_cargo_version(&toml).is_some());
        let out = set_cargo_toml_version(&toml, "9.9.9").unwrap();
        assert_eq!(declared_cargo_version(&out).as_deref(), Some("9.9.9"));

        // Every workspace crate, and only those.
        let lock = read("Cargo.lock");
        let out = set_cargo_lock_version(&lock, "9.9.9").unwrap();
        let bumped = out.matches("version = \"9.9.9\"").count();
        assert!(
            bumped >= 4,
            "expected the 4 santree crates, bumped {bumped}"
        );

        // The declared versions agree today, which is what the release guard
        // requires of any tag.
        let pkg = declared_json_version(&read("package.json")).unwrap();
        assert_eq!(
            declared_json_version(&read("src-tauri/tauri.conf.json")),
            Some(pkg.clone())
        );
        assert_eq!(declared_cargo_version(&toml), Some(pkg.clone()));
        assert!(
            pkg.parse::<Version>().is_ok(),
            "{pkg} must parse as a release version"
        );
    }

    #[test]
    fn changelog_versions_reads_only_section_headings() {
        assert_eq!(changelog_versions(LOG), ["0.1.1", "0.1.0"]);
        assert!(changelog_versions("# Changelog\n\nnothing yet\n").is_empty());
    }

    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("santree-dev-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A whole release, run against real git: bump → commit → tag → push.
    ///
    /// The unit tests above cover each writer in isolation; this one covers the
    /// part that can't be reasoned about from them — that the commit takes *only*
    /// the version files (leaving work in progress behind), that the tag lands on
    /// it, and that re-running after a failed push finishes instead of refusing.
    #[test]
    fn a_release_commits_only_the_version_files_and_pushes_its_tag() {
        let base = scratch("release");
        let remote = base.join("remote.git");
        let work = base.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let g = |cwd: &Path, args: &[&str]| git::git(cwd, args).unwrap();

        git::git(&base, &["init", "--bare", "remote.git"]).unwrap();
        g(&work, &["init", "-b", "main"]);
        g(&work, &["config", "user.email", "dev@example.com"]);
        g(&work, &["config", "user.name", "dev"]);
        g(
            &work,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );

        let write = |rel: &str, body: &str| {
            let path = work.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body).unwrap();
        };
        write(
            "package.json",
            "{\n  \"name\": \"x\",\n  \"version\": \"0.1.1\"\n}\n",
        );
        write(
            "src-tauri/tauri.conf.json",
            "{\n  \"productName\": \"santree\",\n  \"version\": \"0.1.1\"\n}\n",
        );
        write("Cargo.toml", "[workspace.package]\nversion = \"0.1.1\"\n");
        write(
            "Cargo.lock",
            "[[package]]\nname = \"santree\"\nversion = \"0.1.1\"\n",
        );
        write(
            "CHANGELOG.md",
            "# Changelog\n\n## 0.1.1 — 2026-08-20\n\n- old\n",
        );
        write("src/app.ts", "committed\n");
        g(&work, &["add", "-A"]);
        g(&work, &["commit", "-m", "init"]);

        // Work in progress that must survive untouched — a release commit that
        // swept this up would ship an unreviewed change.
        write("src/app.ts", "half-finished\n");
        let before = g(&work, &["rev-parse", "HEAD"]);

        let root = work.to_str().unwrap();
        let out = release(root, "0.2.0-beta.1", "- something new").unwrap();
        assert_eq!(out.tag, "v0.2.0-beta.1");
        assert!(out.pushed);
        assert!(out.commit.is_some(), "the bump should have been committed");
        assert_eq!(
            g(&work, &["log", "-1", "--format=%s"]),
            "release: 0.2.0-beta.1"
        );

        // Every declared version moved, in lockstep — the guard fails a tag otherwise.
        let read = |rel: &str| std::fs::read_to_string(work.join(rel)).unwrap();
        assert_eq!(
            declared_json_version(&read("package.json")).as_deref(),
            Some("0.2.0-beta.1")
        );
        assert_eq!(
            declared_json_version(&read("src-tauri/tauri.conf.json")).as_deref(),
            Some("0.2.0-beta.1")
        );
        assert_eq!(
            declared_cargo_version(&read("Cargo.toml")).as_deref(),
            Some("0.2.0-beta.1")
        );
        assert!(read("Cargo.lock").contains("version = \"0.2.0-beta.1\""));
        assert!(read("CHANGELOG.md").contains("## 0.2.0-beta.1 — "));

        // The commit touched the version files and nothing else…
        let touched = g(&work, &["show", "--name-only", "--format=", "HEAD"]);
        let mut touched: Vec<&str> = touched.lines().filter(|l| !l.is_empty()).collect();
        touched.sort_unstable();
        assert_eq!(
            touched,
            [
                "CHANGELOG.md",
                "Cargo.lock",
                "Cargo.toml",
                "package.json",
                "src-tauri/tauri.conf.json"
            ]
        );
        // …and the work in progress is still uncommitted, exactly as it was.
        assert_eq!(read("src/app.ts"), "half-finished\n");
        assert!(g(&work, &["status", "--porcelain"]).contains("src/app.ts"));
        assert_ne!(g(&work, &["rev-parse", "HEAD"]), before);

        // The tag is on the release commit, and it reached the remote.
        let head = g(&work, &["rev-parse", "HEAD"]);
        assert_eq!(g(&work, &["rev-parse", "v0.2.0-beta.1^{commit}"]), head);
        assert_eq!(
            git::git(&remote, &["rev-parse", "v0.2.0-beta.1^{commit}"]).unwrap(),
            head
        );

        // Re-running is the recovery path for a push that failed: it finishes
        // rather than refusing, writes nothing new, and doesn't duplicate the
        // changelog entry.
        let again = release(root, "0.2.0-beta.1", "- something new").unwrap();
        assert!(again.written.is_empty());
        assert!(again.commit.is_none());
        assert!(again.pushed);
        assert_eq!(read("CHANGELOG.md").matches("## 0.2.0-beta.1").count(), 1);
        assert_eq!(g(&work, &["rev-parse", "HEAD"]), head);

        // A different version whose tag is taken is still refused.
        assert!(release(root, "0.1.1", "- backwards").is_err());

        let _ = std::fs::remove_dir_all(&base);
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
