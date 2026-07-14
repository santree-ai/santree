//! Filesystem watcher for the active repo. Emits a debounced [`WorktreeChanged`]
//! event whenever files under a worktree — or the repo root itself, for the
//! `BASE_ID` pseudo-worktree — change on disk, so the Trees "Changes"/"All
//! files" views refresh without polling or a manual button.
//!
//! Why this exists: the Changes tab reads `git status`, but nothing re-runs it
//! when an *agent* edits files in the terminal. Two watches cover the repo:
//! a recursive one on `<repo>/.santree/worktrees` (their directories are named
//! by issue id, so the first path segment *is* the id), and a recursive one on
//! the repo root itself for the base worktree, filtering out `.santree`/`.git`/
//! build-dir churn in the callback (the `notify` crate has no OS-level
//! "recursive except these subtrees" primitive, so — same as the worktrees
//! watch's `SKIP_DIRS` handling — the filtering happens post-registration, not
//! by skipping the subdirectory at watch-setup time). The per-worktree git
//! metadata lives under the *main* repo's `.git/worktrees/<name>`, which is
//! outside the worktrees tree — so our own `git add`/`commit`/`status` index
//! churn there never feeds back into the worktrees watch and can't cause a
//! refresh loop; the base watch explicitly skips `.git` for the same reason
//! (and to avoid firing on *other* worktrees' ref/index updates, which live
//! under the shared `.git`).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::Result;
use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{
    new_debouncer, DebounceEventResult, DebouncedEvent, Debouncer, RecommendedCache,
};
use serde::Serialize;
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event;

use crate::worktree::BASE_ID;

/// Debounced "a worktree's files changed on disk" signal. The frontend reacts by
/// invalidating that worktree's status/files/diff queries for the active repo.
/// `issue_id` is [`BASE_ID`] for a change to the base worktree (the repo root).
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeChanged {
    pub issue_id: String,
}

/// Debounce window: collapse a burst of raw FS events (an editor's atomic save,
/// or `pnpm install`/build churn) into at most one signal per worktree.
const DEBOUNCE: Duration = Duration::from_millis(400);

/// Subdirectories whose churn we never react to: VCS metadata and the usual
/// build/dependency output. Applies both inside a worktree and at the repo
/// root. (gitignore would be more precise, but `git status` — which actually
/// computes the changes — is already gitignore-aware; this is just a cheap
/// volume filter so a running build doesn't wake us every debounce window.)
const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", "build", ".next"];

type FullDebouncer = Debouncer<RecommendedWatcher, RecommendedCache>;

/// Owns the active watcher state for the active repo. Re-pointing at a new
/// repo drops the old debouncer(s) (which stops their OS threads) and starts
/// fresh ones. Held in Tauri managed state, alongside `Db`/`PtyManager`.
#[derive(Default)]
pub struct WorktreeWatcher {
    inner: Mutex<Option<Active>>,
    /// Bumped right before a `watch()` call starts the (potentially slow)
    /// watcher registration below. Lets a call that's superseded by a later
    /// one — e.g. the user switched repos again before this call finished —
    /// detect that on completion and back off instead of clobbering (or
    /// racing to overwrite) whatever the newer call already stored. Not
    /// touched by calls that short-circuit as a no-op, since those never
    /// write to `inner` and so can't cause a stale write.
    generation: AtomicU64,
    /// Watch targets whose OS registration failed (the documented Linux
    /// `max_user_watches` case). Registering a recursive watch walks the whole
    /// subtree, so retrying a target that will just fail again would re-pay that
    /// cost on every Trees mount / repo switch — remember it, log once, and skip
    /// it for the rest of the session (raising the limit needs a restart anyway).
    failed: Mutex<HashSet<PathBuf>>,
}

