//! The client against the fake daemon over in-memory links: no ssh, no
//! network, real PTYs and processes.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, Notify};

use crate::fake::{FakeDaemon, FakeOptions};
use crate::proto::*;
use crate::transport::{memory_link, BoxFuture, Link, SshTarget};
use crate::*;

const WAIT: Duration = Duration::from_secs(10);

/// Tests that fork real shells run one at a time — the same pty-table
/// contention `santree_pty`'s own suite serialises against.
async fn pty_guard() -> tokio::sync::MutexGuard<'static, ()> {
    static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    SERIAL.lock().await
}

async fn client_for(daemon: &FakeDaemon) -> RemoteClient {
    let client = unhandshaken(daemon);
    let hello = client.hello("santree/test", "owner-a").await.unwrap();
    assert_eq!(hello.protocol, PROTOCOL_VERSION);
    client
}

fn unhandshaken(daemon: &FakeDaemon) -> RemoteClient {
    let Link { reader, writer, .. } = daemon.connect();
    RemoteClient::new(reader, writer)
}

fn open_params(command: &str, args: &[&str]) -> PtyOpenParams {
    PtyOpenParams {
        command: command.into(),
        args: args.iter().map(|a| a.to_string()).collect(),
        cols: 80,
        rows: 24,
        owner: "owner-a".into(),
        label: "test".into(),
        ..Default::default()
    }
}

/// Drain `rx` into `acc` until `done(acc)` or an exit; returns whether the
/// process exited.
async fn collect_until(
    rx: &mut mpsc::UnboundedReceiver<PtyEvent>,
    acc: &mut Vec<u8>,
    done: impl Fn(&[u8]) -> bool,
) -> bool {
    let deadline = tokio::time::Instant::now() + WAIT;
    while !done(acc) {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(PtyEvent::Data(bytes))) => acc.extend_from_slice(&bytes),
            Ok(Some(PtyEvent::Exit)) => return true,
            Ok(None) => panic!(
                "session receiver closed; got {:?}",
                String::from_utf8_lossy(acc)
            ),
            Err(_) => panic!("timed out; got {:?}", String::from_utf8_lossy(acc)),
        }
    }
    false
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

// ── handshake ─────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handshake_reports_the_daemon() {
    let daemon = FakeDaemon::new();
    let client = unhandshaken(&daemon);
    // Nothing but hello is served before hello.
    let early = client.pty_sessions().await.unwrap_err();
    assert_eq!(early.code(), Some(&ErrorCode::BadRequest));

    let hello = client.hello("santree/test", "owner-a").await.unwrap();
    assert_eq!(hello.version, "fake-0.0.0");
    assert_eq!(hello.hostname, "fake-daedalus");
    assert!(client.pty_sessions().await.unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unsupported_protocol_is_refused_and_the_link_stays_open() {
    let daemon = FakeDaemon::new();
    let client = unhandshaken(&daemon);
    let refused = client
        .call::<m::Hello>(&HelloParams {
            protocol: 99,
            client: "santree/test".into(),
            owner: "o".into(),
        })
        .await
        .unwrap_err();
    match refused {
        RemoteError::Remote(e) => {
            assert_eq!(e.code, ErrorCode::Version);
            assert_eq!(e.protocol, Some(PROTOCOL_VERSION));
        }
        other => panic!("{other:?}"),
    }
    assert!(!client.is_closed());
    client.hello("santree/test", "o").await.unwrap();
}

// ── pty ───────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shell_echoes_through_the_link() {
    let _serial = pty_guard().await;
    let daemon = FakeDaemon::new();
    let client = client_for(&daemon).await;
    let info = client.pty_open(&open_params("sh", &[])).await.unwrap();
    assert!(info.alive);
    assert!(!info.attached);

    let (attach, mut rx) = client.pty_attach(info.id, Anchor::Fresh).await.unwrap();
    assert_eq!(attach.mode, ReplayMode::Tail);
    assert_eq!(attach.epoch, info.epoch);
    let listed = client.pty_sessions().await.unwrap();
    assert!(listed.iter().any(|s| s.id == info.id && s.attached));

    client
        .pty_write(info.id, b"echo santree_$((40+2))\n".to_vec())
        .await
        .unwrap();
    let mut out = attach.data;
    collect_until(&mut rx, &mut out, |acc| contains(acc, b"santree_42")).await;

    client.pty_resize(info.id, 100, 30).await.unwrap();
    let listed = client.pty_sessions().await.unwrap();
    assert!(listed
        .iter()
        .any(|s| s.id == info.id && s.cols == 100 && s.rows == 30));

    client.pty_close(info.id).await.unwrap();
    assert!(
        collect_until(&mut rx, &mut out, |_| false).await,
        "close delivers pty.exit"
    );
    let unknown = client.pty_write(info.id, b"x".to_vec()).await.unwrap_err();
    assert_eq!(unknown.code(), Some(&ErrorCode::NotFound));
}

