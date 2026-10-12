//! The real binary, as the app will run it: spawned with a ready pipe on fd 3,
//! driven over its socket with the app's own client.

// Tests type into, open and close terminals directly: clippy.toml's PTY rules
// hold shipped code to its sanctioned sites.
#![allow(clippy::disallowed_methods)]

use std::fs::{self, File};
use std::io::Read;
use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use santree_remote_client::proto::*;
use santree_remote_client::{PtyEvent, RemoteClient};
use tokio::sync::mpsc;

const BIN: &str = env!("CARGO_BIN_EXE_santree-server");
const WAIT: Duration = Duration::from_secs(10);

/// A short dir under /tmp: the socket path must fit `sun_path` (103 bytes on
/// macOS), which `$TMPDIR` there already half fills.
fn scratch() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("sts")
        .tempdir_in("/tmp")
        .unwrap()
}

struct Server {
    child: Child,
    /// The launcher's end of the ready socketpair.
    ready: UnixStream,
}

/// `santree-server serve` on `<dir>/run` with its log and stderr in `dir`,
/// and no ready fd.
fn command(dir: &Path, extra: &[&str], env: &[(&str, &str)]) -> Command {
    let mut cmd = Command::new(BIN);
    cmd.arg("serve")
        .arg("--run-dir")
        .arg(dir.join("run"))
        .arg("--log-file")
        .arg(dir.join("logs/server.log"))
        .args(extra)
        .envs(env.iter().copied())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(File::create(dir.join("stderr")).unwrap());
    cmd
}

/// [`command`], spawned the way the app launches it: one end of a
/// socketpair on fd 3 (`--ready-fd 3`), the other kept here.
fn spawn(dir: &Path, extra: &[&str]) -> Server {
    spawn_with(dir, extra, &[])
}

/// [`spawn`], with `env` added to the server's own environment.
fn spawn_with(dir: &Path, extra: &[&str], env: &[(&str, &str)]) -> Server {
    let (ready, theirs) = UnixStream::pair().unwrap();
    spawn_on(dir, extra, env, ready, theirs)
}

/// Put `fd` at 3 for the child, open across its exec. Between fork and exec:
/// async-signal-safe calls only. Both ends of a pair (and a `File`) are
/// close-on-exec; dup2 clears it on the copy, but onto itself it is a no-op
/// that leaves it set — and which fd a test's file gets is up to the runner.
fn onto_ready_fd(fd: i32) -> std::io::Result<()> {
    // SAFETY: fcntl and dup2 on plain fds; both are async-signal-safe.
    let rc = unsafe {
        if fd == 3 {
            libc::fcntl(3, libc::F_SETFD, 0)
        } else {
            libc::dup2(fd, 3)
        }
    };
    if rc < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// [`spawn_with`] on a ready fd the caller chose: `theirs` is what the server
/// is handed as `--ready-fd 3`, `ready` what the launcher holds to read from.
fn spawn_on(
    dir: &Path,
    extra: &[&str],
    env: &[(&str, &str)],
    ready: UnixStream,
    theirs: UnixStream,
) -> Server {
    let fd = theirs.as_raw_fd();
    let mut cmd = command(dir, extra, env);
    cmd.args(["--ready-fd", "3"]);
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        cmd.pre_exec(move || onto_ready_fd(fd));
    }
    let child = cmd.spawn().unwrap();
    drop(theirs);
    Server { child, ready }
}