struct Active {
    /// Canonical repo root this state was registered for; re-`watch()`ing the
    /// same root is a no-op once both debouncers below are live (or, for
    /// `worktrees_debouncer`, once we've established there's genuinely
    /// nothing to watch yet).
    repo_root: PathBuf,
    /// Recursive watch over `<repo_root>/.santree` (or its `worktrees`
    /// subdir) covering every worktree. `None` when the repo has no
    /// `.santree` dir yet (nothing to watch) or when OS registration failed
    /// (e.g. inotify's `max_user_watches` limit — see the module comment).
    /// Kept alive so its watcher thread keeps running; dropping it stops
    /// watching.
    worktrees_debouncer: Option<FullDebouncer>,
    /// Recursive watch over `repo_root` itself, for the `BASE_ID`
    /// pseudo-worktree. `None` only if OS registration failed.
    base_debouncer: Option<FullDebouncer>,
}

impl WorktreeWatcher {
    /// Point the watcher at `repo_root` (its `.santree/worktrees` subtree, plus
    /// the root itself for the base worktree), replacing any previous watch.
    /// Idempotent: re-watching the same repo once both watches are settled is
    /// a no-op, so the frontend can call this freely on every Trees mount /
    /// repo change.
    ///
    /// Async because registering a recursive watch is heavy: on Linux (inotify) it
    /// enumerates and adds one descriptor per subdirectory, which is slow for
    /// worktrees carrying `node_modules`/`target`. We run that on the blocking pool
    /// rather than stalling the async executor.
    pub async fn watch(&self, app: &AppHandle, repo_root: &Path) -> Result<()> {
        // Resolving the targets stats the filesystem, so it goes to the blocking
        // pool too (a cold/networked FS makes even a canonicalize slow enough to
        // stall an executor thread).
        let root = repo_root.to_path_buf();
        let (repo_root, worktrees_root, worktrees_target) =
            tokio::task::spawn_blocking(move || {
                // Canonicalize once: macOS FSEvents (and `notify` generally) report
                // resolved/canonical paths in change events (e.g. `/private/var/...`
                // for a `/var/...` symlink), so every comparison below — idempotency,
                // `issue_id_for`, and the base-watch filter — must use the same
                // canonical form, or a repo opened via a symlinked path silently never
                // matches (falls back to the lexical path if it doesn't exist yet;
                // mirrors `git.rs`'s `worktree_branch`).
                let repo_root = std::fs::canonicalize(&root).unwrap_or(root);
                let worktrees_root = repo_root.join(".santree").join("worktrees");

                // Don't create anything just because Trees was opened — merely browsing a
                // repo must not write a `.santree/` into it (the dir is created lazily by
                // the worktree-create path). Attach the recursive watch to the worktrees
                // dir when it exists, else to `.santree` (so the first worktree created
                // under it is still picked up); when neither exists yet there's simply no
                // worktrees watch this round (the base-repo watch below is unaffected —
                // the frontend re-calls `watch` once a worktree, and thus the dir, exists).
                let worktrees_target = if worktrees_root.exists() {
                    Some(worktrees_root.clone())
                } else {
                    let santree = repo_root.join(".santree");
                    santree.exists().then_some(santree)
                };
                (repo_root, worktrees_root, worktrees_target)
            })
            .await?;

        // Skip a target we already know the OS refuses to watch (see `failed`), so
        // this call has nothing left to do once the surviving watches are live.
        let failed = self
            .failed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let watch_base = !failed.contains(&repo_root);
        let worktrees_attempt = worktrees_target.filter(|t| !failed.contains(t));

        let already_active = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|a| {
                a.repo_root == repo_root
                    && (a.base_debouncer.is_some() || !watch_base)
                    && (a.worktrees_debouncer.is_some() || worktrees_attempt.is_none())
            });
        if already_active {
            return Ok(());
        }

        // Claim a generation now, right before the cancel-unsafe registration
        // work below, so a call superseded by a later one can detect that once
        // it (eventually) finishes. See the field doc on `generation`.
        let my_gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;

        let app_wt = app.clone();
        let app_base = app.clone();
        let watch_root = worktrees_root.clone();
        let base_root = repo_root.clone();
        let base_watch_target = repo_root.clone();

