//! A Daedalus project's git, end to end over the link — its reads and its
//! writes (staging, commits, push and pull, worktrees, a split): the worktree
//! commands, through [`crate::repo::checkout`] and the git seam, to a fake
//! session host (`FakeAgent` in front of a `FakeDaemon`) running real git in a
//! real repository. The "server" is this machine's temp dir, which is also
//! what makes the link-down test mean something: the path exists here, and
//! nothing may read it.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use santree_core::domain::{FileStatus, RepoLocation};
use santree_remote_client::fake::{FakeAgent, FakeDaemon, FakeOptions};
use santree_remote_client::{ClientOptions, HostOptions};

use super::host::{describe, DaedalusHost};
use crate::db::Db;
use crate::git;
use crate::repo;
use crate::split_stack;
use crate::worktree::{self, BASE_ID};

fn fast() -> HostOptions {
    HostOptions {
        backoff_min: Duration::from_millis(20),
        backoff_max: Duration::from_millis(200),
        hello_timeout: Duration::from_secs(5),
        client: ClientOptions::default(),
    }
}

fn run_git(dir: &Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {out:?}");
}

/// The box: a projects root holding `web`, a checkout on `feature` (one commit
/// past `main`) with a tracked worktree beside it, and uncommitted work in the
/// root — a modification, a staged new file, an untracked file and an
/// untracked symlink that leaves the checkout.
struct Server {
    _dir: tempfile::TempDir,
    root: PathBuf,
    web: PathBuf,
    worktree: PathBuf,
}

fn server() -> Server {
    let dir = tempfile::tempdir().unwrap();
    // Canonical, so the paths git prints match the ones compared against.
    let root = std::fs::canonicalize(dir.path()).unwrap().join("projects");
    let web = root.join("web");
    std::fs::create_dir_all(&web).unwrap();
    run_git(&web, &["init", "-b", "main"]);
    run_git(&web, &["config", "user.name", "Test"]);
    run_git(&web, &["config", "user.email", "test@example.test"]);
    std::fs::write(web.join("a.txt"), "one\ntwo\n").unwrap();
    std::fs::write(web.join("b.txt"), "keep\n").unwrap();
    run_git(&web, &["add", "."]);
    run_git(&web, &["commit", "-m", "base"]);
    // The origin is a bare repo beside the root: `refresh_remote_ref` fetches, and
    // a test must not reach the network.
    let origin = dir.path().join("origin.git");
    run_git(
        dir.path(),
        &["init", "--bare", "-b", "main", &origin.to_string_lossy()],
    );
    run_git(
        &web,
        &["remote", "add", "origin", &origin.to_string_lossy()],
    );
    run_git(&web, &["push", "-q", "origin", "main"]);
    run_git(&web, &["switch", "-c", "feature"]);
    std::fs::write(web.join("c.txt"), "committed on feature\n").unwrap();
    run_git(&web, &["add", "c.txt"]);
    run_git(&web, &["commit", "-m", "feature work"]);

    let worktree = web.join(".santree/worktrees/AK-1");
    run_git(
        &web,
        &[
            "worktree",
            "add",
            "-b",
            "santree/ak-1",
            &worktree.to_string_lossy(),
            "main",
        ],
    );
    std::fs::write(worktree.join("b.txt"), "keep\nmore\n").unwrap();

    std::fs::write(web.join("a.txt"), "one\ntwo\nthree\n").unwrap();
    std::fs::write(web.join("staged.txt"), "s1\n").unwrap();
    run_git(&web, &["add", "staged.txt"]);
    std::fs::write(web.join("new.txt"), "n1\nn2").unwrap();
    std::fs::write(dir.path().join("secret.txt"), "outside\n").unwrap();
    std::os::unix::fs::symlink(dir.path().join("secret.txt"), web.join("escape.txt")).unwrap();
    Server {
        _dir: dir,
        root,
        web,
        worktree,
    }
}

/// A fresh database with `web` registered as a Daedalus project, and the
/// worktree tracked the way `worktree::create` would have recorded it.
async fn registered(server: &Server, db_dir: &Path) -> (Db, String) {
    let db = crate::db::init(db_dir.join("test.db")).await.unwrap();
    let web = server.web.to_string_lossy().into_owned();
    let repo = repo::add_daedalus(&db, &web, Some("git@github.com:acme/web.git"))
        .await
        .unwrap();
    assert_eq!(repo.location, RepoLocation::Daedalus);
    sqlx::query(
        "INSERT INTO worktree_links (repo_path, issue_id, branch, worktree_path, base_branch)
         VALUES (?, 'AK-1', 'santree/ak-1', ?, 'main')",
    )
    .bind(&web)
    .bind(server.worktree.to_string_lossy())
    .execute(&db)
    .await
    .unwrap();
    (db, repo.name)
}

