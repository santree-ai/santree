//! A Daedalus project's terminals and setup scripts, end to end over the link:
//! `terminal::open` and the worktree setup commands, through the app's
//! `DaedalusHost`, to a fake session host (`FakeAgent` in front of a
//! `FakeDaemon`, whose PTYs are a real `PtyManager`). The "box" is this
//! machine's temp dir, which is what makes the link-down test mean something:
//! the path exists here, and nothing may run in it.
//!
//! Every wait is on a condition — bytes on the pane, a state on the link, a
//! session in the box's table — never on a guessed interval.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::watch;

use santree_core::domain::{DaedalusLink, RepoLocation};
use santree_pty::{PtyManager, SessionId};
use santree_remote_client::fake::{FakeAgent, FakeDaemon, FakeOptions};
use santree_remote_client::proto::{Anchor, ReplayMode};
use santree_remote_client::{ClientOptions, HostOptions};

use super::host::{describe, DaedalusHost};
use super::terminals::{self, Sinks, Spec};
use crate::db::Db;
use crate::repo;
use crate::stream::StreamEvent;
use crate::terminal::{self, PaneLink, RawBytes, TerminalOpenOpts};
use crate::worktree;

const WAIT: Duration = Duration::from_secs(20);

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

/// The box: a projects root holding `web`, with a tracked worktree `AK-1`.
struct Server {
    _dir: tempfile::TempDir,
    root: PathBuf,
    web: PathBuf,
    worktree: PathBuf,
}

fn server() -> Server {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap().join("projects");
    let web = root.join("web");
    std::fs::create_dir_all(&web).unwrap();
    run_git(&web, &["init", "-q", "-b", "main"]);
    run_git(&web, &["config", "user.name", "Test"]);
    run_git(&web, &["config", "user.email", "test@example.test"]);
    std::fs::write(web.join("a.txt"), "one\n").unwrap();
    run_git(&web, &["add", "."]);
    run_git(&web, &["commit", "-q", "-m", "base"]);
    let worktree = web.join(".santree/worktrees/AK-1");
    run_git(
        &web,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "santree/ak-1",
            &worktree.to_string_lossy(),
            "main",
        ],
    );
    Server {
        _dir: dir,
        root,
        web,
        worktree,
    }
}

/// A database with `web` registered as a Daedalus project and `AK-1` tracked.
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

fn fake_agent(server: &Server, socket_dir: &Path) -> (FakeAgent, FakeDaemon) {
    let daemon = FakeDaemon::with_options(FakeOptions {
        projects_root: server.root.to_string_lossy().into_owned(),
        ..FakeOptions::default()
    });
    let agent = FakeAgent::serve(socket_dir.join("santree.sock"), daemon.clone()).unwrap();
    (agent, daemon)
}

fn link_through(agent: &FakeAgent) -> DaedalusHost {
    let link = DaedalusHost::with_connector(Arc::new(agent.connector()), fast());
    link.resume(None);
    link
}

/// What a pane has been sent: its bytes, whether it was told the process
/// exited, and every link state in order. Every change bumps `changed`, so a
/// test waits on a condition over it rather than on time.
#[derive(Clone)]
struct Screen {
    out: Arc<Mutex<Vec<u8>>>,
    exited: Arc<Mutex<bool>>,
    links: Arc<Mutex<Vec<PaneLink>>>,
    changed: Arc<watch::Sender<u64>>,
}

impl Screen {
    fn new() -> Self {
        Self {
            out: Arc::default(),
            exited: Arc::default(),
            links: Arc::default(),
            changed: Arc::new(watch::channel(0).0),
        }
    }

    fn bump(&self) {
        self.changed.send_modify(|n| *n += 1);
    }

    fn output(&self, bytes: Vec<u8>) {
        if bytes.is_empty() {
            *self.exited.lock().unwrap() = true;
        } else {
            self.out.lock().unwrap().extend(bytes);
        }
        self.bump();
    }

    fn link(&self, link: PaneLink) {
        self.links.lock().unwrap().push(link);
        self.bump();
    }

    fn sinks(&self) -> Sinks {
        let (out, link) = (self.clone(), self.clone());
        Sinks {
            output: Arc::new(move |bytes| out.output(bytes)),
            link: Arc::new(move |state| link.link(state)),
        }
    }

