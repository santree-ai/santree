//! Move the remaining uncommitted edits one branch forward, with a durable Git backup.
use std::path::Path;
use std::sync::LazyLock;

use anyhow::{anyhow, ensure, Result};
use santree_core::domain::MoveChanges;
use tokio::sync::Mutex;

use crate::{db::Db, git, repo, worktree};

static MUTATIONS: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

async fn root(db: &Db, repo: &str) -> Result<String> {
    repo::path(db, repo)
        .await?
        .ok_or_else(|| anyhow!("Moving changes requires a local repository"))
}

async fn save(db: &Db, root: &str, op: &MoveChanges) -> Result<()> {
    sqlx::query("INSERT INTO worktree_moves (id, repo_path, source_id, data) VALUES (?, ?, ?, ?) ON CONFLICT(repo_path, source_id) DO UPDATE SET id = excluded.id, data = excluded.data")
        .bind(&op.id).bind(root).bind(&op.source_id).bind(serde_json::to_string(op)?).execute(db).await?;
    Ok(())
}

pub async fn preview(db: &Db, repo: &str, source: &str) -> Result<MoveChanges> {
    let _guard = MUTATIONS.lock().await;
    let root = root(db, repo).await?;
    let saved: Option<String> =
        sqlx::query_scalar("SELECT data FROM worktree_moves WHERE repo_path = ? AND source_id = ?")
            .bind(&root)
            .bind(source)
            .fetch_optional(db)
            .await?;
    let mut retry = None;
    if let Some(saved) = saved {
        let mut op: MoveChanges = serde_json::from_str(&saved)?;
        if op.branch.is_some() && !op.completed {
            let path = root.clone();
            let id = op.id.clone();
            let backup =
                tokio::task::spawn_blocking(move || git::split::find_backup(Path::new(&path), &id))
                    .await??;
            if op.stash_oid.is_some() || backup.is_some() {
                op.stash_oid = op.stash_oid.or(backup);
                save(db, &root, &op).await?;
                return Ok(op);
            }
            retry = Some(op);
        }
    }
    check_destination(Path::new(&root), "preview")?;
    crate::santree_dir::ensure(Path::new(&root))?;
    let coords = worktree::coords(db, repo, source).await?;
    let ticket_id = worktree::ticket_id(db, repo, source).await?;
    let source_id = source.to_string();
    let mut op = tokio::task::spawn_blocking(move || -> Result<MoveChanges> {
        git::split::assert_checkout(&coords.path, &coords.branch)?;
        let head = git::split::oid(&coords.path, "HEAD")?;
        let index_tree = git::split::index_tree(&coords.path)?;
        let snapshot_tree = git::split::snapshot(&coords.path)?;
        let files = git::split::changed_paths(&coords.path, &head, &snapshot_tree, &index_tree)?;
        ensure!(
            git::split::oid(&coords.path, "HEAD")? == head
                && git::split::index_tree(&coords.path)? == index_tree
                && git::split::snapshot(&coords.path)? == snapshot_tree,
            "Changes are still being edited. Refresh the preview when edits have stopped"
        );
        let id = uuid::Uuid::new_v4().to_string();
        Ok(MoveChanges {
            worktree_id: format!("split-{id}"),
            id,
            source_id,
            source_branch: coords.branch,
            head,
            snapshot_tree,
            index_tree,
            files,
            ticket_id,
            branch: None,
            stash_oid: None,
            completed: false,
            source_has_changes: false,
        })
    })
    .await??;
    if let Some(previous) = retry {
        if previous.head == op.head && previous.source_branch == op.source_branch {
            op.id = previous.id;
            op.worktree_id = previous.worktree_id;
            op.branch = previous.branch;
            op.ticket_id = previous.ticket_id;
        }
    }
    save(db, &root, &op).await?;
    Ok(op)
}