        // We keep *recursive* watches rather than hand-rolling per-directory
        // registration that skips `SKIP_DIRS`: a manual walker would miss
        // subdirectories created after setup (newly-cloned deps, fresh build dirs)
        // unless it also tracked create events and re-registered them — a whole
        // subsystem to maintain. The debounce window plus the skip filters
        // already collapse build churn to at most one signal per worktree/base.
        let (worktrees_debouncer, base_debouncer, newly_failed) = tokio::task::spawn_blocking(
            move || -> Result<(Option<FullDebouncer>, Option<FullDebouncer>, Vec<PathBuf>)> {
                let mut newly_failed = Vec::new();
                let worktrees_debouncer = match worktrees_attempt {
                    Some(target) => {
                        let mut d =
                            new_debouncer(DEBOUNCE, None, move |res: DebounceEventResult| {
                                let Some(events) = batch("worktrees", res) else {
                                    return;
                                };
                                // One signal per worktree per batch — the path storm
                                // of a single save collapses to a single invalidation.
                                let mut fired = HashSet::new();
                                for ev in events {
                                    for path in &ev.paths {
                                        if let Some(id) = issue_id_for(&watch_root, path) {
                                            if fired.insert(id.clone()) {
                                                let _ =
                                                    WorktreeChanged { issue_id: id }.emit(&app_wt);
                                            }
                                        }
                                    }
                                }
                            })?;
                        match d.watch(&target, RecursiveMode::Recursive) {
                            Ok(()) => Some(d),
                            Err(e) => {
                                // A worktree with a large `node_modules`/`target` can
                                // blow past inotify's `max_user_watches` (commonly
                                // 8192 on Linux) — `notify` registers one descriptor
                                // per subdirectory even for ones we filter out in
                                // `issue_id_for`. Degrade to "no live refresh"
                                // instead of surfacing a command error on every
                                // Trees mount; the worktree-status query's
                                // staleTime-0 refetch-on-remount still keeps data
                                // reasonably fresh without live watching.
                                log::warn!(
                                    "worktree file watch failed for {target:?}: {e}; \
                                     live change refresh disabled for this repo's worktrees \
                                     until restart"
                                );
                                newly_failed.push(target);
                                None
                            }
                        }
                    }
                    None => None,
                };

                let base_debouncer = if watch_base {
                    let mut b = new_debouncer(DEBOUNCE, None, move |res: DebounceEventResult| {
                        let Some(events) = batch("base repo", res) else {
                            return;
                        };
                        let changed = events
                            .iter()
                            .flat_map(|ev| ev.paths.iter())
                            .any(|path| is_base_change(&base_root, path));
                        if changed {
                            let _ = WorktreeChanged {
                                issue_id: BASE_ID.to_string(),
                            }
                            .emit(&app_base);
                        }
                    })?;
                    match b.watch(&base_watch_target, RecursiveMode::Recursive) {
                        Ok(()) => Some(b),
                        Err(e) => {
                            log::warn!(
                                "base repo file watch failed for {base_watch_target:?}: {e}; \
                                 the base worktree's Changes tab won't live-refresh until restart"
                            );
                            newly_failed.push(base_watch_target);
                            None
                        }
                    }
                } else {
                    None
                };

                Ok((worktrees_debouncer, base_debouncer, newly_failed))
            },
        )
        .await??;

        if !newly_failed.is_empty() {
            self.failed
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .extend(newly_failed);
        }

        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        // A newer `watch()` call raced ahead of this one and already stored its
        // own state (see the `generation` field doc) — leave it alone rather
        // than clobbering it with our now-stale result.
        if self.generation.load(Ordering::SeqCst) == my_gen {
            *guard = Some(Active {
                repo_root,
                worktrees_debouncer,
                base_debouncer,
            });
        }
        Ok(())
    }
}

/// Unwrap one debounce batch, logging what `notify` reports instead of dropping
/// it. Its errors are exactly the "the Changes tab stopped updating" causes —
/// an overflowed kernel event queue, or a watch invalidated because its
/// directory was moved/deleted — and they're otherwise invisible: the watcher
/// keeps running, just silently stops signalling.
pub fn batch(what: &str, res: DebounceEventResult) -> Option<Vec<DebouncedEvent>> {
    match res {
        Ok(events) => Some(events),
        Err(errors) => {
            for e in errors {
                log::warn!("{what} file watcher error: {e}; changes may stop live-refreshing");
            }
            None
        }
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
        if c.as_os_str()
            .to_str()
            .is_some_and(|s| SKIP_DIRS.contains(&s))
        {
            return None;
        }
    }
    Some(id)
}