    /// The pane's channels as `terminal::open` takes them.
    fn channels(&self) -> (Channel<RawBytes>, Channel<PaneLink>) {
        let (out, link) = (self.clone(), self.clone());
        let output = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                out.output(bytes);
            }
            Ok(())
        });
        let links = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                link.link(match json.as_str() {
                    "\"live\"" => PaneLink::Live,
                    "\"reconnecting\"" => PaneLink::Reconnecting,
                    other => panic!("unexpected link state {other}"),
                });
            }
            Ok(())
        });
        (output, links)
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.out.lock().unwrap()).into_owned()
    }

    fn len(&self) -> u64 {
        self.out.lock().unwrap().len() as u64
    }

    fn count(&self, needle: &str) -> usize {
        self.text().matches(needle).count()
    }

    fn links(&self) -> Vec<PaneLink> {
        self.links.lock().unwrap().clone()
    }

    fn last_link(&self) -> Option<PaneLink> {
        self.links.lock().unwrap().last().copied()
    }

    fn exited(&self) -> bool {
        *self.exited.lock().unwrap()
    }

    async fn until(&self, what: &str, cond: impl Fn(&Screen) -> bool) {
        let mut changed = self.changed.subscribe();
        let met = tokio::time::timeout(WAIT, changed.wait_for(|_| cond(self))).await;
        assert!(
            met.is_ok(),
            "timed out waiting for {what}; the pane has {:?}, links {:?}",
            self.text(),
            self.links()
        );
    }
}

