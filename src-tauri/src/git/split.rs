//! Private-index previews and recoverable Git-stash transfers into child worktrees.
//!
//! Wherever the checkout lives: every git here runs through the [`Checkout`]
//! (with `GIT_INDEX_FILE` and stdin where a step needs them), so a Daedalus
//! project's split runs on the box exactly as a local one runs here.
use std::path::{Path, PathBuf};

use anyhow::{anyhow, ensure, Context, Result};

use super::{Checkout, FsKind};

/// A scratch index file for one preview or restore, inside the checkout's own
/// git directory: never part of the working tree (so it can't show up in the
/// snapshot it is computing), and on the same machine as the git that writes
/// it. Deleted, with any lock git left beside it, when dropped.
struct PrivateIndex {
    dir: Checkout,
    path: PathBuf,
}

impl PrivateIndex {
    fn new(dir: &Checkout) -> Result<Self> {
        let name = format!("santree-split-{}.index", uuid::Uuid::new_v4());
        let path = super::git(
            dir,
            &["rev-parse", "--path-format=absolute", "--git-path", &name],
        )?;
        ensure!(!path.is_empty(), "git named no place for the split's index");
        Ok(Self {
            dir: dir.clone(),
            path: PathBuf::from(path),
        })
    }

    fn env(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }
}

impl Drop for PrivateIndex {
    fn drop(&mut self) {
        let mut lock = self.path.clone().into_os_string();
        lock.push(".lock");
        for path in [self.path.clone(), PathBuf::from(lock)] {
            if let Err(e) = self.dir.remove(&path) {
                log::warn!(
                    "couldn't remove the split's scratch index {}: {e}",
                    path.display()
                );
            }
        }
    }
}

/// [`super::git`], for the steps that need nothing more.
fn git(cwd: &Checkout, args: &[&str]) -> Result<String> {
    super::git(cwd, args)
}

/// One git step of a split: optionally against a private index, optionally fed
/// `input` on stdin. Its stdout must be UTF-8 — every caller parses it.
fn run(
    cwd: &Checkout,
    index: Option<&PrivateIndex>,
    args: &[&str],
    input: Option<&str>,
) -> Result<String> {
    let index_env = index.map(PrivateIndex::env);
    let env: Vec<(&str, &str)> = index_env
        .iter()
        .map(|path| ("GIT_INDEX_FILE", path.as_str()))
        .collect();
    let out = cwd.git_with(args, &env, input.map(str::as_bytes))?;
    ensure!(out.ok, "{}", out.stderr.trim());
    String::from_utf8(out.stdout).context("This split contains non-UTF-8 diff data")
}

pub(crate) fn oid(cwd: &Checkout, reference: &str) -> Result<String> {
    ensure!(!reference.starts_with('-'), "Invalid reference");
    git(
        cwd,
        &["rev-parse", "--verify", &format!("{reference}^{{commit}}")],
    )
}

pub(crate) fn validate_branch(cwd: &Checkout, branch: &str) -> Result<()> {
    ensure!(
        !branch.is_empty()
            && !branch.starts_with('-')
            && !branch.starts_with("refs/")
            && branch != "HEAD",
        "Invalid branch name"
    );
    git(cwd, &["check-ref-format", &format!("refs/heads/{branch}")])?;
    ensure!(
        git(
            cwd,
            &["show-ref", "--verify", &format!("refs/heads/{branch}")]
        )
        .is_err(),
        "Branch '{branch}' already exists"
    );
    ensure!(
        git(
            cwd,
            &[
                "show-ref",
                "--verify",
                &format!("refs/remotes/origin/{branch}")
            ]
        )
        .is_err(),
        "Remote branch '{branch}' already exists"
    );
    let refs = git(
        cwd,
        &[
            "for-each-ref",
            "--format=%(refname)",
            "refs/heads",
            "refs/remotes/origin",
        ],
    )?;
    for reference in refs.lines() {
        let Some(other) = reference
            .strip_prefix("refs/heads/")
            .or_else(|| reference.strip_prefix("refs/remotes/origin/"))
        else {
            continue;
        };
        ensure!(
            !other.starts_with(&format!("{branch}/")) && !branch.starts_with(&format!("{other}/")),
            "Branch name conflicts with '{other}'"
        );
    }
    Ok(())
}

