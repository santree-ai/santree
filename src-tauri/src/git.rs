//! Low-level git operations, shelled out to the `git` binary (no third-party
//! crate — the same approach as [`crate::repo`] and the santree CLI).
//!
//! These are pure, DB-agnostic helpers keyed on a worktree/repo path. The
//! higher-level orchestration (DB links, setup scripts, agent launch) lives in
//! [`crate::worktree`]. Ported from the CLI's `source/lib/git.ts`.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};

use santree_core::domain::{ChangedFile, FileSource, FileStatus, RepoBranch};

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
/// under the worktree root. Required before any raw `std::fs` read: the lexical
/// check can't catch a symlink *inside* the worktree pointing out of it
/// (`subdir/link → /etc`), and these worktrees hold agent-written, untrusted code.
///
/// Resolving here and *using* the path at the sink is a TOCTOU window, so nothing
/// calls this directly — reads go through [`open_in_worktree`], which re-checks
/// the file it actually opened. Writes and deletes don't use it at all: they go
/// through `git`, which resolves paths itself and never follows a symlink out of
/// the worktree.
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

/// Open a worktree file for reading — the only way raw `std::fs` reads a path that
/// came over IPC.
///
/// Resolving a path and then opening it is inherently racy, and a worktree is the
/// one place in this app where a *hostile* process plausibly runs: the agent's own
/// code. It can swap a component for a symlink between [`safe_real_path`]'s
/// `canonicalize` and the `open`, redirecting the read out of the tree. std exposes
/// no fd-relative resolution (`openat`), so the resolution can't be made atomic —
/// instead the file we *did* open is checked against the one that was validated:
/// `fstat` on the descriptor must report the same inode on the same device as the
/// `lstat` taken immediately before. A path swapped after the check is a mismatch,
/// and is refused before a byte is read.
///
/// The pre-open `lstat` also rejects anything that isn't a regular file, so a FIFO
/// sitting where git reports an untracked file can't wedge us inside a blocking
/// `open(2)`. (One swapped *into* the check→open window still could — a local DoS on
/// the blocking pool by the agent's own code, but never an escape or a disclosure.)
fn open_in_worktree(cwd: &Path, rel: &str) -> Result<std::fs::File> {
    let real = safe_real_path(cwd, rel)?;
    let checked = std::fs::symlink_metadata(&real)?;
    if !checked.is_file() {
        bail!("path '{rel}' is not a regular file");
    }
    let file = std::fs::File::open(&real)?;
    let opened = file.metadata()?;
    if !opened.is_file() || !same_file(&checked, &opened) {
        bail!("path '{rel}' was replaced while it was being opened");
    }
    Ok(file)
}

/// Whether two `Metadata` describe the same filesystem object — the identity check
/// behind [`open_in_worktree`]'s post-open verification.
#[cfg(unix)]
fn same_file(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    (a.dev(), a.ino()) == (b.dev(), b.ino())
}

#[cfg(not(unix))]
fn same_file(_a: &std::fs::Metadata, _b: &std::fs::Metadata) -> bool {
    true
}