/// Wait for state outside the pane (the box's PTY table): checked on every
/// scheduler turn until it holds, bounded by [`WAIT`].
async fn until(what: &str, cond: impl Fn() -> bool) {
    let met = tokio::time::timeout(WAIT, async {
        while !cond() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    assert!(met.is_ok(), "timed out waiting for {what}");
}

/// A shell in the worktree on the box, as the "+" opens one.
fn shell(server: &Server, label: &str) -> Spec {
    Spec {
        cwd: server.worktree.to_string_lossy().into_owned(),
        command: "/bin/sh".into(),
        args: Vec::new(),
        env: vec![("TERM".into(), "xterm-256color".into())],
        label: label.into(),
        agent_kind: None,
    }
}

/// The box's live sessions under `label`.
fn box_sessions(daemon: &FakeDaemon, label: &str) -> Vec<santree_pty::SessionInfo> {
    daemon
        .pty()
        .sessions()
        .into_iter()
        .filter(|s| s.label == label && s.alive)
        .collect()
}

/// Type `line` + Enter into the pane.
fn type_line(link: &DaedalusHost, id: SessionId, line: &str) {
    link.terminals()
        .write(id, format!("{line}\n").into_bytes())
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_daedalus_terminal_runs_on_the_box_and_rides_out_detach_and_a_dropped_link() {
    let _serial = crate::stream::pty_guard().await;
    let server = server();
    let scratch = tempfile::tempdir().unwrap();
    let (agent, daemon) = fake_agent(&server, scratch.path());
    let link = link_through(&agent);
    let label = "tree:AK-1:tab:t1";

    // Open: a shell on the box, in the worktree there.
    let screen = Screen::new();
    let client = link.client_within(Duration::from_secs(5)).await.ok();
    let id = link
        .terminals()
        .open(
            shell(&server, label),
            "page-1".into(),
            (80, 24),
            client,
            screen.sinks(),
        )
        .await
        .unwrap();
    assert!(terminals::is_remote(id), "a remote pane has a remote id");
    assert_eq!(screen.links(), [PaneLink::Live]);
    let on_box = box_sessions(&daemon, label);
    assert_eq!(on_box.len(), 1, "one PTY on the box");
    assert_eq!(
        on_box[0].cwd.as_deref(),
        Some(&*server.worktree.to_string_lossy())
    );
    let pid = on_box[0].pid;

    // Write, read: the echo of `$((…))` differs from its result, so the result
    // counts the command's output alone.
    type_line(&link, id, "echo hello-$((40+2)); pwd");
    screen
        .until("the command's output", |s| s.count("hello-42") == 1)
        .await;
    screen
        .until("the worktree as its cwd", |s| {
            s.text().contains(&*server.worktree.to_string_lossy())
        })
        .await;

    // Resize: the box's PTY takes the new grid, and the shell sees it.
    link.terminals().resize(id, 100, 30).unwrap();
    until("the box's PTY resized", || {
        box_sessions(&daemon, label)
            .first()
            .is_some_and(|s| (s.cols, s.rows) == (100, 30))
    })
    .await;
    type_line(&link, id, "stty size");
    screen
        .until("the new grid", |s| s.text().contains("30 100"))
        .await;

    // Detach, and let the program print while nobody watches; re-attach from
    // where this screen stopped: exactly the missed bytes come back.
    let anchor = Anchor::At {
        epoch: on_box[0].epoch.clone(),
        seq: screen.len(),
    };
    link.terminals().detach(id);
    let remote = on_box[0].id;
    daemon
        .pty()
        .write(remote, b"echo detached-$((1+1))\n")
        .unwrap();
    let again = Screen::new();
    let attached = link
        .terminals()
        .attach(id, anchor, again.sinks())
        .await
        .unwrap();
    assert_eq!(attached.mode, ReplayMode::Exact);
    again
        .until("the output made while detached", |s| {
            s.count("detached-2") == 1
        })
        .await;
    assert!(
        !again.text().contains("hello-42"),
        "an exact re-attach replays only what was missed: {:?}",
        again.text()
    );

    // The link drops: the pane reads reconnecting — never exited — and when the
    // link is back it re-attaches from its anchor, missing nothing and
    // repeating nothing.
    daemon.disconnect_all();
    again
        .until("reconnecting", |s| {
            s.links().contains(&PaneLink::Reconnecting)
        })
        .await;
    daemon
        .pty()
        .write(remote, b"echo dropped-$((2+2))\n")
        .unwrap();
    again
        .until("live again", |s| {
            s.last_link() == Some(PaneLink::Live) && s.links().len() >= 3
        })
        .await;
    again
        .until("the output made across the drop", |s| {
            s.count("dropped-4") == 1
        })
        .await;
    type_line(&link, id, "echo after-$((3+3))");
    again
        .until("typing works again", |s| s.count("after-6") == 1)
        .await;
    assert_eq!(again.count("detached-2"), 1, "nothing replayed twice");
    assert!(!again.exited(), "a dropped link never ends a pane");
    let still = box_sessions(&daemon, label);
    assert_eq!(still.len(), 1, "the same one PTY on the box");
    assert_eq!(still[0].pid, pid, "the same process");

    // Close ends it on the box.
    link.terminals().close(id);
    until("the box's PTY closed", || {
        box_sessions(&daemon, label).is_empty()
    })
    .await;
}

/// santree quits and comes back: the pane opening under the same address
/// finds its session still running on the box — the same process, caught up
/// from the box's ring — and its launch line is not typed a second time.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_daedalus_terminal_survives_santree_restarting() {
    let _serial = crate::stream::pty_guard().await;
    let server = server();
    let scratch = tempfile::tempdir().unwrap();
    let (agent, daemon) = fake_agent(&server, scratch.path());
    let label = "tree:AK-1:tab:t2";

    let first = link_through(&agent);
    let screen = Screen::new();
    let client = first.client_within(Duration::from_secs(5)).await.ok();
    let id = first
        .terminals()
        .open(
            shell(&server, label),
            "page-1".into(),
            (80, 24),
            client,
            screen.sinks(),
        )
        .await
        .unwrap();
    type_line(&first, id, "echo before-$((5+5))");
    screen
        .until("the first run's output", |s| s.count("before-10") == 1)
        .await;
    let pid = box_sessions(&daemon, label)[0].pid;

    // Quit: this app's link goes, and the box sees the connection end.
    first.stop();
    daemon.disconnect_all();
    until("the box to see santree gone", || {
        daemon.connection_count() == 0
    })
    .await;
    assert_eq!(box_sessions(&daemon, label).len(), 1, "still running");

    // Relaunch: a new app, a new page, the same tab.
    let second = link_through(&agent);
    let back = Screen::new();
    let client = second.client_within(Duration::from_secs(5)).await.ok();
    let id = second
        .terminals()
        .open(
            shell(&server, label),
            "page-2".into(),
            (80, 24),
            client,
            back.sinks(),
        )
        .await
        .unwrap();
    back.until("the earlier output, replayed", |s| {
        s.count("before-10") == 1
    })
    .await;
    let found = box_sessions(&daemon, label);
    assert_eq!(found.len(), 1, "found again, not opened twice");
    assert_eq!(found[0].pid, pid, "the same process");

    // A found session is already running its launch: the seed isn't typed.
    second
        .terminals()
        .seed(id, "echo seeded-$((6+6))\r".into())
        .unwrap();
    type_line(&second, id, "echo typed-$((7+7))");
    back.until("typing reaches it", |s| s.count("typed-14") == 1)
        .await;
    assert_eq!(
        back.count("seeded-12"),
        0,
        "the launch line was typed again"
    );

    second.terminals().close(id);
    until("closed", || box_sessions(&daemon, label).is_empty()).await;
}

/// With the link down a Daedalus terminal is a pane waiting to reconnect —
/// nothing opens here or there, keystrokes go nowhere, a setup script is
/// refused with the link's state — and it opens on the box once the link is up.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nothing_runs_locally_while_the_link_is_down() {
    let _serial = crate::stream::pty_guard().await;
    let server = server();
    let scratch = tempfile::tempdir().unwrap();
    let (db, repo) = registered(&server, scratch.path()).await;
    let (agent, daemon) = fake_agent(&server, scratch.path());
    agent.refuse("santree_off", "santree is off for this machine");
    let link = link_through(&agent);
    let off = link.settled(Duration::from_secs(5)).await;
    assert_eq!(off, DaedalusLink::SantreeOff);

    let manager = PtyManager::new();
    let label = "tree:AK-1:tab:t3";
    let opts = |agent_kind| TerminalOpenOpts {
        cwd: Some(server.worktree.to_string_lossy().into_owned()),
        command: "/bin/sh".into(),
        args: Vec::new(),
        cols: 80,
        rows: 24,
        owner: "page-1".into(),
        label: label.into(),
        agent_kind,
    };

    let screen = Screen::new();
    let (output, links) = screen.channels();
    let id = terminal::open(&manager, &db, &link, opts(None), output, links)
        .await
        .unwrap();
    assert!(terminals::is_remote(id));
    assert_eq!(screen.links(), [PaneLink::Reconnecting]);
    type_line(&link, id, "echo lost-$((1+1))");
    assert!(manager.sessions().is_empty(), "no shell opened on this Mac");
    assert!(daemon.pty().sessions().is_empty(), "nor on the box");

    // Agents on the box are the next step: refused, not run anywhere.
    let (output, links) = Screen::new().channels();
    let agent_open = terminal::open(
        &manager,
        &db,
        &link,
        opts(Some(santree_core::domain::AgentKind::Claude)),
        output,
        links,
    )
    .await;
    assert!(agent_open.is_err(), "{agent_open:?}");
    // A cwd that climbs out of the project never leaves this machine.
    let (output, links) = Screen::new().channels();
    let climbing = TerminalOpenOpts {
        cwd: Some(format!("{}/../../etc", server.web.display())),
        ..opts(None)
    };
    assert!(
        terminal::open(&manager, &db, &link, climbing, output, links)
            .await
            .is_err()
    );

    // Setup is refused with the link's own state.
    let (events, log) = recording_channel();
    let setup = worktree::run_setup_streamed(&db, &link, &repo, "AK-1", events).await;
    assert_eq!(setup.unwrap_err().to_string(), describe(&off));
    assert!(log.lock().unwrap().is_empty());

    assert!(manager.sessions().is_empty(), "nothing ran on this Mac");
    assert!(daemon.pty().sessions().is_empty(), "nothing ran on the box");
    assert!(daemon.exec_log().is_empty(), "no command either");

    // Back on: the waiting pane opens on the box, and what was typed while it
    // couldn't reach it was never sent.
    agent.admit();
    link.retry_now();
    screen
        .until("the pane to go live", |s| {
            s.last_link() == Some(PaneLink::Live)
        })
        .await;
    assert_eq!(box_sessions(&daemon, label).len(), 1);
    type_line(&link, id, "echo found-$((2+2))");
    screen
        .until("the shell answers", |s| s.count("found-4") == 1)
        .await;
    assert_eq!(screen.count("lost-2"), 0, "stale keystrokes were replayed");
    assert!(manager.sessions().is_empty(), "still nothing on this Mac");

    link.terminals().close(id);
    until("closed", || box_sessions(&daemon, label).is_empty()).await;
}

// ── Setup scripts ────────────────────────────────────────────────────────────

/// A `Channel` recording the JSON of every `StreamEvent` — what the Setup tab
/// receives — with a signal on every event.
fn recording_channel() -> (Channel<StreamEvent>, Arc<Mutex<Vec<String>>>) {
    let log: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = log.clone();
    let channel = Channel::new(move |body| {
        if let InvokeResponseBody::Json(json) = body {
            sink.lock().unwrap().push(json);
        }
        Ok(())
    });
    (channel, log)
}

fn streamed(log: &Arc<Mutex<Vec<String>>>) -> String {
    log.lock().unwrap().join("")
}

fn write_init(server: &Server, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    let script = server.web.join(".santree/init.sh");
    std::fs::create_dir_all(script.parent().unwrap()).unwrap();
    std::fs::write(&script, body).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
}

async fn setup_ran(db: &Db) -> i64 {
    sqlx::query_scalar("SELECT setup_ran FROM worktree_links WHERE issue_id = 'AK-1'")
        .fetch_one(db)
        .await
        .unwrap()
}

/// The status files the wrapper leaves in the worktree's git dir.
fn status_files(server: &Server) -> Vec<String> {
    let git_dir = server.web.join(".git/worktrees/AK-1");
    std::fs::read_dir(git_dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("santree-setup-"))
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_daedalus_setup_script_runs_on_the_box() {
    let _serial = crate::stream::pty_guard().await;
    let server = server();
    let scratch = tempfile::tempdir().unwrap();
    let (db, repo) = registered(&server, scratch.path()).await;
    let (agent, daemon) = fake_agent(&server, scratch.path());
    let link = Arc::new(link_through(&agent));

    // Nothing to run yet: said so, and a success.
    let (events, log) = recording_channel();
    worktree::run_setup_streamed(&db, &link, &repo, "AK-1", events)
        .await
        .unwrap();
    assert!(
        streamed(&log).contains("nothing to run"),
        "{}",
        streamed(&log)
    );
    assert!(streamed(&log).contains(r#""ok":true"#));

    // A script that succeeds: its output streams, in the worktree on the box,
    // with santree's two variables and a colour-capable TERM on a real tty.
    write_init(
        &server,
        "#!/bin/sh\ntest -t 1 && echo \"tty=yes term=$TERM\"\necho \"in=$PWD\"\n\
         echo \"wt=$SANTREE_WORKTREE_PATH root=$SANTREE_REPO_ROOT\"\n",
    );
    let (events, log) = recording_channel();
    worktree::run_setup_streamed(&db, &link, &repo, "AK-1", events)
        .await
        .unwrap();
    let out = streamed(&log);
    let wt = server.worktree.to_string_lossy();
    assert!(out.contains("tty=yes term=xterm-256color"), "{out}");
    assert!(out.contains(&format!("in={wt}")), "{out}");
    assert!(
        out.contains(&format!("wt={wt} root={}", server.web.display())),
        "{out}"
    );
    assert!(out.ends_with(r#"{"type":"done","ok":true}"#), "{out}");
    assert_eq!(setup_ran(&db).await, 1, "a success is recorded");
    assert!(
        status_files(&server).is_empty(),
        "the status file is removed"
    );
    assert!(daemon.pty().sessions().iter().all(|s| !s.alive));

    // One that fails reports the failure.
    sqlx::query("UPDATE worktree_links SET setup_ran = 0")
        .execute(&db)
        .await
        .unwrap();
    write_init(&server, "#!/bin/sh\necho failing\nexit 3\n");
    let (events, log) = recording_channel();
    worktree::run_setup_streamed(&db, &link, &repo, "AK-1", events)
        .await
        .unwrap();
    assert!(streamed(&log).ends_with(r#"{"type":"done","ok":false}"#));
    assert_eq!(setup_ran(&db).await, 0);
    assert!(status_files(&server).is_empty());

    // One that waits: it can be resized, it rides out a dropped link, and it
    // can be stopped.
    write_init(
        &server,
        "#!/bin/sh\necho started\nread line\necho \"got-$line\"\nwhile :; do sleep 1; done\n",
    );
    let (events, log) = recording_channel();
    let running = {
        let (db, link, repo) = (db.clone(), link.clone(), repo.clone());
        tokio::spawn(async move {
            worktree::run_setup_streamed(&db, &link, &repo, "AK-1", events).await
        })
    };
    let setup_label = "setup:AK-1";
    until("the script to start", || streamed(&log).contains("started")).await;
    let remote = box_sessions(&daemon, setup_label)[0].id;
    assert!(worktree::resize_setup(&db, &link, &repo, "AK-1", 132, 50)
        .await
        .unwrap());
    until("the box's PTY resized", || {
        box_sessions(&daemon, setup_label)
            .first()
            .is_some_and(|s| (s.cols, s.rows) == (132, 50))
    })
    .await;

    daemon.disconnect_all();
    daemon.pty().write(remote, b"abc\n").unwrap();
    until("the output made across the drop", || {
        streamed(&log).contains("got-abc")
    })
    .await;
    assert_eq!(streamed(&log).matches("got-abc").count(), 1);
    assert_eq!(streamed(&log).matches("started").count(), 1);

    assert!(worktree::cancel_setup(&db, &link, &repo, "AK-1")
        .await
        .unwrap());
    tokio::time::timeout(WAIT, running)
        .await
        .expect("the stopped run ends")
        .unwrap()
        .unwrap();
    assert!(streamed(&log).ends_with(r#"{"type":"done","ok":false}"#));
    assert!(box_sessions(&daemon, setup_label).is_empty());
    assert!(!worktree::cancel_setup(&db, &link, &repo, "AK-1")
        .await
        .unwrap());
}