/// A fake agent in front of a fake session host whose projects root is the
/// server's — and that host, whose exec log says what ran on the "box".
fn fake_agent(server: &Server, socket_dir: &Path) -> (FakeAgent, FakeDaemon) {
    let daemon = FakeDaemon::with_options(FakeOptions {
        projects_root: server.root.to_string_lossy().into_owned(),
        ..FakeOptions::default()
    });
    let agent = FakeAgent::serve(socket_dir.join("santree.sock"), daemon.clone()).unwrap();
    (agent, daemon)
}

/// The app's link, through `agent`.
fn link_through(agent: &FakeAgent) -> DaedalusHost {
    let link = DaedalusHost::with_connector(Arc::new(agent.connector()), fast());
    link.resume(None);
    link
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_daedalus_projects_worktrees_and_changes_are_read_on_the_box() {
    let server = server();
    let scratch = tempfile::tempdir().unwrap();
    let (db, repo) = registered(&server, scratch.path()).await;
    let (agent, _daemon) = fake_agent(&server, scratch.path());
    let link = link_through(&agent);

    // The root, as the base entry: on `feature`, measured against `main`.
    let base = worktree::base_worktree(&db, &link, &repo)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (base.branch.as_str(), base.base_branch.as_str()),
        ("feature", "main")
    );
    assert_eq!(base.path, server.web.to_string_lossy());
    assert!(base.dirty);
    assert_eq!(base.ahead, 1, "one commit past main");

    // The tracked worktree, with live stats.
    let listed = worktree::list(&db, &link, &repo).await.unwrap();
    assert_eq!(listed.len(), 1);
    let ak1 = &listed[0];
    assert_eq!(
        (ak1.id.as_str(), ak1.branch.as_str(), ak1.path.as_str()),
        ("AK-1", "santree/ak-1", &*server.worktree.to_string_lossy())
    );
    assert!(ak1.dirty);
    assert_eq!((ak1.add_lines, ak1.del_lines), (1, 0));

    // The changes list: modified, staged, untracked (counted by reading it on
    // the box), and the symlink as git reports it.
    let changes = worktree::status(&db, &link, &repo, BASE_ID).await.unwrap();
    let row = |path: &str| {
        changes
            .iter()
            .find(|c| c.path == path)
            .unwrap_or_else(|| panic!("{path} in {changes:?}"))
    };
    let a = row("a.txt");
    assert_eq!(
        (a.status, a.staged, a.add_lines, a.del_lines),
        (FileStatus::Modified, false, 1, 0)
    );
    let staged = row("staged.txt");
    assert_eq!((staged.status, staged.staged), (FileStatus::Added, true));
    let new = row("new.txt");
    assert_eq!(
        (new.status, new.add_lines, new.binary),
        (FileStatus::Untracked, 2, false),
        "an unterminated last line still counts"
    );
    assert_eq!(row("escape.txt").status, FileStatus::Untracked);

    // A tracked file's diff, and an untracked one's as all additions.
    let diff = worktree::file_diff(&db, &link, &repo, BASE_ID, "a.txt", false)
        .await
        .unwrap();
    assert!(diff.contains("+three"), "{diff}");
    let diff = worktree::file_diff(&db, &link, &repo, BASE_ID, "new.txt", true)
        .await
        .unwrap();
    assert!(diff.contains("+n1") && diff.contains("+n2"), "{diff}");
    // The symlink resolves outside the checkout: the host refuses to read
    // through it, so git is never handed it.
    let escaped = worktree::file_diff(&db, &link, &repo, BASE_ID, "escape.txt", true).await;
    assert!(escaped.is_err(), "{escaped:?}");
    assert!(
        worktree::file_diff(&db, &link, &repo, BASE_ID, "../web/a.txt", false)
            .await
            .is_err(),
        "a path that climbs out never leaves this machine"
    );

    // Both sides of a file, for the diff viewer's context.
    let source = worktree::file_source(&db, &link, &repo, BASE_ID, "a.txt")
        .await
        .unwrap();
    assert_eq!(
        (source.old_text.as_str(), source.new_text.as_str()),
        ("one\ntwo\n", "one\ntwo\nthree\n")
    );

    // What the branch committed over its base, and one file of it.
    let committed = worktree::branch_changes(&db, &link, &repo, BASE_ID)
        .await
        .unwrap();
    let paths: Vec<_> = committed.iter().map(|c| c.path.as_str()).collect();
    assert_eq!(paths, ["c.txt"]);
    assert_eq!(committed[0].status, FileStatus::Added);
    let diff = worktree::branch_file_diff(&db, &link, &repo, BASE_ID, "c.txt")
        .await
        .unwrap();
    assert!(diff.contains("+committed on feature"), "{diff}");
    let untouched = worktree::branch_file_diff(&db, &link, &repo, "AK-1", "b.txt")
        .await
        .unwrap();
    assert!(untouched.is_empty(), "AK-1 committed nothing: {untouched}");

    // Every browsable file, and the branch picker's list.
    let files = worktree::files(&db, &link, &repo, BASE_ID).await.unwrap();
    for path in ["a.txt", "b.txt", "c.txt", "new.txt", "staged.txt"] {
        assert!(files.iter().any(|f| f == path), "{path} in {files:?}");
    }
    let branches = worktree::branches(&db, &link, &repo).await.unwrap();
    let names: Vec<_> = branches.iter().map(|b| b.name.as_str()).collect();
    for name in ["main", "feature", "santree/ak-1"] {
        assert!(names.contains(&name), "{name} in {names:?}");
    }
    assert!(branches
        .iter()
        .find(|b| b.name == "santree/ak-1")
        .is_some_and(|b| b.has_worktree));
}

