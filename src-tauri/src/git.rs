//! Low-level git operations, shelled out to the `git` binary (no third-party
//! crate — the same approach as [`crate::repo`] and the santree CLI).
//!
//! These are pure, DB-agnostic helpers keyed on a worktree/repo path. The
//! higher-level orchestration (DB links, setup scripts, agent launch) lives in
//! [`crate::worktree`]. Ported from the CLI's `source/lib/git.ts`.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, bail, Result};

use santree_core::domain::{ChangedFile, FileSource, FileStatus};

/// Resolve a frontend-supplied *relative* path against the worktree, refusing
/// anything that escapes it (absolute paths or `..` traversal). These paths
/// arrive over the IPC boundary, so even though only our own UI sends them today,
/// a value like `../../etc/passwd` must never reach `remove_file`/`read`.
///
/// This is a *lexical* check — enough for git ops, which confine themselves to
/// the worktree via `-C <cwd>` + `--` pathspecs regardless. Raw `std::fs` ops
/// must use [`safe_real_path`] instead (it also resolves symlinks).
fn safe_path(cwd: &Path, rel: &str) -> Result<PathBuf> {
    let candidate = Path::new(rel);
    if candidate.is_absolute() {
        bail!("path '{rel}' must be relative to the worktree");
    }
    if candidate.components().any(|c| {
        matches!(
            c,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir
        )
    }) {
        bail!("path '{rel}' must not escape the worktree");
    }
    Ok(cwd.join(candidate))
}

/// Like [`safe_path`] but also resolves symlinks and asserts the result stays
/// under the worktree root. Required before any raw `std::fs` read/delete: the
/// lexical check can't catch a symlink *inside* the worktree pointing out of it
/// (`subdir/link → /etc`), and these worktrees hold agent-written, untrusted code.
fn safe_real_path(cwd: &Path, rel: &str) -> Result<PathBuf> {
    let joined = safe_path(cwd, rel)?;
    let root =
        std::fs::canonicalize(cwd).map_err(|e| anyhow!("can't resolve worktree root: {e}"))?;
    // Canonicalize the target when it exists; otherwise resolve its parent so a
    // symlinked directory component is still caught for not-yet-created paths.
    let real = match std::fs::canonicalize(&joined) {
        Ok(p) => p,
        Err(_) => {
            let parent = joined.parent().unwrap_or(&joined);
            let real_parent = std::fs::canonicalize(parent)
                .map_err(|e| anyhow!("can't resolve path '{rel}': {e}"))?;
            match joined.file_name() {
                Some(name) => real_parent.join(name),
                None => real_parent,
            }
        }
    };
    if !real.starts_with(&root) {
        bail!("path '{rel}' escapes the worktree");
    }
    Ok(real)
}

/// Run `git -C <cwd> <args>`, returning trimmed stdout. Errors (with stderr) on
/// non-zero exit or if git can't be spawned.
pub fn git(cwd: &Path, args: &[&str]) -> Result<String> {
    let (ok, stdout, stderr) = git_capture(cwd, args)?;
    if !ok {
        bail!("git {}: {}", args.join(" "), stderr.trim());
    }
    Ok(stdout.trim().to_string())
}

/// Like [`git`] but returns raw stdout (no trimming) — for diffs and file blobs
/// where leading/trailing whitespace and newlines are significant.
pub fn git_output(cwd: &Path, args: &[&str]) -> Result<String> {
    let (ok, stdout, stderr) = git_capture(cwd, args)?;
    if !ok {
        bail!("git {}: {}", args.join(" "), stderr.trim());
    }
    Ok(stdout)
}