/// True if `path` (an absolute path from the base-repo watcher) should count as
/// a change to the `BASE_ID` pseudo-worktree — i.e. not inside `.santree` (the
/// worktrees tree, already covered by the other debouncer) or one of the usual
/// VCS/build dirs.
fn is_base_change(root: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return false;
    };
    !rel.components().any(|c| {
        c.as_os_str()
            .to_str()
            .is_some_and(|s| s == ".santree" || SKIP_DIRS.contains(&s))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique scratch dir under the OS temp dir, cleaned before use. Mirrors
    /// `git.rs`'s test harness (this workspace doesn't depend on the
    /// `tempfile` crate).
    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "santree-git-watch-test-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

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

    /// Regression guard for #30: FSEvents/`notify` report change paths already
    /// resolved through symlinks, so an uncanonicalized watch root (the repo
    /// path as the frontend/DB stored it, before `watch()`'s canonicalize)
    /// never matches — the watcher would silently never fire for a repo opened
    /// via a symlinked path.
    #[test]
    #[cfg(unix)]
    fn canonicalizing_root_matches_resolved_event_paths() {
        // Canonicalize the scratch dir itself first: on macOS the default temp
        // dir sits under `/var`, itself a symlink to `/private/var`, so without
        // this the test's own "real" path wouldn't be in true canonical form —
        // independent of the `link-repo` symlink this test is actually about.
        let base = std::fs::canonicalize(scratch_dir("symlink-root")).unwrap();
        let real_worktrees = base.join("real").join(".santree").join("worktrees");
        std::fs::create_dir_all(&real_worktrees).unwrap();
        let link_repo = base.join("link-repo");
        std::os::unix::fs::symlink(base.join("real"), &link_repo).unwrap();

        // A repo registered via the symlinked path...
        let lexical_root = link_repo.join(".santree").join("worktrees");
        // ...but the OS reports change paths already resolved through the
        // symlink, under the *real* dir.
        let reported_event_path = real_worktrees.join("AK-1").join("src").join("main.rs");

        // Uncanonicalized: never matches (the bug).
        assert_eq!(issue_id_for(&lexical_root, &reported_event_path), None);

        // Canonicalized (what `watch()` now does before capturing the root):
        // matches correctly (the fix).
        let canonical_root = std::fs::canonicalize(&lexical_root).unwrap();
        assert_eq!(
            issue_id_for(&canonical_root, &reported_event_path).as_deref(),
            Some("AK-1")
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn is_base_change_skips_santree_and_vcs_dirs() {
        let root = Path::new("/repo");
        for p in [
            "/repo/.santree/worktrees/AK-1/src/main.rs",
            "/repo/.git/index",
            "/repo/node_modules/x/y.js",
            "/repo/target/debug/foo",
        ] {
            assert!(!is_base_change(root, Path::new(p)), "should skip {p}");
        }
    }

    #[test]
    fn is_base_change_fires_for_real_repo_edits() {
        let root = Path::new("/repo");
        for p in [
            "/repo/src/main.rs",
            "/repo/README.md",
            "/repo/crates/core/src/lib.rs",
        ] {
            assert!(is_base_change(root, Path::new(p)), "should fire for {p}");
        }
    }

    #[test]
    fn is_base_change_ignores_paths_outside_root() {
        let root = Path::new("/repo");
        assert!(!is_base_change(root, Path::new("/somewhere/else/file")));
    }

    /// `notify` reports a queue overflow / invalidated watch as an `Err` batch. It
    /// carries no events, so nothing is emitted either way — the point of routing
    /// it through [`batch`] is that it takes the logging path instead of being
    /// pattern-matched away.
    #[test]
    fn error_batches_are_routed_through_the_logging_path() {
        assert!(batch("test", Err(vec![notify::Error::generic("queue overflow")])).is_none());
        assert!(batch("test", Ok(Vec::new())).is_some());
    }
}
