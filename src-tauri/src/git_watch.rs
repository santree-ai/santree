//! Filesystem watcher for the active repo's worktrees. Emits a debounced
//! [`WorktreeChanged`] event whenever files under a worktree change on disk, so
//! the Trees "Changes"/"All files" views refresh without polling or a manual
//! button.
//!
//! Why this exists: the Changes tab reads `git status`, but nothing re-runs it
//! when an *agent* edits files in the terminal. A single recursive watch on
//! `<repo>/.santree/worktrees` covers every worktree at once (their directories
//! are named by issue id, so the first path segment *is* the id). The per-worktree
//! git metadata lives under the *main* repo's `.git/worktrees/<name>`, which is
//! outside this tree — so our own `git add`/`commit`/`status` index churn never
//! feeds back here and can't cause a refresh loop.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::Result;
use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::Serialize;
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event;

/// Debounced "a worktree's files changed on disk" signal. The frontend reacts by
/// invalidating that worktree's status/files/diff queries for the active repo.
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeChanged {
    pub issue_id: String,
}

/// Debounce window: collapse a burst of raw FS events (an editor's atomic save,
/// or `pnpm install`/build churn) into at most one signal per worktree.
const DEBOUNCE: Duration = Duration::from_millis(400);

/// Subdirectories inside a worktree whose churn we never react to: VCS metadata
/// and the usual build/dependency output. (gitignore would be more precise, but
/// `git status` — which actually computes the changes — is already gitignore-aware;
/// this is just a cheap volume filter so a running build doesn't wake us every
/// debounce window.)
const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", "build", ".next"];

type FullDebouncer = Debouncer<RecommendedWatcher, RecommendedCache>;

/// Owns the single active watcher. Re-pointing at a new repo drops the old
/// debouncer (which stops its OS thread) and starts a fresh one. Held in Tauri
/// managed state, alongside `Db`/`PtyManager`.
#[derive(Default)]
pub struct WorktreeWatcher {
    inner: Mutex<Option<Active>>,
}

struct Active {
    root: PathBuf,
    // Kept alive so its watcher thread keeps running; dropping it stops watching.
    _debouncer: FullDebouncer,
}

impl WorktreeWatcher {
    /// Point the watcher at `<repo_root>/.santree/worktrees`, replacing any
    /// previous watch. Idempotent: re-watching the same root is a no-op (so the
    /// frontend can call this freely on every Trees mount / repo change).
    pub fn watch(&self, app: &AppHandle, repo_root: &Path) -> Result<()> {
        let root = repo_root.join(".santree").join("worktrees");
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if guard.as_ref().is_some_and(|a| a.root == root) {
            return Ok(());
        }
        // Don't create anything just because Trees was opened — merely browsing a
        // repo must not write a `.santree/` into it (the dir is created lazily by
        // the worktree-create path). Attach the recursive watch to the worktrees
        // dir when it exists, else to `.santree` (so the first worktree created
        // under it is still picked up); when neither exists yet, skip — the
        // frontend re-calls watch once a worktree (and thus the dir) is created.
        let watch_target = if root.exists() {
            root.clone()
        } else {
            let santree = repo_root.join(".santree");
            if santree.exists() {
                santree
            } else {
                return Ok(());
            }
        };

        let app = app.clone();
        // The watch may attach to `.santree`, but issue ids are mapped relative to
        // the worktrees dir, so paths outside it simply don't map.
        let watch_root = root.clone();
        let mut debouncer = new_debouncer(DEBOUNCE, None, move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            // One signal per worktree per batch — the path storm of a single save
            // collapses to a single invalidation.
            let mut fired = HashSet::new();
            for ev in events {
                for path in &ev.paths {
                    if let Some(id) = issue_id_for(&watch_root, path) {
                        if fired.insert(id.clone()) {
                            let _ = WorktreeChanged { issue_id: id }.emit(&app);
                        }
                    }
                }
            }
        })?;
        debouncer.watch(&watch_target, RecursiveMode::Recursive)?;

        // Replace (and thereby drop/stop) any previous watcher only after the new
        // one is live, so there's no gap.
        *guard = Some(Active {
            root,
            _debouncer: debouncer,
        });
        Ok(())
    }
}

/// Map an absolute changed path to the issue id of the worktree it belongs to —
/// the first path segment under the watch root (worktree dirs are named by issue
/// id). Returns `None` for paths inside a skipped subdir.
fn issue_id_for(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let mut comps = rel.components();
    let id = comps.next()?.as_os_str().to_str()?.to_string();
    // Only inspect components *inside* the worktree, so a repo dir that happens to
    // be named like a skip entry can't suppress real changes.
    for c in comps {
        if c.as_os_str().to_str().is_some_and(|s| SKIP_DIRS.contains(&s)) {
            return None;
        }
    }
    Some(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_first_segment_to_issue_id() {
        let root = Path::new("/repo/.santree/worktrees");
        let p = Path::new("/repo/.santree/worktrees/AK-170/src/main.rs");
        assert_eq!(issue_id_for(root, p).as_deref(), Some("AK-170"));
    }

    #[test]
    fn skips_vcs_and_build_dirs() {
        let root = Path::new("/repo/.santree/worktrees");
        for p in [
            "/repo/.santree/worktrees/AK-170/.git/index",
            "/repo/.santree/worktrees/AK-170/node_modules/x/y.js",
            "/repo/.santree/worktrees/AK-170/target/debug/foo",
        ] {
            assert_eq!(issue_id_for(root, Path::new(p)), None, "should skip {p}");
        }
    }

    #[test]
    fn ignores_paths_outside_root() {
        let root = Path::new("/repo/.santree/worktrees");
        assert_eq!(issue_id_for(root, Path::new("/somewhere/else/file")), None);
    }
}