/// Run git and capture `(success, stdout, stderr)`. Only errors if the process
/// can't be spawned — a non-zero exit is reported via the bool, so callers can
/// handle commands that exit non-zero by design (e.g. `diff --no-index`).
fn git_capture(cwd: &Path, args: &[&str]) -> Result<(bool, String, String)> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|e| anyhow!("failed to run git: {e}"))?;
    Ok((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

/// The default branch for the repo's `origin` remote (e.g. `main`/`master`),
/// falling back to whichever of main/master exists, then to `main`.
pub fn default_branch(repo: &Path) -> String {
    if let Ok(r) = git(repo, &["symbolic-ref", "refs/remotes/origin/HEAD"]) {
        if let Some(b) = r.strip_prefix("refs/remotes/origin/") {
            return b.to_string();
        }
    }
    for b in ["main", "master"] {
        if git(repo, &["rev-parse", "--verify", &format!("refs/heads/{b}")]).is_ok() {
            return b.to_string();
        }
    }
    "main".to_string()
}

/// Whether a local branch already exists.
fn branch_exists(repo: &Path, branch: &str) -> bool {
    git(
        repo,
        &["rev-parse", "--verify", &format!("refs/heads/{branch}")],
    )
    .is_ok()
}

/// Create a git worktree at `worktree_path` checked out on `branch`.
///
/// Best-effort fetches `base` first so the new branch starts from the freshest
/// commit (preferring `origin/<base>` when it exists). If `branch` already
/// exists it's checked out as-is; otherwise it's created from the base.
pub fn create_worktree(repo: &Path, worktree_path: &Path, branch: &str, base: &str) -> Result<()> {
    if let Some(parent) = worktree_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if worktree_path.exists() {
        bail!("Worktree already exists at {}", worktree_path.display());
    }

    let path = worktree_path.to_string_lossy();
    if branch_exists(repo, branch) {
        git(repo, &["worktree", "add", &path, branch])?;
        return Ok(());
    }

    // Freshen the base, then branch from origin/<base> when available.
    let _ = git_capture(repo, &["fetch", "origin", base]);
    let origin_ref = format!("origin/{base}");
    let start = if git(repo, &["rev-parse", "--verify", &origin_ref]).is_ok() {
        origin_ref
    } else {
        base.to_string()
    };
    git(repo, &["worktree", "add", "-b", branch, &path, &start])?;
    Ok(())
}

/// Remove a worktree and delete its branch. Idempotent: the goal is simply that
/// the worktree no longer exist, so a half-removed worktree (e.g. a prior delete
/// interrupted by a hot-reload) cleans up cleanly instead of wedging forever.
///
/// `git worktree remove` is the clean path, but it fails outright when the
/// worktree is already partly gone — `fatal: '…' is not a working tree` once the
/// admin metadata or the dir's `.git` file is missing. We treat that as
/// non-fatal: drop the directory ourselves and `prune` git's stale bookkeeping so
/// the path is fully forgotten (and the id can be reused later). Branch deletion
/// is best-effort (it may be checked out elsewhere or already gone).
pub fn remove_worktree(repo: &Path, worktree_path: &Path, branch: &str) -> Result<()> {
    let path = worktree_path.to_string_lossy().into_owned();
    if git(repo, &["worktree", "remove", "--force", &path]).is_err() {
        // Half-removed (or never a real worktree): finish the job manually.
        if worktree_path.exists() {
            let _ = std::fs::remove_dir_all(worktree_path);
        }
        // Forget any orphaned admin entry so `<id>` is free to recreate.
        let _ = git(repo, &["worktree", "prune"]);
    } else if worktree_path.exists() {
        // Clean removal can still leave untracked files behind.
        let _ = std::fs::remove_dir_all(worktree_path);
    }
    let _ = git(repo, &["branch", "-D", branch]);
    Ok(())
}

/// The branch checked out at `worktree_path`, read from `git worktree list`.
/// Returns `None` when the path isn't a registered worktree (e.g. a stale dir).
/// Used to adopt worktrees the app didn't create (the CLI, a prior run).
pub fn worktree_branch(repo: &Path, worktree_path: &Path) -> Option<String> {
    let out = git_output(repo, &["worktree", "list", "--porcelain"]).ok()?;
    let target =
        std::fs::canonicalize(worktree_path).unwrap_or_else(|_| worktree_path.to_path_buf());
    let mut at_target = false;
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            let path = std::fs::canonicalize(p).unwrap_or_else(|_| std::path::PathBuf::from(p));
            at_target = path == target;
        } else if let Some(branch) = line.strip_prefix("branch refs/heads/") {
            if at_target {
                return Some(branch.to_string());
            }
        }
    }
    None
}