/// With the link down, a Daedalus project's reads and writes fail with the
/// link's own state — and run nothing, here or there, though the same path
/// exists on this machine. Staging, committing, pushing, pulling, worktrees
/// and a split all resolve through `repo::checkout`, whose one answer for a
/// down link is `NotConnected`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nothing_runs_locally_when_the_link_is_down() {
    let server = server();
    let scratch = tempfile::tempdir().unwrap();
    let (db, repo) = registered(&server, scratch.path()).await;
    let (agent, daemon) = fake_agent(&server, scratch.path());
    agent.refuse("santree_off", "santree is off for this machine");
    let link = link_through(&agent);
    let off = link.settled(Duration::from_secs(5)).await;
    assert_eq!(off, santree_core::domain::DaedalusLink::SantreeOff);

    let said = describe(&off);
    let refused = |result: anyhow::Result<()>, what: &str| {
        assert_eq!(
            result.expect_err(what).to_string(),
            said,
            "{what} fails with the link's state"
        );
    };
    let status = worktree::status(&db, &link, &repo, BASE_ID).await;
    assert_eq!(status.unwrap_err().to_string(), said);
    let listed = worktree::list(&db, &link, &repo).await;
    assert_eq!(listed.unwrap_err().to_string(), said);
    assert!(worktree::base_worktree(&db, &link, &repo).await.is_err());
    assert!(
        worktree::file_diff(&db, &link, &repo, BASE_ID, "a.txt", false)
            .await
            .is_err()
    );

    refused(
        worktree::stage(&db, &link, &repo, "AK-1", "b.txt").await,
        "stage",
    );
    refused(
        worktree::stage_all(&db, &link, &repo, "AK-1").await,
        "stage all",
    );
    refused(
        worktree::unstage_all(&db, &link, &repo, BASE_ID).await,
        "unstage all",
    );
    refused(
        worktree::discard(&db, &link, &repo, "AK-1", "b.txt", false).await,
        "discard",
    );
    refused(
        worktree::commit(&db, &link, &repo, BASE_ID, "nope", true).await,
        "commit",
    );
    refused(worktree::push(&db, &link, &repo, "AK-1").await, "push");
    refused(
        worktree::pull_remote(&db, &link, &repo, "AK-1").await,
        "pull",
    );
    refused(
        worktree::pull(&db, &link, &repo, "AK-1").await.map(drop),
        "pull base",
    );
    refused(
        worktree::update_base(&db, &link, &repo, BASE_ID)
            .await
            .map(drop),
        "update base",
    );
    refused(
        worktree::commit_message(&db, &link, &repo, BASE_ID)
            .await
            .map(drop),
        "commit message",
    );
    // Creating and removing a worktree start from the repo's root checkout,
    // which is where a down link stops them.
    refused(
        worktree::root(&db, &link, &repo).await.map(drop),
        "worktree root",
    );
    refused(
        split_stack::preview(&db, &link, &repo, "AK-1")
            .await
            .map(drop),
        "split preview",
    );

    let calls = git::git_calls_under(&server.web);
    assert_eq!(calls, 0, "no git ran for the project, anywhere");
    assert!(
        daemon.exec_log().is_empty(),
        "nothing ran on the box either"
    );
    // Nothing changed: the worktree's edit is unstaged and in place.
    assert_eq!(
        std::fs::read_to_string(server.worktree.join("b.txt")).unwrap(),
        "keep\nmore\n"
    );
    assert_eq!(
        git_out(&server.worktree, &["diff", "--cached", "--name-only"]),
        ""
    );
    // And no shell opens in it here: `terminal_open` asks this first.
    assert!(repo::daedalus_repo_at(&db, &server.web.join("src"))
        .await
        .unwrap()
        .is_some());
    assert!(repo::daedalus_repo_at(&db, &server.root.join("webby"))
        .await
        .unwrap()
        .is_none());

    // Back on: the same reads and writes answer.
    agent.admit();
    link.retry_now();
    assert!(!worktree::status(&db, &link, &repo, BASE_ID)
        .await
        .unwrap()
        .is_empty());
    worktree::stage(&db, &link, &repo, "AK-1", "b.txt")
        .await
        .unwrap();
    assert_eq!(
        git_out(&server.worktree, &["diff", "--cached", "--name-only"]),
        "b.txt"
    );
}