pub(crate) fn assert_checkout(cwd: &Checkout, branch: &str) -> Result<()> {
    ensure!(
        git(cwd, &["config", "--bool", "core.sparseCheckout"])
            .ok()
            .as_deref()
            != Some("true"),
        "Splitting requires a full checkout; sparse worktrees are not supported"
    );
    // Its own top level, not a directory some other checkout contains.
    ensure!(
        git(cwd, &["rev-parse", "--show-prefix"])?.is_empty(),
        "Worktree no longer exists at its registered path"
    );
    ensure!(
        git(cwd, &["symbolic-ref", "--short", "HEAD"])? == branch,
        "The checked-out branch changed; reopen the split"
    );
    ensure!(
        git(cwd, &["ls-files", "--unmerged"])?.is_empty(),
        "Resolve merge conflicts before splitting"
    );
    for state in [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
    ] {
        let path = git(
            cwd,
            &["rev-parse", "--path-format=absolute", "--git-path", state],
        )?;
        ensure!(
            cwd.stat(Path::new(&path))?.is_none(),
            "Finish the current Git operation before splitting"
        );
    }
    Ok(())
}

pub(crate) fn snapshot(cwd: &Checkout) -> Result<String> {
    snapshot_from(cwd, None)
}

pub(crate) fn snapshot_from(cwd: &Checkout, seed: Option<&str>) -> Result<String> {
    let index = PrivateIndex::new(cwd)?;
    let staged = run(cwd, None, &["write-tree"], None)?;
    run(
        cwd,
        Some(&index),
        &["read-tree", seed.unwrap_or(staged.trim())],
        None,
    )?;
    if seed.is_some() {
        // Recovery's expected tree may include files not yet in the real index.
        run(cwd, Some(&index), &["add", "-A", "--", "."], None)?;
    } else {
        // Read dirtiness from the real index's stat cache. Passing every tracked
        // filename as a pathspec makes Git do quadratic work in large repositories.
        let changed = run(
            cwd,
            None,
            &[
                "ls-files",
                "--modified",
                "--others",
                "--exclude-standard",
                "-z",
            ],
            None,
        )?;
        let added = run(
            cwd,
            None,
            &[
                "diff",
                "--cached",
                "--name-only",
                "--diff-filter=A",
                "--ita-visible-in-index",
                "-z",
                "--",
            ],
            None,
        )?;
        let deleted = run(cwd, None, &["ls-files", "--deleted", "-z"], None)?;
        let missing: std::collections::HashSet<&str> =
            deleted.split('\0').filter(|p| !p.is_empty()).collect();
        let paths: std::collections::BTreeSet<&str> = changed
            .split('\0')
            .chain(added.split('\0'))
            .filter(|p| !p.is_empty() && !missing.contains(p))
            .collect();
        if !deleted.is_empty() {
            run(
                cwd,
                Some(&index),
                &["update-index", "--force-remove", "-z", "--stdin"],
                Some(&deleted),
            )?;
        }
        let mut forced = std::collections::HashSet::new();
        for path in added.split('\0').filter(|p| paths.contains(p)) {
            let file = super::safe_path(cwd.path(), path)?;
            let kind = cwd
                .stat(&file)?
                .ok_or_else(|| anyhow!("{path} disappeared while reading the split"))?;
            if kind != FsKind::Dir {
                forced.insert(path);
            }
        }
        for force in [false, true] {
            let input = paths
                .iter()
                .filter(|path| forced.contains(**path) == force)
                .map(|path| format!("{path}\0"))
                .collect::<String>();
            if input.is_empty() {
                continue;
            }
            let mut args = vec!["--literal-pathspecs", "add", "-A"];
            if force {
                args.push("-f");
            }
            args.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
            run(cwd, Some(&index), &args, Some(&input))?;
        }
    }
    Ok(run(cwd, Some(&index), &["write-tree"], None)?.trim().into())
}

/// Unlike ordinary worktree creation, a split must use the frozen parent exactly.
pub(crate) fn create_worktree(
    root: &Checkout,
    path: &Path,
    branch: &str,
    base: &str,
) -> Result<()> {
    validate_branch(root, branch)?;
    ensure!(
        base.len() >= 40 && base.len() <= 64 && base.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid split base"
    );
    // `worktree add` makes the directory and its parents itself.
    git(
        root,
        &[
            "worktree",
            "add",
            "-b",
            branch,
            &path.to_string_lossy(),
            base,
        ],
    )?;
    Ok(())
}

pub(crate) fn index_tree(cwd: &Checkout) -> Result<String> {
    Ok(run(cwd, None, &["write-tree"], None)?.trim().into())
}

