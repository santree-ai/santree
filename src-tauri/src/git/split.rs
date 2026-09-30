//! Private-index previews and recoverable Git-stash transfers into child worktrees.
//!
//! Local checkouts only: a preview builds a private index in this machine's temp
//! directory, so the split runs its own `git` (with `GIT_INDEX_FILE` and stdin)
//! rather than going through [`super::Checkout`]. The UI offers it for local
//! worktrees alone.
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{ensure, Context, Result};

use super::Checkout;

pub(crate) struct Scratch(PathBuf);
impl Scratch {
    pub(crate) fn new() -> Result<Self> {
        let path = std::env::temp_dir().join(format!("santree-split-{}", uuid::Uuid::new_v4()));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path)?;
        Ok(Self(path))
    }
    pub(crate) fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// [`super::git`] in a checkout on this machine.
fn git(cwd: &Path, args: &[&str]) -> Result<String> {
    super::git(&Checkout::local(cwd), args)
}

fn run(cwd: &Path, index: Option<&Path>, args: &[&str], input: Option<&str>) -> Result<String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(cwd)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(index) = index {
        cmd.env("GIT_INDEX_FILE", index);
    }
    cmd.stdin(if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    let mut child = cmd.spawn()?;
    if let Some(input) = input {
        // Feed concurrently so a large rejected patch cannot deadlock on stderr.
        let mut stdin = child.stdin.take().unwrap();
        let bytes = input.as_bytes().to_vec();
        let writer = std::thread::spawn(move || stdin.write_all(&bytes));
        let out = child.wait_with_output()?;
        let _ = writer.join();
        ensure!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
        return String::from_utf8(out.stdout).context("This split contains non-UTF-8 diff data");
    }
    let out = child.wait_with_output()?;
    ensure!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr).trim()
    );
    String::from_utf8(out.stdout).context("This split contains non-UTF-8 diff data")
}

pub(crate) fn oid(cwd: &Path, reference: &str) -> Result<String> {
    ensure!(!reference.starts_with('-'), "Invalid reference");
    git(
        cwd,
        &["rev-parse", "--verify", &format!("{reference}^{{commit}}")],
    )
}

pub(crate) fn validate_branch(cwd: &Path, branch: &str) -> Result<()> {
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

pub(crate) fn assert_checkout(cwd: &Path, branch: &str) -> Result<()> {
    ensure!(
        git(cwd, &["config", "--bool", "core.sparseCheckout"])
            .ok()
            .as_deref()
            != Some("true"),
        "Splitting requires a full checkout; sparse worktrees are not supported"
    );
    let top = git(cwd, &["rev-parse", "--show-toplevel"])?;
    ensure!(
        std::fs::canonicalize(top)? == std::fs::canonicalize(cwd)?,
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
        let path = git(cwd, &["rev-parse", "--git-path", state])?;
        ensure!(
            !cwd.join(path).exists(),
            "Finish the current Git operation before splitting"
        );
    }
    Ok(())
}

pub(crate) fn snapshot(cwd: &Path) -> Result<String> {
    snapshot_from(cwd, None)
}

pub(crate) fn snapshot_from(cwd: &Path, seed: Option<&str>) -> Result<String> {
    let scratch = Scratch::new()?;
    let index = scratch.path().join("index");
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
            let file = super::safe_path(cwd, path)?;
            if !std::fs::symlink_metadata(file)?.is_dir() {
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
pub(crate) fn create_worktree(root: &Path, path: &Path, branch: &str, base: &str) -> Result<()> {
    validate_branch(root, branch)?;
    ensure!(
        base.len() >= 40 && base.len() <= 64 && base.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid split base"
    );
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
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

pub(crate) fn index_tree(cwd: &Path) -> Result<String> {
    Ok(run(cwd, None, &["write-tree"], None)?.trim().into())
}

pub(crate) fn changed_paths(
    cwd: &Path,
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
            super::safe_path(cwd, path)?;
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

pub(crate) fn find_backup(cwd: &Path, id: &str) -> Result<Option<String>> {
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
    cwd: &Path,
    op: &santree_core::domain::MoveChanges,
) -> Result<String> {
    super::with_index_lock(&Checkout::local(cwd), || {
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

pub(crate) fn restore_backup(cwd: &Path, stash: &str, head: &str) -> Result<()> {
    super::with_index_lock(&Checkout::local(cwd), || {
        ensure!(
            oid(cwd, "HEAD")? == head,
            "The destination branch changed; its files were preserved"
        );
        ensure!(
            oid(cwd, &format!("{stash}^1"))? == head,
            "The source branch changed while saving the recovery stash"
        );
        let scratch = Scratch::new()?;
        let index = scratch.path().join("index");
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