/// `git <args>` in `dir` on the "box" (this machine), read directly — how a
/// test checks what the link did, never through it.
fn git_out(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {out:?}");
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

/// Whether `argv` ran on the box, as the host's exec log saw it.
fn ran(daemon: &FakeDaemon, argv: &[&str]) -> bool {
    daemon
        .exec_log()
        .iter()
        .any(|seen| seen.iter().map(String::as_str).eq(argv.iter().copied()))
}

/// The commit box's writes and the sync buttons, on a Daedalus worktree: each
/// runs as `exec.run` on the box, in the checkout, and changes it there.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_daedalus_worktree_is_staged_committed_pushed_and_pulled_on_the_box() {
    let server = server();
    let scratch = tempfile::tempdir().unwrap();
    let (db, repo) = registered(&server, scratch.path()).await;
    let (agent, daemon) = fake_agent(&server, scratch.path());
    let link = link_through(&agent);
    let wt = &server.worktree;
    let staged = |dir: &Path| git_out(dir, &["diff", "--cached", "--name-only"]);

    // Stage one file, unstage it, stage everything.
    worktree::stage(&db, &link, &repo, "AK-1", "b.txt")
        .await
        .unwrap();
    assert_eq!(staged(wt), "b.txt");
    assert!(ran(&daemon, &["git", "add", "--", "b.txt"]));
    worktree::unstage(&db, &link, &repo, "AK-1", "b.txt")
        .await
        .unwrap();
    assert_eq!(staged(wt), "");

    // Discard: an untracked file is deleted, a tracked edit restored.
    std::fs::write(wt.join("scratch.txt"), "throwaway\n").unwrap();
    std::fs::write(wt.join("a.txt"), "one\ntwo\nlocal\n").unwrap();
    worktree::discard(&db, &link, &repo, "AK-1", "scratch.txt", true)
        .await
        .unwrap();
    assert!(!wt.join("scratch.txt").exists());
    worktree::discard(&db, &link, &repo, "AK-1", "a.txt", false)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(wt.join("a.txt")).unwrap(),
        "one\ntwo\n"
    );
    // A path that climbs out is refused here, before anything is sent.
    assert!(
        worktree::discard(&db, &link, &repo, "AK-1", "../../../a.txt", false)
            .await
            .is_err()
    );

    // Commit what's staged.
    worktree::stage_all(&db, &link, &repo, "AK-1")
        .await
        .unwrap();
    assert_eq!(staged(wt), "b.txt");
    worktree::commit(&db, &link, &repo, "AK-1", "AK-1: more", false)
        .await
        .unwrap();
    assert_eq!(git_out(wt, &["log", "-1", "--format=%s"]), "AK-1: more");
    assert_eq!(git_out(wt, &["status", "--porcelain"]), "");

    // Push to the (bare, local) origin.
    worktree::push(&db, &link, &repo, "AK-1").await.unwrap();
    let origin = server._dir.path().join("origin.git");
    assert_eq!(
        git_out(&origin, &["rev-parse", "refs/heads/santree/ak-1"]),
        git_out(wt, &["rev-parse", "HEAD"])
    );
    assert!(ran(
        &daemon,
        &["git", "push", "-u", "origin", "santree/ak-1"]
    ));

    // A teammate lands work on main.
    let teammate = scratch.path().join("teammate");
    run_git(
        scratch.path(),
        &["clone", "-q", &origin.to_string_lossy(), "teammate"],
    );
    run_git(&teammate, &["config", "user.name", "Mate"]);
    run_git(&teammate, &["config", "user.email", "mate@example.test"]);
    std::fs::write(teammate.join("theirs.txt"), "from main\n").unwrap();
    run_git(&teammate, &["add", "theirs.txt"]);
    run_git(&teammate, &["commit", "-q", "-m", "theirs"]);
    run_git(&teammate, &["push", "-q", "origin", "main"]);
    let their_main = git_out(&teammate, &["rev-parse", "HEAD"]);

    // "Update base" fast-forwards the root's own `main` (it is on `feature`).
    let base = worktree::update_base(&db, &link, &repo, BASE_ID)
        .await
        .unwrap();
    assert_eq!(base, "main");
    assert_eq!(
        git_out(&server.web, &["rev-parse", "refs/heads/main"]),
        their_main
    );
    // "Pull from main" merges it into the worktree.
    worktree::pull(&db, &link, &repo, "AK-1").await.unwrap();
    assert_eq!(
        std::fs::read_to_string(wt.join("theirs.txt")).unwrap(),
        "from main\n"
    );
    // "Pull" takes a commit someone pushed to the branch itself.
    run_git(&teammate, &["fetch", "-q", "origin", "santree/ak-1"]);
    run_git(
        &teammate,
        &["switch", "-q", "-c", "santree/ak-1", "origin/santree/ak-1"],
    );
    std::fs::write(teammate.join("suggested.txt"), "a suggestion\n").unwrap();
    run_git(&teammate, &["add", "suggested.txt"]);
    run_git(&teammate, &["commit", "-q", "-m", "suggestion"]);
    run_git(&teammate, &["push", "-q", "origin", "santree/ak-1"]);
    worktree::pull_remote(&db, &link, &repo, "AK-1")
        .await
        .unwrap();
    assert!(wt.join("suggested.txt").exists());

    // Everything above ran on the box, and only git ran there.
    let log = daemon.exec_log();
    assert!(!log.is_empty());
    assert!(log.iter().all(|argv| argv[0] == "git"), "{log:?}");
}