pub async fn move_remaining(
    db: &Db,
    repo: &str,
    id: &str,
    branch: &str,
    ticket_id: Option<String>,
) -> Result<MoveChanges> {
    let _guard = MUTATIONS.lock().await;
    let root = root(db, repo).await?;
    let data: String =
        sqlx::query_scalar("SELECT data FROM worktree_moves WHERE repo_path = ? AND id = ?")
            .bind(&root)
            .bind(id)
            .fetch_optional(db)
            .await?
            .ok_or_else(|| anyhow!("This preview is outdated. Refresh it before moving"))?;
    let mut op: MoveChanges = serde_json::from_str(&data)?;
    if op.completed {
        return Ok(op);
    }
    ensure!(
        !op.files.is_empty(),
        "There are no uncommitted changes to move"
    );
    if let Some(ticket) = &ticket_id {
        worktree::validate_issue_id(ticket)?;
        ensure!(!ticket.trim().is_empty(), "Ticket ID cannot be empty");
    }
    let coords = worktree::coords(db, repo, &op.source_id).await?;
    if let Some(chosen) = &op.branch {
        ensure!(
            chosen == branch && op.ticket_id == ticket_id,
            "Retry the existing move using its original branch and ticket"
        );
    } else {
        let path = coords.path.clone();
        let checked = op.clone();
        let name = branch.to_string();
        let base = coords.base_branch.clone();
        let base_kind = worktree::base_kind_of(db, &root, &base).await?;
        tokio::task::spawn_blocking(move || -> Result<()> {
            git::split::assert_checkout(&path, &checked.source_branch)?;
            let base = match base_kind {
                git::BaseKind::LocalBranch => git::split::oid(&path, &base)?,
                git::BaseKind::Upstream => git::split::oid(&path, &format!("origin/{base}"))
                    .or_else(|_| git::split::oid(&path, &base))?,
            };
            let count: u32 = git::git(
                &path,
                &["rev-list", "--count", &format!("{base}..{}", checked.head)],
            )?
            .parse()?;
            ensure!(
                count > 0,
                "Commit the first part on this branch before creating a child branch"
            );
            git::split::validate_branch(&path, &name)?;
            ensure!(
                git::split::oid(&path, "HEAD")? == checked.head
                    && git::split::snapshot(&path)? == checked.snapshot_tree
                    && git::split::index_tree(&path)? == checked.index_tree,
                "Changes have changed since the preview. Refresh it before moving"
            );
            Ok(())
        })
        .await??;
        op.branch = Some(branch.to_string());
        op.ticket_id = ticket_id;
        save(db, &root, &op).await?;
    }
    check_destination(Path::new(&root), &op.worktree_id)?;
    let wt = worktree::create(
        db,
        repo,
        &op.worktree_id,
        branch,
        None,
        Some(&op.head),
        None,
        worktree::BranchPlan::Split(branch),
    )
    .await?;
    ensure!(
        wt.id == op.worktree_id,
        "Another worktree owns this branch; its files were preserved"
    );
    check_destination(Path::new(&root), &op.worktree_id)?;
    let path = wt.path.clone();
    let name = branch.to_string();
    let head = op.head.clone();
    let backed_up = op.stash_oid.is_some();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let path = Path::new(&path);
        git::split::assert_checkout(path, &name)?;
        ensure!(
            git::split::oid(path, "HEAD")? == head,
            "The destination branch changed; its files were preserved"
        );
        // Before stashing the source, never commandeer an edited destination.
        if !backed_up {
            ensure!(
                git::git(path, &["status", "--porcelain"])?.is_empty(),
                "The destination already has edits; both worktrees were preserved"
            );
        }
        Ok(())
    })
    .await??;
    let updated = sqlx::query("UPDATE worktree_links SET ticket_id = ?, base_branch = ? WHERE repo_path = ? AND issue_id = ?")
        .bind(op.ticket_id.as_deref().unwrap_or("")).bind(&op.source_branch).bind(&root).bind(&op.worktree_id).execute(db).await?;
    ensure!(
        updated.rows_affected() == 1,
        "The destination worktree was removed; the source was preserved"
    );
    if op.stash_oid.is_none() {
        let source = coords.path.clone();
        let checked = op.clone();
        let stash = tokio::task::spawn_blocking(move || -> Result<String> {
            if let Some(stash) = git::split::find_backup(&source, &checked.id)? {
                return Ok(stash);
            }
            git::split::stash_remaining(&source, &checked)
        })
        .await??;
        op.stash_oid = Some(stash);
        save(db, &root, &op).await?;
    }
    let stash = op.stash_oid.clone().unwrap();
    let pin = format!("refs/santree/moves/{}", op.id);
    let path = wt.path.clone();
    let head = op.head.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let path = Path::new(&path);
        git::git(path, &["update-ref", &pin, &stash])?;
        git::split::restore_backup(path, &stash, &head)
    })
    .await??;
    op.source_has_changes =
        !tokio::task::spawn_blocking(move || git::git(&coords.path, &["status", "--porcelain"]))
            .await??
            .is_empty();
    op.completed = true;
    save(db, &root, &op).await?;
    Ok(op)
}

