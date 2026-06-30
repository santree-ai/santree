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
    if candidate
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_) | Component::RootDir))
    {
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
    let root = std::fs::canonicalize(cwd).map_err(|e| anyhow!("can't resolve worktree root: {e}"))?;
    // Canonicalize the target when it exists; otherwise resolve its parent so a
    // symlinked directory component is still caught for not-yet-created paths.
    let real = match std::fs::canonicalize(&joined) {
        Ok(p) => p,
        Err(_) => {
            let parent = joined.parent().unwrap_or(&joined);
            let real_parent =
                std::fs::canonicalize(parent).map_err(|e| anyhow!("can't resolve path '{rel}': {e}"))?;
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
    let target = std::fs::canonicalize(worktree_path).unwrap_or_else(|_| worktree_path.to_path_buf());
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
/// if the base is the branch checked out there, it's ff-merged; otherwise just
/// the ref is moved (which `fetch refspec` does, ff-only).
pub fn update_base(repo: &Path, base: &str) -> Result<()> {
    let (ok, _o, err) = git_capture(repo, &["fetch", "origin", base])?;
    if !ok {
        bail!("Couldn't fetch origin/{base}: {}", err.trim());
    }
    let checked_out = git(repo, &["symbolic-ref", "--short", "HEAD"]).ok();
    if checked_out.as_deref() == Some(base) {
        git(repo, &["merge", "--ff-only", &format!("origin/{base}")])?;
    } else {
        // Move the local ref to origin/<base>, ff-only (errors if it would rewind).
        git(repo, &["fetch", "origin", &format!("{base}:{base}")])?;
    }
    Ok(())
}

/// Whether the working tree has any uncommitted change (staged or not).
pub fn is_dirty(cwd: &Path) -> bool {
    git_output(cwd, &["status", "--porcelain"])
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

/// The working-tree status as a list of changed files (the commit box model).
/// Combines porcelain status (for state + staged flag) with `--numstat` line
/// counts; untracked files are counted by reading them.
pub fn status(cwd: &Path) -> Result<Vec<ChangedFile>> {
    let raw = git_output(cwd, &["status", "--porcelain=v1", "-z"])?;
    let parts: Vec<&str> = raw.split('\0').collect();
    let numstat = numstat(cwd)?;

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
/// from HEAD (staged + unstaged combined). Binary files report `-`/`-`.
///
/// Uses `--numstat -z` so renames key by their real (porcelain) path: without
/// `-z`, git emits a `{old => new}` arrow form for renames that never matches the
/// status path, so they'd show (0, 0). A map (not a Vec + linear scan) keeps the
/// per-file lookup in [`status`] O(1) instead of O(files²).
fn numstat(cwd: &Path) -> Result<HashMap<String, (u32, u32, bool)>> {
    let raw = git_output(cwd, &["diff", "HEAD", "--numstat", "-z"])?;
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

/// Additions / binary-ness of an untracked file. The binary check only needs the
/// first chunk, so a huge binary (image, build artifact) is detected without a
/// full read; a text file is then streamed for its line count without ever being
/// held wholly in memory.
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
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(m) => lines += buf[..m].iter().filter(|&&b| b == b'\n').count() as u32,
        }
    }
    (lines.max(1), 0, false)
}

/// A unified diff for a single file vs HEAD (staged + unstaged combined).
/// Untracked files are diffed against `/dev/null` so they render as all-adds.
pub fn file_diff(cwd: &Path, path: &str, untracked: bool) -> Result<String> {
    if untracked {
        // `--no-index` reads any path on disk, so resolve symlinks and confirm
        // containment before handing it the absolute path.
        let abs = safe_real_path(cwd, path)?;
        // `--no-index` exits 1 when the files differ — expected, so capture.
        let (_, stdout, _) =
            git_capture(cwd, &["diff", "--no-index", "--", "/dev/null", &abs.to_string_lossy()])?;
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
        &["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
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