/// Creating and removing worktrees on the box: the `.santree/worktrees`
/// layout, the ignore file, reclaiming an empty leftover, and the branch going
/// with the tree.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn daedalus_worktrees_are_created_and_removed_on_the_box() {
    let server = server();
    let scratch = tempfile::tempdir().unwrap();
    let (db, repo) = registered(&server, scratch.path()).await;
    let (agent, daemon) = fake_agent(&server, scratch.path());
    let link = link_through(&agent);
    let root = worktree::root(&db, &link, &repo).await.unwrap();
    let dir = server.web.join(".santree/worktrees/AK-2");

    let created = worktree::create(
        &db,
        &root,
        &repo,
        "AK-2",
        "Second thing",
        None,
        None,
        None,
        worktree::BranchPlan::Derived,
    )
    .await
    .unwrap();
    assert_eq!(created.path, dir.to_string_lossy());
    assert_eq!(created.branch, "santree/ak-2-second-thing");
    assert_eq!(
        git_out(&dir, &["symbolic-ref", "--short", "HEAD"]),
        "santree/ak-2-second-thing"
    );
    let ignore = std::fs::read_to_string(server.web.join(".santree/.gitignore")).unwrap();
    assert!(ignore.lines().any(|l| l == "worktrees/"), "{ignore}");
    let ids: Vec<_> = worktree::list(&db, &link, &repo)
        .await
        .unwrap()
        .into_iter()
        .map(|w| w.id)
        .collect();
    assert!(ids.contains(&"AK-2".to_string()), "{ids:?}");
    // Again: the tracked tree is returned, nothing is re-made.
    let again = worktree::create(
        &db,
        &root,
        &repo,
        "AK-2",
        "Second thing",
        None,
        None,
        None,
        worktree::BranchPlan::Derived,
    )
    .await
    .unwrap();
    assert_eq!(again.path, created.path);

    // An empty leftover where a tree belongs is reclaimed on the box.
    let leftover = server.web.join(".santree/worktrees/AK-3");
    std::fs::create_dir_all(&leftover).unwrap();
    worktree::create(
        &db,
        &root,
        &repo,
        "AK-3",
        "Third",
        None,
        None,
        None,
        worktree::BranchPlan::New("ak-3-work"),
    )
    .await
    .unwrap();
    assert_eq!(
        git_out(&leftover, &["symbolic-ref", "--short", "HEAD"]),
        "ak-3-work"
    );
    assert!(ran(&daemon, &["rmdir", "--", &leftover.to_string_lossy()]));

    // Removing takes the tree and its branch.
    worktree::remove(&db, &root, &repo, "AK-2", None)
        .await
        .unwrap();
    assert!(!dir.exists());
    let branch = std::process::Command::new("git")
        .current_dir(&server.web)
        .args([
            "rev-parse",
            "--verify",
            "-q",
            "refs/heads/santree/ak-2-second-thing",
        ])
        .status()
        .unwrap();
    assert!(!branch.success(), "the branch went with the tree");
    let ids: Vec<_> = worktree::list(&db, &link, &repo)
        .await
        .unwrap()
        .into_iter()
        .map(|w| w.id)
        .collect();
    assert!(!ids.contains(&"AK-2".to_string()), "{ids:?}");
}