fn check_destination(root: &Path, id: &str) -> Result<()> {
    for rel in [
        ".santree".to_string(),
        ".santree/.gitignore".to_string(),
        ".santree/worktrees".to_string(),
        format!(".santree/worktrees/{id}"),
    ] {
        if let Ok(meta) = std::fs::symlink_metadata(root.join(rel)) {
            ensure!(
                !meta.file_type().is_symlink(),
                "The worktree destination must not contain symlinks"
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Fixture {
        _scratch: git::split::Scratch,
        path: PathBuf,
        db: Db,
    }
    impl Fixture {
        async fn new() -> Self {
            let scratch = git::split::Scratch::new().unwrap();
            let path = scratch.path().join("repo");
            std::fs::create_dir(&path).unwrap();
            git::git(&path, &["init", "-b", "main"]).unwrap();
            git::git(&path, &["config", "user.name", "Move test"]).unwrap();
            git::git(&path, &["config", "user.email", "move@example.test"]).unwrap();
            std::fs::write(path.join(".gitignore"), ".santree/\n*.secret\n").unwrap();
            std::fs::write(path.join("a.txt"), "original\n").unwrap();
            std::fs::write(path.join("deleted.txt"), "remove later\n").unwrap();
            git::git(&path, &["add", "."]).unwrap();
            git::git(&path, &["commit", "-m", "base"]).unwrap();
            git::git(&path, &["switch", "-c", "feature"]).unwrap();
            std::fs::write(path.join("committed.txt"), "belongs on first branch\n").unwrap();
            git::git(&path, &["add", "."]).unwrap();
            git::git(&path, &["commit", "-m", "first reviewed part"]).unwrap();
            let db = crate::db::init(scratch.path().join("test.db"))
                .await
                .unwrap();
            sqlx::query("INSERT INTO repos (name, tracker, path) VALUES ('test', 'Local git', ?)")
                .bind(path.to_str().unwrap())
                .execute(&db)
                .await
                .unwrap();
            sqlx::query("INSERT INTO worktree_links (repo_path, issue_id, title, branch, worktree_path, base_branch) VALUES (?, 'AK-123', 'Notifications', 'feature', ?, 'main')").bind(path.to_str().unwrap()).bind(path.to_str().unwrap()).execute(&db).await.unwrap();
            Self {
                _scratch: scratch,
                path,
                db,
            }
        }
        async fn preview(&self) -> MoveChanges {
            preview(&self.db, "test", "AK-123").await.unwrap()
        }
        async fn run(&self, op: &MoveChanges) -> Result<MoveChanges> {
            move_remaining(
                &self.db,
                "test",
                &op.id,
                "feature-next",
                Some("AK-456".into()),
            )
            .await
        }
    }

    #[tokio::test]
    async fn refuses_child_until_source_has_its_own_commit() {
        let f = Fixture::new().await;
        git::git(&f.path, &["reset", "--soft", "main"]).unwrap();
        let op = f.preview().await;
        let error = f.run(&op).await.unwrap_err().to_string();
        assert!(error.contains("Commit the first part"), "{error}");
        assert_eq!(git::split::oid(&f.path, "HEAD").unwrap(), op.head);
        assert_eq!(git::split::index_tree(&f.path).unwrap(), op.index_tree);
        assert_eq!(git::split::snapshot(&f.path).unwrap(), op.snapshot_tree);
        assert!(git::split::find_backup(&f.path, &op.id).unwrap().is_none());
        assert!(git::split::oid(&f.path, "feature-next").is_err());
        f.db.close().await;
    }

    #[tokio::test]
    async fn upstream_commits_do_not_count_as_source_commits() {
        let f = Fixture::new().await;
        git::git(&f.path, &["update-ref", "refs/remotes/origin/main", "HEAD"]).unwrap();
        std::fs::write(f.path.join("a.txt"), "remaining\n").unwrap();
        for remote_only in [false, true] {
            if remote_only {
                git::git(&f.path, &["branch", "-D", "main"]).unwrap();
            }
            let op = f.preview().await;
            let error = f.run(&op).await.unwrap_err().to_string();
            assert!(error.contains("Commit the first part"), "{error}");
            assert_eq!(git::split::snapshot(&f.path).unwrap(), op.snapshot_tree);
            assert!(git::split::find_backup(&f.path, &op.id).unwrap().is_none());
            assert!(git::split::oid(&f.path, "feature-next").is_err());
        }
        f.db.close().await;
    }

    #[tokio::test]
    async fn moves_remaining_changes_and_preserves_commits_staging_and_ticket_chain() {
        let f = Fixture::new().await;
        std::fs::write(f.path.join("a.txt"), "staged\n").unwrap();
        git::git(&f.path, &["add", "a.txt"]).unwrap();
        std::fs::write(f.path.join("a.txt"), "staged and unstaged\n").unwrap();
        std::fs::write(f.path.join("forced.secret"), "staged ignored\n").unwrap();
        git::git(&f.path, &["add", "-f", "forced.secret"]).unwrap();
        std::fs::write(f.path.join("keep.secret"), "stay in source\n").unwrap();
        std::fs::write(f.path.join("new.txt"), "no final newline").unwrap();
        std::fs::write(f.path.join("binary.bin"), [0, 255, 0, 16]).unwrap();
        std::fs::remove_file(f.path.join("deleted.txt")).unwrap();
        let op = f.preview().await;
        assert_eq!(op.ticket_id.as_deref(), Some("AK-123"));
        let done = f.run(&op).await.unwrap();
        assert!(done.completed);
        assert!(!done.source_has_changes);
        assert!(git::git(&f.path, &["status", "--porcelain"])
            .unwrap()
            .is_empty());
        assert_eq!(git::split::oid(&f.path, "HEAD").unwrap(), op.head);
        assert!(f.path.join("keep.secret").exists());
        assert!(!f.path.join("new.txt").exists());
        let child = worktree::get(&f.db, "test", &done.worktree_id)
            .await
            .unwrap()
            .unwrap();
        let child_path = Path::new(&child.path);
        assert_eq!(child.base_branch, "feature");
        assert_eq!(child.ticket_id.as_deref(), Some("AK-456"));
        assert_eq!(git::split::snapshot(child_path).unwrap(), op.snapshot_tree);
        assert_eq!(git::split::index_tree(child_path).unwrap(), op.index_tree);
        assert_eq!(git::split::oid(child_path, "HEAD").unwrap(), op.head);
        assert_eq!(
            git::split::find_backup(&f.path, &op.id).unwrap(),
            done.stash_oid
        );
        assert_eq!(f.run(&op).await.unwrap().worktree_id, child.id);
        // Commit only the staged portion; carry the rest one more branch forward.
        git::git(child_path, &["commit", "-m", "second reviewed part"]).unwrap();
        let next = preview(&f.db, "test", &child.id).await.unwrap();
        let last = move_remaining(&f.db, "test", &next.id, "feature-third", None)
            .await
            .unwrap();
        let last = worktree::get(&f.db, "test", &last.worktree_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(last.base_branch, "feature-next");
        assert_eq!(last.ticket_id, None);
        assert_eq!(
            git::split::snapshot(Path::new(&last.path)).unwrap(),
            op.snapshot_tree
        );
        assert!(git::git(child_path, &["status", "--porcelain"])
            .unwrap()
            .is_empty());
        f.db.close().await;
    }

    #[tokio::test]
    async fn stale_preview_and_invalid_names_preserve_source_and_create_nothing() {
        let f = Fixture::new().await;
        std::fs::write(f.path.join("new.txt"), "remaining\n").unwrap();
        let op = f.preview().await;
        for branch in ["--help", "main", "feature/child", "refs/heads/no"] {
            assert!(move_remaining(&f.db, "test", &op.id, branch, None)
                .await
                .is_err());
        }
        std::fs::write(f.path.join("new.txt"), "newer edits\n").unwrap();
        assert!(f
            .run(&op)
            .await
            .unwrap_err()
            .to_string()
            .contains("preview"));
        assert_eq!(
            std::fs::read_to_string(f.path.join("new.txt")).unwrap(),
            "newer edits\n"
        );
        assert!(git::split::oid(&f.path, "feature-next").is_err());
        assert!(git::split::find_backup(&f.path, &op.id).unwrap().is_none());
        f.db.close().await;
    }

    #[tokio::test]
    async fn resumes_after_stash_and_after_apply_without_touching_new_source_edits() {
        let f = Fixture::new().await;
        std::fs::write(f.path.join("new.txt"), "remaining\n").unwrap();
        let mut op = f.preview().await;
        op.branch = Some("feature-next".into());
        op.ticket_id = Some("AK-456".into());
        save(&f.db, f.path.to_str().unwrap(), &op).await.unwrap();
        let stash = git::split::stash_remaining(&f.path, &op).unwrap();
        std::fs::write(f.path.join("later.txt"), "new source edits\n").unwrap();
        let resumed = f.preview().await;
        assert_eq!(resumed.id, op.id);
        let done = f.run(&resumed).await.unwrap();
        assert_eq!(done.stash_oid.as_deref(), Some(stash.as_str()));
        assert!(done.source_has_changes);
        assert!(f.path.join("later.txt").exists());
        let mut interrupted = done.clone();
        interrupted.completed = false;
        save(&f.db, f.path.to_str().unwrap(), &interrupted)
            .await
            .unwrap();
        assert!(f.run(&interrupted).await.unwrap().completed);
        assert_eq!(
            git::git(&f.path, &["stash", "list", "--format=%H"])
                .unwrap()
                .lines()
                .count(),
            1
        );
        f.db.close().await;
    }

    #[tokio::test]
    async fn edited_destination_is_preserved_and_backup_can_be_retried() {
        let f = Fixture::new().await;
        std::fs::write(f.path.join("new.txt"), "remaining\n").unwrap();
        let mut op = f.preview().await;
        op.branch = Some("feature-next".into());
        op.ticket_id = Some("AK-456".into());
        let wt = worktree::create(
            &f.db,
            "test",
            &op.worktree_id,
            "feature-next",
            None,
            Some(&op.head),
            None,
            worktree::BranchPlan::Split("feature-next"),
        )
        .await
        .unwrap();
        op.stash_oid = Some(git::split::stash_remaining(&f.path, &op).unwrap());
        save(&f.db, f.path.to_str().unwrap(), &op).await.unwrap();
        let path = Path::new(&wt.path);
        std::fs::write(path.join("a.txt"), "user destination edits\n").unwrap();
        assert!(f.run(&op).await.is_err());
        assert_eq!(
            std::fs::read_to_string(path.join("a.txt")).unwrap(),
            "user destination edits\n"
        );
        assert!(git::split::find_backup(&f.path, &op.id).unwrap().is_some());
        git::git(path, &["restore", "a.txt"]).unwrap();
        assert!(f.run(&op).await.unwrap().completed);
        f.db.close().await;
    }

    #[tokio::test]
    async fn staged_change_with_working_file_reverted_is_not_lost() {
        let f = Fixture::new().await;
        std::fs::write(f.path.join("a.txt"), "staged only\n").unwrap();
        git::git(&f.path, &["add", "a.txt"]).unwrap();
        std::fs::write(f.path.join("a.txt"), "original\n").unwrap();
        let op = f.preview().await;
        assert_eq!(op.files, vec!["a.txt"]);
        let done = f.run(&op).await.unwrap();
        let wt = worktree::get(&f.db, "test", &done.worktree_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            git::split::index_tree(Path::new(&wt.path)).unwrap(),
            op.index_tree
        );
        assert_eq!(
            git::split::snapshot(Path::new(&wt.path)).unwrap(),
            op.snapshot_tree
        );
        f.db.close().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn refuses_symlink_destination_without_stashing_source() {
        let f = Fixture::new().await;
        std::fs::write(f.path.join("new.txt"), "remaining\n").unwrap();
        let op = f.preview().await;
        std::fs::create_dir_all(f.path.join(".santree")).unwrap();
        std::os::unix::fs::symlink(f._scratch.path(), f.path.join(".santree/worktrees")).unwrap();
        assert!(f
            .run(&op)
            .await
            .unwrap_err()
            .to_string()
            .contains("symlink"));
        assert!(f.path.join("new.txt").exists());
        assert!(git::split::find_backup(&f.path, &op.id).unwrap().is_none());
        f.db.close().await;
    }
    #[tokio::test]
    async fn refreshes_failed_move_before_backup_and_reuses_clean_child() {
        let f = Fixture::new().await;
        std::fs::write(f.path.join("new.txt"), "original remainder\n").unwrap();
        let mut op = f.preview().await;
        op.branch = Some("feature-next".into());
        op.ticket_id = Some("AK-456".into());
        save(&f.db, f.path.to_str().unwrap(), &op).await.unwrap();
        worktree::create(
            &f.db,
            "test",
            &op.worktree_id,
            "feature-next",
            None,
            Some(&op.head),
            None,
            worktree::BranchPlan::Split("feature-next"),
        )
        .await
        .unwrap();
        std::fs::write(f.path.join("new.txt"), "newer remainder\n").unwrap();
        assert!(f.run(&op).await.is_err());
        let refreshed = f.preview().await;
        assert_eq!(refreshed.id, op.id);
        assert_ne!(refreshed.snapshot_tree, op.snapshot_tree);
        let done = f.run(&refreshed).await.unwrap();
        let wt = worktree::get(&f.db, "test", &done.worktree_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(Path::new(&wt.path).join("new.txt")).unwrap(),
            "newer remainder\n"
        );
        f.db.close().await;
    }

    #[tokio::test]
    async fn root_source_keeps_santree_metadata_and_never_moves_nested_worktrees() {
        let f = Fixture::new().await;
        std::fs::write(f.path.join(".gitignore"), "*.secret\n").unwrap();
        git::git(&f.path, &["add", ".gitignore"]).unwrap();
        git::git(&f.path, &["commit", "-m", "use nested ignores"]).unwrap();
        std::fs::write(f.path.join("new.txt"), "remaining\n").unwrap();
        let op = preview(&f.db, "test", worktree::BASE_ID).await.unwrap();
        assert_eq!(op.files, vec!["new.txt"]);
        let done = f.run(&op).await.unwrap();
        assert!(f.path.join(".santree/.gitignore").exists());
        assert!(f
            .path
            .join(".santree/worktrees")
            .join(&done.worktree_id)
            .exists());
        let after = preview(&f.db, "test", worktree::BASE_ID).await.unwrap();
        assert!(after.files.is_empty());
        assert!(!f.path.join("new.txt").exists());
        f.db.close().await;
    }
    #[tokio::test]
    async fn dirty_path_snapshot_keeps_intent_to_add_and_excludes_ignored_directory_contents() {
        let f = Fixture::new().await;
        std::fs::write(f.path.join("intent.secret"), "intent to add\n").unwrap();
        git::git(&f.path, &["add", "-N", "-f", "intent.secret"]).unwrap();
        std::fs::remove_file(f.path.join("a.txt")).unwrap();
        std::fs::create_dir(f.path.join("a.txt")).unwrap();
        std::fs::write(f.path.join("a.txt/visible.txt"), "include\n").unwrap();
        std::fs::write(f.path.join("a.txt/ignored.secret"), "stay ignored\n").unwrap();
        let before = git::split::index_tree(&f.path).unwrap();
        let tree = git::split::snapshot(&f.path).unwrap();
        let names = git::git(&f.path, &["ls-tree", "-r", "--name-only", &tree]).unwrap();
        assert!(names.lines().any(|p| p == "intent.secret"));
        assert!(names.lines().any(|p| p == "a.txt/visible.txt"));
        assert!(!names.lines().any(|p| p == "a.txt/ignored.secret"));
        assert_eq!(git::split::index_tree(&f.path).unwrap(), before);
        f.db.close().await;
    }
}