/// Count commits `branch` is ahead of `base` (`<base>..HEAD`). 0 on failure.
pub fn ahead(cwd: &Path, base: &str) -> u32 {
    git(cwd, &["rev-list", "--count", &format!("{base}..HEAD")])
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

/// Count commits HEAD is behind `origin/<base>` (`HEAD..origin/<base>`). 0 on
/// failure (e.g. no upstream).
pub fn behind(cwd: &Path, base: &str) -> u32 {
    git(
        cwd,
        &["rev-list", "--count", &format!("HEAD..origin/{base}")],
    )
    .ok()
    .and_then(|s| s.parse().ok())
    .unwrap_or(0)
}

/// Count commits on `branch` that aren't on its remote tracking branch yet —
/// i.e. what a `git push` would upload. When the branch has been pushed before,
/// that's `origin/<branch>..HEAD`; when it never has (no remote ref), every commit
/// the branch added over `base` is unpushed, so fall back to `ahead`. 0 on failure.
pub fn unpushed(cwd: &Path, branch: &str, base: &str) -> u32 {
    let origin_ref = format!("origin/{branch}");
    if git(cwd, &["rev-parse", "--verify", &origin_ref]).is_ok() {
        return git(
            cwd,
            &["rev-list", "--count", &format!("{origin_ref}..HEAD")],
        )
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    }
    ahead(cwd, base)
}

/// Merge the freshest base branch (`origin/<base>`, else local `<base>`) into the
/// worktree's branch — the Trees "pull from main/master" button. Best-effort
/// fetches first. On a conflicting (non-clean) merge it aborts and errors, so the
/// worktree is left untouched. Returns the resolved base ref that was merged.
pub fn pull_base(cwd: &Path, base: &str) -> Result<String> {
    let _ = git_capture(cwd, &["fetch", "origin", base]);
    let target = if git(cwd, &["rev-parse", "--verify", &format!("origin/{base}")]).is_ok() {
        format!("origin/{base}")
    } else {
        base.to_string()
    };
    let (ok, _out, err) = git_capture(cwd, &["merge", "--no-edit", &target])?;
    if !ok {
        // Roll back a started-but-conflicting merge so the tree stays clean.
        let _ = git_capture(cwd, &["merge", "--abort"]);
        bail!("Can't cleanly merge {target}: {}", err.trim());
    }
    Ok(target)
}

/// Fast-forward the *local* base branch (main/master) to `origin/<base>` — the
/// "update master" action. Since the base is never worked on directly, this is
/// expected to always be a clean fast-forward. Runs against the main repo dir:
/// if the base is the branch checked out there, a plain fetch + `merge
/// --ff-only` is required (git refuses to move the ref HEAD points at via a
/// fetch refspec); otherwise a single combined-refspec fetch ff-updates the
/// local ref directly, in one round-trip instead of two.
pub fn update_base(repo: &Path, base: &str) -> Result<()> {
    let checked_out = git(repo, &["symbolic-ref", "--short", "HEAD"]).ok();
    if checked_out.as_deref() == Some(base) {
        let (ok, _o, err) = git_capture(repo, &["fetch", "origin", base])?;
        if !ok {
            bail!("Couldn't fetch origin/{base}: {}", err.trim());
        }
        git(repo, &["merge", "--ff-only", &format!("origin/{base}")])?;
    } else {
        // Move the local ref to origin/<base>, ff-only (errors if it would rewind).
        let (ok, _o, err) =
            git_capture(repo, &["fetch", "origin", &format!("{base}:{base}")])?;
        if !ok {
            bail!("Couldn't fetch origin/{base}: {}", err.trim());
        }
    }
    Ok(())
}

/// Whether the working tree has any uncommitted change (staged or not).
pub fn is_dirty(cwd: &Path) -> bool {
    git_output(cwd, &["status", "--porcelain"])
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

/// Git's canonical empty-tree object hash (stable across every repo — it's the
/// hash of a tree with zero entries, not repo-specific data). Stands in for
/// `HEAD` when the repo has no commits yet: a freshly `git init`-ed repo is a
/// valid, connected repo per this app's validation (`rev-parse
/// --show-toplevel` succeeds with zero commits), and `git diff HEAD` errors
/// outright on that unborn HEAD.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// The working-tree status as a list of changed files (the commit box model).
/// Combines porcelain status (for state + staged flag) with `--numstat` line
/// counts; untracked files are counted by reading them.
pub fn status(cwd: &Path) -> Result<Vec<ChangedFile>> {
    let raw = git_output(cwd, &["status", "--porcelain=v1", "-z"])?;
    let parts: Vec<&str> = raw.split('\0').collect();
    // HEAD is unborn on a brand-new repo (no commits yet) — diff against the
    // empty tree instead so untracked/staged files still get counted rather
    // than the whole status call erroring out.
    let diff_base = if git(cwd, &["rev-parse", "--verify", "HEAD"]).is_ok() {
        "HEAD"
    } else {
        EMPTY_TREE
    };
    let numstat = numstat(cwd, diff_base)?;

    let mut files = Vec::new();
    let mut i = 0;
    while i < parts.len() {
        let rec = parts[i];
        if rec.len() < 3 {
            i += 1;
            continue;
        }
        let bytes = rec.as_bytes();
        let index = bytes[0] as char;
        let working = bytes[1] as char;
        let path = rec[3..].to_string();

        // Renames/copies are followed by a NUL-separated original path.
        let old_path = if matches!(index, 'R' | 'C') || matches!(working, 'R' | 'C') {
            i += 1;
            parts.get(i).map(|s| s.to_string())
        } else {
            None
        };

        let untracked = index == '?' && working == '?';
        let status = if untracked {
            FileStatus::Untracked
        } else if index == 'A' || working == 'A' {
            FileStatus::Added
        } else if index == 'D' || working == 'D' {
            FileStatus::Deleted
        } else if index == 'R' || working == 'R' {
            FileStatus::Renamed
        } else {
            FileStatus::Modified
        };
        // Staged = the index column holds a change (not space, not untracked).
        let staged = index != ' ' && index != '?';

        let (add_lines, del_lines, binary) = if untracked {
            count_new_file(cwd, &path)
        } else {
            numstat.get(&path).copied().unwrap_or((0, 0, false))
        };

        files.push(ChangedFile {
            path,
            old_path,
            status,
            staged,
            add_lines,
            del_lines,
            binary,
        });
        i += 1;
    }
    Ok(files)
}

/// Parse one `git diff --numstat` line into `(path, additions, deletions,
/// binary)`. Binary files report their counts as `-`.
pub fn parse_numstat_line(line: &str) -> Option<(String, u32, u32, bool)> {
    let mut cols = line.splitn(3, '\t');
    let a = cols.next()?;
    let d = cols.next()?;
    let path = cols.next()?.to_string();
    let binary = a == "-" || d == "-";
    Some((path, a.parse().unwrap_or(0), d.parse().unwrap_or(0), binary))
}

/// `path → (additions, deletions, binary)` for every tracked file that differs
/// from `diff_base` (staged + unstaged combined; `diff_base` is `HEAD`, or the
/// empty-tree hash when HEAD is unborn — see [`status`]). Binary files report
/// `-`/`-`.
///
/// Uses `--numstat -z` so renames key by their real (porcelain) path: without
/// `-z`, git emits a `{old => new}` arrow form for renames that never matches the
/// status path, so they'd show (0, 0). A map (not a Vec + linear scan) keeps the
/// per-file lookup in [`status`] O(1) instead of O(files²).
fn numstat(cwd: &Path, diff_base: &str) -> Result<HashMap<String, (u32, u32, bool)>> {
    let raw = git_output(cwd, &["diff", diff_base, "--numstat", "-z"])?;
    let mut map = HashMap::new();
    // With `-z`, each record is `add\tdel\tpath\0`; for a rename the path field is
    // empty and the old then new paths follow as two extra NUL-separated fields.
    let mut fields = raw.split('\0');
    while let Some(record) = fields.next() {
        if record.is_empty() {
            continue;
        }
        let mut cols = record.splitn(3, '\t');
        let (Some(a), Some(d), Some(rest)) = (cols.next(), cols.next(), cols.next()) else {
            continue;
        };
        let binary = a == "-" || d == "-";
        let entry = (a.parse().unwrap_or(0), d.parse().unwrap_or(0), binary);
        let path = if rest.is_empty() {
            // Rename: skip the old path, key by the new one (matches the status path).
            let _old = fields.next();
            match fields.next() {
                Some(new) => new.to_string(),
                None => break,
            }
        } else {
            rest.to_string()
        };
        map.insert(path, entry);
    }
    Ok(map)
}

/// Line-count cap for [`count_new_file`] — beyond this the exact count no
/// longer matters for a `+N` badge, so scanning stops and reports the cap.
const MAX_COUNTED_LINES: u32 = 10_000;

/// Byte cap for [`count_new_file`], guarding the pathological case of a huge
/// file with very few newlines (e.g. a multi-MB single-line minified bundle)
/// where the line cap alone would never kick in.
const MAX_SCANNED_BYTES: usize = 4 * 1024 * 1024;

/// Additions / binary-ness of an untracked file. The binary check only needs the
/// first chunk, so a huge binary (image, build artifact) is detected without a
/// full read; a text file is then streamed for its line count, capped at
/// [`MAX_COUNTED_LINES`]/[`MAX_SCANNED_BYTES`] so a large generated file (log,
/// dataset, lockfile) isn't read end-to-end on every `worktree_status` poll —
/// the file watcher's 400ms debounce would otherwise re-read it repeatedly just
/// to show a line-count badge.
fn count_new_file(cwd: &Path, path: &str) -> (u32, u32, bool) {
    use std::io::Read;
    let Ok(real) = safe_real_path(cwd, path) else {
        return (0, 0, false);
    };
    let Ok(file) = std::fs::File::open(real) else {
        return (0, 0, false);
    };
    let mut reader = std::io::BufReader::new(file);

    // A NUL byte in the first ~8 KB marks the file binary (git's own heuristic).
    let mut head = [0u8; 8192];
    let n = reader.read(&mut head).unwrap_or(0);
    if head[..n].contains(&0) {
        return (0, 0, true);
    }
    let mut lines = head[..n].iter().filter(|&&b| b == b'\n').count() as u32;
    let mut scanned = n;
    let mut buf = [0u8; 8192];
    while lines < MAX_COUNTED_LINES && scanned < MAX_SCANNED_BYTES {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(m) => {
                lines += buf[..m].iter().filter(|&&b| b == b'\n').count() as u32;
                scanned += m;
            }
        }
    }
    (lines.clamp(1, MAX_COUNTED_LINES), 0, false)
}

/// A unified diff for a single file vs HEAD (staged + unstaged combined).
/// Untracked files are diffed against `/dev/null` so they render as all-adds.
pub fn file_diff(cwd: &Path, path: &str, untracked: bool) -> Result<String> {
    if untracked {
        // `--no-index` reads any path on disk, so resolve symlinks and confirm
        // containment before handing it the absolute path.
        let abs = safe_real_path(cwd, path)?;
        // `--no-index` exits 1 when the files differ — expected, so capture.
        let (_, stdout, _) = git_capture(
            cwd,
            &[
                "diff",
                "--no-index",
                "--",
                "/dev/null",
                &abs.to_string_lossy(),
            ],
        )?;
        return Ok(stdout);
    }
    safe_path(cwd, path)?;
    git_output(cwd, &["diff", "HEAD", "--", path])
}

/// The old (HEAD) and new (working-tree) full contents of a file, for the diff
/// viewer's context expansion. Either side is empty when absent.
pub fn file_source(cwd: &Path, path: &str) -> Result<FileSource> {
    let new_text = std::fs::read_to_string(safe_real_path(cwd, path)?).unwrap_or_default();
    let old_text = git_output(cwd, &["show", &format!("HEAD:{path}")]).unwrap_or_default();
    Ok(FileSource { old_text, new_text })
}

/// Stage a single file (works for new, modified, deleted).
pub fn stage(cwd: &Path, path: &str) -> Result<()> {
    safe_path(cwd, path)?;
    git(cwd, &["add", "--", path]).map(|_| ())
}

/// Unstage a single file (leaves the working tree untouched).
pub fn unstage(cwd: &Path, path: &str) -> Result<()> {
    safe_path(cwd, path)?;
    git(cwd, &["restore", "--staged", "--", path]).map(|_| ())
}

/// Discard a file's uncommitted changes. Untracked files are deleted; tracked
/// files are restored from HEAD (both index and working tree).
pub fn discard(cwd: &Path, path: &str, untracked: bool) -> Result<()> {
    if untracked {
        std::fs::remove_file(safe_real_path(cwd, path)?)?;
        return Ok(());
    }
    safe_path(cwd, path)?;
    git(cwd, &["checkout", "HEAD", "--", path]).map(|_| ())
}

/// Stage every change (new, modified, deleted).
pub fn stage_all(cwd: &Path) -> Result<()> {
    git(cwd, &["add", "-A"]).map(|_| ())
}

/// Unstage everything (mixed reset; working tree untouched).
pub fn unstage_all(cwd: &Path) -> Result<()> {
    git(cwd, &["reset"]).map(|_| ())
}

/// Commit the staged index with `message`. Errors if nothing is staged.
pub fn commit(cwd: &Path, message: &str) -> Result<()> {
    git(cwd, &["commit", "-m", message]).map(|_| ())
}

/// The full staged diff, for AI commit-message generation.
pub fn staged_diff(cwd: &Path) -> String {
    git_output(cwd, &["diff", "--cached"]).unwrap_or_default()
}

/// Push `branch` to origin, setting upstream. Network op — slow / may fail.
pub fn push(cwd: &Path, branch: &str) -> Result<()> {
    git(cwd, &["push", "-u", "origin", branch]).map(|_| ())
}

/// Subject of the first commit on this branch since `base` — the natural PR
/// title. `None` when there are no commits ahead of `base`.
pub fn first_commit_subject(cwd: &Path, base: &str) -> Option<String> {
    let range = format!("{base}..HEAD");
    let out = git_output(cwd, &["log", &range, "--reverse", "--format=%s"]).ok()?;
    out.lines()
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// `git log base..HEAD` as a bullet list of subjects, for PR-body context.
pub fn commit_log(cwd: &Path, base: &str) -> String {
    let range = format!("{base}..HEAD");
    git_output(cwd, &["log", &range, "--format=- %s"]).unwrap_or_default()
}

/// `git diff base..HEAD --stat`, for PR-body context.
pub fn diff_stat(cwd: &Path, base: &str) -> String {
    let range = format!("{base}..HEAD");
    git_output(cwd, &["diff", &range, "--stat"]).unwrap_or_default()
}

/// Full `git diff base..HEAD`, for PR-body context (capped by the caller).
pub fn diff_range(cwd: &Path, base: &str) -> String {
    let range = format!("{base}..HEAD");
    git_output(cwd, &["diff", &range]).unwrap_or_default()
}

/// Every file in the worktree the user would browse — tracked plus untracked,
/// honouring `.gitignore`. Relative paths, sorted; the frontend builds the tree.
pub fn list_files(cwd: &Path) -> Result<Vec<String>> {
    let raw = git_output(
        cwd,
        &[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
    )?;
    let mut files: Vec<String> = raw
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    files.sort();
    files.dedup();
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique scratch dir under the OS temp dir, cleaned before use. Mirrors
    /// the ad-hoc temp-repo harness in `worktree.rs`'s test module (this
    /// workspace doesn't depend on the `tempfile` crate).
    fn scratch_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("santree-git-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn run_git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .current_dir(dir)
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?} failed");
    }

    // ---- safe_path (lexical traversal guard) ----

    #[test]
    fn safe_path_rejects_absolute() {
        let cwd = Path::new("/repo/worktree");
        assert!(safe_path(cwd, "/etc/passwd").is_err());
    }

    #[test]
    fn safe_path_rejects_parent_dir_traversal() {
        let cwd = Path::new("/repo/worktree");
        assert!(safe_path(cwd, "../x").is_err());
        assert!(safe_path(cwd, "a/../../x").is_err());
    }

    #[test]
    fn safe_path_accepts_normal_relative_path() {
        let cwd = Path::new("/repo/worktree");
        assert_eq!(
            safe_path(cwd, "sub/file.txt").unwrap(),
            cwd.join("sub/file.txt")
        );
    }

    // ---- safe_real_path (symlink-resolving containment check) ----

    #[test]
    #[cfg(unix)]
    fn safe_real_path_rejects_symlink_escape() {
        let base = scratch_dir("symlink-escape");
        let root = base.join("root");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();

        assert!(
            safe_real_path(&root, "link/file").is_err(),
            "a path through a symlink pointing outside root must be rejected"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn safe_real_path_accepts_nonexistent_nested_path() {
        let base = scratch_dir("nonexistent-nested");
        let root = base.join("root");
        std::fs::create_dir_all(root.join("sub")).unwrap();

        // `sub/new.txt` doesn't exist yet, but its parent does and resolves
        // inside root — this is the "not-yet-created file" branch.
        let real = safe_real_path(&root, "sub/new.txt").unwrap();
        assert!(!real.exists());
        assert!(real.starts_with(std::fs::canonicalize(&root).unwrap()));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    #[cfg(unix)]
    fn safe_real_path_rejects_symlinked_parent_dir_for_new_file() {
        let base = scratch_dir("symlink-parent");
        let root = base.join("root");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("evil-link-dir")).unwrap();

        assert!(
            safe_real_path(&root, "evil-link-dir/new.txt").is_err(),
            "a not-yet-created file whose parent dir is itself a symlink \
             escaping root must be rejected"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn safe_real_path_accepts_normal_nested_paths() {
        let base = scratch_dir("normal-nested");
        let root = base.join("root");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/file.txt"), "hi\n").unwrap();

        let real = safe_real_path(&root, "sub/file.txt").unwrap();
        assert_eq!(
            real,
            std::fs::canonicalize(root.join("sub/file.txt")).unwrap()
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    // ---- status()'s porcelain `-z` parsing (rename record consumption) ----

    /// A regression guard for the `i += 1` rename-record dance in `status()`:
    /// a staged rename is followed by an unrelated unstaged change, so an
    /// off-by-one in consuming the rename's extra NUL-delimited old-path field
    /// would desync the stream and corrupt (or swallow) the next record.
    #[test]
    fn status_handles_rename_without_desyncing_subsequent_records() {
        let base = scratch_dir("status-rename");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init", "-b", "main"]);
        run_git(&repo, &["config", "user.email", "t@t.test"]);
        run_git(&repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(repo.join("b.txt"), "hello\n").unwrap();
        run_git(&repo, &["add", "-A"]);
        run_git(&repo, &["commit", "-m", "init"]);

        // Stage a rename (content unchanged, so it's detected at 100% similarity)...
        run_git(&repo, &["mv", "a.txt", "a-renamed.txt"]);
        // ...plus an unrelated unstaged modification right after it.
        std::fs::write(repo.join("b.txt"), "hello\nworld\n").unwrap();

        let files = status(&repo).unwrap();

        let renamed = files
            .iter()
            .find(|f| f.status == FileStatus::Renamed)
            .expect("rename record present");
        assert_eq!(renamed.path, "a-renamed.txt");
        assert_eq!(renamed.old_path.as_deref(), Some("a.txt"));
        assert!(renamed.staged, "git mv stages the rename");

        let modified = files
            .iter()
            .find(|f| f.path == "b.txt")
            .expect("b.txt record wasn't swallowed by the rename's extra field");
        assert_eq!(modified.status, FileStatus::Modified);
        assert!(!modified.staged);
        assert_eq!(modified.old_path, None);
        assert_eq!(modified.add_lines, 1);
        assert_eq!(modified.del_lines, 0);

        let _ = std::fs::remove_dir_all(&base);
    }

    // ---- status() on an unborn HEAD (freshly `git init`-ed repo) ----

    /// A brand-new repo (zero commits) is a valid, connected repo per this
    /// app's validation (`rev-parse --show-toplevel` succeeds with no commits).
    /// `status()` used to propagate `git diff HEAD`'s failure on the unborn
    /// HEAD, erroring out the whole commit box instead of listing the
    /// untracked files a user adding their first commit needs to see.
    #[test]
    fn status_on_unborn_head_lists_untracked_files() {
        let base = scratch_dir("status-unborn-head-untracked");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init", "-b", "main"]);
        run_git(&repo, &["config", "user.email", "t@t.test"]);
        run_git(&repo, &["config", "user.name", "Test"]);

        std::fs::write(repo.join("new.txt"), "hello\nworld\n").unwrap();

        let files = status(&repo).expect("status() must not error on unborn HEAD");
        let f = files
            .iter()
            .find(|f| f.path == "new.txt")
            .expect("untracked file must be listed on unborn HEAD");
        assert_eq!(f.status, FileStatus::Untracked);
        assert!(!f.staged);
        assert_eq!(f.add_lines, 2);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// A staged file on an unborn HEAD diffs against the empty tree, so its
    /// line count is still reported correctly (not silently `0`).
    #[test]
    fn status_on_unborn_head_counts_staged_file_via_empty_tree_diff() {
        let base = scratch_dir("status-unborn-head-staged");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init", "-b", "main"]);
        run_git(&repo, &["config", "user.email", "t@t.test"]);
        run_git(&repo, &["config", "user.name", "Test"]);

        std::fs::write(repo.join("staged.txt"), "a\nb\nc\n").unwrap();
        run_git(&repo, &["add", "staged.txt"]);

        let files = status(&repo).expect("status() must not error on unborn HEAD");
        let f = files
            .iter()
            .find(|f| f.path == "staged.txt")
            .expect("staged file must be listed on unborn HEAD");
        assert_eq!(f.status, FileStatus::Added);
        assert!(f.staged);
        assert_eq!(f.add_lines, 3);
        assert_eq!(f.del_lines, 0);

        let _ = std::fs::remove_dir_all(&base);
    }

    // ---- count_new_file's NUL-byte binary heuristic ----

    #[test]
    fn count_new_file_detects_embedded_nul_as_binary() {
        let base = scratch_dir("count-new-file-binary");
        std::fs::write(base.join("bin.dat"), [b'h', b'i', 0u8, b'x']).unwrap();

        let (add, del, binary) = count_new_file(&base, "bin.dat");
        assert!(
            binary,
            "a NUL byte in the content must be detected as binary"
        );
        assert_eq!((add, del), (0, 0));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn count_new_file_counts_lines_for_text() {
        let base = scratch_dir("count-new-file-text");
        std::fs::write(base.join("text.txt"), "one\ntwo\nthree\n").unwrap();

        let (add, del, binary) = count_new_file(&base, "text.txt");
        assert!(!binary);
        assert_eq!(add, 3);
        assert_eq!(del, 0);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A large untracked file (log, dataset, lockfile) must not be read end to
    /// end just to count its lines — the count saturates at
    /// [`MAX_COUNTED_LINES`] instead of scanning the whole file.
    #[test]
    fn count_new_file_caps_line_count_for_huge_files() {
        let base = scratch_dir("count-new-file-cap");
        let content = "x\n".repeat(MAX_COUNTED_LINES as usize + 500);
        std::fs::write(base.join("huge.txt"), content).unwrap();

        let (add, del, binary) = count_new_file(&base, "huge.txt");
        assert!(!binary);
        assert_eq!(add, MAX_COUNTED_LINES, "line count must saturate at the cap");
        assert_eq!(del, 0);
        let _ = std::fs::remove_dir_all(&base);
    }

    // ---- parse_numstat_line ----

    #[test]
    fn parse_numstat_line_flags_binary_dash_counts() {
        let (path, add, del, binary) = parse_numstat_line("-\t-\tfoo.png").unwrap();
        assert_eq!(path, "foo.png");
        assert_eq!((add, del), (0, 0));
        assert!(binary);
    }

    #[test]
    fn parse_numstat_line_parses_normal_counts() {
        let (path, add, del, binary) = parse_numstat_line("12\t3\tfoo.rs").unwrap();
        assert_eq!(path, "foo.rs");
        assert_eq!(add, 12);
        assert_eq!(del, 3);
        assert!(!binary);
    }

    // ---- update_base ----

    /// Sets up a bare "origin" repo plus a `seed` clone (kept around so the
    /// test can push further commits to simulate someone else advancing the
    /// base) and a `repo` clone — the one `update_base` is exercised against.
    /// Returns `(origin, seed, repo)`.
    fn init_origin_seed_and_clone(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base = scratch_dir(name);
        let origin = base.join("origin.git");
        let seed = base.join("seed");
        let repo = base.join("repo");

        run_git(&base, &["init", "--bare", "-b", "main", "origin.git"]);

        std::fs::create_dir_all(&seed).unwrap();
        run_git(&seed, &["init", "-b", "main"]);
        run_git(&seed, &["config", "user.email", "t@t.test"]);
        run_git(&seed, &["config", "user.name", "Test"]);
        std::fs::write(seed.join("f.txt"), "v1\n").unwrap();
        run_git(&seed, &["add", "-A"]);
        run_git(&seed, &["commit", "-m", "init"]);
        run_git(&seed, &["remote", "add", "origin", origin.to_str().unwrap()]);
        run_git(&seed, &["push", "origin", "main"]);

        run_git(
            &base,
            &["clone", origin.to_str().unwrap(), repo.to_str().unwrap()],
        );
        run_git(&repo, &["config", "user.email", "t@t.test"]);
        run_git(&repo, &["config", "user.name", "Test"]);

        (origin, seed, repo)
    }

    /// Pushes a new commit to origin's `main` via the `seed` clone, simulating
    /// the base advancing upstream after `repo` was cloned.
    fn advance_origin_main(seed: &Path, content: &str) {
        std::fs::write(seed.join("f.txt"), content).unwrap();
        run_git(seed, &["add", "-A"]);
        run_git(seed, &["commit", "-m", "advance"]);
        run_git(seed, &["push", "origin", "main"]);
    }

    /// When `base` isn't the branch checked out in `repo`, `update_base` must
    /// fast-forward the local `refs/heads/<base>` ref directly (the combined
    /// `fetch origin base:base` refspec) rather than needing a separate merge.
    #[test]
    fn update_base_fast_forwards_local_ref_when_not_checked_out() {
        let (origin, seed, repo) = init_origin_seed_and_clone("update-base-not-checked-out");
        // Switch off `main` so it's not the checked-out branch — mirrors an
        // agent's worktree sitting on its own feature branch.
        run_git(&repo, &["checkout", "-b", "feature"]);

        advance_origin_main(&seed, "v2\n");

        update_base(&repo, "main").expect("update_base should succeed");

        let local_main = git(&repo, &["rev-parse", "refs/heads/main"]).unwrap();
        let origin_tip = git(&origin, &["rev-parse", "main"]).unwrap();
        assert_eq!(
            local_main, origin_tip,
            "local main ref must be fast-forwarded to origin's tip"
        );

        let _ = std::fs::remove_dir_all(seed.parent().unwrap());
    }

    /// When `base` IS the checked-out branch, a direct-ref fetch can't move it
    /// (git refuses to update the ref HEAD points at) — `update_base` must
    /// fall back to a plain fetch + `merge --ff-only`, updating the working
    /// tree too.
    #[test]
    fn update_base_ff_merges_when_base_is_checked_out() {
        let (origin, seed, repo) = init_origin_seed_and_clone("update-base-checked-out");
        // `clone` checks out `main` by default, so this is already the
        // "base is checked out" case.

        advance_origin_main(&seed, "v2\n");

        update_base(&repo, "main").expect("update_base should succeed");

        let content = std::fs::read_to_string(repo.join("f.txt")).unwrap();
        assert_eq!(
            content, "v2\n",
            "checked-out main's working tree must be ff-merged"
        );
        let local_head = git(&repo, &["rev-parse", "HEAD"]).unwrap();
        let origin_tip = git(&origin, &["rev-parse", "main"]).unwrap();
        assert_eq!(local_head, origin_tip);

        let _ = std::fs::remove_dir_all(seed.parent().unwrap());
    }
}