pub(crate) fn changed_paths(
    cwd: &Checkout,
    head: &str,
    tree: &str,
    index: &str,
) -> Result<Vec<String>> {
    let mut paths = std::collections::BTreeSet::new();
    for to in [tree, index] {
        let names = run(
            cwd,
            None,
            &["diff", "--no-renames", "--name-only", "-z", head, to, "--"],
            None,
        )?;
        for path in names.split('\0').filter(|p| !p.is_empty()) {
            super::safe_path(cwd.path(), path)?;
            ensure!(
                !path.starts_with(".santree/worktrees/") && !path.starts_with(".santree/reviews/"),
                "Santree checkout storage cannot be moved as project changes"
            );
            if path == ".santree/.gitignore" {
                ensure!(git(cwd, &["cat-file", "-e", &format!("{head}:{path}")]).is_err() && git(cwd, &["cat-file", "-e", &format!("{index}:{path}")]).is_err(), "Commit or discard changes to .santree/.gitignore before moving; it protects the worktree storage");
                continue;
            }
            ensure!(
                !path.split('/').any(|p| p.eq_ignore_ascii_case(".git")),
                "Cannot move Git metadata"
            );
            paths.insert(path.to_string());
        }
        let raw = run(
            cwd,
            None,
            &["diff", "--raw", "--no-renames", head, to, "--"],
            None,
        )?;
        ensure!(
            !raw.lines().any(|line| line.starts_with(":160000 ")
                || line.split_whitespace().nth(1) == Some("160000")),
            "Submodule changes cannot be moved with this action"
        );
    }
    Ok(paths.into_iter().collect())
}

pub(crate) fn find_backup(cwd: &Checkout, id: &str) -> Result<Option<String>> {
    let marker = format!("santree-move:{id}");
    let list = run(cwd, None, &["stash", "list", "--format=%H%x09%gs"], None)?;
    Ok(list.lines().find_map(|line| {
        let (oid, subject) = line.split_once('\t')?;
        subject.ends_with(&marker).then(|| oid.to_string())
    }))
}

/// Git writes the recovery commit before removing anything from the checkout.
/// The explicit path list excludes ignored files and Santree's worktree storage.
pub(crate) fn stash_remaining(
    cwd: &Checkout,
    op: &santree_core::domain::MoveChanges,
) -> Result<String> {
    super::with_index_lock(cwd, || {
        assert_checkout(cwd, &op.source_branch)?;
        ensure!(
            oid(cwd, "HEAD")? == op.head
                && snapshot(cwd)? == op.snapshot_tree
                && index_tree(cwd)? == op.index_tree,
            "Changes have changed since the preview. Refresh it before moving"
        );
        let paths = op
            .files
            .iter()
            .map(|p| format!("{p}\0"))
            .collect::<String>();
        let result = run(
            cwd,
            None,
            &[
                "--literal-pathspecs",
                "stash",
                "push",
                "--include-untracked",
                "--message",
                &format!("santree-move:{}", op.id),
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            Some(&paths),
        );
        // A crash or cleanup error after stash creation still leaves a usable backup.
        if let Some(stash) = find_backup(cwd, &op.id)? {
            return Ok(stash);
        }
        result.context("Could not save a recovery stash; your source changes were not moved")?;
        anyhow::bail!("Git did not create a recovery stash; your source changes were not moved")
    })
}

pub(crate) fn restore_backup(cwd: &Checkout, stash: &str, head: &str) -> Result<()> {
    super::with_index_lock(cwd, || {
        ensure!(
            oid(cwd, "HEAD")? == head,
            "The destination branch changed; its files were preserved"
        );
        ensure!(
            oid(cwd, &format!("{stash}^1"))? == head,
            "The source branch changed while saving the recovery stash"
        );
        let index = PrivateIndex::new(cwd)?;
        run(cwd, Some(&index), &["read-tree", stash], None)?;
        if oid(cwd, &format!("{stash}^3")).is_ok() {
            run(
                cwd,
                Some(&index),
                &["read-tree", "--prefix=", &format!("{stash}^3")],
                None,
            )?;
        }
        let expected = run(cwd, Some(&index), &["write-tree"], None)?
            .trim()
            .to_string();
        let staged = git(cwd, &["rev-parse", &format!("{stash}^2^{{tree}}")])?;
        if snapshot_from(cwd, Some(&expected))? == expected && index_tree(cwd)? == staged {
            return Ok(());
        }
        ensure!(git(cwd, &["status", "--porcelain"])?.is_empty(), "The destination already has edits. They were preserved. Resolve them before retrying; the recovery stash is still available");
        run(cwd, None, &["stash", "apply", "--index", stash], None)
            .context("Could not apply the recovery stash. It is still saved; inspect the destination before retrying")?;
        ensure!(
            snapshot(cwd)? == expected && index_tree(cwd)? == staged,
            "The destination changed during the move. The recovery stash is still available"
        );
        Ok(())
    })
}