impl Server {
    /// The one line on the ready pipe ("" if it closed without one).
    fn ready_line(&mut self) -> String {
        let mut reader = self.ready.try_clone().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut out = Vec::new();
            let mut byte = [0u8; 1];
            while let Ok(1) = reader.read(&mut byte) {
                out.push(byte[0]);
                if byte[0] == b'\n' {
                    break;
                }
            }
            let _ = tx.send(String::from_utf8_lossy(&out).into_owned());
        });
        rx.recv_timeout(WAIT).expect("nothing on the ready pipe")
    }

    fn wait_ready(&mut self) {
        let line = self.ready_line();
        assert_eq!(
            line,
            format!("ready {}\n", self.child.id()),
            "the server did not come up"
        );
    }

    fn pid(&self) -> i32 {
        self.child.id() as i32
    }

    fn exit_within(&mut self, limit: Duration) -> Option<ExitStatus> {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if let Some(status) = self.child.try_wait().unwrap() {
                return Some(status);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        None
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn socket(dir: &Path) -> PathBuf {
    santree_server::endpoint::socket_path(&dir.join("run"))
}

async fn connect(dir: &Path) -> (RemoteClient, HelloResult) {
    let stream = tokio::net::UnixStream::connect(socket(dir)).await.unwrap();
    let (r, w) = stream.into_split();
    let client = RemoteClient::new(r, w);
    let hello = client.hello("santree/test", "owner-test").await.unwrap();
    (client, hello)
}

fn shell() -> PtyOpenParams {
    PtyOpenParams {
        command: "/bin/sh".into(),
        cols: 80,
        rows: 24,
        owner: "owner-test".into(),
        label: "test".into(),
        // The server refuses an open without the environment to inherit.
        base_env: vec![("PATH".into(), "/usr/bin:/bin".into())],
        ..Default::default()
    }
}

/// A session the kernel's hangup alone can't end (SIGHUP ignored), so only
/// the server closing it — which escalates to SIGKILL — does.
fn stubborn() -> PtyOpenParams {
    PtyOpenParams {
        command: "/bin/sh".into(),
        args: vec!["-c".into(), "trap '' HUP; exec sleep 30".into()],
        ..shell()
    }
}

fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the pid exists.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

/// Wait for `pid` to be gone (a zombie, reparented on its server's exit, is
/// reaped by init shortly after).
fn gone_within(pid: u32, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if !alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

async fn collect_until(
    rx: &mut mpsc::UnboundedReceiver<PtyEvent>,
    acc: &mut Vec<u8>,
    needle: &[u8],
) {
    let deadline = tokio::time::Instant::now() + WAIT;
    while !acc.windows(needle.len()).any(|w| w == needle) {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(PtyEvent::Data(bytes))) => acc.extend_from_slice(&bytes),
            other => panic!(
                "waiting for {:?}: {other:?}; got {:?}",
                String::from_utf8_lossy(needle),
                String::from_utf8_lossy(acc)
            ),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shell_outlives_its_client_and_stop_ends_both() {
    let dir = scratch();
    let mut server = spawn(dir.path(), &[]);
    server.wait_ready();
    let log = dir.path().join("logs/server.log");
    assert_eq!(
        fs::metadata(&log).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let sock = socket(dir.path());
    assert_eq!(
        fs::metadata(&sock).unwrap().permissions().mode() & 0o777,
        0o600
    );

    let (client, hello) = connect(dir.path()).await;
    for feature in [
        "pty.baseEnv",
        "server.info",
        "server.keepAwake",
        "server.stop",
    ] {
        assert!(
            hello.has(feature),
            "hello lacks {feature}: {:?}",
            hello.features
        );
    }
    assert!(hello.supports::<m::ServerInfo>());

    let info = client.pty_open(&shell()).await.unwrap();
    let shell_pid = info.pid.expect("a running shell has a pid");
    let (attach, mut rx) = client.pty_attach(info.id, Anchor::Fresh).await.unwrap();
    let base = attach.seq - attach.data.len() as u64;
    let mut seen = attach.data.clone();
    // The answer, not the echo of what was typed.
    client
        .pty_write(info.id, b"echo $((40+2))\n".to_vec())
        .await
        .unwrap();
    collect_until(&mut rx, &mut seen, b"42").await;
    let anchor = Anchor::At {
        epoch: attach.epoch.clone(),
        seq: base + seen.len() as u64,
    };
    drop(rx);
    drop(client);

    // The app is gone; the shell is not.
    let (client, _) = connect(dir.path()).await;
    let (resumed, mut rx) = client.pty_attach(info.id, anchor).await.unwrap();
    assert_eq!(resumed.mode, ReplayMode::Exact);
    seen.extend_from_slice(&resumed.data);
    assert_eq!(
        resumed.seq,
        base + seen.len() as u64,
        "no gap, no duplicate"
    );
    client
        .pty_write(info.id, b"echo $((50+5))\n".to_vec())
        .await
        .unwrap();
    collect_until(&mut rx, &mut seen, b"55").await;

    let me = client.call::<m::ServerInfo>(&Empty).await.unwrap();
    assert_eq!(me.version, env!("CARGO_PKG_VERSION"));
    assert_eq!(me.revision, santree_server::REVISION);
    assert_eq!(me.pid, server.child.id());
    assert_eq!(me.live_sessions, 1);
    assert_eq!(me.clients, 1);
    assert!(me.exe.ends_with("santree-server"), "{}", me.exe);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    assert!(
        (now_ms - 60_000..=now_ms).contains(&me.started_at_ms),
        "{me:?}"
    );

    let stubborn_pid = client.pty_open(&stubborn()).await.unwrap().pid.unwrap();
    client.call::<m::ServerStop>(&Empty).await.unwrap();
    let status = server
        .exit_within(WAIT)
        .expect("server.stop did not end the server");
    assert_eq!(status.code(), Some(0));
    assert!(
        gone_within(shell_pid, WAIT),
        "the session outlived server.stop"
    );
    assert!(
        gone_within(stubborn_pid, WAIT),
        "a session ignoring SIGHUP outlived server.stop"
    );
    // Left for the next lock holder to replace, never unlinked on the way out.
    assert!(
        fs::symlink_metadata(&sock).is_ok(),
        "the socket was unlinked at exit"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn keep_awake_is_idempotent_both_ways() {
    let dir = scratch();
    let mut server = spawn(dir.path(), &[]);
    server.wait_ready();
    let (client, _) = connect(dir.path()).await;
    let supported = cfg!(target_os = "macos");
    for on in [true, true, false, false, true] {
        let params = KeepAwakeParams { on };
        assert_eq!(
            client.call::<m::ServerKeepAwake>(&params).await.unwrap(),
            KeepAwakeResult {
                active: on && supported,
                supported
            }
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_server_finds_the_endpoint_occupied() {
    let dir = scratch();
    let mut first = spawn(dir.path(), &[]);
    first.wait_ready();

    let mut second = spawn(dir.path(), &[]);
    assert_eq!(second.ready_line(), "occupied\n");
    let status = second.exit_within(WAIT).expect("the loser kept running");
    assert_eq!(status.code(), Some(santree_server::EXIT_OCCUPIED));

    // The winner never noticed.
    let (client, _) = connect(dir.path()).await;
    let me = client.call::<m::ServerInfo>(&Empty).await.unwrap();
    assert_eq!(me.pid, first.child.id());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stale_socket_is_replaced() {
    let dir = scratch();
    let run = dir.path().join("run");
    fs::create_dir(&run).unwrap();
    fs::set_permissions(&run, fs::Permissions::from_mode(0o700)).unwrap();
    // What a crashed server leaves: the socket file, nobody listening.
    // (Not asserted unconnectable: a sibling test's fork may hold the
    // listener for the instant before its exec closes it.)
    drop(std::os::unix::net::UnixListener::bind(socket(dir.path())).unwrap());
    assert!(socket(dir.path()).exists());

    let mut server = spawn(dir.path(), &[]);
    server.wait_ready();
    let (client, _) = connect(dir.path()).await;
    let me = client.call::<m::ServerInfo>(&Empty).await.unwrap();
    assert_eq!(me.pid, server.child.id());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unused_server_retires() {
    let dir = scratch();
    let mut server = spawn(
        dir.path(),
        &["--idle-grace-ms", "200", "--idle-initial-ms", "300"],
    );
    server.wait_ready();
    let status = server
        .exit_within(WAIT)
        .expect("nobody came, and it stayed");
    assert_eq!(status.code(), Some(0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_client_that_leaves_nothing_behind_lets_it_retire_after_the_grace() {
    let dir = scratch();
    // An initial window far beyond the wait below: only the grace can end it.
    let mut server = spawn(
        dir.path(),
        &["--idle-grace-ms", "300", "--idle-initial-ms", "60000"],
    );
    server.wait_ready();
    let (client, _) = connect(dir.path()).await;
    drop(client);
    let status = server
        .exit_within(Duration::from_secs(5))
        .expect("it outlived its grace");
    assert_eq!(status.code(), Some(0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_live_session_keeps_it_with_no_client() {
    let dir = scratch();
    let mut server = spawn(
        dir.path(),
        &["--idle-grace-ms", "200", "--idle-initial-ms", "200"],
    );
    server.wait_ready();
    let (client, _) = connect(dir.path()).await;
    let info = client.pty_open(&shell()).await.unwrap();
    drop(client);

    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert!(
        server.child.try_wait().unwrap().is_none(),
        "it retired under a live session"
    );
    let (client, _) = connect(dir.path()).await;
    let sessions = client.pty_sessions().await.unwrap();
    assert!(sessions.iter().any(|s| s.id == info.id && s.alive));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sigterm_closes_every_session_and_exits_zero() {
    let dir = scratch();
    let mut server = spawn(dir.path(), &[]);
    server.wait_ready();
    let (client, _) = connect(dir.path()).await;
    let info = client.pty_open(&stubborn()).await.unwrap();
    let shell_pid = info.pid.unwrap();
    assert!(alive(shell_pid));

    // SAFETY: signalling our own child.
    assert_eq!(unsafe { libc::kill(server.pid(), libc::SIGTERM) }, 0);
    let status = server.exit_within(WAIT).expect("SIGTERM did not end it");
    assert_eq!(status.code(), Some(0));
    assert!(gone_within(shell_pid, WAIT), "the session outlived SIGTERM");
}

/// What a session's process sees of the server: none of the nested-session
/// markers the server itself inherited, and nothing naming its socket, run
/// dir or log — a pane that found the socket could try it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_inherits_no_marker_and_no_server_path() {
    let dir = scratch();
    let mut server = spawn_with(dir.path(), &[], &[("CLAUDECODE", "1")]);
    server.wait_ready();
    let (client, _) = connect(dir.path()).await;
    let info = client
        .pty_open(&PtyOpenParams {
            command: "/bin/sh".into(),
            args: vec!["-c".into(), "env; echo END-OF-ENV; exec sleep 30".into()],
            ..shell()
        })
        .await
        .unwrap();
    let (attach, mut rx) = client.pty_attach(info.id, Anchor::Fresh).await.unwrap();
    let mut seen = attach.data.clone();
    collect_until(&mut rx, &mut seen, b"END-OF-ENV").await;
    let env = String::from_utf8_lossy(&seen);
    assert!(!env.contains("CLAUDECODE="), "{env}");
    let root = dir.path().to_string_lossy();
    assert!(!env.contains(root.as_ref()), "{env}");
    assert!(!env.contains("server-r"), "{env}");
}

/// The app forwards the environment its panes would have inherited; that is
/// all a session gets. A variable only the server's own environment holds
/// (whatever launched it) never shows through around it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_forwarded_base_env_is_the_whole_inheritance() {
    let dir = scratch();
    let mut server = spawn_with(dir.path(), &[], &[("SANTREE_SERVER_ONLY", "leaked")]);
    server.wait_ready();
    let (client, _) = connect(dir.path()).await;
    let info = client
        .pty_open(&PtyOpenParams {
            command: "/bin/sh".into(),
            args: vec!["-c".into(), "env; echo END-OF-ENV; exec sleep 30".into()],
            base_env: vec![
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("FROM_THE_APP".into(), "forwarded".into()),
            ],
            ..shell()
        })
        .await
        .unwrap();
    let (attach, mut rx) = client.pty_attach(info.id, Anchor::Fresh).await.unwrap();
    let mut seen = attach.data.clone();
    collect_until(&mut rx, &mut seen, b"END-OF-ENV").await;
    let env = String::from_utf8_lossy(&seen);
    assert!(env.contains("FROM_THE_APP=forwarded"), "{env}");
    assert!(!env.contains("SANTREE_SERVER_ONLY"), "{env}");
}

#[test]
fn a_run_dir_others_can_reach_is_refused() {
    let dir = scratch();
    let run = dir.path().join("run");
    fs::create_dir(&run).unwrap();
    fs::set_permissions(&run, fs::Permissions::from_mode(0o755)).unwrap();

    let mut server = spawn(dir.path(), &[]);
    assert_eq!(server.ready_line(), "", "it started in an open run dir");
    let status = server.exit_within(WAIT).expect("it kept running");
    assert_eq!(status.code(), Some(1));
    let stderr = fs::read_to_string(dir.path().join("stderr")).unwrap();
    assert!(stderr.contains("0700"), "{stderr}");
    assert!(!socket(dir.path()).exists());
}

#[test]
fn version_names_the_revision_and_features() {
    let out = Command::new(BIN)
        .args(["version", "--json"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(v["revision"], santree_server::REVISION);
    assert_eq!(v["protocol"], PROTOCOL_VERSION);
    let features: Vec<&str> = v["features"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f.as_str().unwrap())
        .collect();
    assert_eq!(
        features,
        [
            "pty.baseEnv",
            "pty.modes",
            "server.info",
            "server.keepAwake",
            "server.stop"
        ]
    );

    let out = Command::new(BIN).arg("version").output().unwrap();
    assert_eq!(
        String::from_utf8(out.stdout).unwrap(),
        format!(
            "santree-server {} revision {} protocol {PROTOCOL_VERSION}\n",
            env!("CARGO_PKG_VERSION"),
            santree_server::REVISION
        )
    );

    let out = Command::new(BIN).arg("status").output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("usage:"));
}

/// Everything `rx` delivers for `window`.
async fn collect_for(rx: &mut mpsc::UnboundedReceiver<PtyEvent>, window: Duration) -> Vec<u8> {
    let mut acc = Vec::new();
    let deadline = tokio::time::Instant::now() + window;
    while let Ok(Some(event)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        if let PtyEvent::Data(bytes) = event {
            acc.extend_from_slice(&bytes);
        }
    }
    acc
}

/// The security audit's exploit: `--ready-fd 3` with fd 3 closed. The log
/// file was opened first and became fd 3, passed for the ready fd, and was
/// closed after `ready` — while the logger kept writing to fd 3, by then a
/// client's socket and then a PTY master, so log lines were typed into a
/// terminal. A ready fd is now adopted before any file is opened and must be
/// a unix socket; this one is refused and nothing is served.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_closed_ready_fd_is_refused_so_no_log_line_reaches_a_terminal() {
    let dir = scratch();
    let mut cmd = command(dir.path(), &["--ready-fd", "3"], &[]);
    // SAFETY: close is async-signal-safe; fd 3 may or may not be open.
    unsafe {
        cmd.pre_exec(|| {
            libc::close(3);
            Ok(())
        });
    }
    let mut child = cmd.spawn().unwrap();
    let sock = socket(dir.path());
    let deadline = Instant::now() + WAIT;
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if tokio::net::UnixStream::connect(&sock).await.is_ok() {
            // It came up: run the exploit and show where the log went. Each
            // pause lets the server close (or take) the fd before the next step.
            tokio::time::sleep(Duration::from_millis(300)).await;
            let first = tokio::net::UnixStream::connect(&sock).await.unwrap();
            tokio::time::sleep(Duration::from_millis(300)).await;
            let (client, _) = connect(dir.path()).await;
            tokio::time::sleep(Duration::from_millis(300)).await;
            drop(first);
            tokio::time::sleep(Duration::from_millis(300)).await;
            let info = client
                .pty_open(&PtyOpenParams {
                    command: "/bin/cat".into(),
                    ..shell()
                })
                .await
                .unwrap();
            let (attach, mut rx) = client.pty_attach(info.id, Anchor::Fresh).await.unwrap();
            // More logged lines: a connection opening and its hello.
            let (another, _) = connect(dir.path()).await;
            drop(another);
            let mut typed = attach.data;
            typed.extend(collect_for(&mut rx, Duration::from_secs(1)).await);
            let _ = child.kill();
            let _ = child.wait();
            let typed = String::from_utf8_lossy(&typed);
            assert!(
                !typed.contains(" INFO "),
                "log lines reached the terminal as input: {typed:?}"
            );
            panic!("it served with a closed ready fd");
        }
        assert!(Instant::now() < deadline, "neither served nor exited");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(status.code(), Some(1));
    let stderr = fs::read_to_string(dir.path().join("stderr")).unwrap();
    assert!(stderr.contains("--ready-fd 3"), "{stderr}");
    assert!(!sock.exists(), "it bound with a closed ready fd");
}

/// The audit's exploit: on macOS a client socket connected to a *named*
/// listener reports the LISTENER's token, so an agent could connect to a
/// socket santree.app listens on and hand it over as `--ready-fd` to make a
/// genuine server serve. The launcher's end is a socketpair end, which has no
/// name; a connected client's peer has one, and is refused (exit 21), in an
/// unsigned server too.
#[test]
fn a_ready_fd_connected_to_a_named_listener_is_refused() {
    let dir = scratch();
    let listener = std::os::unix::net::UnixListener::bind(dir.path().join("l.sock")).unwrap();
    let client = UnixStream::connect(dir.path().join("l.sock")).unwrap();
    let (_accepted, _) = listener.accept().unwrap();
    let probe = client.try_clone().unwrap();
    let mut server = spawn_on(dir.path(), &[], &[], probe, client);
    let status = server
        .exit_within(WAIT)
        .expect("the server served for a ready fd that names a listener");
    assert_eq!(status.code(), Some(21));
    let log = fs::read_to_string(dir.path().join("logs/server.log")).unwrap();
    assert!(log.contains("not a socketpair"), "{log}");
    assert!(!socket(dir.path()).exists(), "it bound the endpoint");
}

/// A ready fd that is open but not a socket — a file, the shape the log took
/// in the exploit above — is refused the same way.
#[test]
fn a_ready_fd_that_is_not_a_socket_is_refused() {
    let dir = scratch();
    let file = File::create(dir.path().join("not-a-socket")).unwrap();
    let fd = file.as_raw_fd();
    let mut cmd = command(dir.path(), &["--ready-fd", "3"], &[]);
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        cmd.pre_exec(move || onto_ready_fd(fd));
    }
    let status = cmd.status().unwrap();
    assert_eq!(status.code(), Some(1));
    let stderr = fs::read_to_string(dir.path().join("stderr")).unwrap();
    assert!(stderr.contains("not a socket"), "{stderr}");
    assert!(!socket(dir.path()).exists());
}

/// `pty.open` without `baseEnv` is refused: the server's own environment is
/// whatever launched it, and must never become a session's.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_open_without_a_base_env_is_refused() {
    let dir = scratch();
    let mut server = spawn_with(dir.path(), &[], &[("SANTREE_SERVER_ONLY", "leaked")]);
    server.wait_ready();
    let (client, _) = connect(dir.path()).await;
    let refused = client
        .pty_open(&PtyOpenParams {
            base_env: Vec::new(),
            ..shell()
        })
        .await
        .unwrap_err();
    match refused {
        santree_remote_client::RemoteError::Remote(e) => {
            assert_eq!(e.code, ErrorCode::BadRequest, "{}", e.msg);
            assert!(e.msg.contains("baseEnv is required"), "{}", e.msg);
        }
        other => panic!("{other:?}"),
    }
    // Nothing was spawned: the next open is the first session.
    let info = client.pty_open(&shell()).await.unwrap();
    assert_eq!(info.id, 0);
}

/// What the server's fds 0–2 point at, by `/dev/null` or not. macOS only: a
/// Linux server is non-dumpable, so its `/proc/<pid>/fd` is not ours to read.
#[cfg(target_os = "macos")]
fn standard_fds_of(pid: u32) -> Vec<String> {
    let out = Command::new("/usr/sbin/lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "0,1,2", "-Fn"])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.strip_prefix('n').map(str::to_string))
        .collect()
}

/// Launched with its standard streams closed, the server holds `/dev/null`
/// there, so nothing it opens — its log, a client's socket, a PTY master —
/// takes fd 0, 1 or 2, where a panic message or a stray print would land.
#[cfg(target_os = "macos")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closed_standard_streams_are_held_by_dev_null() {
    let dir = scratch();
    let (ready, theirs) = UnixStream::pair().unwrap();
    let fd = theirs.as_raw_fd();
    let mut cmd = command(dir.path(), &["--ready-fd", "3"], &[]);
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        cmd.pre_exec(move || {
            onto_ready_fd(fd)?;
            libc::close(0);
            libc::close(1);
            libc::close(2);
            Ok(())
        });
    }
    let mut server = Server {
        child: cmd.spawn().unwrap(),
        ready,
    };
    drop(theirs);
    server.wait_ready();
    let (client, _) = connect(dir.path()).await;
    client.pty_open(&shell()).await.unwrap();
    let fds = standard_fds_of(server.child.id());
    assert_eq!(fds, ["/dev/null", "/dev/null", "/dev/null"], "{fds:?}");
}

/// A session that ended keeps its server — and with it how the session
/// ended — until the reaper closes it; only then does an unused server
/// retire. A relaunched app finds "exited", not "server stopped".
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_exited_session_keeps_it_until_reaped() {
    let dir = scratch();
    let mut server = spawn(
        dir.path(),
        &[
            "--idle-grace-ms",
            "200",
            "--idle-initial-ms",
            "200",
            "--reap-after-ms",
            "2000",
        ],
    );
    server.wait_ready();
    let (client, _) = connect(dir.path()).await;
    let info = client
        .pty_open(&PtyOpenParams {
            command: "/bin/sh".into(),
            args: vec!["-c".into(), "exit 3".into()],
            ..shell()
        })
        .await
        .unwrap();
    drop(client);

    tokio::time::sleep(Duration::from_millis(1000)).await;
    assert!(
        server.child.try_wait().unwrap().is_none(),
        "it retired with an exited session nobody had read"
    );
    let (client, _) = connect(dir.path()).await;
    let sessions = client.pty_sessions().await.unwrap();
    assert!(
        sessions.iter().any(|s| s.id == info.id && !s.alive),
        "{sessions:?}"
    );
    drop(client);
    let status = server
        .exit_within(WAIT)
        .expect("it outlived the reaper and its grace");
    assert_eq!(status.code(), Some(0));
}

/// `server.stop`'s answer is on the wire before the server goes — by order,
/// not by a head start.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_always_answers_before_the_server_exits() {
    for round in 0..50 {
        let dir = scratch();
        let mut server = spawn(dir.path(), &[]);
        server.wait_ready();
        let (client, _) = connect(dir.path()).await;
        client
            .call::<m::ServerStop>(&Empty)
            .await
            .unwrap_or_else(|e| panic!("round {round}: {e}"));
        let status = server.exit_within(WAIT).expect("it did not stop");
        assert_eq!(status.code(), Some(0), "round {round}");
    }
}

// ── The server restores its own endpoint ─────────────────────────────────────

/// Fast looks, so the tests don't wait seconds for one.
const WATCHFUL: &[&str] = &["--endpoint-check-ms", "100"];

/// Dial and say hello until the server answers, or fail after [`WAIT`].
async fn reach(dir: &Path) -> (RemoteClient, HelloResult) {
    let deadline = Instant::now() + WAIT;
    loop {
        if let Ok(Ok(stream)) = tokio::time::timeout(
            Duration::from_millis(500),
            tokio::net::UnixStream::connect(socket(dir)),
        )
        .await
        {
            let (r, w) = stream.into_split();
            let client = RemoteClient::new(r, w);
            if let Ok(Ok(hello)) = tokio::time::timeout(
                Duration::from_millis(1500),
                client.hello("santree/test", "o"),
            )
            .await
            {
                return (client, hello);
            }
        }
        assert!(Instant::now() < deadline, "the socket never came back");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn server_pid(client: &RemoteClient) -> u32 {
    client.call::<m::ServerInfo>(&Empty).await.unwrap().pid
}

fn lock_file(dir: &Path) -> PathBuf {
    santree_server::endpoint::lock_path(&dir.join("run"))
}

/// Whether some process holds the lock at `path` (a shared probe, like the
/// app's: it excludes the server's exclusive one).
fn lock_held(path: &Path) -> bool {
    let file = File::open(path).unwrap();
    // SAFETY: a valid open fd.
    let got = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB) } == 0;
    !got
}

/// The agent in a terminal runs as the user and can `rm` the socket. The server
/// notices, binds again, and the app dials it as if nothing happened; the
/// connection it already had is untouched.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_removed_socket_is_restored_and_existing_connections_survive() {
    let dir = scratch();
    let mut server = spawn(dir.path(), WATCHFUL);
    server.wait_ready();
    let (before, _) = connect(dir.path()).await;
    let pid = server_pid(&before).await;
    assert_eq!(pid, server.child.id());

    fs::remove_file(socket(dir.path())).unwrap();
    assert!(tokio::net::UnixStream::connect(socket(dir.path()))
        .await
        .is_err());

    let (after, _) = reach(dir.path()).await;
    assert_eq!(server_pid(&after).await, pid, "a different server answered");
    assert_eq!(
        fs::metadata(socket(dir.path()))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    // The link that was open before is still the same server's.
    assert_eq!(server_pid(&before).await, pid);
    assert!(server.child.try_wait().unwrap().is_none());

    // Again: each rebind ends the previous accept loop (and its listener), and
    // the connections that loop accepted run on without it.
    fs::remove_file(socket(dir.path())).unwrap();
    let (third, _) = reach(dir.path()).await;
    assert_eq!(server_pid(&third).await, pid);
    assert_eq!(server_pid(&before).await, pid, "ended with its accept loop");
    assert_eq!(server_pid(&after).await, pid);
}

/// Both files removed: the server restores both, and a second server of the
/// same revision still finds the endpoint occupied.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_removed_socket_and_lock_are_both_restored_and_the_endpoint_stays_occupied() {
    let dir = scratch();
    let mut server = spawn(dir.path(), WATCHFUL);
    server.wait_ready();
    let (probe, _) = connect(dir.path()).await;
    let pid = server_pid(&probe).await;

    fs::remove_file(socket(dir.path())).unwrap();
    fs::remove_file(lock_file(dir.path())).unwrap();
    let (client, _) = reach(dir.path()).await;
    assert_eq!(server_pid(&client).await, pid);
    assert!(lock_file(dir.path()).exists(), "the lock was not restored");
    assert!(
        lock_held(&lock_file(dir.path())),
        "the restored lock is not held"
    );

    let mut second = spawn(dir.path(), &[]);
    assert_eq!(second.ready_line(), "occupied\n");
    let status = second.exit_within(WAIT).expect("the second server exited");
    assert_eq!(status.code(), Some(20));
}