/// The reattach guarantee end to end: a client dies mid-stream, output keeps
/// accumulating on the server, and a new client resuming from the old one's
/// (epoch, seq) sees every byte exactly once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_client_resumes_exactly_where_a_dropped_one_stopped() {
    let _serial = pty_guard().await;
    let daemon = FakeDaemon::new();
    let lines = 150;
    let script =
        format!("i=0; while [ $i -lt {lines} ]; do echo line$i; i=$((i+1)); sleep 0.01; done");
    let expected: Vec<u8> = (0..lines)
        .flat_map(|i| format!("line{i}\r\n").into_bytes())
        .collect();

    let first = client_for(&daemon).await;
    let info = first
        .pty_open(&open_params("sh", &["-c", &script]))
        .await
        .unwrap();
    let (attach, mut rx) = first.pty_attach(info.id, Anchor::Fresh).await.unwrap();
    let mut seen = attach.data.clone();
    let base = attach.seq - attach.data.len() as u64;
    assert_eq!(base, 0, "a fresh attach this early holds the whole stream");
    collect_until(&mut rx, &mut seen, |acc| contains(acc, b"line20\r\n")).await;
    let anchor = Anchor::At {
        epoch: attach.epoch.clone(),
        seq: seen.len() as u64,
    };
    drop(rx);
    drop(first);

    // Let the server run on with nobody watching.
    tokio::time::sleep(Duration::from_millis(300)).await;

    let second = client_for(&daemon).await;
    let (resumed, mut rx) = second.pty_attach(info.id, anchor).await.unwrap();
    assert_eq!(resumed.mode, ReplayMode::Exact);
    assert!(
        !resumed.data.is_empty(),
        "output produced while detached is replayed"
    );
    seen.extend_from_slice(&resumed.data);
    assert_eq!(resumed.seq, seen.len() as u64);
    let exited = collect_until(&mut rx, &mut seen, |acc| acc.len() >= expected.len()).await;
    if !exited {
        assert!(collect_until(&mut rx, &mut seen, |_| false).await);
    }
    assert_eq!(
        String::from_utf8_lossy(&seen),
        String::from_utf8_lossy(&expected),
        "no gap, no duplicate"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn process_exit_reaches_the_receiver_attached_or_not() {
    let _serial = pty_guard().await;
    let daemon = FakeDaemon::new();
    let client = client_for(&daemon).await;

    // Attached while it exits.
    let live = client
        .pty_open(&open_params("sh", &["-c", "sleep 0.3; echo bye"]))
        .await
        .unwrap();
    let (attach, mut rx) = client.pty_attach(live.id, Anchor::Fresh).await.unwrap();
    let mut out = attach.data;
    assert!(collect_until(&mut rx, &mut out, |_| false).await);
    assert!(contains(&out, b"bye"));
    assert_eq!(rx.recv().await, None, "nothing follows the exit");

    // Exited before anyone attached: the answer, then the exit.
    let gone = client
        .pty_open(&open_params("sh", &["-c", "echo early"]))
        .await
        .unwrap();
    let deadline = tokio::time::Instant::now() + WAIT;
    while client
        .pty_sessions()
        .await
        .unwrap()
        .iter()
        .any(|s| s.id == gone.id && s.alive)
    {
        assert!(
            tokio::time::Instant::now() < deadline,
            "process never exited"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    let (attach, mut rx) = client.pty_attach(gone.id, Anchor::Fresh).await.unwrap();
    assert!(contains(&attach.data, b"early"));
    let mut rest = Vec::new();
    assert!(collect_until(&mut rx, &mut rest, |_| false).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_newer_attach_replaces_the_older_receiver() {
    let _serial = pty_guard().await;
    let daemon = FakeDaemon::new();
    let client = client_for(&daemon).await;
    let info = client.pty_open(&open_params("sh", &[])).await.unwrap();
    let (first, mut old_rx) = client.pty_attach(info.id, Anchor::Fresh).await.unwrap();
    let (_, mut new_rx) = client
        .pty_attach(
            info.id,
            Anchor::At {
                epoch: first.epoch,
                seq: first.seq,
            },
        )
        .await
        .unwrap();
    // The old receiver ends (possibly after data sent before the swap).
    let deadline = tokio::time::Instant::now() + WAIT;
    while tokio::time::timeout_at(deadline, old_rx.recv())
        .await
        .expect("old receiver never closed")
        .is_some()
    {}
    client
        .pty_write(info.id, b"echo swapped\n".to_vec())
        .await
        .unwrap();
    let mut out = Vec::new();
    collect_until(&mut new_rx, &mut out, |acc| contains(acc, b"swapped\r\n")).await;

    // Detach stops delivery without killing the process.
    client.pty_detach(info.id).await.unwrap();
    let listed = client.pty_sessions().await.unwrap();
    assert!(listed
        .iter()
        .any(|s| s.id == info.id && s.alive && !s.attached));
    client.pty_close(info.id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn adopt_hands_other_owners_sessions_over() {
    let _serial = pty_guard().await;
    let daemon = FakeDaemon::new();
    let client = client_for(&daemon).await;
    let info = client.pty_open(&open_params("sh", &[])).await.unwrap();
    assert_eq!(client.pty_adopt("owner-a").await.unwrap(), vec![]);
    let adopted = client.pty_adopt("owner-b").await.unwrap();
    assert_eq!(adopted.len(), 1);
    assert_eq!(
        (adopted[0].id, adopted[0].owner.as_str()),
        (info.id, "owner-b")
    );
    // Still attachable after the hand-over.
    let (attach, _rx) = client.pty_attach(info.id, Anchor::Unknown).await.unwrap();
    assert_eq!(attach.mode, ReplayMode::Reanchor);
    assert!(attach.data.is_empty());
    client.pty_close(info.id).await.unwrap();
}

// ── exec ──────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exec_runs_argv_with_optional_locks_off() {
    let daemon = FakeDaemon::new();
    let client = client_for(&daemon).await;
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();

    let git = client
        .exec_run(&ExecParams {
            cwd: cwd.clone(),
            argv: vec!["git".into(), "--version".into()],
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(git.success(), "{git:?}");
    assert!(String::from_utf8_lossy(&git.stdout).starts_with("git version"));

    let env = client
        .exec_run(&ExecParams {
            cwd: cwd.clone(),
            argv: vec![
                "sh".into(),
                "-c".into(),
                "printf %s \"$GIT_OPTIONAL_LOCKS:$X\"; cat; exit 3".into(),
            ],
            env: Some(vec![
                ("X".into(), "y".into()),
                ("GIT_OPTIONAL_LOCKS".into(), "1".into()),
            ]),
            stdin: Some(b"|in".to_vec()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(env.code, Some(3));
    assert_eq!(env.stdout, b"0:y|in");

    let slow = client
        .exec_run(&ExecParams {
            cwd: cwd.clone(),
            argv: vec!["sleep".into(), "5".into()],
            timeout_ms: Some(200),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(slow.code(), Some(&ErrorCode::Timeout));

    let missing = client
        .exec_run(&ExecParams {
            cwd,
            argv: vec!["santree-no-such-binary".into()],
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(missing.code(), Some(&ErrorCode::NotFound));

    let relative = client
        .exec_run(&ExecParams {
            cwd: "relative".into(),
            argv: vec!["true".into()],
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(relative.code(), Some(&ErrorCode::BadRequest));
}

/// Requests run concurrently and answer out of order.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_slow_call_does_not_hold_up_a_fast_one() {
    let daemon = FakeDaemon::new();
    let client = Arc::new(client_for(&daemon).await);
    let slow = {
        let client = client.clone();
        tokio::spawn(async move {
            client
                .exec_run(&ExecParams {
                    cwd: "/".into(),
                    argv: vec!["sleep".into(), "1".into()],
                    ..Default::default()
                })
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    let fast = tokio::time::timeout(Duration::from_millis(500), client.fs_stat("/")).await;
    assert!(fast.expect("stat waited behind exec").unwrap().exists);
    assert!(!slow.is_finished());
    assert!(slow.await.unwrap().unwrap().success());
}

// ── fs ────────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fs_reads_writes_and_confines() {
    let daemon = FakeDaemon::new();
    let client = client_for(&daemon).await;
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let outside = tmp.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    let s = |p: &std::path::Path| p.to_string_lossy().into_owned();

    // Atomic write, parents created, mode applied.
    let file = root.join("deep/dir/hello.txt");
    client
        .fs_write(&s(&file), b"hello world".to_vec(), Some(0o600))
        .await
        .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    // Overwrite keeps the mode.
    client
        .fs_write(&s(&file), b"hello world".to_vec(), None)
        .await
        .unwrap();

    let read = |offset: Option<i64>, len: Option<u64>, within: Option<String>| FsReadParams {
        path: s(&file),
        offset,
        len,
        within,
    };
    let whole = client
        .fs_read(&read(None, None, Some(s(&root))))
        .await
        .unwrap();
    assert_eq!(
        (whole.data.as_slice(), whole.size, whole.eof),
        (&b"hello world"[..], 11, true)
    );
    let head = client.fs_read(&read(Some(0), Some(5), None)).await.unwrap();
    assert_eq!((head.data.as_slice(), head.eof), (&b"hello"[..], false));
    let tail = client.fs_read(&read(Some(-5), None, None)).await.unwrap();
    assert_eq!((tail.data.as_slice(), tail.eof), (&b"world"[..], true));
    let past = client
        .fs_read(&read(Some(-50), Some(3), None))
        .await
        .unwrap();
    assert_eq!(past.data, b"hel");

    // A symlink inside the root that points out of it is refused.
    std::fs::write(outside.join("secret"), b"nope").unwrap();
    let link = root.join("escape");
    std::os::unix::fs::symlink(outside.join("secret"), &link).unwrap();
    let escaped = client
        .fs_read(&FsReadParams {
            path: s(&link),
            within: Some(s(&root)),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(escaped.code(), Some(&ErrorCode::Outside));
    let dotdot = client
        .fs_read(&FsReadParams {
            path: format!("{}/../outside/secret", s(&root)),
            within: Some(s(&root)),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(dotdot.code(), Some(&ErrorCode::Outside));
    let missing = client
        .fs_read(&FsReadParams {
            path: s(&root.join("nope")),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(missing.code(), Some(&ErrorCode::NotFound));

    // stat is an lstat, and a missing path is an answer.
    let st = client.fs_stat(&s(&link)).await.unwrap();
    assert_eq!((st.exists, st.kind), (true, Some(FsKind::Symlink)));
    let st = client.fs_stat(&s(&file)).await.unwrap();
    assert_eq!((st.kind, st.size), (Some(FsKind::File), 11));
    assert!(st.mtime_ms > 0);
    assert_eq!(
        client.fs_stat(&s(&root)).await.unwrap().kind,
        Some(FsKind::Dir)
    );
    assert_eq!(
        client.fs_stat(&s(&root.join("nope"))).await.unwrap(),
        FsStat::default()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_blocking_helper_works_from_a_blocking_thread() {
    let daemon = FakeDaemon::new();
    let client = Arc::new(client_for(&daemon).await);
    let stat = tokio::task::spawn_blocking({
        let client = client.clone();
        move || client.call_blocking::<m::FsStat>(&FsStatParams { path: "/".into() })
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(stat.kind, Some(FsKind::Dir));
}

// ── hooks ─────────────────────────────────────────────────────────────────

async fn next_hook(rx: &mut mpsc::UnboundedReceiver<HookMessage>) -> HookMessage {
    tokio::time::timeout(WAIT, rx.recv())
        .await
        .expect("no hook message")
        .expect("hooks receiver closed")
}

async fn next_seq(rx: &mut mpsc::UnboundedReceiver<HookMessage>) -> u64 {
    match next_hook(rx).await {
        HookMessage::Event(e) => e.seq,
        other => panic!("{other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hooks_queue_until_acked() {
    let daemon = FakeDaemon::new();
    for event in ["SessionStart", "UserPromptSubmit", "Stop"] {
        daemon.push_hook(
            event,
            vec![("CLAUDE_PROJECT_DIR".into(), "/srv".into())],
            b"{}".to_vec(),
        );
    }

    let client = client_for(&daemon).await;
    let mut rx = client.hooks_subscribe(None).await.unwrap();
    match next_hook(&mut rx).await {
        HookMessage::Event(e) => {
            assert_eq!(
                (e.seq, e.event.as_str(), e.stdin.as_slice()),
                (1, "SessionStart", &b"{}"[..])
            );
            assert_eq!(e.env, vec![("CLAUDE_PROJECT_DIR".into(), "/srv".into())]);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(next_seq(&mut rx).await, 2);
    assert_eq!(next_seq(&mut rx).await, 3);

    // Live, and through the protocol (the hook subcommand's path).
    let seq = client
        .hooks_push(&HookPushParams {
            event: "Notification".into(),
            env: vec![],
            stdin: vec![],
        })
        .await
        .unwrap();
    assert_eq!(seq, 4);
    assert_eq!(next_seq(&mut rx).await, 4);

    client.hooks_ack(2).await.unwrap();
    assert_eq!(daemon.queued_hooks(), vec![3, 4]);
    drop(rx);
    drop(client);

    // A new subscriber gets only what was never acked.
    let client = client_for(&daemon).await;
    let mut rx = client.hooks_subscribe(None).await.unwrap();
    assert_eq!(next_seq(&mut rx).await, 3);
    assert_eq!(next_seq(&mut rx).await, 4);
    let mut rx = client.hooks_subscribe(Some(3)).await.unwrap();
    assert_eq!(next_seq(&mut rx).await, 4);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hook_overflow_is_reported() {
    let daemon = FakeDaemon::with_options(FakeOptions {
        hook_queue_cap: 2,
        ..Default::default()
    });
    for _ in 0..5 {
        daemon.push_hook("Stop", vec![], vec![]);
    }
    let client = client_for(&daemon).await;
    let mut rx = client.hooks_subscribe(None).await.unwrap();
    assert_eq!(next_hook(&mut rx).await, HookMessage::Dropped { count: 3 });
    assert_eq!(next_seq(&mut rx).await, 4);
    assert_eq!(next_seq(&mut rx).await, 5);
}

// ── link death ────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_silent_link_is_declared_dead() {
    let (link, _server) = memory_link();
    let client = RemoteClient::with_options(
        link.reader,
        link.writer,
        ClientOptions {
            idle_timeout: Duration::from_millis(200),
            ..Default::default()
        },
    );
    let err = tokio::time::timeout(WAIT, client.hello("t", "o"))
        .await
        .unwrap()
        .unwrap_err();
    assert!(err.is_disconnected(), "{err:?}");
    assert!(client.close_reason().unwrap().contains("no traffic"));
    // Calls after death fail at once.
    assert!(client.pty_sessions().await.unwrap_err().is_disconnected());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pings_keep_an_idle_link_alive() {
    let daemon = FakeDaemon::with_options(FakeOptions {
        ping_interval: Duration::from_millis(50),
        ..Default::default()
    });
    let Link { reader, writer, .. } = daemon.connect();
    let client = RemoteClient::with_options(
        reader,
        writer,
        ClientOptions {
            idle_timeout: Duration::from_millis(300),
            ..Default::default()
        },
    );
    client.hello("t", "o").await.unwrap();
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert!(!client.is_closed(), "{:?}", client.close_reason());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn eof_and_oversized_lines_end_the_link() {
    let (link, server) = memory_link();
    let client = RemoteClient::new(link.reader, link.writer);
    let pending = client.hello("t", "o");
    drop(server);
    assert!(pending.await.unwrap_err().is_disconnected());
    tokio::time::timeout(WAIT, client.closed()).await.unwrap();

    let (link, mut server) = memory_link();
    let client = RemoteClient::with_options(
        link.reader,
        link.writer,
        ClientOptions {
            max_line: 1024,
            ..Default::default()
        },
    );
    server.write_all(&[b'x'; 4096]).await.unwrap();
    tokio::time::timeout(WAIT, client.closed()).await.unwrap();
    assert!(client.close_reason().unwrap().contains("over 1024"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_server_side_drop_fails_in_flight_calls() {
    let daemon = FakeDaemon::new();
    let client = Arc::new(client_for(&daemon).await);
    let call = {
        let client = client.clone();
        tokio::spawn(async move {
            client
                .exec_run(&ExecParams {
                    cwd: "/".into(),
                    argv: vec!["sleep".into(), "5".into()],
                    ..Default::default()
                })
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    daemon.disconnect_all();
    let result = tokio::time::timeout(WAIT, call).await.unwrap().unwrap();
    assert!(result.unwrap_err().is_disconnected());
}

// ── host ──────────────────────────────────────────────────────────────────

fn host_config() -> HostConfig {
    HostConfig {
        target: SshTarget {
            user: "santiago".into(),
            host: "s2.example.org".into(),
            port: 22,
            identity_file: None,
        },
        client: "santree/test".into(),
        owner: "owner-a".into(),
        hook_cursor: None,
        boot_id: None,
    }
}

fn fast_host_options() -> HostOptions {
    HostOptions {
        backoff_min: Duration::from_millis(20),
        backoff_max: Duration::from_millis(100),
        hello_timeout: Duration::from_secs(5),
        client: ClientOptions::default(),
    }
}

async fn wait_status(
    rx: &mut tokio::sync::watch::Receiver<HostStatus>,
    want: impl Fn(&HostStatus) -> bool,
) -> HostStatus {
    tokio::time::timeout(WAIT, rx.wait_for(|s| want(s)))
        .await
        .expect("status never arrived")
        .unwrap()
        .clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_host_retries_reconnects_and_resumes_hooks() {
    let daemon = FakeDaemon::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let release = Arc::new(Notify::new());
    let connector = {
        let (daemon, calls, release) = (daemon.clone(), calls.clone(), release.clone());
        Arc::new(
            move |target: &SshTarget| -> BoxFuture<'static, Result<Link, String>> {
                let n = calls.fetch_add(1, Ordering::SeqCst);
                assert_eq!(target.host, "s2.example.org");
                let (daemon, release) = (daemon.clone(), release.clone());
                Box::pin(async move {
                    match n {
                        0 => Err("ssh: no route to host".into()),
                        // The retry waits until the test has seen the
                        // Unreachable it expects, so the transition can't be missed.
                        1 => {
                            release.notified().await;
                            Ok(daemon.connect())
                        }
                        _ => Ok(daemon.connect()),
                    }
                })
            },
        )
    };
    let host = RemoteHost::new(connector, fast_host_options());
    assert_eq!(host.current_status(), HostStatus::NotConfigured);
    let mut status = host.status();
    let mut reconnected = host.reconnected();
    let mut hooks = host.take_hook_events().unwrap();
    assert!(host.take_hook_events().is_none());

    host.configure(Some(host_config()));
    let unreachable =
        wait_status(&mut status, |s| matches!(s, HostStatus::Unreachable { .. })).await;
    assert_eq!(
        unreachable,
        HostStatus::Unreachable {
            reason: "ssh: no route to host".into()
        }
    );
    assert!(host.client().is_none());
    release.notify_one();

    let connected = wait_status(&mut status, |s| matches!(s, HostStatus::Connected { .. })).await;
    assert_eq!(
        connected,
        HostStatus::Connected {
            version: "fake-0.0.0".into()
        }
    );
    let first = tokio::time::timeout(WAIT, reconnected.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first.generation, 1);
    assert!(host.client().is_some());

    // Hooks flow; ack one; leave one unacked.
    daemon.push_hook("SessionStart", vec![], vec![]);
    daemon.push_hook("Stop", vec![], vec![]);
    assert_eq!(
        next_delivered(&mut hooks).await,
        (daemon.boot_id().to_string(), 1)
    );
    assert_eq!(next_delivered(&mut hooks).await.1, 2);
    assert!(host.ack_hooks(daemon.boot_id(), 1).await);

    // The network drops. The host says so, reconnects, and announces it.
    daemon.disconnect_all();
    wait_status(&mut status, |s| *s == HostStatus::Connecting).await;
    wait_status(&mut status, |s| matches!(s, HostStatus::Connected { .. })).await;
    let second = tokio::time::timeout(WAIT, reconnected.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(second.generation, 2);

    // Seq 2 was redelivered by the daemon (unacked) but not forwarded twice;
    // the next event is the next thing the consumer sees.
    daemon.push_hook("Notification", vec![], vec![]);
    assert_eq!(next_delivered(&mut hooks).await.1, 3);
    assert_eq!(daemon.queued_hooks(), vec![2, 3]);

    host.stop();
    assert_eq!(host.current_status(), HostStatus::NotConfigured);
    assert!(host.client().is_none());
}

/// The next hook event off a host's stream, as `(boot, seq)`.
async fn next_delivered(rx: &mut mpsc::UnboundedReceiver<HookDelivery>) -> (String, u64) {
    let delivery = tokio::time::timeout(WAIT, rx.recv())
        .await
        .expect("no hook delivery")
        .expect("hook stream closed");
    match delivery.message {
        HookMessage::Event(e) => (delivery.boot_id, e.seq),
        other => panic!("expected an event, got {other:?}"),
    }
}

/// A connector that reaches whichever daemon is current — swapping it is a
/// server restart as the app sees one.
fn swappable(current: Arc<std::sync::Mutex<FakeDaemon>>) -> Arc<dyn Connector> {
    Arc::new(
        move |_: &SshTarget| -> BoxFuture<'static, Result<Link, String>> {
            let link = current.lock().unwrap().connect();
            Box::pin(async move { Ok(link) })
        },
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cursor_survives_a_reconnect_to_the_same_boot() {
    let daemon = FakeDaemon::new();
    for _ in 0..3 {
        daemon.push_hook("Stop", vec![], vec![]);
    }
    let host = RemoteHost::new(daemon.connector(), fast_host_options());
    let mut status = host.status();
    let mut hooks = host.take_hook_events().unwrap();
    // A restart of the *app*: the persisted cursor, under the boot it was taken in.
    host.configure(Some(HostConfig {
        hook_cursor: Some(2),
        boot_id: Some(daemon.boot_id().to_string()),
        ..host_config()
    }));
    wait_status(&mut status, |s| matches!(s, HostStatus::Connected { .. })).await;
    // Resumed after 2, and the stale ack went with the connect.
    assert_eq!(next_delivered(&mut hooks).await.1, 3);
    assert_eq!(daemon.queued_hooks(), vec![3]);

    daemon.disconnect_all();
    wait_status(&mut status, |s| *s == HostStatus::Connecting).await;
    wait_status(&mut status, |s| matches!(s, HostStatus::Connected { .. })).await;
    daemon.push_hook("Stop", vec![], vec![]);
    assert_eq!(
        next_delivered(&mut hooks).await.1,
        4,
        "no replay on the same boot"
    );
    host.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_boot_resets_the_cursor_and_refuses_the_old_boots_acks() {
    let first = FakeDaemon::new();
    let current = Arc::new(std::sync::Mutex::new(first.clone()));
    let host = RemoteHost::new(swappable(current.clone()), fast_host_options());
    let mut status = host.status();
    let mut hooks = host.take_hook_events().unwrap();
    host.configure(Some(host_config()));
    wait_status(&mut status, |s| matches!(s, HostStatus::Connected { .. })).await;
    for _ in 0..3 {
        first.push_hook("Stop", vec![], vec![]);
    }
    let old_boot = first.boot_id().to_string();
    for want in 1..=3 {
        assert_eq!(next_delivered(&mut hooks).await, (old_boot.clone(), want));
    }
    assert!(host.ack_hooks(&old_boot, 3).await);

    // The server restarts: a new boot, whose seqs start over at 1.
    let second = FakeDaemon::new();
    assert_ne!(second.boot_id(), old_boot);
    second.push_hook("SessionStart", vec![], vec![]);
    second.push_hook("Stop", vec![], vec![]);
    *current.lock().unwrap() = second.clone();
    first.shutdown();
    wait_status(&mut status, |s| *s == HostStatus::Connecting).await;
    wait_status(&mut status, |s| matches!(s, HostStatus::Connected { .. })).await;

    // Everything the new boot has, from 1 — not skipped as "already seen".
    let new_boot = second.boot_id().to_string();
    assert_eq!(next_delivered(&mut hooks).await, (new_boot.clone(), 1));
    assert_eq!(next_delivered(&mut hooks).await, (new_boot.clone(), 2));
    // A late ack for the old boot is refused, and never reaches the new daemon.
    assert!(!host.ack_hooks(&old_boot, 3).await);
    assert_eq!(second.queued_hooks(), vec![1, 2]);
    assert!(host.ack_hooks(&new_boot, 1).await);
    tokio::time::timeout(WAIT, async {
        while second.queued_hooks() != vec![2] {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the new boot's ack never landed");
    host.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_host_reports_a_protocol_mismatch() {
    let daemon = FakeDaemon::with_options(FakeOptions {
        protocol: 2,
        ..Default::default()
    });
    let host = RemoteHost::new(daemon.connector(), fast_host_options());
    let mut status = host.status();
    host.configure(Some(host_config()));
    let mismatch = wait_status(&mut status, |s| {
        matches!(s, HostStatus::VersionMismatch { .. })
    })
    .await;
    assert_eq!(mismatch, HostStatus::VersionMismatch { theirs: Some(2) });
    host.stop();
}