/// The full contents of a worktree file, read through [`open_in_worktree`].
fn read_in_worktree(cwd: &Path, rel: &str) -> Result<String> {
    use std::io::Read;
    let mut text = String::new();
    open_in_worktree(cwd, rel)?.read_to_string(&mut text)?;
    Ok(text)
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
    #[cfg(test)]
    count_git_call(cwd);
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        // Read-only commands (`status`, `diff`) opportunistically take
        // `.git/index.lock` to write back a refreshed index. That's a pure
        // optimization, but it makes every status poll a contender for the lock
        // that `add`/`restore`/`commit` *must* have — and this app polls status on
        // every filesystem burst while an agent writes. Opting out (what editors
        // and IDEs do) keeps the reads out of the fight entirely; commands whose
        // index write is required, not optional, are unaffected.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args(args)
        .output()
        .map_err(|e| anyhow!("failed to run git: {e}"))?;
    Ok((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

/// How long to keep retrying a command blocked on a `.git/index.lock` we don't
/// own, and how often to re-check. Bounded: a *stale* lock (a git that crashed
/// mid-write) never clears, and the user has to be told about that rather than
/// watch a click hang forever.
const INDEX_LOCK_WAIT: Duration = Duration::from_secs(2);
const INDEX_LOCK_POLL: Duration = Duration::from_millis(50);

/// Serialize the git commands that write a worktree's index, and ride out a lock
/// held by a git process we don't control.
///
/// Git has no wait-for-lock: a second `add`/`restore`/`commit` in the same worktree
/// fails outright ("Unable to create '…/index.lock': File exists") instead of
/// queueing. Two things race for that lock here. Our own commands — staging is one
/// command per file, and clicking several checkboxes in a row fires them
/// concurrently — which the mutex removes entirely. And the agent's CLI, which runs
/// git in these worktrees whenever it likes; nothing in this process can serialize
/// *that*, so the retry rides it out.
///
/// The mutex is deliberately held across the retry sleeps: while one santree
/// command waits for the worktree to free up, the rest should queue behind it
/// rather than pile onto the same contended lock.
///
/// Not reentrant (`std::sync::Mutex`) — a locked command must never call another
/// one. [`commit`] is why that matters: it stages and commits inside a *single*
/// lock rather than taking one per step, which is also what stops a staging click
/// from landing between the two.
fn with_index_lock<T>(cwd: &Path, mut run: impl FnMut() -> Result<T>) -> Result<T> {
    /// One entry per worktree path — bounded by the worktrees that exist on disk.
    /// Poison-tolerant, like the linear/pty/settings locks: the map holds only
    /// `Arc`s, so a thread that panicked mid-access left it structurally sound.
    static INDEX_LOCKS: LazyLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> =
        LazyLock::new(Default::default);

    let lock = INDEX_LOCKS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(cwd.to_path_buf())
        .or_default()
        .clone();
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());

    let deadline = Instant::now() + INDEX_LOCK_WAIT;
    loop {
        match run() {
            Err(e) if is_index_lock_contention(&e) && Instant::now() < deadline => {
                std::thread::sleep(INDEX_LOCK_POLL);
            }
            res => return res,
        }
    }
}

/// Run one index-writing git command under [`with_index_lock`]; otherwise [`git`].
fn git_indexed(cwd: &Path, args: &[&str]) -> Result<String> {
    with_index_lock(cwd, || git(cwd, args))
}

/// Whether a git failure is "someone else is holding `.git/index.lock`" — the one
/// error worth retrying. Both halves of git's message are required, so an unrelated
/// failure that merely names the lock path can't be mistaken for contention.
fn is_index_lock_contention(e: &anyhow::Error) -> bool {
    let msg = e.to_string();
    msg.contains("index.lock") && msg.contains("File exists")
}

/// A census of spawned `git` processes, keyed by the directory each ran in. The
/// worktree-status build runs on every filesystem-event burst (~400ms while an agent
/// writes), so its subprocess count per worktree is a load-bearing number — this is
/// what lets a test pin it down instead of trusting a reading of the code. Keyed by
/// cwd (not a bare counter) so tests, which share the process and run in parallel,
/// each count only the git runs under their own scratch repo.
#[cfg(test)]
static GIT_CALLS: LazyLock<Mutex<HashMap<PathBuf, u32>>> = LazyLock::new(Default::default);

#[cfg(test)]
fn count_git_call(cwd: &Path) {
    let mut calls = GIT_CALLS.lock().unwrap_or_else(|e| e.into_inner());
    *calls.entry(cwd.to_path_buf()).or_default() += 1;
}

/// How many `git` processes have been spawned in (or below) `prefix` so far.
#[cfg(test)]
pub(crate) fn git_calls_under(prefix: &Path) -> u32 {
    GIT_CALLS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter(|(dir, _)| dir.starts_with(prefix))
        .map(|(_, n)| n)
        .sum()
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

/// The freshest ref to branch from / merge in for `<base>`: `origin/<base>` when
/// it exists and the local branch hasn't got past it, else the local `<base>`.
///
/// The two kinds of base want opposite answers. For the repo's default branch the
/// remote is nearly always fresher — the app never checks `master` out, so its
/// local ref sits behind whatever `origin/master` has moved on to. For a *stacked*
/// base (a sibling worktree's branch, see `worktree::create`) the local ref is the
/// one being actively worked on, and preferring the remote would silently fork the
/// child off the parent's last *pushed* commit, dropping everything the parent has
/// committed but not pushed. "Does local already contain origin?" separates the two
/// without having to know which kind of base this is.
fn freshest_base(repo: &Path, base: &str) -> String {
    let origin_ref = format!("origin/{base}");
    if git(repo, &["rev-parse", "--verify", &origin_ref]).is_err() {
        return base.to_string();
    }
    if local_base_is_fresher(repo, base) {
        base.to_string()
    } else {
        origin_ref
    }
}

/// Whether the local `<base>` branch already contains `origin/<base>` — the test
/// that tells a stacked base from an upstream one without having to know which it
/// is (see [`freshest_base`]). A local ref that doesn't exist, or that sits behind
/// the remote, both fail the ancestry check, which is the answer callers want:
/// prefer `origin/<base>`. One process — an unresolvable ref makes `merge-base`
/// exit non-zero, so no separate existence check is needed.
fn local_base_is_fresher(repo: &Path, base: &str) -> bool {
    git(
        repo,
        &[
            "merge-base",
            "--is-ancestor",
            &format!("origin/{base}"),
            &format!("refs/heads/{base}"),
        ],
    )
    .is_ok()
}

/// The **common** git directory behind a checkout: `<repo>/.git` for a plain
/// clone, and the same `<repo>/.git` for every linked worktree branched off it.
///
/// A linked worktree's `.git` is a *file* holding `gitdir: <repo>/.git/worktrees/<id>`,
/// and that per-worktree directory's `commondir` points back at the shared one.
/// Everything git writes for a fetch, merge or rebase is under the answer:
/// `FETCH_HEAD` / `index` / `ORIG_HEAD` in the per-worktree directory, `objects/`
/// and `refs/` in the common one — and the common one contains the per-worktree
/// one, so a single path covers both.
///
/// Resolved by reading the two pointer files rather than by shelling out to
/// `git rev-parse --git-common-dir`: this runs on the session-launch path, where a
/// subprocess is the expensive part, and the layout is git's own on-disk contract.
/// Nothing here is assumed about *where* the pointers lead — an absolute `gitdir:`
/// and a relative `commondir` are both what git actually writes.
///
/// `None` on anything unexpected, and that matters more than usual: the caller
/// ([`crate::codex_config`]) uses this to *widen* an agent sandbox, so a wrong
/// answer is worse than no answer. The result must be an absolute, canonical path
/// that really is a git directory — it has `HEAD` and `objects/` — or nothing.
/// Absolute is also what keeps it from being read as a flag when it reaches argv.
pub fn common_git_dir(cwd: &Path) -> Option<PathBuf> {
    let dot_git = cwd.join(".git");
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else {
        let target = read_pointer_file(&dot_git)?;
        let target = target
            .lines()
            .find_map(|line| line.trim().strip_prefix("gitdir:"))?
            .trim();
        if target.is_empty() {
            return None;
        }
        // `join` on an absolute `target` discards `cwd`, which is exactly right:
        // git writes the link absolute here and relative-to-the-worktree elsewhere.
        cwd.join(target)
    };
    let common = match read_pointer_file(&git_dir.join("commondir")) {
        Some(rel) => {
            let rel = rel.trim();
            if rel.is_empty() {
                return None;
            }
            git_dir.join(rel)
        }
        // A plain clone's `.git` has no `commondir`: it is already the common one.
        None => git_dir,
    };
    let common = std::fs::canonicalize(common).ok()?;
    let is_git_dir = common.join("HEAD").is_file() && common.join("objects").is_dir();
    (common.is_absolute() && is_git_dir).then_some(common)
}

/// One of git's short on-disk pointer files (`.git`, `commondir`). Capped, because
/// a multi-megabyte file at either path is not a pointer whatever else it is, and
/// this runs before anything has established that the directory is a repo at all.
fn read_pointer_file(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > 4096 {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// Create a git worktree at `worktree_path` checked out on `branch`.
///
/// Best-effort fetches `base` first so the new branch starts from the freshest
/// commit ([`freshest_base`]). If `branch` already exists it's checked out as-is;
/// otherwise it's created from the base.
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

    // Freshen the base, then branch from whichever of local/origin is ahead.
    let _ = git_capture(repo, &["fetch", "origin", base]);
    let start = freshest_base(repo, base);
    git(repo, &["worktree", "add", "-b", branch, &path, &start])?;
    Ok(())
}

/// Add a worktree that checks out an **existing** branch — a PR's head branch —
/// fetching it from origin first. Unlike [`create_worktree`] (which branches *new*
/// work off a base), this puts the worktree on the branch itself, so commits made
/// in it land on that branch and update the PR. If the branch already exists
/// locally it's checked out directly; otherwise a local branch tracking
/// `origin/<branch>` is created. `branch` must be caller-validated (no leading `-`).
pub fn add_worktree_for_branch(repo: &Path, worktree_path: &Path, branch: &str) -> Result<()> {
    if let Some(parent) = worktree_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if worktree_path.exists() {
        bail!("Worktree already exists at {}", worktree_path.display());
    }
    let path = worktree_path.to_string_lossy();

    // Freshen the branch from origin so we check out its latest tip.
    let _ = git_capture(repo, &["fetch", "origin", branch]);

    if branch_exists(repo, branch) {
        git(repo, &["worktree", "add", &path, branch])?;
        return Ok(());
    }
    let origin_ref = format!("origin/{branch}");
    if git(repo, &["rev-parse", "--verify", &origin_ref]).is_ok() {
        // Remote-only branch (a PR whose branch we haven't checked out): create a
        // local branch tracking it so the worktree is on the PR's actual branch.
        git(
            repo,
            &[
                "worktree",
                "add",
                "--track",
                "-b",
                branch,
                &path,
                &origin_ref,
            ],
        )?;
        return Ok(());
    }
    bail!("branch '{branch}' not found locally or on origin (a fork PR?)");
}

/// Reject anything that isn't a legal branch name before it reaches a `git` argv.
///
/// Two separate hazards, one gate:
///
/// * **Flag injection.** Branch names are passed positionally (`worktree add -b
///   <branch>`, `fetch origin <branch>`), so a leading `-` would be read as an
///   option — `--upload-pack=<cmd>` is remote code execution on a fetch. Rejected
///   outright, exactly as [`safe_sha`] does for object ids.
/// * **Validity.** The Create-worktree dialog lets the user *type* a new branch
///   name, which is untrusted input that git itself would reject halfway through
///   the operation. These are `git check-ref-format`'s documented rules for
///   `refs/heads/<name>`, applied up front so the UI can disable the button
///   instead of letting the user click into a git error.
///
/// Every real branch satisfies this — git applied the same rules when it was
/// created — so it is also safe on names that came back from `git for-each-ref`.
pub fn safe_branch(name: &str) -> Result<&str> {
    let invalid = |why: &str| anyhow!("'{name}' is not a valid branch name ({why})");
    if name.is_empty() {
        return Err(invalid("empty"));
    }
    // Ours, not git's: a positional argument starting with a dash is a flag.
    if name.starts_with('-') {
        return Err(invalid("starts with '-'"));
    }
    if name.contains("..") || name.contains("@{") || name == "@" {
        return Err(invalid("reserved sequence"));
    }
    if name.chars().any(|c| {
        c.is_ascii_control()
            || matches!(c, ' ' | '~' | '^' | ':' | '?' | '*' | '[' | '\\' | '\u{7f}')
    }) {
        return Err(invalid("illegal character"));
    }
    if name.starts_with('/') || name.ends_with('/') || name.contains("//") {
        return Err(invalid("empty path component"));
    }
    if name.ends_with('.') {
        return Err(invalid("ends with '.'"));
    }
    for component in name.split('/') {
        if component.starts_with('.') || component.ends_with(".lock") {
            return Err(invalid("illegal path component"));
        }
    }
    Ok(name)
}

/// Reject anything that isn't a plain git object id before it reaches a `git`
/// argv.
///
/// The SHA arrives over IPC (it comes from the PR detail the webview holds), and
/// it's passed positionally to `worktree add` / `checkout` — so a value starting
/// with `-` would be read as a **flag**, not a commit. Hex-only closes that and
/// every other shape at once; the length band is git's own (a short SHA is at
/// least 4, a full one 40, and SHA-256 repos use 64).
pub(crate) fn safe_sha(sha: &str) -> Result<&str> {
    if !(4..=64).contains(&sha.len()) || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        bail!("'{sha}' is not a git object id");
    }
    Ok(sha)
}

/// The branch a pull request's worktree should land on, created locally when it
/// has to be.
///
/// A PR's checkout is an ordinary worktree now, so it needs an ordinary branch —
/// and which branch that is depends on where the PR's head lives:
///
///  - **Same repo.** `origin/<head_ref>` is the PR's head, so the worktree goes
///    on `head_ref` itself and a commit made in it pushes back to the PR. That is
///    the case worth having, and the reason this doesn't just always cut a local
///    branch.
///  - **A fork** (or a head that has moved on). `origin/<head_ref>` is absent or
///    points somewhere else, so `refs/pull/<number>/head` — which GitHub exposes
///    on the *base* repo for every PR, forks included — is fetched into a local
///    `santree/pr-<number>`.
///
/// The fork branch is santree-namespaced rather than named after the PR's own
/// branch, because a fork's head ref is routinely `main` or `patch-1`: creating a
/// local branch under that name would be checking out something that looks like
/// the repo's own trunk and isn't. Matching `origin/<head_ref>` by **commit** and
/// not by existence is the other half of that: a fork PR from a branch called
/// `main` must not resolve to the base repo's `main`.
pub fn pr_branch(repo: &Path, number: u32, head_ref: &str, head_sha: &str) -> Result<String> {
    let sha = safe_sha(head_sha)?;
    let head_ref = safe_branch(head_ref)?;

    // Best-effort: a branch that isn't on origin (the fork case) fails here, and
    // the comparison below is what decides, not this.
    let _ = git_capture(repo, &["fetch", "--no-tags", "origin", head_ref]);
    let origin_ref = format!("origin/{head_ref}");
    if let Ok(at) = git(
        repo,
        &["rev-parse", "--verify", &format!("{origin_ref}^{{commit}}")],
    ) {
        if at.trim() == sha {
            return Ok(head_ref.to_string());
        }
    }

    // The PR's head, wherever it lives. This ref exists on the base repo for every
    // PR, which is the whole reason a fork is reviewable at all.
    let pull_ref = format!("refs/pull/{number}/head");
    let fetched = git(repo, &["fetch", "--no-tags", "origin", &pull_ref]);
    if git(repo, &["cat-file", "-e", &format!("{sha}^{{commit}}")]).is_err() {
        let why = fetched
            .err()
            .map_or_else(|| "commit not found".into(), |e| e.to_string());
        bail!("couldn't fetch PR #{number} from origin: {why}");
    }

    let local = format!("santree/pr-{number}");
    // `-f` so a re-review after new commits moves the branch instead of failing.
    // Safe because the name is santree's own namespace, and because a branch that
    // is checked out somewhere is refused by git rather than silently reset.
    git(repo, &["branch", "-f", &local, sha])?;
    Ok(local)
}

/// Unregister one of the detached checkouts earlier versions kept under
/// `.santree/reviews/`.
///
/// Best-effort by design — it holds nothing the user authored (it was detached and
/// read-only), so a failure to remove it costs disk rather than correctness. No
/// branch to delete, unlike [`remove_worktree`]: those checkouts were on none.
///
/// Kept only for the one-time sweep in `reviews::sweep_legacy_checkouts`; nothing
/// creates such a checkout any more.
pub fn remove_legacy_review_checkout(repo: &Path, worktree_path: &Path) {
    let reviews_root = repo.join(".santree").join("reviews");
    let direct_child = worktree_path.parent() == Some(reviews_root.as_path())
        && worktree_path.file_name().is_some_and(|name| {
            let mut components = Path::new(name).components();
            matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
        });
    if !direct_child {
        log::error!(
            "refusing to remove review checkout outside {}: {}",
            reviews_root.display(),
            worktree_path.display()
        );
        return;
    }
    let path = worktree_path.to_string_lossy().into_owned();
    let _ = git(repo, &["worktree", "remove", "--force", &path]);
    if worktree_path.exists() {
        let _ = std::fs::remove_dir_all(worktree_path);
    }
    let _ = git(repo, &["worktree", "prune"]);
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

/// Every branch already checked out in one of the repo's worktrees — the main
/// checkout included.
///
/// Git allows exactly one checkout per branch, so this is precisely the set
/// `worktree add` would refuse. Read from git rather than from santree's own
/// `worktree_links` so a worktree the app didn't create still counts.
fn checked_out_branches(repo: &Path) -> HashSet<String> {
    let Ok(out) = git_output(repo, &["worktree", "list", "--porcelain"]) else {
        return HashSet::new();
    };
    out.lines()
        .filter_map(|l| l.strip_prefix("branch refs/heads/"))
        .map(str::to_string)
        .collect()
}

/// The repo's branches — every local one, plus the `origin/` branches that have
/// no local counterpart — newest commit first.
///
/// Remote-only branches are included because [`add_worktree_for_branch`] can
/// check one out (it creates a local tracking branch), which is what makes "the
/// branch a teammate pushed" reachable from the Create-worktree dialog without a
/// manual `git fetch` first.
pub fn branches(repo: &Path) -> Result<Vec<RepoBranch>> {
    let checked_out = checked_out_branches(repo);
    // One process for both namespaces. `%09` is a tab: a branch name can contain
    // almost anything except a control character, so it can't appear in the name
    // and the split is unambiguous.
    let out = git_output(
        repo,
        &[
            "for-each-ref",
            "--format=%(refname:short)%09%(committerdate:iso-strict)",
            "refs/heads",
            "refs/remotes/origin",
        ],
    )?;

    let mut locals: Vec<RepoBranch> = Vec::new();
    let mut remotes: Vec<RepoBranch> = Vec::new();
    for line in out.lines() {
        let (name, updated_at) = line.split_once('\t').unwrap_or((line, ""));
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        match name.strip_prefix("origin/") {
            // `origin/HEAD` is a symbolic alias for the default branch, not a
            // branch of its own — offering it would create a worktree on a ref
            // whose name means something else tomorrow.
            Some("HEAD") => continue,
            Some(short) => remotes.push(RepoBranch {
                name: short.to_string(),
                has_worktree: checked_out.contains(short),
                remote_only: true,
                updated_at: updated_at.to_string(),
            }),
            None => locals.push(RepoBranch {
                name: name.to_string(),
                has_worktree: checked_out.contains(name),
                remote_only: false,
                updated_at: updated_at.to_string(),
            }),
        }
    }

    let local_names: HashSet<&str> = locals.iter().map(|b| b.name.as_str()).collect();
    let mut all: Vec<RepoBranch> = remotes
        .iter()
        .filter(|b| !local_names.contains(b.name.as_str()))
        .cloned()
        .collect();
    all.extend(locals);
    // Newest first: a branch picker is nearly always reaching for recent work.
    // Name as the tiebreak so refs sharing a commit date keep a stable order.
    all.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(all)
}

/// The ref to log/diff a worktree branch against for PR-style "what this branch
/// adds" semantics. Prefers `origin/<base>` — the ref the worktree was actually
/// forked from (see [`create_worktree`]) — so a stale *local* `<base>` (a `master`
/// the app never checks out or pulls, sitting behind `origin/master`) doesn't fold
/// every unrelated upstream commit between the stale local ref and the fork point
/// into the branch's diff, stats, and PR title. Falls back to the local `<base>`
/// for stacked branches whose base is a sibling worktree branch with no remote.
pub(crate) fn compare_base(cwd: &Path, base: &str) -> String {
    let origin_ref = format!("origin/{base}");
    if git(cwd, &["rev-parse", "--verify", &origin_ref]).is_ok() {
        origin_ref
    } else {
        base.to_string()
    }
}

/// Best-effort, throttled `git fetch origin <branch>` so the branch's remote
/// tracking ref (and thus [`Stats::remote_behind`]) reflects commits added upstream —
/// PR-UI suggestions, "Update branch", a teammate's push. Nothing else in the app
/// fetches the worktree's own branch, so without this the ref stays stale and the
/// Pull button never lights up.
///
/// Throttled per worktree path because the worktree-status query refetches on
/// every filesystem change (the FS watcher invalidates it): an agent actively
/// writing files would otherwise trigger a fetch storm. Failures are swallowed
/// (offline, no remote) — a stale ref just means the Pull count lags, never an error.
pub fn refresh_remote_ref(cwd: &Path, branch: &str) {
    static LAST_FETCH: LazyLock<Mutex<HashMap<PathBuf, Instant>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    const THROTTLE: Duration = Duration::from_secs(20);

    {
        let mut last = LAST_FETCH.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        if let Some(&t) = last.get(cwd) {
            if now.duration_since(t) < THROTTLE {
                return;
            }
        }
        // Record before fetching so concurrent status builds for the same worktree
        // (spawned in parallel by `list`) don't all fire a redundant fetch.
        last.insert(cwd.to_path_buf(), now);
    }
    let _ = git_capture(cwd, &["fetch", "origin", branch]);
}

/// Every git stat the Trees sidebar shows for one worktree.
///
/// Gathered together, and deliberately so: the FS watcher invalidates the
/// worktree-status query on every ~400ms burst, so an agent writing files re-runs
/// this for every worktree, several times a second. Computed one stat at a time it
/// cost ~10 `git` processes each — including `rev-parse --verify origin/<base>`
/// spawned two or three times with the same answer. See [`stats`].
pub struct Stats {
    pub add_lines: u32,
    pub del_lines: u32,
    pub dirty: bool,
    pub ahead: u32,
    pub behind: u32,
    pub unpushed: u32,
    pub remote_behind: u32,
}

/// What kind of branch a worktree's base is, which decides whether the local ref or
/// `origin/<base>` is the authoritative tip to measure divergence against.
///
/// The caller knows this for free (a stacked worktree's base is another worktree's
/// branch, straight out of `worktree_links`), so [`stats`] never has to spend a git
/// process working it out — it runs on the app's hottest refresh path. See
/// [`freshest_base`] for the same distinction where it *does* have to be probed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BaseKind {
    /// The repo's default branch (main/master) — never checked out by the app, so
    /// its local ref lags and `origin/<base>` is the fresher one.
    Upstream,
    /// Another worktree's branch (a stacked worktree) — local is authoritative.
    LocalBranch,
}

/// Gather a worktree's stats in one pass. Purely local — [`refresh_remote_ref`] is
/// the (throttled) network half, called separately, so the paths that must not touch
/// the network don't.
///
/// * `ahead` / `behind` — against the ref the branch was forked from (per `kind`),
///   which is also the ref the "Pull from main" button merges.
/// * `unpushed` / `remote_behind` — against the branch's own tracking ref: what a
///   push would upload and what a pull would download. A branch that was never
///   pushed has no tracking ref, so everything it added over the base is unpushed.
pub fn stats(cwd: &Path, branch: &str, base: &str, kind: BaseKind) -> Stats {
    // One `for-each-ref` for both remote refs, rather than a `rev-parse --verify`
    // per lookup — the same two were resolved up to five times per build.
    let remotes = origin_refs(cwd, &[base, branch]);
    let published = |name: &str| remotes.iter().any(|r| r == name);

    // Which ref *is* the base right now, so the number we display agrees with what
    // Pull would actually merge (`freshest_base`). The caller says which kind of
    // base this is, because it can answer for free from the worktree list — asking
    // git would cost another fork+exec on the app's hottest path.
    let compare = match kind {
        // A sibling worktree's branch: the local ref is the one being worked on. It
        // advances on every parent pull/commit, long before any of that is pushed —
        // measuring against `origin/<parent>` would report the child up to date with
        // a parent that has moved on, and disable the Pull that would restack it.
        BaseKind::LocalBranch => base.to_string(),
        BaseKind::Upstream if published(base) => format!("origin/{base}"),
        BaseKind::Upstream => base.to_string(),
    };
    let (add_lines, del_lines) = numstat_totals(cwd, &compare);
    let (behind, ahead) = left_right(cwd, &compare, "HEAD");
    let (remote_behind, unpushed) = if published(branch) {
        left_right(cwd, &format!("origin/{branch}"), "HEAD")
    } else {
        (0, ahead)
    };

    Stats {
        add_lines,
        del_lines,
        dirty: is_dirty(cwd),
        ahead,
        behind,
        unpushed,
        remote_behind,
    }
}

/// Which of `names` exist as `origin/<name>`, resolved in a single `git` process.
/// `for-each-ref` takes several patterns at once and (unlike `rev-parse --verify`)
/// can't mistake a name for a flag, since each is embedded in a full `refs/…` path.
fn origin_refs(cwd: &Path, names: &[&str]) -> Vec<String> {
    let patterns: Vec<String> = names
        .iter()
        .map(|n| format!("refs/remotes/origin/{n}"))
        .collect();
    let mut args = vec!["for-each-ref", "--format=%(refname)"];
    args.extend(patterns.iter().map(String::as_str));
    let Ok(out) = git_output(cwd, &args) else {
        return Vec::new();
    };
    // A pattern also matches refs *below* it (`…/origin/main` matches `…/origin/main/x`),
    // so keep only the exact names we asked about.
    out.lines()
        .filter_map(|l| l.strip_prefix("refs/remotes/origin/"))
        .filter(|name| names.contains(name))
        .map(str::to_string)
        .collect()
}

/// Additions/deletions of the whole worktree — committed *and* uncommitted — against
/// its merge base with `base`, the way a PR shows them. `--merge-base` resolves the
/// fork point inside the same process, so this is one `git` call, not a `merge-base`
/// followed by a `diff`. `(0, 0)` when `base` can't be resolved.
fn numstat_totals(cwd: &Path, base: &str) -> (u32, u32) {
    let Ok(raw) = git_output(cwd, &["diff", "--merge-base", base, "--numstat"]) else {
        return (0, 0);
    };
    raw.lines()
        .filter_map(parse_numstat_line)
        .fold((0, 0), |(a, d), (_, add, del, _)| (a + add, d + del))
}

/// The two commit counts of the symmetric difference `a...b` — what each side has
/// that the other doesn't — in a single process instead of a `rev-list` per
/// direction. `(0, 0)` when either ref can't be resolved.
fn left_right(cwd: &Path, a: &str, b: &str) -> (u32, u32) {
    let Ok(out) = git(
        cwd,
        &["rev-list", "--left-right", "--count", &format!("{a}...{b}")],
    ) else {
        return (0, 0);
    };
    let mut counts = out.split_whitespace().map(|n| n.parse().unwrap_or(0));
    (counts.next().unwrap_or(0), counts.next().unwrap_or(0))
}

/// Whether merging `target` into HEAD would conflict — what disables the Pull button
/// up front. Memoized per worktree on the pair of commits the answer depends on: the
/// underlying [`merge_conflicts`] runs `merge-tree --write-tree`, which writes real
/// objects into the object database, and the status build that asks this re-runs on
/// every filesystem burst. Neither commit moves while an agent is merely *editing*
/// files, so the virtual merge now runs when one of them actually does.
pub fn would_conflict(cwd: &Path, target: &str) -> bool {
    /// Per worktree: the commit pair the last answer was computed for, and the answer.
    type Cache = Mutex<HashMap<PathBuf, ([String; 2], bool)>>;
    // One entry per worktree: the previous answer is only ever consulted for the same
    // (HEAD, target) pair, so a moved commit replaces it rather than growing the map.
    static CACHE: LazyLock<Cache> = LazyLock::new(Default::default);

    let Some(pair) = rev_pair(cwd, "HEAD", target) else {
        return false;
    };
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((cached, conflict)) = cache.get(cwd) {
        if *cached == pair {
            return *conflict;
        }
    }
    let conflict = merge_conflicts(cwd, target).is_some_and(|c| !c.is_empty());
    cache.insert(cwd.to_path_buf(), (pair, conflict));
    conflict
}

/// Resolve two revs to their commit oids in one process. `None` if either is missing.
fn rev_pair(cwd: &Path, a: &str, b: &str) -> Option<[String; 2]> {
    let out = git(cwd, &["rev-parse", a, b]).ok()?;
    let mut lines = out.lines();
    Some([lines.next()?.to_string(), lines.next()?.to_string()])
}

/// Merge the freshest base branch ([`freshest_base`]) into the worktree's branch —
/// the Trees "pull from main/master" button, and the restack for a worktree whose
/// base is a sibling branch. Best-effort fetches first. On a conflicting (non-clean)
/// merge it aborts and errors, so the worktree is left untouched. Returns the
/// resolved base ref that was merged.
pub fn pull_base(cwd: &Path, base: &str) -> Result<String> {
    let _ = git_capture(cwd, &["fetch", "origin", base]);
    let target = freshest_base(cwd, base);
    merge_checked(cwd, &target)?;
    Ok(target)
}

/// Conflicted paths that merging `target` into HEAD *would* produce, computed
/// WITHOUT touching the working tree via `git merge-tree --write-tree` — a virtual
/// in-memory merge (git ≥2.38). `Some(vec![])` = clean, `Some(paths)` = would
/// conflict, `None` = detection couldn't run (old git / error), so the caller
/// falls back to attempting a real merge.
///
/// On conflict, stdout is `<tree-oid>\n<conflicted paths…>\n\n<messages…>`, so the
/// files are the lines between the oid (line 1) and the first blank line.
pub fn merge_conflicts(cwd: &Path, target: &str) -> Option<Vec<String>> {
    let (ok, out, _err) = git_capture(
        cwd,
        &["merge-tree", "--write-tree", "--name-only", "HEAD", target],
    )
    .ok()?;
    if ok {
        return Some(Vec::new());
    }
    let files: Vec<String> = out
        .lines()
        .skip(1)
        .take_while(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    // Non-zero exit with no file list means a real error (bad args, unsupported
    // git), not a conflict — signal fallback rather than report a phantom result.
    if files.is_empty() {
        None
    } else {
        Some(files)
    }
}

/// Merge `target` into the current branch, but only if it applies cleanly.
/// Conflicts are detected UP FRONT with [`merge_conflicts`] (a virtual merge that
/// never touches the tree), so a conflicting pull is refused with a legible error
/// instead of dropping the branch into a half-merged, conflicted state the user
/// then has to `git merge --abort` out of. Shared by the pull actions.
fn merge_checked(cwd: &Path, target: &str) -> Result<()> {
    if let Some(conflicts) = merge_conflicts(cwd, target) {
        if !conflicts.is_empty() {
            bail!(
                "Merging {target} would conflict in {} — nothing was changed. Resolve it in the worktree (git merge {target}), then commit.",
                conflicts.join(", ")
            );
        }
    }
    // Clean per the virtual merge (or detection unavailable). The abort is a
    // safety net — normally unreachable after a clean pre-check. A merge writes
    // the index, so it queues with staging rather than racing it; the pre-check
    // and the network fetch above stay outside the lock (they don't need it, and
    // holding it across a fetch would stall the commit box for seconds).
    with_index_lock(cwd, || {
        let (ok, _out, err) = git_capture(cwd, &["merge", "--no-edit", target])?;
        if !ok {
            let _ = git_capture(cwd, &["merge", "--abort"]);
            bail!("Can't cleanly merge {target}: {}", err.trim());
        }
        Ok(())
    })
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
        git_indexed(repo, &["merge", "--ff-only", &format!("origin/{base}")])?;
    } else {
        // Move the local ref to origin/<base>, ff-only (errors if it would rewind).
        let (ok, _o, err) = git_capture(repo, &["fetch", "origin", &format!("{base}:{base}")])?;
        if !ok {
            bail!("Couldn't fetch origin/{base}: {}", err.trim());
        }
    }
    Ok(())
}

/// Integrate `origin/<branch>` into the worktree's own branch — the Trees "Pull"
/// button, for commits added to the branch remotely (PR-UI suggestions, GitHub's
/// "Update branch", a teammate's push). Fast-forwards when the local branch is
/// strictly behind (no merge commit — keeps history clean); when it has *diverged*
/// (local commits origin lacks, e.g. unpushed work plus a remote master-merge),
/// ff isn't possible, so it falls back to [`merge_checked`] — which refuses up
/// front (no working-tree touch) if the merge would conflict, exactly like
/// [`pull_base`].
pub fn pull_remote(cwd: &Path, branch: &str) -> Result<()> {
    let (ok, _o, err) = git_capture(cwd, &["fetch", "origin", branch])?;
    if !ok {
        bail!("Couldn't fetch origin/{branch}: {}", err.trim());
    }
    let origin_ref = format!("origin/{branch}");
    // Prefer a clean fast-forward; `--ff-only` fails without side effects (no
    // MERGE_HEAD, tree untouched) when the branch has diverged, so we can fall
    // through to a merge.
    if git_indexed(cwd, &["merge", "--ff-only", &origin_ref]).is_ok() {
        return Ok(());
    }
    merge_checked(cwd, &origin_ref)
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
    // `-uall` expands an untracked *directory* into its files. Without it git
    // collapses it to a single `?? dir/` record, which then reads as a file:
    // zero added lines, and an empty diff when the user clicks it.
    let raw = git_output(cwd, &["status", "--porcelain=v1", "-z", "-uall"])?;
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
fn parse_numstat_line(line: &str) -> Option<(String, u32, u32, bool)> {
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
    let raw = git_output(cwd, &["diff", diff_base, "--numstat", "-z", "--"])?;
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

/// Additions / binary-ness of an untracked file, counted the way `git diff`
/// counts them: one line per newline, plus a final unterminated line, and 0 for
/// an empty file. The binary check only needs the first chunk, so a huge binary
/// (image, build artifact) is detected without a full read; a text file is then
/// streamed for its line count, capped at [`MAX_COUNTED_LINES`]/
/// [`MAX_SCANNED_BYTES`] so a large generated file (log, dataset, lockfile)
/// isn't read end-to-end on every `worktree_status` poll — the file watcher's
/// 400ms debounce would otherwise re-read it repeatedly just to show a
/// line-count badge.
fn count_new_file(cwd: &Path, path: &str) -> (u32, u32, bool) {
    use std::io::Read;
    let Ok(file) = open_in_worktree(cwd, path) else {
        return (0, 0, false);
    };
    let mut reader = std::io::BufReader::new(file);

    let mut buf = [0u8; 8192];
    let mut lines: u32 = 0;
    let mut scanned = 0usize;
    let mut last = b'\n';
    let mut at_eof = false;
    while lines < MAX_COUNTED_LINES && scanned < MAX_SCANNED_BYTES {
        let n = match reader.read(&mut buf) {
            Ok(0) => {
                at_eof = true;
                break;
            }
            Ok(n) => n,
            Err(_) => break,
        };
        // A NUL byte in the first chunk marks the file binary (git's own heuristic).
        if scanned == 0 && buf[..n].contains(&0) {
            return (0, 0, true);
        }
        lines += buf[..n].iter().filter(|&&b| b == b'\n').count() as u32;
        scanned += n;
        last = buf[n - 1];
    }
    // A trailing line with no newline still counts as an addition (git shows it
    // with "\ No newline at end of file"); an empty file has none at all.
    if at_eof && last != b'\n' {
        lines += 1;
    }
    (lines.min(MAX_COUNTED_LINES), 0, false)
}

/// A unified diff for a single file vs HEAD (staged + unstaged combined).
/// Untracked files are diffed against `/dev/null` so they render as all-adds.
pub fn file_diff(cwd: &Path, path: &str, untracked: bool) -> Result<String> {
    if untracked {
        // `--no-index` reads any path on disk, so resolve symlinks and confirm
        // containment before handing it the absolute path.
        //
        // This is a check-then-use: git re-resolves the string, so a leaf swapped to a
        // symlink after the check is read as its 120000 *target path* (harmless), but a
        // swapped intermediate *directory* component would be followed to a file
        // outside the worktree and its contents shown in the diff. Unlike the delete in
        // `discard` (a destructive out-of-tree write, closed by routing through git) or
        // the reads in `open_in_worktree` (an fstat recheck), this residual isn't a
        // privilege gain: the only actor who can win the race is the agent whose code
        // runs in this worktree, and it can already read any file the user can. Closing
        // it would mean passing git a verified fd (`/dev/fd/N`) — which needs the fd to
        // survive the `exec` — for no security the attacker doesn't already have.
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
    let new_text = read_in_worktree(cwd, path).unwrap_or_default();
    let old_text = git_output(cwd, &["show", &format!("HEAD:{path}")]).unwrap_or_default();
    Ok(FileSource { old_text, new_text })
}

/// Stage a single file (works for new, modified, deleted).
pub fn stage(cwd: &Path, path: &str) -> Result<()> {
    safe_path(cwd, path)?;
    git_indexed(cwd, &["add", "--", path]).map(|_| ())
}

/// Unstage a single file (leaves the working tree untouched).
pub fn unstage(cwd: &Path, path: &str) -> Result<()> {
    safe_path(cwd, path)?;
    git_indexed(cwd, &["restore", "--staged", "--", path]).map(|_| ())
}

/// Auto-unstage every file that was staged and then modified again on disk, so a
/// re-edit forces the user to re-review it before it can be committed. Returns
/// the paths it unstaged (empty when nothing qualified).
///
/// Why this is load-bearing, not cosmetic: [`commit`] runs a whole-index
/// `git commit`, so a file left staged after a further edit would silently commit
/// the *older* snapshot captured at stage time and drop the newer changes. Fired
/// off the worktree file-watcher on every disk change (see `git_watch.rs`).
///
/// A file qualifies when porcelain shows a real change in *both* columns — the
/// index column holds a staged change (not space/untracked) and the worktree
/// column is also dirty — i.e. `MM`, `AM`, `MD`, …. Whole-file, matching how the
/// commit box stages.
pub fn reconcile_staged(cwd: &Path) -> Result<Vec<String>> {
    let raw = git_output(cwd, &["status", "--porcelain=v1", "-z", "-uall"])?;
    let parts: Vec<&str> = raw.split('\0').collect();

    let mut dirtied = Vec::new();
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
        // A rename/copy record carries a NUL-separated original path in the next
        // field — step over it so the following record isn't misread as one
        // (mirrors the `i += 1` dance in `status`).
        if matches!(index, 'R' | 'C') || matches!(working, 'R' | 'C') {
            i += 1;
        }
        // Staged in the index AND changed again in the worktree since staging.
        let staged = index != ' ' && index != '?';
        let working_dirty = working != ' ' && working != '?';
        if staged && working_dirty {
            dirtied.push(rec[3..].to_string());
        }
        i += 1;
    }

    if dirtied.is_empty() {
        return Ok(dirtied);
    }
    // Under the index lock so it serialises with the user's own stage/commit
    // clicks on this worktree rather than colliding on `.git/index.lock`. The
    // paths are git's own porcelain output (repo-internal, never IPC) and `--`
    // guards against any leading-dash pathspec.
    let mut args = vec!["restore", "--staged", "--"];
    args.extend(dirtied.iter().map(String::as_str));
    git_indexed(cwd, &args)?;
    Ok(dirtied)
}

/// Discard a file's uncommitted changes. Untracked files are deleted; tracked
/// files are restored from HEAD (both index and working tree).
///
/// The untracked delete is `git clean`, not `remove_file`: git resolves the pathspec
/// itself and never follows a symlink out of the worktree — it won't descend through
/// a symlinked directory component, and it unlinks a symlinked leaf rather than its
/// target. `remove_file` had to be handed an already-resolved absolute path, which an
/// agent writing in the worktree could invalidate between the check and the `unlink`.
pub fn discard(cwd: &Path, path: &str, untracked: bool) -> Result<()> {
    safe_path(cwd, path)?;
    if untracked {
        return git_indexed(cwd, &["clean", "--force", "--", path]).map(|_| ());
    }
    git_indexed(cwd, &["checkout", "HEAD", "--", path]).map(|_| ())
}

/// Stage every change (new, modified, deleted).
pub fn stage_all(cwd: &Path) -> Result<()> {
    git_indexed(cwd, &["add", "-A"]).map(|_| ())
}

/// Unstage everything (mixed reset; working tree untouched).
pub fn unstage_all(cwd: &Path) -> Result<()> {
    git_indexed(cwd, &["reset"]).map(|_| ())
}

/// Commit the index with `message`, optionally staging everything first. Errors if
/// nothing is staged.
///
/// The two steps share one lock rather than taking one each: between a separate
/// `stage_all` and `commit`, a staging click could land and be committed silently —
/// the commit would then contain something other than what the user had selected.
pub fn commit(cwd: &Path, message: &str, stage_all: bool) -> Result<()> {
    with_index_lock(cwd, || {
        if stage_all {
            git(cwd, &["add", "-A"])?;
        }
        git(cwd, &["commit", "-m", message])
    })
    .map(|_| ())
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
    let base = compare_base(cwd, base);
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
    let base = compare_base(cwd, base);
    let range = format!("{base}..HEAD");
    git_output(cwd, &["log", &range, "--format=- %s"]).unwrap_or_default()
}

/// `git diff base...HEAD --stat`, for PR-body context. Three-dot (merge-base) diff
/// so it shows only the branch's own changes, never a net-diff against an upstream
/// `base` that advanced past the fork point.
pub fn diff_stat(cwd: &Path, base: &str) -> String {
    let base = compare_base(cwd, base);
    let range = format!("{base}...HEAD");
    git_output(cwd, &["diff", &range, "--stat"]).unwrap_or_default()
}

/// Full `git diff base...HEAD`, for PR-body context (capped by the caller).
/// Three-dot (merge-base) diff — see [`diff_stat`].
pub fn diff_range(cwd: &Path, base: &str) -> String {
    let base = compare_base(cwd, base);
    let range = format!("{base}...HEAD");
    git_output(cwd, &["diff", &range]).unwrap_or_default()
}

/// The files a branch has committed relative to its base — `git diff
/// <base>...HEAD` as a `--name-status` list with `--numstat` line counts folded
/// in. Three-dot (merge-base), like [`diff_stat`], so an upstream `base` that
/// advanced past the fork point contributes nothing. `staged` is always false:
/// these are commits, not index state. Sorted by path.
///
/// Rename detection is left to git's default (`diff.renames`) on both calls, the
/// same setting [`status`]'s porcelain follows, so the two listings agree.
pub fn branch_changes(cwd: &Path, base: &str) -> Result<Vec<ChangedFile>> {
    let base = compare_base(cwd, base);
    let range = format!("{base}...HEAD");
    // `--` after the range: a file named like `main...HEAD` must stay a path.
    let raw = git_output(cwd, &["diff", &range, "--name-status", "-z", "--"])?;
    let counts = numstat(cwd, &range)?;

    let mut files = Vec::new();
    // With `-z`, each record is `<status>\0<path>\0`; a rename/copy carries a
    // similarity score on the status (`R100`) and the old then new paths.
    let mut fields = raw.split('\0');
    while let Some(record) = fields.next() {
        if record.is_empty() {
            continue;
        }
        let Some(first) = fields.next() else {
            break;
        };
        let letter = record.chars().next().unwrap_or('M');
        let (status, old_path, path) = match letter {
            'R' | 'C' => {
                let Some(new) = fields.next() else {
                    break;
                };
                let status = if letter == 'R' {
                    FileStatus::Renamed
                } else {
                    FileStatus::Added
                };
                (status, Some(first.to_string()), new.to_string())
            }
            'A' => (FileStatus::Added, None, first.to_string()),
            'D' => (FileStatus::Deleted, None, first.to_string()),
            _ => (FileStatus::Modified, None, first.to_string()),
        };
        let (add_lines, del_lines, binary) = counts.get(&path).copied().unwrap_or((0, 0, false));
        files.push(ChangedFile {
            path,
            old_path,
            status,
            staged: false,
            add_lines,
            del_lines,
            binary,
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// A unified diff of one file's committed changes on the branch — `git diff
/// <base>...HEAD -- <path>` (the diff a [`branch_changes`] row opens). Empty
/// when the branch didn't touch the file.
pub fn branch_file_diff(cwd: &Path, base: &str, path: &str) -> Result<String> {
    safe_path(cwd, path)?;
    // A leading `:` is pathspec magic (`:/`, `:(glob)`, `:!`), never a file the
    // panel listed; and the path is passed as a literal so `*`/`?` in a real
    // filename can't widen the diff to whatever they'd match.
    if path.starts_with(':') {
        bail!("path '{path}' must not start with ':'");
    }
    let base = compare_base(cwd, base);
    let range = format!("{base}...HEAD");
    let literal = format!(":(literal){path}");
    git_output(cwd, &["diff", &range, "--", &literal])
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

    #[test]
    fn safe_sha_accepts_real_object_ids() {
        assert!(safe_sha("a1b2c3d").is_ok());
        assert!(safe_sha(&"0".repeat(40)).is_ok());
        // SHA-256 repos.
        assert!(safe_sha(&"f".repeat(64)).is_ok());
    }

    #[test]
    fn safe_sha_rejects_anything_that_could_be_read_as_a_flag() {
        // The SHA is passed positionally to `worktree add` / `checkout`, so a
        // leading dash is flag injection, not a bad commit.
        assert!(safe_sha("--force").is_err());
        assert!(safe_sha("-abc123").is_err());
        assert!(safe_sha("HEAD").is_err());
        assert!(safe_sha("main").is_err());
        assert!(safe_sha("a1b2c3d; rm -rf /").is_err());
        assert!(safe_sha("").is_err());
        assert!(safe_sha("abc").is_err());
        assert!(safe_sha(&"a".repeat(65)).is_err());
    }

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

    // ---- safe_branch (flag injection + git's own ref rules) ----

    #[test]
    fn safe_branch_accepts_real_branch_names() {
        for name in [
            "main",
            "feature/AK-1-do-a-thing",
            "santree/ak-165-fix",
            "release-2.0",
            "user@host",
            "a.b.c",
        ] {
            assert!(safe_branch(name).is_ok(), "{name} should be valid");
        }
    }

    #[test]
    fn safe_branch_rejects_flag_injection() {
        // The branch is passed positionally to `worktree add -b`/`fetch origin`,
        // so a leading dash is an option, not a ref — `--upload-pack=<cmd>` on a
        // fetch is remote code execution.
        assert!(safe_branch("--upload-pack=/bin/sh").is_err());
        assert!(safe_branch("-b").is_err());
        assert!(safe_branch("-").is_err());
    }

    #[test]
    fn safe_branch_rejects_what_check_ref_format_rejects() {
        for name in [
            "",     // empty
            "a..b", // double dot
            "a b",  // space
            "a~b",  // ~ ^ : ? * [ \\ are all reserved
            "a^b",
            "a:b",
            "a?b",
            "a*b",
            "a[b",
            "a\\b",
            "feat/@{now}", // @{ sequence
            "@",           // the single-character @
            ".hidden",     // component starting with a dot
            "feat/.hidden",
            "feat.lock", // component ending in .lock
            "feat/x.lock",
            "/leading",
            "trailing/",
            "double//slash",
            "ends.with.dot.",
            "new\nline", // control character
        ] {
            assert!(safe_branch(name).is_err(), "{name:?} should be rejected");
        }
    }

    /// The invariant the picker depends on: a branch git already holds in a
    /// worktree is flagged, because `worktree add` would refuse a second one.
    #[test]
    fn branches_flag_the_ones_already_checked_out() {
        let base = scratch_dir("branches");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init", "-b", "main"]);
        run_git(&repo, &["config", "user.email", "t@t.test"]);
        run_git(&repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("README.md"), "hi\n").unwrap();
        run_git(&repo, &["add", "-A"]);
        run_git(&repo, &["commit", "-m", "init"]);
        run_git(&repo, &["branch", "spare"]);
        run_git(&repo, &["branch", "taken"]);
        let wt = base.join("wt");
        run_git(
            &repo,
            &["worktree", "add", wt.to_string_lossy().as_ref(), "taken"],
        );

        let listed = branches(&repo).unwrap();
        let by_name = |n: &str| listed.iter().find(|b| b.name == n).cloned();

        // `main` is the repo's own checkout — also a worktree, also unavailable.
        assert!(by_name("main").unwrap().has_worktree);
        assert!(by_name("taken").unwrap().has_worktree);
        assert!(!by_name("spare").unwrap().has_worktree);
        assert!(!by_name("spare").unwrap().remote_only);
        assert!(
            listed.iter().all(|b| !b.updated_at.is_empty()),
            "every row carries a real committer date"
        );
        let _ = std::fs::remove_dir_all(&base);
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

    /// A PR's worktree id becomes a path component and a positional `git`
    /// argument elsewhere in this codebase, so `review-` plus a length-prefixed
    /// slug has to stay one safe component whatever the owner/name look like.
    #[test]
    fn a_review_worktree_id_is_a_safe_path_component() {
        let cwd = Path::new("/repo/worktree");
        for (owner, name, number) in [
            ("acme", "web", 7u32),
            ("a-b", "c", 1),
            ("Acme", "kubernetes", 50868),
            // A hyphen-heavy slug is where a naive prefix test breaks; the id
            // still has to stay one component.
            ("canary-technologies-corp", "canary", 50868),
        ] {
            let id = crate::reviews::review_worktree_id(owner, name, number).unwrap();
            assert!(!id.starts_with('-'), "{id} would be read as a flag");
            assert_eq!(
                safe_path(cwd, &id).unwrap(),
                cwd.join(&id),
                "{id} must join as a single normal component"
            );
            // The one name a PR's checkout has, on both sides of the bridge:
            // exactly what the frontend's `reviewTreeId` mints.
            assert_eq!(
                id,
                format!(
                    "review-{}-{owner}-{}-{name}-{number}",
                    owner.len(),
                    name.len()
                )
            );
        }
    }

    #[test]
    fn review_removal_refuses_paths_outside_its_checkout_root() {
        let base = std::env::temp_dir().join(format!(
            "santree-review-remove-boundary-{}",
            std::process::id()
        ));
        let repo = base.join("repo");
        let outside = base.join("victim");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("keep"), "safe").unwrap();

        remove_legacy_review_checkout(&repo, &outside);

        assert!(outside.join("keep").is_file());
        let _ = std::fs::remove_dir_all(&base);
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

    // ---- branch_changes() / branch_file_diff() (committed diff vs the base) ----

    /// A repo on `main` with a `feature` branch that adds, modifies, deletes,
    /// renames and adds-a-binary in one commit — then `main` moves on, so the
    /// three-dot semantics (upstream commits past the fork point are not the
    /// branch's) are exercised too.
    fn branch_fixture(name: &str) -> (PathBuf, PathBuf) {
        let base = scratch_dir(name);
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init", "-b", "main"]);
        run_git(&repo, &["config", "user.email", "t@t.test"]);
        run_git(&repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(repo.join("c.txt"), "gone\n").unwrap();
        std::fs::write(repo.join("d.txt"), "x\ny\n").unwrap();
        run_git(&repo, &["add", "-A"]);
        run_git(&repo, &["commit", "-m", "init"]);

        run_git(&repo, &["checkout", "-b", "feature"]);
        std::fs::write(repo.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::remove_file(repo.join("c.txt")).unwrap();
        run_git(&repo, &["mv", "d.txt", "d-renamed.txt"]);
        std::fs::write(repo.join("new.txt"), "n1\nn2\n").unwrap();
        std::fs::write(repo.join("bin.dat"), b"\x00\x01\x02binary\n").unwrap();
        run_git(&repo, &["add", "-A"]);
        run_git(&repo, &["commit", "-m", "feature work"]);

        // Upstream advances after the fork point: not part of the branch's diff.
        run_git(&repo, &["checkout", "main"]);
        std::fs::write(repo.join("upstream.txt"), "later\n").unwrap();
        run_git(&repo, &["add", "-A"]);
        run_git(&repo, &["commit", "-m", "upstream"]);
        run_git(&repo, &["checkout", "feature"]);
        (base, repo)
    }

    #[test]
    fn branch_changes_lists_committed_files_with_statuses_and_counts() {
        let (base, repo) = branch_fixture("branch-changes");

        let files = branch_changes(&repo, "main").unwrap();
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            ["a.txt", "bin.dat", "c.txt", "d-renamed.txt", "new.txt"],
            "path-sorted, and main's later commit is not the branch's"
        );
        assert!(
            files.iter().all(|f| !f.staged),
            "commits are never 'staged'"
        );

        let by = |p: &str| files.iter().find(|f| f.path == p).unwrap();
        let a = by("a.txt");
        assert_eq!(a.status, FileStatus::Modified);
        assert_eq!((a.add_lines, a.del_lines, a.binary), (1, 0, false));
        assert_eq!(a.old_path, None);

        let bin = by("bin.dat");
        assert_eq!(bin.status, FileStatus::Added);
        assert!(bin.binary, "numstat's `-` marks it binary");
        assert_eq!((bin.add_lines, bin.del_lines), (0, 0));

        let c = by("c.txt");
        assert_eq!(c.status, FileStatus::Deleted);
        assert_eq!((c.add_lines, c.del_lines), (0, 1));

        let d = by("d-renamed.txt");
        assert_eq!(d.status, FileStatus::Renamed);
        assert_eq!(d.old_path.as_deref(), Some("d.txt"));
        assert_eq!((d.add_lines, d.del_lines), (0, 0));

        let n = by("new.txt");
        assert_eq!(n.status, FileStatus::Added);
        assert_eq!((n.add_lines, n.del_lines), (2, 0));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn branch_file_diff_shows_one_files_committed_hunks_and_guards_the_path() {
        let (base, repo) = branch_fixture("branch-file-diff");

        let diff = branch_file_diff(&repo, "main", "a.txt").unwrap();
        assert!(diff.contains("+three"), "the branch's own change: {diff}");
        assert!(
            !diff.contains("upstream"),
            "main's later commit is excluded"
        );
        assert_eq!(
            branch_file_diff(&repo, "main", "upstream.txt").unwrap(),
            "",
            "a file the branch never touched diffs to nothing"
        );
        assert!(branch_file_diff(&repo, "main", "../a.txt").is_err());
        assert!(branch_file_diff(&repo, "main", "/etc/passwd").is_err());
        assert!(
            branch_file_diff(&repo, "main", ":/a.txt").is_err(),
            "pathspec magic is refused"
        );
        assert_eq!(
            branch_file_diff(&repo, "main", "*.txt").unwrap(),
            "",
            "a glob is a literal filename, not a pattern"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    // ---- reconcile_staged() (auto-unstage on re-edit) ----

    /// The core guarantee: a file staged and then edited again on disk is
    /// unstaged, so the stale staged snapshot can't be committed. Also asserts
    /// the working-tree content is preserved (only the index is touched) and
    /// that a cleanly-staged file is left alone.
    #[test]
    fn reconcile_staged_unstages_only_files_edited_after_staging() {
        let base = scratch_dir("reconcile-staged");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init", "-b", "main"]);
        run_git(&repo, &["config", "user.email", "t@t.test"]);
        run_git(&repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        std::fs::write(repo.join("b.txt"), "keep\n").unwrap();
        run_git(&repo, &["add", "-A"]);
        run_git(&repo, &["commit", "-m", "init"]);

        // Stage an edit to a.txt, and stage b.txt's edit but leave it clean.
        std::fs::write(repo.join("a.txt"), "two\n").unwrap();
        std::fs::write(repo.join("b.txt"), "edited\n").unwrap();
        run_git(&repo, &["add", "a.txt", "b.txt"]);

        // Nothing edited-after-staging yet: reconcile is a no-op.
        assert!(reconcile_staged(&repo).unwrap().is_empty());

        // Now edit a.txt *again* on disk (porcelain `MM`); b.txt stays `M `.
        std::fs::write(repo.join("a.txt"), "three\n").unwrap();

        let unstaged = reconcile_staged(&repo).unwrap();
        assert_eq!(
            unstaged,
            vec!["a.txt".to_string()],
            "only the re-edited file"
        );

        let files = status(&repo).unwrap();
        let a = files.iter().find(|f| f.path == "a.txt").unwrap();
        assert!(!a.staged, "a.txt is unstaged after being re-edited");
        let b = files.iter().find(|f| f.path == "b.txt").unwrap();
        assert!(b.staged, "cleanly-staged b.txt is untouched");

        // The working tree (the latest edit) is preserved — only the index moved.
        assert_eq!(
            std::fs::read_to_string(repo.join("a.txt")).unwrap(),
            "three\n"
        );

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

    // ---- the per-worktree index lock ----

    /// Staging is one `git add`/`git restore` per file, and ticking several
    /// checkboxes in a row fires them at once. Git doesn't queue on
    /// `.git/index.lock` — the losers die with "Unable to create …index.lock:
    /// File exists" — so without [`with_index_lock`] a fast burst surfaced as a
    /// row of red toasts *and* left the index disagreeing with the checkboxes.
    #[test]
    fn concurrent_staging_serializes_instead_of_failing_on_index_lock() {
        let base = scratch_dir("index-lock-burst");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init", "-b", "main"]);
        run_git(&repo, &["config", "user.email", "t@t.test"]);
        run_git(&repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("seed.txt"), "seed\n").unwrap();
        run_git(&repo, &["add", "-A"]);
        run_git(&repo, &["commit", "-m", "init"]);

        const FILES: usize = 12;
        for i in 0..FILES {
            std::fs::write(repo.join(format!("f{i}.txt")), format!("line {i}\n")).unwrap();
        }

        // Every file staged from its own thread, as concurrently as the OS allows.
        let failures: Vec<String> = std::thread::scope(|s| {
            let handles: Vec<_> = (0..FILES)
                .map(|i| {
                    let repo = &repo;
                    s.spawn(move || {
                        stage(repo, &format!("f{i}.txt"))
                            .err()
                            .map(|e| e.to_string())
                    })
                })
                .collect();
            handles
                .into_iter()
                .filter_map(|h| h.join().unwrap())
                .collect()
        });
        assert!(
            failures.is_empty(),
            "concurrent staging must not fail on index.lock: {failures:?}"
        );

        // ...and the index must agree with what was asked for, not just "no error".
        let staged: Vec<_> = status(&repo)
            .unwrap()
            .into_iter()
            .filter(|f| f.staged)
            .map(|f| f.path)
            .collect();
        assert_eq!(staged.len(), FILES, "every file must be staged: {staged:?}");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The retry is for locks held by a git process we *don't* own (the agent's CLI
    /// runs git in these worktrees freely), so it's exercised with a real leftover
    /// `index.lock` rather than a second santree call — which the mutex would have
    /// serialized before it ever reached git.
    #[test]
    fn staging_waits_out_a_lock_held_by_another_process() {
        let base = scratch_dir("index-lock-foreign");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init", "-b", "main"]);
        run_git(&repo, &["config", "user.email", "t@t.test"]);
        run_git(&repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("a.txt"), "a\n").unwrap();

        let lock = repo.join(".git/index.lock");
        std::fs::write(&lock, "").unwrap();
        // Released well inside INDEX_LOCK_WAIT, the way a foreign git finishing its
        // own write would release it.
        let releaser = {
            let lock = lock.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(250));
                std::fs::remove_file(&lock).unwrap();
            })
        };

        stage(&repo, "a.txt").expect("staging must ride out a foreign index.lock");
        releaser.join().unwrap();

        // And a lock that never clears still errors rather than hanging the click.
        std::fs::write(&lock, "").unwrap();
        let err = stage(&repo, "a.txt").expect_err("a stale lock must surface, not hang");
        assert!(
            is_index_lock_contention(&err),
            "the give-up error should still name the lock: {err}"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Without `-uall`, git collapses an untracked directory into one `?? dir/`
    /// record — which reads as a file with 0 added lines and (on click) an empty
    /// diff, because there's no such file to open or diff.
    #[test]
    fn status_expands_untracked_directories_into_files() {
        let base = scratch_dir("status-untracked-dir");
        let repo = base.join("repo");
        std::fs::create_dir_all(repo.join("newdir/nested")).unwrap();
        run_git(&repo, &["init", "-b", "main"]);
        run_git(&repo, &["config", "user.email", "t@t.test"]);
        run_git(&repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("newdir/a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(repo.join("newdir/nested/b.txt"), "solo\n").unwrap();

        let files = status(&repo).unwrap();
        let mut paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        paths.sort_unstable();
        assert_eq!(paths, ["newdir/a.txt", "newdir/nested/b.txt"]);
        assert!(files.iter().all(|f| f.status == FileStatus::Untracked));
        let a = files.iter().find(|f| f.path == "newdir/a.txt").unwrap();
        assert_eq!(a.add_lines, 2, "the file's real line count, not 0");

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

    /// `git diff` reports 0 additions for an empty file and counts a final line
    /// that has no trailing newline ("\ No newline at end of file") — the badge
    /// must say the same thing.
    #[test]
    fn count_new_file_matches_git_for_empty_and_unterminated_files() {
        let base = scratch_dir("count-new-file-edges");
        std::fs::write(base.join("empty.txt"), "").unwrap();
        std::fs::write(base.join("no-newline.txt"), "one\ntwo").unwrap();

        assert_eq!(count_new_file(&base, "empty.txt"), (0, 0, false));
        assert_eq!(count_new_file(&base, "no-newline.txt"), (2, 0, false));
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
        assert_eq!(
            add, MAX_COUNTED_LINES,
            "line count must saturate at the cap"
        );
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

    // ---- create_worktree start point ----

    /// A worktree stacked on a sibling branch must start from that branch's *local*
    /// tip. The parent is a branch someone is actively working in, so its unpushed
    /// commits are exactly the code the child is being started to build on —
    /// preferring `origin/<parent>` (right for a stale local `master`) would fork
    /// the child off the parent's last *pushed* commit and silently lose them.
    #[test]
    fn create_worktree_stacks_on_the_parent_branch_local_tip() {
        let (_origin, seed, repo) = init_origin_seed_and_clone("stacked-base");

        // The parent worktree: pushed once (it has a PR), then committed to again.
        let parent = repo.join(".santree/worktrees/AK-274");
        create_worktree(&repo, &parent, "santree/ak-274", "main").unwrap();
        std::fs::write(parent.join("p.txt"), "pushed\n").unwrap();
        run_git(&parent, &["add", "-A"]);
        run_git(&parent, &["commit", "-m", "pushed work"]);
        run_git(&parent, &["push", "-u", "origin", "santree/ak-274"]);
        std::fs::write(parent.join("p.txt"), "unpushed\n").unwrap();
        run_git(&parent, &["add", "-A"]);
        run_git(&parent, &["commit", "-m", "unpushed work"]);

        let child = repo.join(".santree/worktrees/AK-275");
        create_worktree(&repo, &child, "santree/ak-275", "santree/ak-274").unwrap();

        let parent_tip = git(&repo, &["rev-parse", "refs/heads/santree/ak-274"]).unwrap();
        let child_head = git(&child, &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(
            child_head, parent_tip,
            "child must fork from the parent's local tip, not its pushed one"
        );
        assert_eq!(
            std::fs::read_to_string(child.join("p.txt")).unwrap(),
            "unpushed\n"
        );

        let _ = std::fs::remove_dir_all(seed.parent().unwrap());
    }

    /// A stacked child's divergence must be measured against its parent's **local**
    /// tip. Pulling master into the parent advances only the local branch — its
    /// `origin/<parent>` ref doesn't move until a push — so comparing against the
    /// remote leaves the child reporting "up to date" with a parent that has moved
    /// on, and its Pull button disabled with no way to restack.
    #[test]
    fn stats_measure_a_stacked_child_against_the_parent_local_tip() {
        let (_origin, seed, repo) = init_origin_seed_and_clone("stacked-stats");

        // Parent worktree, pushed (so `origin/santree/ak-274` exists — it has a PR).
        let parent = repo.join(".santree/worktrees/AK-274");
        create_worktree(&repo, &parent, "santree/ak-274", "main").unwrap();
        std::fs::write(parent.join("p.txt"), "pushed\n").unwrap();
        run_git(&parent, &["add", "-A"]);
        run_git(&parent, &["commit", "-m", "pushed work"]);
        run_git(&parent, &["push", "-u", "origin", "santree/ak-274"]);

        // Child stacked on the parent, in sync at this point.
        let child = repo.join(".santree/worktrees/AK-275");
        create_worktree(&repo, &child, "santree/ak-275", "santree/ak-274").unwrap();
        assert_eq!(
            stats(
                &child,
                "santree/ak-275",
                "santree/ak-274",
                BaseKind::LocalBranch
            )
            .behind,
            0,
            "freshly stacked child starts level with its parent"
        );

        // The parent moves on locally only — exactly what "pull master into the
        // parent" does. Nothing is pushed, so origin/santree/ak-274 stays put.
        std::fs::write(parent.join("p.txt"), "local only\n").unwrap();
        run_git(&parent, &["add", "-A"]);
        run_git(&parent, &["commit", "-m", "merged master locally"]);

        assert_eq!(
            stats(
                &child,
                "santree/ak-275",
                "santree/ak-274",
                BaseKind::LocalBranch
            )
            .behind,
            1,
            "child must see the parent's unpushed advance, so it can restack"
        );

        let _ = std::fs::remove_dir_all(seed.parent().unwrap());
    }

    /// The stacked case above must not cost the default branch its remote-first
    /// start point: a local `master` the app never checks out sits behind
    /// `origin/master`, and branching from it would fork the worktree off a stale
    /// commit (and fold every upstream commit since into its diff).
    #[test]
    fn create_worktree_starts_from_origin_when_the_local_base_is_stale() {
        let (origin, seed, repo) = init_origin_seed_and_clone("stale-local-base");
        advance_origin_main(&seed, "v2\n");

        let wt = repo.join(".santree/worktrees/AK-1");
        create_worktree(&repo, &wt, "santree/ak-1", "main").unwrap();

        let origin_tip = git(&origin, &["rev-parse", "main"]).unwrap();
        let head = git(&wt, &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(
            head, origin_tip,
            "must fork from origin/main, not stale local"
        );

        let _ = std::fs::remove_dir_all(seed.parent().unwrap());
    }

    // ---- common_git_dir (the writable root a sandboxed agent's git needs) ----

    /// A one-commit repo with a linked worktree beside it, the shape every
    /// santree worktree has. Returns `(repo, worktree)`.
    fn init_repo_with_linked_worktree(name: &str) -> (PathBuf, PathBuf) {
        let base = scratch_dir(name);
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init", "-b", "main"]);
        run_git(&repo, &["config", "user.email", "t@t.test"]);
        run_git(&repo, &["config", "user.name", "Test"]);
        run_git(&repo, &["commit", "--allow-empty", "-m", "init"]);

        let worktree = base.join("wt");
        run_git(
            &repo,
            &["worktree", "add", worktree.to_str().unwrap(), "-b", "feat"],
        );
        (repo, worktree)
    }

    #[test]
    fn common_git_dir_of_a_linked_worktree_is_the_main_repos() {
        let (repo, worktree) = init_repo_with_linked_worktree("common-dir-linked");
        assert!(
            worktree.join(".git").is_file(),
            "a linked worktree's .git is a pointer file, not a directory"
        );

        let expected = std::fs::canonicalize(repo.join(".git")).unwrap();
        assert_eq!(common_git_dir(&worktree).as_deref(), Some(&*expected));
        // The per-worktree metadata a fetch/rebase writes sits under it, so the
        // one root covers both halves.
        assert!(expected.join("worktrees/wt").is_dir());

        let _ = std::fs::remove_dir_all(repo.parent().unwrap());
    }

    #[test]
    fn common_git_dir_of_a_plain_checkout_is_its_own_git_dir() {
        let (repo, _worktree) = init_repo_with_linked_worktree("common-dir-plain");
        let expected = std::fs::canonicalize(repo.join(".git")).unwrap();
        assert_eq!(common_git_dir(&repo).as_deref(), Some(&*expected));
        let _ = std::fs::remove_dir_all(repo.parent().unwrap());
    }

    /// The failure mode that matters: the answer widens a sandbox, so anything
    /// unreadable, unparseable, or not actually a git directory must come back
    /// `None` — never a broader root, and never a panic.
    #[test]
    fn common_git_dir_degrades_to_none_rather_than_to_a_broader_root() {
        let dir = scratch_dir("common-dir-degrade");
        assert_eq!(common_git_dir(&dir), None, "no .git at all");

        let dot_git = dir.join(".git");
        for bogus in [
            "",
            "not a gitdir line\n",
            "gitdir:\n",
            // A pointer at a real directory that is not a git directory: the
            // shape that would otherwise hand an agent a writable `/` or `$HOME`.
            "gitdir: /\n",
            "gitdir: ../\n",
        ] {
            std::fs::write(&dot_git, bogus).unwrap();
            assert_eq!(common_git_dir(&dir), None, "{bogus:?}");
        }

        // A pointer at nothing at all, and one too large to be a pointer.
        std::fs::write(&dot_git, "gitdir: ./nowhere\n").unwrap();
        assert_eq!(common_git_dir(&dir), None);
        std::fs::write(&dot_git, "x".repeat(8192)).unwrap();
        assert_eq!(common_git_dir(&dir), None);

        let _ = std::fs::remove_dir_all(&dir);
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
        run_git(
            &seed,
            &["remote", "add", "origin", origin.to_str().unwrap()],
        );
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

    // ---- pull_remote / remote_behind ----

    /// Puts `repo` on a feature branch pushed to origin, then advances that same
    /// branch on origin via `seed` (simulating a PR-UI commit / teammate push).
    /// Returns `(origin, seed, repo)` with `repo`'s tracking ref intentionally
    /// stale — the caller decides when to fetch.
    fn init_diverged_feature(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let (origin, seed, repo) = init_origin_seed_and_clone(name);
        // repo starts a feature branch and publishes it.
        run_git(&repo, &["checkout", "-b", "feature"]);
        std::fs::write(repo.join("f.txt"), "local\n").unwrap();
        run_git(&repo, &["add", "-A"]);
        run_git(&repo, &["commit", "-m", "feature c1"]);
        run_git(&repo, &["push", "-u", "origin", "feature"]);
        // seed picks up the branch and advances it on origin.
        run_git(&seed, &["fetch", "origin", "feature"]);
        run_git(&seed, &["checkout", "-b", "feature", "origin/feature"]);
        std::fs::write(seed.join("f.txt"), "remote-edit\n").unwrap();
        run_git(&seed, &["add", "-A"]);
        run_git(&seed, &["commit", "-m", "PR-UI suggestion"]);
        run_git(&seed, &["push", "origin", "feature"]);
        (origin, seed, repo)
    }

    /// `pull_remote` fast-forwards the worktree's own branch to origin/<branch>,
    /// pulling in a commit added to the branch remotely.
    #[test]
    fn pull_remote_fast_forwards_branch_from_origin() {
        let (origin, seed, repo) = init_diverged_feature("pull-remote-ff");

        pull_remote(&repo, "feature").expect("pull_remote should ff cleanly");

        let content = std::fs::read_to_string(repo.join("f.txt")).unwrap();
        assert_eq!(
            content, "remote-edit\n",
            "working tree must reflect the remote commit"
        );
        let local_head = git(&repo, &["rev-parse", "HEAD"]).unwrap();
        let origin_tip = git(&origin, &["rev-parse", "feature"]).unwrap();
        assert_eq!(
            local_head, origin_tip,
            "local branch must match origin's feature tip"
        );

        let _ = std::fs::remove_dir_all(seed.parent().unwrap());
    }

    /// `stats().remote_behind` counts commits on origin/<branch> the local branch
    /// lacks, but only after a fetch has updated the tracking ref (it reads the local
    /// `origin/<branch>` ref, matching how the worktree-list builder observes it).
    #[test]
    fn remote_behind_counts_after_fetch() {
        let (_origin, seed, repo) = init_diverged_feature("remote-behind-count");

        // Tracking ref is stale until a fetch, so nothing looks pending yet.
        assert_eq!(
            stats(&repo, "feature", "main", BaseKind::Upstream).remote_behind,
            0
        );

        run_git(&repo, &["fetch", "origin", "feature"]);
        assert_eq!(
            stats(&repo, "feature", "main", BaseKind::Upstream).remote_behind,
            1,
            "one remote commit is now pending"
        );

        pull_remote(&repo, "feature").expect("pull_remote should succeed");
        assert_eq!(
            stats(&repo, "feature", "main", BaseKind::Upstream).remote_behind,
            0,
            "up to date after pulling"
        );

        let _ = std::fs::remove_dir_all(seed.parent().unwrap());
    }

    // ---- stats (the one-pass worktree-status gather) ----

    /// Every counter `stats` reports, against a branch with a published tracking ref,
    /// an unpushed local commit, and uncommitted work on top. Each used to be its own
    /// `git` invocation (or two); they must all still agree after being folded into a
    /// single pass over `for-each-ref` + `rev-list --left-right` + `diff --merge-base`.
    #[test]
    fn stats_reports_every_counter_in_one_pass() {
        let (_origin, seed, repo) = init_origin_seed_and_clone("stats-counters");
        run_git(&repo, &["checkout", "-b", "feature"]);

        // A commit that IS pushed…
        std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
        run_git(&repo, &["add", "-A"]);
        run_git(&repo, &["commit", "-m", "pushed"]);
        run_git(&repo, &["push", "-u", "origin", "feature"]);
        // …and one that isn't.
        std::fs::write(repo.join("b.txt"), "three\n").unwrap();
        run_git(&repo, &["add", "-A"]);
        run_git(&repo, &["commit", "-m", "local only"]);
        // Plus uncommitted work, which the badge counts like a PR diff does.
        std::fs::write(repo.join("c.txt"), "four\n").unwrap();
        run_git(&repo, &["add", "c.txt"]);
        // Meanwhile the base moved on upstream.
        advance_origin_main(&seed, "v2\n");
        run_git(&repo, &["fetch", "origin", "main"]);

        let s = stats(&repo, "feature", "main", BaseKind::Upstream);
        assert_eq!(s.ahead, 2, "two commits on top of the base");
        assert_eq!(s.behind, 1, "one commit added to the base upstream");
        assert_eq!(s.unpushed, 1, "only the second commit is unpushed");
        assert_eq!(
            s.remote_behind, 0,
            "nothing was added to the branch remotely"
        );
        assert!(s.dirty, "a staged-but-uncommitted file is a dirty tree");
        // 2 (a.txt) + 1 (b.txt) + 1 (c.txt) — committed *and* uncommitted, from the
        // merge base, so the base's own upstream commit is never folded in.
        assert_eq!((s.add_lines, s.del_lines), (4, 0));

        let _ = std::fs::remove_dir_all(seed.parent().unwrap());
    }

    /// A branch that was never pushed has no tracking ref: nothing can be pending on
    /// it, and *every* commit it added over the base is what a push would upload.
    #[test]
    fn stats_treats_a_never_pushed_branch_as_fully_unpushed() {
        let (_origin, seed, repo) = init_origin_seed_and_clone("stats-unpushed");
        run_git(&repo, &["checkout", "-b", "feature"]);
        std::fs::write(repo.join("a.txt"), "x\n").unwrap();
        run_git(&repo, &["add", "-A"]);
        run_git(&repo, &["commit", "-m", "c1"]);

        let s = stats(&repo, "feature", "main", BaseKind::Upstream);
        assert_eq!((s.ahead, s.unpushed), (1, 1));
        assert_eq!(s.remote_behind, 0, "no tracking ref, nothing to pull");
        assert!(!s.dirty);

        let _ = std::fs::remove_dir_all(seed.parent().unwrap());
    }

    /// `would_conflict` is the Pull button's up-front check. Its `merge-tree
    /// --write-tree` writes objects into the ODB and the status build re-runs on every
    /// filesystem burst, so the answer is memoized on the (HEAD, target) commit pair:
    /// repeat asks must spawn no merge at all, and a moved commit must invalidate it.
    #[test]
    fn would_conflict_answers_from_cache_until_a_commit_moves() {
        let (_origin, seed, repo) = init_diverged_feature("would-conflict-cache");
        std::fs::write(repo.join("f.txt"), "local-conflict\n").unwrap();
        run_git(&repo, &["add", "-A"]);
        run_git(&repo, &["commit", "-m", "conflicting local edit"]);
        run_git(&repo, &["fetch", "origin", "feature"]);

        assert!(would_conflict(&repo, "origin/feature"));
        // The repeat answer costs a single `rev-parse` — no second virtual merge.
        let before = git_calls_under(&repo);
        assert!(would_conflict(&repo, "origin/feature"));
        assert_eq!(
            git_calls_under(&repo) - before,
            1,
            "a cached answer re-resolves the commits but must not re-run merge-tree"
        );

        // Moving HEAD invalidates it: taking origin's version resolves the conflict.
        run_git(
            &repo,
            &["merge", "-X", "theirs", "--no-edit", "origin/feature"],
        );
        assert!(
            !would_conflict(&repo, "origin/feature"),
            "the cache must not outlive the commit pair it was computed for"
        );

        let _ = std::fs::remove_dir_all(seed.parent().unwrap());
    }

    /// When the local branch has diverged (its own commit origin doesn't have)
    /// but the changes don't conflict, `pull_remote` falls back to a real merge:
    /// both the local commit and the remote edit survive.
    #[test]
    fn pull_remote_merges_on_nonconflicting_divergence() {
        let (_origin, seed, repo) = init_diverged_feature("pull-remote-merge");
        // A local-only commit touching a *different* file — diverges history but
        // won't conflict with origin's edit to f.txt.
        std::fs::write(repo.join("g.txt"), "local only\n").unwrap();
        run_git(&repo, &["add", "-A"]);
        run_git(&repo, &["commit", "-m", "local divergence"]);

        pull_remote(&repo, "feature").expect("non-conflicting divergence should merge");

        // Remote edit pulled in…
        assert_eq!(
            std::fs::read_to_string(repo.join("f.txt")).unwrap(),
            "remote-edit\n"
        );
        // …and the local-only commit preserved.
        assert!(
            repo.join("g.txt").exists(),
            "local commit must survive the merge"
        );

        let _ = std::fs::remove_dir_all(seed.parent().unwrap());
    }

    /// When the divergence *conflicts*, `pull_remote` detects it up front (virtual
    /// merge) and refuses — the working tree is never touched, so it's never left
    /// in a half-merged/conflicted state, and the error names the file.
    #[test]
    fn pull_remote_refuses_conflicting_merge() {
        let (_origin, seed, repo) = init_diverged_feature("pull-remote-conflict");
        // Local edits the *same* file origin edited — an unmergeable divergence.
        std::fs::write(repo.join("f.txt"), "local-conflict\n").unwrap();
        run_git(&repo, &["add", "-A"]);
        run_git(&repo, &["commit", "-m", "conflicting local edit"]);
        let head_before = git(&repo, &["rev-parse", "HEAD"]).unwrap();

        let err = pull_remote(&repo, "feature").expect_err("conflicting pull must error");

        // The message must name the conflicted file, not leak git's raw stderr.
        let msg = err.to_string();
        assert!(
            msg.contains("f.txt"),
            "error should name the conflicted file: {msg}"
        );
        assert!(
            msg.contains("would conflict"),
            "error should be the up-front form: {msg}"
        );
        // Nothing touched: clean tree, unchanged HEAD, no MERGE_HEAD started.
        assert!(
            !is_dirty(&repo),
            "tree must be untouched when a conflict is detected"
        );
        assert_eq!(
            git(&repo, &["rev-parse", "HEAD"]).unwrap(),
            head_before,
            "HEAD must not move"
        );
        assert!(
            git(&repo, &["rev-parse", "--verify", "MERGE_HEAD"]).is_err(),
            "no merge in progress"
        );
        assert_eq!(
            std::fs::read_to_string(repo.join("f.txt")).unwrap(),
            "local-conflict\n"
        );

        let _ = std::fs::remove_dir_all(seed.parent().unwrap());
    }

    /// `merge_conflicts` reports the would-conflict paths from a *virtual* merge
    /// without touching the working tree — the primitive behind the up-front check.
    #[test]
    fn merge_conflicts_detects_without_touching_tree() {
        let (_origin, seed, repo) = init_diverged_feature("merge-conflicts-detect");
        std::fs::write(repo.join("f.txt"), "local-conflict\n").unwrap();
        run_git(&repo, &["add", "-A"]);
        run_git(&repo, &["commit", "-m", "conflicting local edit"]);
        run_git(&repo, &["fetch", "origin", "feature"]);

        let conflicts = merge_conflicts(&repo, "origin/feature").expect("detection should run");
        assert_eq!(conflicts, vec!["f.txt".to_string()]);
        assert!(
            !is_dirty(&repo),
            "virtual merge must not touch the working tree"
        );

        let _ = std::fs::remove_dir_all(seed.parent().unwrap());
    }

    /// The pending-pull pair the Trees sidebar shows: how many commits origin added to
    /// the branch, and whether taking them would conflict (which disables the button).
    /// `refresh_remote_ref` is the fetch that makes the count live.
    #[test]
    fn pending_pull_is_counted_and_flagged_as_conflicting() {
        let (_origin, seed, repo) = init_diverged_feature("pull-state-conflict");
        std::fs::write(repo.join("f.txt"), "local-conflict\n").unwrap();
        run_git(&repo, &["add", "-A"]);
        run_git(&repo, &["commit", "-m", "conflicting local edit"]);

        refresh_remote_ref(&repo, "feature");
        let s = stats(&repo, "feature", "main", BaseKind::Upstream);
        assert_eq!(s.remote_behind, 1, "one remote commit is pending");
        assert!(
            would_conflict(&repo, "origin/feature"),
            "the pending pull conflicts with the local edit"
        );
        assert!(!is_dirty(&repo), "detecting it must not touch the tree");

        let _ = std::fs::remove_dir_all(seed.parent().unwrap());
    }

    /// A non-conflicting divergence pulls cleanly, so the Pull button stays enabled.
    #[test]
    fn pending_pull_is_not_flagged_when_it_would_merge_cleanly() {
        let (_origin, seed, repo) = init_diverged_feature("pull-state-clean");
        // Local commit on a *different* file — pending pull, but no conflict.
        std::fs::write(repo.join("g.txt"), "local only\n").unwrap();
        run_git(&repo, &["add", "-A"]);
        run_git(&repo, &["commit", "-m", "non-conflicting local edit"]);

        refresh_remote_ref(&repo, "feature");
        assert_eq!(
            stats(&repo, "feature", "main", BaseKind::Upstream).remote_behind,
            1
        );
        assert!(
            !would_conflict(&repo, "origin/feature"),
            "a non-conflicting pull must not be flagged"
        );

        let _ = std::fs::remove_dir_all(seed.parent().unwrap());
    }

    // ---- discard (untracked deletes go through git, not `remove_file`) ----

    /// The base case: discarding an untracked file deletes it, and a tracked file is
    /// restored from HEAD.
    #[test]
    fn discard_removes_untracked_and_restores_tracked() {
        let base = scratch_dir("discard-basic");
        let repo = base.join("repo");
        std::fs::create_dir_all(repo.join("sub")).unwrap();
        run_git(&repo, &["init", "-b", "main"]);
        run_git(&repo, &["config", "user.email", "t@t.test"]);
        run_git(&repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("tracked.txt"), "original\n").unwrap();
        run_git(&repo, &["add", "-A"]);
        run_git(&repo, &["commit", "-m", "init"]);

        // Untracked, nested inside a directory git has never seen.
        std::fs::write(repo.join("sub/new.txt"), "x\n").unwrap();
        discard(&repo, "sub/new.txt", true).unwrap();
        assert!(!repo.join("sub/new.txt").exists(), "untracked file deleted");

        std::fs::write(repo.join("tracked.txt"), "clobbered\n").unwrap();
        discard(&repo, "tracked.txt", false).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.join("tracked.txt")).unwrap(),
            "original\n"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The reason the untracked delete is `git clean` and not `remove_file`: a
    /// worktree holds agent-written code, so a path component can be a symlink out of
    /// the tree. Discarding through it must never reach what it points at — neither by
    /// following a symlinked *leaf* to its target, nor by descending a symlinked
    /// *directory* component.
    #[test]
    #[cfg(unix)]
    fn discard_never_deletes_through_a_symlink() {
        let base = scratch_dir("discard-symlink");
        let repo = base.join("repo");
        let outside = base.join("outside");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("victim.txt"), "precious\n").unwrap();
        run_git(&repo, &["init", "-b", "main"]);
        run_git(&repo, &["config", "user.email", "t@t.test"]);
        run_git(&repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("README.md"), "hi\n").unwrap();
        run_git(&repo, &["add", "-A"]);
        run_git(&repo, &["commit", "-m", "init"]);

        // A symlinked leaf: the link goes, its target stays.
        std::os::unix::fs::symlink(outside.join("victim.txt"), repo.join("link.txt")).unwrap();
        discard(&repo, "link.txt", true).unwrap();
        assert!(repo.join("link.txt").symlink_metadata().is_err());
        assert!(
            outside.join("victim.txt").exists(),
            "the symlink's target must survive — only the link is discarded"
        );

        // A symlinked directory component: nothing beyond it may be touched.
        std::os::unix::fs::symlink(&outside, repo.join("escape")).unwrap();
        let _ = discard(&repo, "escape/victim.txt", true);
        assert!(
            outside.join("victim.txt").exists(),
            "discard must not descend a symlinked directory out of the worktree"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    // ---- open_in_worktree (the only raw-fs read sink) ----

    /// The read sink accepts exactly what it should: a regular file inside the tree —
    /// including one reached through a symlink that stays inside it, which is a
    /// legitimate thing for a repo to contain.
    #[test]
    #[cfg(unix)]
    fn open_in_worktree_reads_regular_files_including_inside_symlinks() {
        let base = scratch_dir("open-in-worktree-ok");
        let root = base.join("root");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("real.txt"), "content\n").unwrap();
        std::os::unix::fs::symlink(root.join("real.txt"), root.join("inside-link")).unwrap();

        assert_eq!(read_in_worktree(&root, "real.txt").unwrap(), "content\n");
        assert_eq!(read_in_worktree(&root, "inside-link").unwrap(), "content\n");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// …and refuses anything that isn't a regular file. The FIFO is the load-bearing
    /// case: `path` reaches [`file_source`] straight off the IPC boundary, and
    /// `open(2)` on a FIFO with no writer blocks *forever* — which would pin a
    /// blocking-pool thread and hang the read. The pre-open `lstat` is what turns that
    /// into an error. (Without it this test doesn't fail — it hangs, which is the bug.)
    #[test]
    #[cfg(unix)]
    fn open_in_worktree_refuses_anything_that_is_not_a_regular_file() {
        let base = scratch_dir("open-in-worktree-refuse");
        let root = base.join("root");
        std::fs::create_dir_all(root.join("dir")).unwrap();
        assert!(Command::new("mkfifo")
            .arg(root.join("pipe"))
            .status()
            .unwrap()
            .success());

        assert!(
            open_in_worktree(&root, "pipe").is_err(),
            "a FIFO must be refused before open(2) can block on it"
        );
        assert!(
            open_in_worktree(&root, "dir").is_err(),
            "a directory is not a regular file"
        );
        // And a symlink *out* of the tree is still refused, lexically, as before.
        let outside = base.join("outside.txt");
        std::fs::write(&outside, "secret\n").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();
        assert!(open_in_worktree(&root, "escape").is_err());

        let _ = std::fs::remove_dir_all(&base);
    }
}