/// Splitting a branch on the box: the preview's private index and the move's
/// recovery stash run in the checkout there, the child worktree gets the
/// remaining edits (staging kept), and no scratch index is left behind.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_daedalus_branch_is_split_on_the_box() {
    let server = server();
    let scratch = tempfile::tempdir().unwrap();
    let (db, repo) = registered(&server, scratch.path()).await;
    let (agent, daemon) = fake_agent(&server, scratch.path());
    let link = link_through(&agent);
    let wt = &server.worktree;
    // AK-1 has a commit of its own past `main`, and edits after it: one
    // staged, one not, one untracked.
    std::fs::write(wt.join("first.txt"), "the first part\n").unwrap();
    run_git(wt, &["add", "first.txt"]);
    run_git(wt, &["commit", "-q", "-m", "first part"]);
    std::fs::write(wt.join("staged.txt"), "staged for later\n").unwrap();
    run_git(wt, &["add", "staged.txt"]);
    std::fs::write(wt.join("later.txt"), "untracked for later\n").unwrap();
    let head = git_out(wt, &["rev-parse", "HEAD"]);

    let op = split_stack::preview(&db, &link, &repo, "AK-1")
        .await
        .unwrap();
    assert_eq!(op.head, head);
    assert_eq!(op.files, ["b.txt", "later.txt", "staged.txt"]);
    // Previewing changed nothing.
    assert_eq!(
        git_out(wt, &["diff", "--cached", "--name-only"]),
        "staged.txt"
    );

    let done = split_stack::move_remaining(&db, &link, &repo, &op.id, "ak-1-next", None)
        .await
        .unwrap();
    assert!(done.completed);
    assert!(!done.source_has_changes);
    let child = server
        .web
        .join(".santree/worktrees")
        .join(&done.worktree_id);
    assert_eq!(
        git_out(&child, &["symbolic-ref", "--short", "HEAD"]),
        "ak-1-next"
    );
    assert_eq!(git_out(&child, &["rev-parse", "HEAD"]), head);
    assert_eq!(
        std::fs::read_to_string(child.join("b.txt")).unwrap(),
        "keep\nmore\n"
    );
    assert!(child.join("later.txt").exists());
    assert_eq!(
        git_out(&child, &["diff", "--cached", "--name-only"]),
        "staged.txt",
        "staging is kept"
    );
    assert_eq!(git_out(wt, &["status", "--porcelain"]), "");
    assert!(daemon
        .exec_log()
        .iter()
        .any(|argv| argv.iter().any(|a| a == "stash") && argv.iter().any(|a| a == "push")));

    // Every private index was removed on the box, with any lock beside it.
    let mut left = Vec::new();
    let mut dirs = vec![server.web.join(".git")];
    while let Some(dir) = dirs.pop() {
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                dirs.push(path);
            } else if entry
                .file_name()
                .to_string_lossy()
                .starts_with("santree-split-")
            {
                left.push(path);
            }
        }
    }
    assert!(left.is_empty(), "{left:?}");
}
