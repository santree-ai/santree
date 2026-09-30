//! A Daedalus project's reads, end to end over the link: the worktree
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
use crate::git::{self, Checkout};
use crate::repo;
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
/// server's.
fn fake_agent(server: &Server, socket_dir: &Path) -> FakeAgent {
    let daemon = FakeDaemon::with_options(FakeOptions {
        projects_root: server.root.to_string_lossy().into_owned(),
        ..FakeOptions::default()
    });
    FakeAgent::serve(socket_dir.join("santree.sock"), daemon).unwrap()
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
    let agent = fake_agent(&server, scratch.path());
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

/// With the link down, a Daedalus project's reads fail with the link's own
/// state — and run nothing here, though the same path exists on this machine.
/// The operations that still need this machine's filesystem refuse a Daedalus
/// checkout outright, link or no link.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nothing_runs_locally_when_the_link_is_down() {
    let server = server();
    let scratch = tempfile::tempdir().unwrap();
    let (db, repo) = registered(&server, scratch.path()).await;
    let agent = fake_agent(&server, scratch.path());
    agent.refuse("santree_off", "santree is off for this machine");
    let link = link_through(&agent);
    let off = link.settled(Duration::from_secs(5)).await;
    assert_eq!(off, santree_core::domain::DaedalusLink::SantreeOff);

    let said = describe(&off);
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
    let calls = git::git_calls_under(&server.web);
    assert_eq!(calls, 0, "no git ran for the project, anywhere");
    // And no shell opens in it here: `terminal_open` asks this first.
    assert!(repo::on_daedalus(&db, &server.web.join("src"))
        .await
        .unwrap());
    assert!(!repo::on_daedalus(&db, &server.root.join("webby"))
        .await
        .unwrap());

    // Back on: the same reads answer.
    agent.admit();
    link.retry_now();
    assert!(!worktree::status(&db, &link, &repo, BASE_ID)
        .await
        .unwrap()
        .is_empty());

    // Creating a worktree still needs this machine's filesystem: refused for a
    // Daedalus checkout before anything is made.
    let client = link.client().unwrap();
    let web = Checkout::daedalus(client, &server.web);
    let target = server.web.join(".santree/worktrees/AK-2");
    let made = tokio::task::spawn_blocking(move || {
        git::create_worktree(&web, &target, "santree/ak-2", "main")
    })
    .await
    .unwrap();
    assert!(made.is_err());
    assert!(!server.web.join(".santree/worktrees/AK-2").exists());
}
