//! The supervisor against the REAL `santree-server` binary, over real sockets
//! in short scratch dirs. Every server a test starts is killed by its
//! `Fixture`.

// Tests type into, open and close terminals directly: clippy.toml's PTY rules
// hold shipped code to its sanctioned sites.
#![allow(clippy::disallowed_methods)]

use std::os::unix::fs::PermissionsExt;

use super::*;
use crate::server::connector::Verifier;
use crate::server::testkit::{self, hold_exclusive, script, until, Fixture};
use crate::sessions::{PaneLink, Sinks, Spec};
use santree_remote_client::proto::PtyOpenParams;

type Emitted = Arc<Mutex<Vec<ServerStatus>>>;
/// What the server last confirmed it holds awake.
type Held = Arc<Mutex<Option<bool>>>;

struct Harness {
    servers: Arc<LocalServers>,
    emitted: Emitted,
    keep_awake_calls: Arc<std::sync::atomic::AtomicUsize>,
    keep_awake: Arc<AtomicBool>,
    keep_awake_held: Held,
}

fn config_for(
    fx: &Fixture,
    mode: Mode,
    bundled: Option<PathBuf>,
) -> (
    ServerConfig,
    Emitted,
    Arc<std::sync::atomic::AtomicUsize>,
    Arc<AtomicBool>,
    Held,
) {
    let emitted: Emitted = Arc::default();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let on = Arc::new(AtomicBool::new(false));
    let held: Held = Arc::default();
    let cfg = ServerConfig {
        app_data_dir: fx.dir.path().to_path_buf(),
        log_dir: Some(fx.dir.path().join("logs")),
        bundled_binary: bundled,
        mode,
        ids: Arc::new(IdRegistry::default()),
        retire: Arc::new(|_| Box::pin(async {})),
        emit: {
            let emitted = emitted.clone();
            Arc::new(move |status| lock(&emitted).push(status))
        },
        keep_awake: {
            let (calls, on) = (calls.clone(), on.clone());
            Arc::new(move || {
                calls.fetch_add(1, Ordering::SeqCst);
                on.load(Ordering::SeqCst)
            })
        },
        keep_awake_held: {
            let held = held.clone();
            Arc::new(move |active| *lock(&held) = Some(active))
        },
    };
    (cfg, emitted, calls, on, held)
}

fn harness_with(fx: &Fixture, mode: Mode, bundled: Option<PathBuf>, revision: u32) -> Harness {
    let (cfg, emitted, calls, on, held) = config_for(fx, mode, bundled);
    Harness {
        servers: LocalServers::build(cfg, Ok(fx.layout.clone()), revision),
        emitted,
        keep_awake_calls: calls,
        keep_awake: on,
        keep_awake_held: held,
    }
}

fn harness(fx: &Fixture) -> Harness {
    harness_with(fx, Mode::OptIn, Some(testkit::real_binary()), REVISION)
}

fn running_pid(servers: &LocalServers) -> Option<u32> {
    match servers.status().state {
        ServerState::Running { pid, .. } => Some(pid),
        _ => None,
    }
}

fn server_pids(fx: &Fixture) -> Vec<u32> {
    testkit::pids_running_under(fx.dir.path())
}

fn is_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the pid exists.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

/// The draining servers as `(revision, session count)`.
fn draining_of(servers: &LocalServers) -> Vec<(u32, SessionCount)> {
    servers
        .status()
        .draining
        .iter()
        .map(|d| (d.revision, d.sessions))
        .collect()
}

fn down_reason(state: &ServerState) -> &str {
    match state {
        ServerState::Down { reason } | ServerState::Failing { reason } => reason,
        other => panic!("not down: {other:?}"),
    }
}

// ── ensure ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn ensure_launches_the_server_connects_and_announces_each_step() {
    let fx = Fixture::new();
    let h = harness(&fx);
    assert_eq!(
        h.servers.status().state,
        ServerState::Starting,
        "before ensure"
    );
    assert!(!h.servers.complete(), "nothing is known before ensure");

    h.servers.ensure().await;

    let ServerState::Running {
        revision,
        pid,
        live_sessions,
        started_at_ms,
        ..
    } = h.servers.status().state
    else {
        panic!("not running: {:?}", h.servers.status())
    };
    fx.track(pid);
    assert_eq!(revision, REVISION);
    assert_eq!(live_sessions, 0);
    assert!(started_at_ms > 1.0e12, "{started_at_ms}");
    assert!(is_alive(pid));
    assert!(h.servers.current().is_some());
    assert_eq!(h.servers.all().len(), 1);
    assert!(h.servers.complete());
    // Keep-awake was applied on the connect, from the app's setting.
    assert_eq!(h.keep_awake_calls.load(Ordering::SeqCst), 1);

    let states: Vec<ServerState> = lock(&h.emitted).iter().map(|s| s.state.clone()).collect();
    assert_eq!(states.first(), Some(&ServerState::Starting), "{states:?}");
    assert!(
        matches!(states.last(), Some(ServerState::Running { .. })),
        "{states:?}"
    );
    assert!(
        states.windows(2).all(|w| w[0] != w[1]),
        "an unchanged status isn't announced twice: {states:?}"
    );
}

#[tokio::test]
async fn two_ensures_racing_converge_on_one_server() {
    let fx = Fixture::new();
    let (a, b) = (harness(&fx), harness(&fx));
    tokio::join!(a.servers.ensure(), b.servers.ensure());

    let (pa, pb) = (running_pid(&a.servers), running_pid(&b.servers));
    assert!(pa.is_some(), "{:?}", a.servers.status());
    assert_eq!(pa, pb, "both adopted the winner");
    fx.track(pa.unwrap());
    // The loser exited "occupied" a moment ago; `ps` may still list it.
    until("the loser to be gone", 10, || {
        server_pids(&fx) == vec![pa.unwrap()]
    })
    .await;
}

#[tokio::test]
async fn a_stale_socket_and_a_dead_lock_are_replaced() {
    let fx = Fixture::new();
    fx.layout.prepare().unwrap();
    let socket = fx.layout.socket_for(REVISION);
    testkit::stale_socket(&socket);
    std::fs::File::create(fx.layout.run.join(endpoint::lock_name(REVISION))).unwrap();

    let h = harness(&fx);
    h.servers.ensure().await;
    let pid = running_pid(&h.servers).unwrap_or_else(|| panic!("{:?}", h.servers.status()));
    fx.track(pid);
    assert_eq!(testkit::info_over(&socket).await.pid, pid);
}

// ── why it isn't running ────────────────────────────────────────────────────

#[tokio::test]
async fn a_launch_that_fails_says_why_and_leaves_the_user_to_start_it() {
    let fx = Fixture::new();
    let scripts = fx.dir.path().join("fake");
    std::fs::create_dir(&scripts).unwrap();

    let cases = [
        (
            "exit 21",
            "santree server refused to start: it was not launched by santree",
        ),
        (
            "exit 22",
            "santree server is not signed by the expected team",
        ),
        (
            "echo 'cannot bind: address in use' >&2; exit 1",
            "cannot bind: address in use",
        ),
    ];
    for (i, (body, expected)) in cases.iter().enumerate() {
        let bin = script(&scripts, &format!("s{i}"), body);
        let h = harness_with(&fx, Mode::OptIn, Some(bin), REVISION);
        h.servers.ensure().await;
        let status = h.servers.status();
        let reason = down_reason(&status.state);
        assert!(reason.contains(expected), "{body}: {reason}");
        assert!(
            h.servers.current().is_none(),
            "no new panes on a server that isn't there"
        );
        // Nothing was listening, so nothing it held can still be running.
        assert!(h.servers.complete());
        assert!(h.servers.start().await.is_err());
    }

    // A build with no server to launch.
    let h = harness_with(&fx, Mode::OptIn, None, REVISION);
    h.servers.ensure().await;
    assert!(down_reason(&h.servers.status().state).contains("no santree server"));
}

#[tokio::test]
async fn a_server_the_signature_check_refuses_is_down_and_gets_no_panes() {
    // Signed mode, but the binary on the socket is unsigned: the app's real
    // peer check refuses it, so the app never speaks to it.
    let fx = Fixture::new();
    let h = harness_with(
        &fx,
        Mode::Signed { team: "ABCDE12345" },
        Some(testkit::real_binary()),
        REVISION,
    );
    h.servers.ensure().await;
    let status = h.servers.status();
    let reason = down_reason(&status.state);
    // Refused, or (the first check of a binary in a process is slow) not yet
    // judged: either way it is the socket's occupant that is the problem.
    assert!(
        reason.contains("on the santree server's socket"),
        "{reason}"
    );
    assert!(h.servers.current().is_none());
    assert!(
        !h.servers.complete(),
        "an unverifiable server may hold sessions"
    );
    assert!(h.servers.current.host.client().is_none());
    // The unsigned server the test launched is on the socket; it never saw `hello`.
    for pid in server_pids(&fx) {
        fx.track(pid);
    }
}

#[tokio::test]
async fn a_server_of_another_revision_on_the_current_socket_is_down() {
    let fx = Fixture::installed();
    let mut spawned = spawn::spawn_server(&fx.layout).unwrap();
    fx.track(spawned.pid);
    assert!(matches!(spawned.start().await, Start::Ready { .. }));
    // The same server, reachable as the next revision's socket: a build expecting
    // that revision finds this one there.
    std::fs::hard_link(
        fx.layout.socket_for(REVISION),
        fx.layout.socket_for(REVISION + 1),
    )
    .unwrap();

    let h = harness_with(&fx, Mode::OptIn, Some(testkit::real_binary()), REVISION + 1);
    h.servers.ensure().await;
    assert_eq!(
        h.servers.status().state,
        ServerState::Down {
            reason: "unexpected server revision".into()
        }
    );
    assert!(h.servers.current().is_none());
}

#[tokio::test]
async fn without_a_server_mode_there_is_nothing_to_start_and_the_status_still_answers() {
    let fx = Fixture::new();
    let h = harness_with(&fx, Mode::Off, None, REVISION);
    h.servers.ensure().await;
    assert_eq!(h.servers.status().state, ServerState::Off);
    assert!(h.servers.start().await.is_err());
    assert!(h.servers.current().is_none());
    assert!(h.servers.all().is_empty());
    assert!(h.servers.complete());
    h.servers.adopt_ready().await;
}

// ── respawn ─────────────────────────────────────────────────────────────────

fn crash_budget_at(offsets: &[u64]) -> Vec<bool> {
    let start = Instant::now();
    let mut budget = CrashBudget::default();
    offsets
        .iter()
        .map(|s| budget.allow(start + Duration::from_secs(*s)))
        .collect()
}

#[test]
fn five_crashes_a_minute_are_answered_and_the_sixth_is_not() {
    assert_eq!(
        crash_budget_at(&[0, 1, 2, 3, 4, 5]),
        [true, true, true, true, true, false]
    );
    // The window slides: the oldest crash ages out and frees a place.
    assert_eq!(
        crash_budget_at(&[0, 10, 20, 30, 40, 45, 61]),
        [true, true, true, true, true, false, true]
    );
    let mut budget = CrashBudget::default();
    let now = Instant::now();
    for _ in 0..5 {
        assert!(budget.allow(now));
    }
    assert!(!budget.allow(now));
    budget.reset();
    assert!(budget.allow(now));
}

fn kill_pid(pid: u32) {
    // SAFETY: SIGKILL to a test's own server.
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

#[tokio::test]
async fn a_server_that_dies_is_relaunched_and_a_crash_loop_ends_in_failing_until_started() {
    let fx = Fixture::new();
    let h = harness(&fx);
    h.servers.ensure().await;
    let mut pid = running_pid(&h.servers).expect("running");

    // Five crashes are each answered with a relaunch…
    for n in 1..=CRASH_LIMIT {
        kill_pid(pid);
        let was = pid;
        until(&format!("relaunch after crash {n}"), 30, || {
            running_pid(&h.servers).is_some_and(|p| p != was)
        })
        .await;
        pid = running_pid(&h.servers).unwrap();
    }
    // …the sixth within the window is not.
    kill_pid(pid);
    until("Failing", 30, || {
        matches!(h.servers.status().state, ServerState::Failing { .. })
    })
    .await;
    let status = h.servers.status();
    assert!(down_reason(&status.state).contains("won't be restarted automatically"));
    assert!(h.servers.current().is_none());
    assert!(
        h.servers.complete(),
        "nothing is listening: what it held is gone"
    );
    // And it stays down: nothing relaunches it behind the user's back.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(matches!(
        h.servers.status().state,
        ServerState::Failing { .. }
    ));
    assert_eq!(server_pids(&fx), Vec::<u32>::new());

    // Start is the user's call, with a fresh budget.
    h.servers.start().await.unwrap();
    assert!(running_pid(&h.servers).is_some());
    assert!(lock(&h.servers.budget).at.is_empty());
    for pid in server_pids(&fx) {
        fx.track(pid);
    }
}

#[tokio::test]
async fn restart_replaces_the_server_and_is_not_a_crash() {
    let fx = Fixture::new();
    let h = harness(&fx);
    h.servers.ensure().await;
    let first = running_pid(&h.servers).expect("running");
    fx.track(first);

    h.servers.restart().await.unwrap();
    let second = running_pid(&h.servers).expect("running again");
    fx.track(second);
    assert_ne!(first, second);
    assert!(
        !is_alive(first) || server_pids(&fx) == vec![second],
        "the old server is gone"
    );
    assert!(
        lock(&h.servers.budget).at.is_empty(),
        "a restart on purpose spends none of the crash budget"
    );
}

// ── quitting ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn release_disconnects_and_never_stops_the_server() {
    let fx = Fixture::new();
    let h = harness(&fx);
    h.servers.ensure().await;
    let pid = running_pid(&h.servers).expect("running");
    fx.track(pid);

    h.servers.release();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        is_alive(pid),
        "quitting leaves the server and its sessions running"
    );
    assert!(
        h.servers.current.host.client().is_none(),
        "but the link is let go"
    );
    // Nothing is relaunched or started once the app is going.
    h.servers.ensure().await;
    assert!(h.servers.start().await.is_err());
    assert_eq!(server_pids(&fx), vec![pid]);

    // The next launch of the app finds the same server, sessions and all.
    let next = harness(&fx);
    next.servers.ensure().await;
    assert_eq!(running_pid(&next.servers), Some(pid));
}

// ── keep-awake ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn keep_awake_follows_the_apps_setting_on_every_connect_and_tick() {
    let fx = Fixture::new();
    let h = harness(&fx);
    h.keep_awake.store(true, Ordering::SeqCst);
    h.servers.ensure().await;
    fx.track(running_pid(&h.servers).expect("running"));
    assert_eq!(h.keep_awake_calls.load(Ordering::SeqCst), 1);

    // The server holds the machine awake where it can, as the setting says…
    let on = h
        .servers
        .apply_keep_awake()
        .await
        .unwrap()
        .expect("offered");
    assert!(on.active);
    assert_eq!(
        *lock(&h.keep_awake_held),
        Some(on.active),
        "the app is told what the server holds, not what it asked for"
    );
    // …and a reconnect asks the setting again.
    let before = h.keep_awake_calls.load(Ordering::SeqCst);
    h.keep_awake.store(false, Ordering::SeqCst);
    h.servers.current.kick();
    until("the reconnect to re-apply keep-awake", 10, || {
        h.keep_awake_calls.load(Ordering::SeqCst) > before
    })
    .await;
    let off = h
        .servers
        .apply_keep_awake()
        .await
        .unwrap()
        .expect("offered");
    assert!(!off.active);
    assert_eq!(*lock(&h.keep_awake_held), Some(false));

    // The setting moves without the toggle command (a restore, another
    // window): the next tick tells the server, once.
    assert_eq!(*lock(&h.servers.keep_awake_sent), Some(false));
    h.servers.sync_keep_awake().await;
    assert_eq!(*lock(&h.servers.keep_awake_sent), Some(false));
    h.keep_awake.store(true, Ordering::SeqCst);
    h.servers.sync_keep_awake().await;
    assert_eq!(*lock(&h.servers.keep_awake_sent), Some(true));
    assert!(
        h.servers
            .apply_keep_awake()
            .await
            .unwrap()
            .expect("offered")
            .active
    );
}

// ── adoption ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn adopt_ready_waits_for_the_supervisor_and_complete_tracks_the_link() {
    let fx = Fixture::new();
    let h = harness(&fx);
    let ready = {
        let servers = h.servers.clone();
        tokio::spawn(async move { servers.adopt_ready().await })
    };
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(
        !ready.is_finished(),
        "nothing is known before ensure has an answer"
    );

    h.servers.ensure().await;
    tokio::time::timeout(Duration::from_secs(10), ready)
        .await
        .expect("adopt_ready resolves once settled")
        .unwrap();
    fx.track(running_pid(&h.servers).expect("running"));
    assert!(h.servers.complete());

    // Losing the link makes what is known incomplete until it is known again.
    kill_pid(running_pid(&h.servers).unwrap());
    until(
        "an incomplete state while the server is unreachable",
        10,
        || !h.servers.complete(),
    )
    .await;
}

// ── older servers ───────────────────────────────────────────────────────────

async fn open_session(socket: &Path) -> RemoteClient {
    let stream = tokio::net::UnixStream::connect(socket).await.unwrap();
    let (reader, writer) = stream.into_split();
    let client = RemoteClient::new(reader, writer);
    client.hello("santree/test", "test-owner").await.unwrap();
    client
        .pty_open(&PtyOpenParams {
            command: "/bin/sleep".into(),
            args: vec!["60".into()],
            cols: 80,
            rows: 24,
            // A server that takes its sessions' environment from the app
            // requires one.
            base_env: vec![("PATH".into(), "/usr/bin:/bin".into())],
            owner: "test-owner".into(),
            label: "tree:legacy".into(),
            ..PtyOpenParams::default()
        })
        .await
        .unwrap();
    client
}

#[tokio::test]
async fn an_older_server_with_sessions_drains_and_one_without_is_let_go() {
    let fx = Fixture::installed();
    let mut spawned = spawn::spawn_server(&fx.layout).unwrap();
    fx.track(spawned.pid);
    assert!(matches!(spawned.start().await, Start::Ready { .. }));
    let socket = fx.layout.socket_for(REVISION);

    // This "build" is the next revision; the running server is an older one to it.
    let h = harness_with(&fx, Mode::OptIn, Some(testkit::real_binary()), REVISION + 1);

    // Idle: nothing to keep alive, so it is disconnected and retires itself.
    h.servers.discover_legacy().await;
    assert!(h.servers.status().draining.is_empty());
    assert_eq!(h.servers.all().len(), 1);

    // With a session it is kept: its panes still route there.
    let _owner = open_session(&socket).await;
    h.servers.discover_legacy().await;
    assert_eq!(
        draining_of(&h.servers),
        vec![(REVISION, SessionCount::Known { count: 1 })]
    );
    assert_eq!(h.servers.all().len(), 2);
    let draining = h.servers.status().draining;
    assert_eq!(
        draining[0].pid,
        Some(spawned.pid),
        "who it is, from server.info"
    );
    assert_eq!(
        draining[0].version.as_deref(),
        Some(env!("CARGO_PKG_VERSION"))
    );
    assert!(
        lock(&h.emitted).iter().any(|s| s.draining.len() == 1),
        "the draining server was announced"
    );

    // Ending it is the user's call and closes what it holds.
    h.servers.end_draining(REVISION).await.unwrap();
    assert!(h.servers.status().draining.is_empty());
    until("the old server to exit", 10, || !is_alive(spawned.pid)).await;
    assert!(
        h.servers.end_draining(REVISION).await.is_err(),
        "no longer there"
    );
}

#[tokio::test]
async fn a_drained_server_is_let_go_so_it_can_retire() {
    let fx = Fixture::installed();
    let mut spawned = spawn::spawn_server(&fx.layout).unwrap();
    fx.track(spawned.pid);
    assert!(matches!(spawned.start().await, Start::Ready { .. }));
    let owner = open_session(&fx.layout.socket_for(REVISION)).await;
    let sessions = owner.pty_sessions().await.unwrap();

    let h = harness_with(&fx, Mode::OptIn, Some(testkit::real_binary()), REVISION + 1);
    h.servers.discover_legacy().await;
    assert_eq!(h.servers.status().draining.len(), 1);

    owner.pty_close(sessions[0].id).await.unwrap();
    for _ in 0..100 {
        h.servers.refresh_draining().await;
        if h.servers.status().draining.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        h.servers.status().draining.is_empty(),
        "the empty draining server was let go"
    );
}

// ── older servers: what may be let go ───────────────────────────────────────

/// An older server's endpoint as it looks on disk: its lock file, and a socket.
fn plant_lock(layout: &Layout, revision: u32) {
    std::fs::File::create(layout.run.join(endpoint::lock_name(revision))).unwrap();
}

/// A listener that accepts and never says a word: a server that is hung.
fn hang_at(socket: &Path) -> tokio::task::JoinHandle<()> {
    let listener = tokio::net::UnixListener::bind(socket).unwrap();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((stream, _)) = listener.accept().await {
            held.push(stream);
        }
    })
}

fn pretend_current_is_dead(servers: &Arc<LocalServers>) {
    *lock(&servers.current.endpoint) = Endpoint::Dead;
    servers.set_phase(Phase::Down("test".into()));
}

#[tokio::test]
async fn an_older_server_that_does_not_answer_is_kept_open_not_forgotten() {
    let fx = Fixture::new();
    fx.layout.prepare().unwrap();
    // r1 hangs; r2 is a stale socket file nobody listens on.
    plant_lock(&fx.layout, 1);
    plant_lock(&fx.layout, 2);
    let _hung = hang_at(&fx.layout.socket_for(1));
    testkit::stale_socket(&fx.layout.socket_for(2));

    let h = harness_with(&fx, Mode::OptIn, None, 3);
    pretend_current_is_dead(&h.servers);
    assert!(h.servers.complete(), "nothing else is known to run");

    h.servers.discover_legacy().await;

    // The refused one is gone, and rightly so. The silent one may be running
    // agents: it stays, with a session count nobody knows.
    assert_eq!(draining_of(&h.servers), vec![(1, SessionCount::Unknown)]);
    assert!(
        !h.servers.complete(),
        "a server we can't hear from may hold agents; their absence is not an exit"
    );
    assert!(h.servers.untrusted_servers().is_empty());
    let slot = lock(&h.servers.draining).get(&1).cloned().unwrap();
    assert!(!slot.sessions_known.load(Ordering::SeqCst));
}

#[tokio::test]
async fn an_older_server_that_never_answers_is_given_up_on_and_reported() {
    let fx = Fixture::new();
    fx.layout.prepare().unwrap();
    plant_lock(&fx.layout, 1);
    let _hung = hang_at(&fx.layout.socket_for(1));
    let h = harness_with(&fx, Mode::OptIn, None, 2);
    pretend_current_is_dead(&h.servers);
    h.servers.discover_legacy().await;
    assert!(!h.servers.complete());

    // Not yet: the bound hasn't passed.
    h.servers.refresh_draining().await;
    assert_eq!(h.servers.status().draining.len(), 1);

    // Past the bound it stops holding the app's picture open, and says so.
    let slot = lock(&h.servers.draining).get(&1).cloned().unwrap();
    *lock(&slot.since) = Instant::now() - UNRESOLVED_BOUND - Duration::from_secs(1);
    h.servers.refresh_draining().await;
    assert!(h.servers.status().draining.is_empty());
    assert_eq!(h.servers.unreachable_servers().len(), 1);
    assert!(h.servers.complete());
}

#[tokio::test]
async fn only_a_definitive_refusal_drops_an_older_socket_as_untrusted() {
    use santree_server::peer::Verdict;

    let fx = Fixture::new();
    fx.layout.prepare().unwrap();
    for rev in 1..=5 {
        plant_lock(&fx.layout, rev);
    }
    let _hung: Vec<_> = (1..=5)
        .map(|rev| hang_at(&fx.layout.socket_for(rev)))
        .collect();

    let h = harness_with(&fx, Mode::OptIn, None, 6);
    pretend_current_is_dead(&h.servers);
    // What each older socket's peer check says:
    //  r1  the requirement was evaluated and failed: a squatter
    //  r2  the check ran out of time
    //  r3  the check itself blew up
    //  r4  the peer's uid couldn't be read
    //  r5  the peer's audit token couldn't be read
    // Only the first is a verdict. The rest say nothing about who is there, and
    // a server that may be running agents must not be forgotten on their word.
    let make: TestConnectors = Arc::new(|socket: &Path| {
        let name = socket.file_name().unwrap().to_string_lossy().into_owned();
        let verifier: Verifier = match name.as_str() {
            "server-r1.sock" => Arc::new(|_| {
                Verdict::Refused(
                    "peer is not com.santree.server signed by team ABCDE12345: OSStatus -67050 \
                     (code failed to satisfy specified code requirement(s))"
                        .into(),
                )
            }),
            "server-r2.sock" => Arc::new(|_| {
                std::thread::sleep(Duration::from_millis(700));
                Verdict::Trusted
            }),
            "server-r3.sock" => Arc::new(|_| panic!("the signature library fell over")),
            "server-r4.sock" => {
                Arc::new(|_| Verdict::Refused("uid of peer unreadable: EINVAL".into()))
            }
            _ => Arc::new(|_| {
                Verdict::Refused(
                    "peer is not com.santree.server signed by team ABCDE12345: peer audit \
                     token unreadable: Invalid argument (os error 22)"
                        .into(),
                )
            }),
        };
        Arc::new(
            ServerConnector::new(socket.to_path_buf(), Expect::UidOnly)
                .with_verifier(verifier)
                .with_timeout(Duration::from_millis(100)),
        )
    });
    *lock(&h.servers.legacy_connector) = Some(make);

    h.servers.discover_legacy().await;

    let untrusted: Vec<u32> = h
        .servers
        .untrusted_servers()
        .iter()
        .map(|(r, _)| *r)
        .collect();
    assert_eq!(untrusted, [1], "only the definitive refusal is a squatter");
    let kept: Vec<u32> = h
        .servers
        .status()
        .draining
        .iter()
        .map(|d| d.revision)
        .collect();
    assert_eq!(kept, [2, 3, 4, 5], "everything else may hold agents");
    assert!(!h.servers.complete());

    // Reported with the reason.
    let untrusted = h.servers.untrusted_servers();
    assert!(
        untrusted[0].1.contains("not com.santree.server"),
        "{untrusted:?}"
    );
    assert!(h.servers.unreachable_servers().is_empty());

    // A problem is about a socket that was there: once r1's socket and lock are
    // gone, so is the entry.
    std::fs::remove_file(fx.layout.socket_for(1)).unwrap();
    std::fs::remove_file(lock_beside(&fx.layout.socket_for(1), 1)).unwrap();
    h.servers.discover_legacy().await;
    assert!(
        h.servers.untrusted_servers().is_empty(),
        "an entry for a socket that is gone is cleared"
    );
}

#[test]
fn a_legacy_candidate_is_older_plain_and_has_its_lock() {
    let dir = testkit::scratch();
    let bind = |name: &str| std::os::unix::net::UnixListener::bind(dir.path().join(name)).unwrap();
    let lock_for =
        |rev: &str| std::fs::write(dir.path().join(format!("server-r{rev}.lock")), b"").unwrap();
    let mut keep = Vec::new();
    for (name, rev) in [
        ("server-r1.sock", "1"),
        ("server-r2.sock", "2"),
        ("server-r3.sock", "3"),
        ("server-r7.sock", "7"),
        ("server-r0.sock", "0"),
    ] {
        keep.push(bind(name));
        lock_for(rev);
    }
    // No lock beside it.
    keep.push(bind("server-r4.sock"));
    // Not a socket.
    std::fs::write(dir.path().join("server-r5.sock"), b"x").unwrap();
    lock_for("5");
    // Names that are not plain decimal revisions.
    for name in [
        "server-r+6.sock",
        "server-r06.sock",
        "server-r 8.sock",
        "server-r.sock",
        "server-r9x.sock",
        "server-rX.sock",
        "other.sock",
        "server-r99999999999.sock",
    ] {
        if let Ok(l) = std::os::unix::net::UnixListener::bind(dir.path().join(name)) {
            keep.push(l);
        }
    }
    for rev in ["+6", "06", " 8", "9x", "X", "99999999999"] {
        lock_for(rev);
    }

    let mut found: Vec<u32> = legacy_sockets(dir.path(), 3)
        .into_iter()
        .map(|(r, _)| r)
        .collect();
    found.sort_unstable();
    assert_eq!(found, [0, 1, 2], "strictly older than 3, plain, with locks");
    assert!(legacy_sockets(&dir.path().join("missing"), 3).is_empty());

    assert_eq!(parse_revision("server-r12.sock"), Some(12));
    assert_eq!(parse_revision("server-r0.sock"), Some(0));
    for bad in [
        "server-r012.sock",
        "server-r+1.sock",
        "server-r-1.sock",
        "server-r1.sock.bak",
        "server-r.sock",
        "server-r4294967296.sock",
    ] {
        assert_eq!(parse_revision(bad), None, "{bad}");
    }
}

#[test]
fn at_most_eight_older_servers_are_looked_for_newest_first() {
    let found: BTreeMap<u32, PathBuf> = (1..=12)
        .map(|r| (r, PathBuf::from(format!("/r{r}"))))
        .collect();
    let picked: Vec<u32> = pick_legacy(found).into_iter().map(|(r, _)| r).collect();
    assert_eq!(picked, [12, 11, 10, 9, 8, 7, 6, 5]);
}

#[tokio::test]
async fn a_run_dir_that_is_not_private_is_not_scanned() {
    let fx = Fixture::new();
    let other = fx.layout.other_run.clone().expect("a second run dir");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::set_permissions(&other, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(other.join("server-r1.lock"), b"").unwrap();
    let _hung = hang_at(&other.join("server-r1.sock"));

    let h = harness_with(&fx, Mode::OptIn, None, 2);
    h.servers.discover_legacy().await;
    assert!(
        h.servers.status().draining.is_empty(),
        "a dir anyone could write into is not believed"
    );

    // The same dir, made private, is.
    std::fs::set_permissions(&other, std::fs::Permissions::from_mode(0o700)).unwrap();
    h.servers.discover_legacy().await;
    assert_eq!(h.servers.status().draining.len(), 1);
}

// ── state: starting that goes nowhere, adoption, panes ───────────────────────

#[tokio::test]
async fn a_failed_reconnect_does_not_leave_the_phase_starting_for_good() {
    let fx = Fixture::new();
    let h = harness_with(&fx, Mode::OptIn, None, REVISION);
    let silent = HostStatus::Down(ConnectError::Failed(
        "the session host didn't answer in time".into(),
    ));

    // A slow peer check isn't a verdict.
    h.servers
        .on_status(HostStatus::Down(ConnectError::Unverified {
            slow: true,
            why: "the peer check took longer than 2.5 s".into(),
        }));
    assert!(matches!(h.servers.phase(), Phase::Starting));

    // A bring-up in progress is working it out itself.
    let held = h.servers.gate.lock().await;
    h.servers.on_status(silent.clone());
    assert!(matches!(h.servers.phase(), Phase::Starting));
    drop(held);

    h.servers.on_status(silent);
    assert!(
        matches!(h.servers.phase(), Phase::Down(_)),
        "{:?}",
        h.servers.phase()
    );

    h.servers.set_phase(Phase::Starting);
    h.servers
        .on_status(HostStatus::VersionMismatch { theirs: Some(9) });
    let status = h.servers.status();
    assert!(
        down_reason(&status.state).contains("another protocol"),
        "{status:?}"
    );
}

#[tokio::test]
async fn adopt_ready_does_not_resolve_on_a_down_that_may_pass() {
    let fx = Fixture::new();
    let h = harness_with(&fx, Mode::OptIn, None, REVISION);
    h.servers.discovered.send_replace(true);
    h.servers.set_phase(Phase::Down("can't reach it".into()));

    let waiting = {
        let servers = h.servers.clone();
        tokio::spawn(async move { servers.adopt_ready().await })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        !waiting.is_finished(),
        "a server that is only unreachable may still come back with agents in it"
    );

    // Once nothing listens, there is nothing to wait for.
    *lock(&h.servers.current.endpoint) = Endpoint::Dead;
    tokio::time::timeout(Duration::from_secs(5), waiting)
        .await
        .expect("resolves when the server is known dead")
        .unwrap();
}

fn screen() -> (Sinks, Arc<Mutex<Vec<PaneLink>>>) {
    let links: Arc<Mutex<Vec<PaneLink>>> = Arc::default();
    let sinks = Sinks {
        output: Arc::new(|_| {}),
        link: {
            let links = links.clone();
            Arc::new(move |link| lock(&links).push(link))
        },
    };
    (sinks, links)
}

fn a_spec(label: &str) -> Spec {
    Spec {
        cwd: None,
        command: "/bin/sleep".into(),
        args: vec!["60".into()],
        env: Vec::new(),
        label: label.into(),
        agent_kind: None,
    }
}

#[tokio::test]
async fn panes_of_a_draining_server_that_dies_are_told_it_is_lost() {
    let fx = Fixture::installed();
    let mut spawned = spawn::spawn_server(&fx.layout).unwrap();
    fx.track(spawned.pid);
    assert!(matches!(spawned.start().await, Start::Ready { .. }));
    let _session = open_session(&fx.layout.socket_for(REVISION)).await;

    let h = harness_with(&fx, Mode::OptIn, None, REVISION + 1);
    h.servers.discover_legacy().await;
    let slot = lock(&h.servers.draining)
        .get(&REVISION)
        .cloned()
        .expect("draining");
    // Adoption turns its session into a pane; a view attaches to it.
    let mut adopted = Vec::new();
    until("the draining server's session to be adopted", 10, || {
        adopted = slot.terminals.adopt("page");
        !adopted.is_empty()
    })
    .await;
    let (sinks, links) = screen();
    slot.terminals
        .attach(
            adopted[0].id,
            santree_remote_client::proto::Anchor::Fresh,
            sinks,
        )
        .await
        .unwrap();

    kill_pid(spawned.pid);
    until("the pane to be told its server is lost", 15, || {
        lock(&links).contains(&PaneLink::Lost)
    })
    .await;
    assert_eq!(slot.endpoint(), Endpoint::Dead);
    until("the dead draining server to be dropped", 5, || {
        h.servers.status().draining.is_empty()
    })
    .await;
}

#[tokio::test]
async fn a_tab_opened_while_the_server_was_coming_up_is_lost_when_it_never_does() {
    let fx = Fixture::new();
    // No server in this build: the launch will fail.
    let h = harness_with(&fx, Mode::OptIn, None, REVISION);
    let terminals = h
        .servers
        .current()
        .expect("new panes may queue for a starting server");
    let (sinks, links) = screen();
    let id = terminals
        .open(a_spec("tree:queued"), "page".into(), (80, 24), None, sinks)
        .await
        .unwrap();
    assert_eq!(
        *lock(&links),
        [PaneLink::Reconnecting],
        "it waits for a link"
    );

    h.servers.ensure().await;
    assert!(matches!(h.servers.phase(), Phase::Down(_)));
    assert!(
        lock(&links).contains(&PaneLink::Lost),
        "a later Start must not type this tab's launch line: {:?}",
        lock(&links)
    );
    assert!(!terminals.seed_wanted(id));
}

// ── trust is pinned, not implied ────────────────────────────────────────────

#[test]
fn each_mode_demands_one_level_of_trust_everywhere() {
    let team = Mode::Signed { team: "ABCDE12345" };
    assert_eq!(
        trust_for(team),
        (Expect::Team("ABCDE12345".into()), Required::Signed)
    );
    assert_eq!(trust_for(Mode::OptIn), (Expect::UidOnly, Required::UidOnly));
    assert_eq!(trust_for(Mode::Off), (Expect::UidOnly, Required::UidOnly));
}

#[tokio::test]
async fn a_slot_insists_on_its_modes_trust_before_any_byte() {
    use santree_remote_client::fake::FakeDaemon;
    use santree_remote_client::PeerTrust;

    let fx = Fixture::new();
    for (mode, enough, too_little) in [
        (
            Mode::Signed { team: "ABCDE12345" },
            PeerTrust::Signed {
                team: "ABCDE12345".into(),
            },
            PeerTrust::UidOnly,
        ),
        (Mode::OptIn, PeerTrust::UidOnly, PeerTrust::Unverified),
    ] {
        let (cfg, ..) = config_for(&fx, mode, None);
        let daemon = FakeDaemon::new();
        daemon.set_peer(too_little.clone());
        let slot = build_slot_over(
            &cfg,
            1,
            Path::new("/nonexistent/server-r1.sock"),
            daemon.connector(),
            "owner",
        );

        // A link below the mode's bar is dropped, `hello` unsent — and so is
        // everything a pane would send: the terminals speak over no other link.
        let pane = slot
            .terminals
            .open(
                crate::sessions::Spec {
                    cwd: None,
                    command: "/bin/sh".into(),
                    args: Vec::new(),
                    env: vec![("SECRET".into(), "s3cr3t".into())],
                    label: "tree:A:tab:1".into(),
                    agent_kind: None,
                },
                "page".into(),
                (80, 24),
                None,
                crate::sessions::Sinks {
                    output: Arc::new(|_| {}),
                    link: Arc::new(|_| {}),
                },
            )
            .await
            .expect("a pane waits for a link");
        slot.kick();
        let status = settle(&slot.host, Duration::from_secs(5)).await;
        assert!(
            matches!(status, HostStatus::Down(ConnectError::Untrusted(_))),
            "{mode:?} accepted a {too_little:?} link: {status:?}"
        );
        assert_eq!(
            daemon.request_log(),
            Vec::<String>::new(),
            "{mode:?}: the daemon was spoken to"
        );
        slot.terminals.close(pane);

        daemon.set_peer(enough);
        slot.kick();
        let status = settle(&slot.host, Duration::from_secs(5)).await;
        assert!(
            matches!(status, HostStatus::Connected { .. }),
            "{mode:?}: {status:?}"
        );
        slot.host.stop();
    }
}

// ── the smoke guard, healthy servers, binaries ──────────────────────────────

/// Under the smoke run nothing launches a server — not the app's own ensure,
/// and not `server_start`, a command the webview can call — or CI is left
/// with a server nobody kills.
#[tokio::test]
async fn ensure_and_start_do_nothing_in_a_smoke_run() {
    let fx = Fixture::new();
    let h = harness(&fx);
    h.servers.ensure_unless(true).await;
    let refused = h.servers.start_unless(true).await;
    assert!(refused.is_err(), "a smoke run was told the server started");
    assert!(matches!(h.servers.phase(), Phase::Starting));
    assert_eq!(server_pids(&fx), Vec::<u32>::new(), "no server was started");
    assert!(!*h.servers.discovered.borrow());
}

#[tokio::test]
async fn ensure_and_start_leave_a_healthy_connected_server_alone() {
    let fx = Fixture::new();
    let h = harness(&fx);
    h.servers.ensure().await;
    let pid = running_pid(&h.servers).expect("running");
    fx.track(pid);
    let generation = h.servers.current.host.generation();

    h.servers.ensure().await;
    h.servers.start().await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;

    assert_eq!(
        h.servers.current.host.generation(),
        generation,
        "the link was dropped and re-made under a healthy server"
    );
    assert_eq!(running_pid(&h.servers), Some(pid));
}

#[tokio::test]
async fn a_server_that_is_already_answering_is_connected_to_not_launched_over() {
    let fx = Fixture::installed();
    let mut running = spawn::spawn_server(&fx.layout).unwrap();
    fx.track(running.pid);
    assert!(matches!(running.start().await, Start::Ready { .. }));
    let installed = std::fs::read(&fx.layout.bin).unwrap();

    // A bundle that differs from what is installed: with nothing running that
    // would replace it and launch; with a server answering it must do neither.
    let scripts = fx.dir.path().join("fake");
    std::fs::create_dir(&scripts).unwrap();
    let marker = fx.dir.path().join("ran");
    let other = script(&scripts, "s", &format!("touch {}", marker.display()));
    let h = harness_with(&fx, Mode::OptIn, Some(other), REVISION);

    assert!(
        h.servers.launch(&fx.layout).await,
        "{:?}",
        h.servers.status()
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!marker.exists(), "a second server was launched");
    assert_eq!(
        std::fs::read(&fx.layout.bin).unwrap(),
        installed,
        "a running binary was replaced"
    );
    assert!(matches!(
        h.servers.host_status(),
        HostStatus::Connected { .. }
    ));
    assert_eq!(server_pids(&fx), vec![running.pid]);
}

#[tokio::test]
async fn a_tab_that_got_its_terminals_before_down_cannot_queue_after_it() {
    let fx = Fixture::new();
    let h = harness_with(&fx, Mode::OptIn, None, REVISION);
    // The tab asked for the current server while it was starting…
    let terminals = h
        .servers
        .current()
        .expect("a starting server takes new panes");
    // …the server never came…
    h.servers.ensure().await;
    assert!(matches!(h.servers.phase(), Phase::Down(_)));
    // …and the open reaches the terminals only now, after the sweep of the
    // waiting tabs has already run. It must not sit queued for a later Start.
    let (sinks, links) = screen();
    let id = terminals
        .open(a_spec("tree:late"), "page".into(), (80, 24), None, sinks)
        .await
        .unwrap();
    assert!(
        lock(&links).contains(&PaneLink::Lost),
        "a late tab would type its launch line when the user clicks Start: {:?}",
        lock(&links)
    );
    assert!(!terminals.seed_wanted(id));

    // Once the supervisor is trying again, tabs queue as usual.
    h.servers.set_phase(Phase::Starting);
    let (sinks, links) = screen();
    terminals
        .open(a_spec("tree:next"), "page".into(), (80, 24), None, sinks)
        .await
        .unwrap();
    assert_eq!(*lock(&links), [PaneLink::Reconnecting]);
}

/// An older "server" that answers `hello`, `server.info` and `pty.sessions`
/// (one live session) and says yes to `server.stop` — and carries on. One that
/// does not stop when asked.
fn stubborn_server_at(socket: &Path) -> tokio::task::JoinHandle<()> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let listener = tokio::net::UnixListener::bind(socket).unwrap();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (reader, mut writer) = stream.into_split();
                let mut lines = BufReader::new(reader).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let Ok(req) = serde_json::from_str::<serde_json::Value>(&line) else {
                        continue;
                    };
                    let result = match req["m"].as_str() {
                        Some("hello") => serde_json::json!({
                            "protocol": santree_remote_client::proto::PROTOCOL_VERSION,
                            "version": "0", "hostname": "h", "user": "u", "home": "/",
                            "bootId": "boot", "projectsRoot": "/", "hookBin": "/x",
                            "features": [],
                        }),
                        Some("server.info") => serde_json::json!({
                            "version": "0", "revision": 1, "pid": 1, "startedAtMs": 0,
                            "exe": "", "liveSessions": 1, "clients": 1,
                        }),
                        Some("pty.sessions") => serde_json::json!([{
                            "id": 1, "pid": 1, "command": "sleep", "owner": "o",
                            "label": "tree:x", "cols": 80, "rows": 24, "attached": false,
                            "alive": true, "epoch": "e",
                        }]),
                        Some("server.stop") => serde_json::json!({}),
                        _ => continue,
                    };
                    let reply = serde_json::json!({"id": req["id"], "ok": result});
                    if writer
                        .write_all(format!("{reply}\n").as_bytes())
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            });
        }
    })
}

#[tokio::test]
async fn ending_a_draining_server_that_does_not_stop_keeps_it_and_says_so() {
    let fx = Fixture::new();
    fx.layout.prepare().unwrap();
    plant_lock(&fx.layout, 1);
    let _server = stubborn_server_at(&fx.layout.socket_for(1));

    let h = harness_with(&fx, Mode::OptIn, None, 2);
    h.servers.discover_legacy().await;
    assert_eq!(
        draining_of(&h.servers),
        vec![(1, SessionCount::Known { count: 1 })]
    );
    h.servers.stop_wait_ms.store(300, Ordering::SeqCst);

    let err = h.servers.end_draining(1).await.unwrap_err();
    assert!(err.to_string().contains("didn't stop"), "{err:#}");
    // Still there, still counted: it is running, whatever it said.
    assert_eq!(h.servers.status().draining.len(), 1);
    let slot = lock(&h.servers.draining).get(&1).cloned().expect("kept");
    assert_ne!(slot.endpoint(), Endpoint::Dead);
    assert!(matches!(
        slot.host.current_status(),
        HostStatus::Connected { .. }
    ));
}

#[tokio::test]
async fn ending_a_draining_server_that_stops_tells_its_panes_they_are_lost() {
    let fx = Fixture::installed();
    let mut spawned = spawn::spawn_server(&fx.layout).unwrap();
    fx.track(spawned.pid);
    assert!(matches!(spawned.start().await, Start::Ready { .. }));
    let _owner = open_session(&fx.layout.socket_for(REVISION)).await;

    let h = harness_with(&fx, Mode::OptIn, None, REVISION + 1);
    h.servers.discover_legacy().await;
    let slot = lock(&h.servers.draining)
        .get(&REVISION)
        .cloned()
        .expect("draining");
    let mut adopted = Vec::new();
    until("the session to be adopted", 10, || {
        adopted = slot.terminals.adopt("page");
        !adopted.is_empty()
    })
    .await;
    let (sinks, links) = screen();
    let attached = slot
        .terminals
        .attach(
            adopted[0].id,
            santree_remote_client::proto::Anchor::Fresh,
            sinks,
        )
        .await
        .unwrap();
    assert_eq!(
        attached.mode,
        santree_remote_client::proto::ReplayMode::Tail,
        "{attached:?}"
    );

    tokio::time::timeout(Duration::from_secs(20), h.servers.end_draining(REVISION))
        .await
        .expect("end_draining hung")
        .unwrap();
    assert!(lock(&links).contains(&PaneLink::Lost), "{:?}", lock(&links));
    assert!(h.servers.status().draining.is_empty());
    assert_eq!(slot.endpoint(), Endpoint::Dead);
}

// ── a socket that vanishes under a live server ──────────────────────────────

/// A process that holds a revision's endpoint lock, as a live server does.
fn hold_lock(dir: &Path, revision: u32) -> testkit::HeldLock {
    hold_exclusive(&dir.join(endpoint::lock_name(revision)))
}

/// The user is told the server is there but unreachable; nothing was launched.
fn assert_socket_gone(h: &Harness, fx: &Fixture) {
    let state = h.servers.status().state;
    assert_eq!(
        down_reason(&state),
        socket_gone(&lock_beside(&fx.layout.socket_for(REVISION), REVISION))
    );
    assert!(
        !h.servers.complete(),
        "a live server we can't reach holds agents we can't see"
    );
    assert_eq!(server_pids(fx), Vec::<u32>::new(), "a launch was attempted");
}

/// A same-uid agent can `rm` a live server's socket. The lock beside it is
/// still held by the server: that is a server alive, not one that died, and
/// reading it as dead is how an agent running fine reads as exited and gets
/// resumed a second time.
#[tokio::test]
async fn a_live_servers_missing_socket_is_unreachable_not_dead() {
    use crate::session::{occupancy, Occupancy};
    let fx = Fixture::new();
    fx.layout.prepare().unwrap();
    let held = hold_lock(&fx.layout.run, REVISION);
    let h = harness(&fx);

    h.servers.ensure().await;
    assert_socket_gone(&h, &fx);
    assert_eq!(h.servers.current.endpoint(), Endpoint::Orphaned);
    assert!(
        lock(&h.servers.budget).allow(Instant::now()),
        "not a crash: the budget is untouched"
    );

    // Through the facade: nothing reads as exited, and a resume is refused.
    let dir = tempfile::tempdir().unwrap();
    let db = crate::db::init(dir.path().join("t.db")).await.unwrap();
    sqlx::query(
        "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, agent_kind) \
         VALUES ('r', 'tree:A:tab:1', '/w', 's1', 'Claude')",
    )
    .execute(&db)
    .await
    .unwrap();
    let daedalus = crate::daedalus::host::DaedalusHost::default();
    let terminals = crate::sessions::Terminals::new(
        crate::sessions::Local::Server(h.servers.clone()),
        daedalus.terminals().clone(),
        daedalus.ids().clone(),
    );
    let live = terminals.liveness().await;
    assert!(!live.complete);
    assert_eq!(
        occupancy(
            &db,
            "r",
            "s1",
            santree_core::domain::AgentKind::Claude,
            &live
        )
        .await
        .unwrap(),
        Occupancy::Unknown
    );

    // The lock free (the process really is gone): dead as ever, and Start
    // brings a server up.
    held.let_go();
    h.servers.start().await.unwrap();
    let pid = running_pid(&h.servers).expect("running");
    fx.track(pid);
    assert!(h.servers.complete());
}

/// The same, found on a reconnect: a running server loses its socket, the link
/// is redialled, and the dial finds nothing.
#[tokio::test]
async fn a_connected_server_whose_socket_is_removed_is_not_relaunched_over_itself() {
    let fx = Fixture::new();
    let h = harness(&fx);
    h.servers.ensure().await;
    let pid = running_pid(&h.servers).expect("running");
    fx.track(pid);

    std::fs::remove_file(fx.layout.socket_for(REVISION)).unwrap();
    h.servers.current.host.stop();
    h.servers.current.kick();
    until("the dial to find the socket gone", 15, || {
        matches!(h.servers.status().state, ServerState::Down { .. })
    })
    .await;

    assert_eq!(
        down_reason(&h.servers.status().state),
        socket_gone(&lock_beside(&fx.layout.socket_for(REVISION), REVISION))
    );
    assert!(!h.servers.complete());
    assert!(is_alive(pid), "the server was disturbed");
    assert_eq!(server_pids(&fx), vec![pid], "a second launch was attempted");
    assert!(lock(&h.servers.budget).allow(Instant::now()));

    // It really dies: nothing holds the lock, so the same absence is a death.
    kill_pid(pid);
    until("it to be gone", 10, || !is_alive(pid)).await;
    h.servers.start().await.unwrap();
    let again = running_pid(&h.servers).expect("a fresh server");
    fx.track(again);
    assert_ne!(again, pid);
}

/// An older server whose socket was removed under it stays an unknown-count
/// draining server, however long; with the lock free it is let go as before.
#[tokio::test]
async fn an_older_server_with_a_live_lock_and_no_socket_is_kept_and_found() {
    let fx = Fixture::new();
    fx.layout.prepare().unwrap();
    // No socket at all, only the lock a live server holds.
    let held = hold_lock(&fx.layout.run, 1);
    let h = harness_with(&fx, Mode::OptIn, None, 2);
    pretend_current_is_dead(&h.servers);

    h.servers.discover_legacy().await;
    assert_eq!(
        draining_of(&h.servers),
        vec![(1, SessionCount::Unknown)],
        "an older server with a live lock but no socket was not even looked for"
    );
    assert!(!h.servers.complete(), "it may hold agents");

    // Not given up on, not forgotten: it is alive.
    let slot = lock(&h.servers.draining).get(&1).cloned().unwrap();
    *lock(&slot.since) = Instant::now() - UNRESOLVED_BOUND - Duration::from_secs(1);
    h.servers.refresh_draining().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    h.servers.refresh_draining().await;
    assert_eq!(h.servers.status().draining.len(), 1);
    assert!(h.servers.unreachable_servers().is_empty());
    assert!(!h.servers.complete());

    // The process goes: the lock is free, and the slot is let go.
    held.let_go();
    h.servers.refresh_draining().await;
    assert!(h.servers.status().draining.is_empty());
    assert!(h.servers.complete());
}

/// The current server's lock looked at again later: when the process behind the
/// missing socket goes, it is a dead server, not an unreachable one.
#[tokio::test]
async fn housekeeping_notices_when_the_server_behind_a_missing_socket_dies() {
    let fx = Fixture::new();
    fx.layout.prepare().unwrap();
    let held = hold_lock(&fx.layout.run, REVISION);
    let h = harness(&fx);
    h.servers.ensure().await;
    assert_socket_gone(&h, &fx);

    h.servers.housekeeping().await;
    assert_socket_gone(&h, &fx); // still alive: unchanged

    held.let_go();
    h.servers.housekeeping().await;
    assert!(h.servers.complete(), "nothing holds the lock: it is gone");
    assert!(down_reason(&h.servers.status().state).contains("gone"));
}

/// Exit 20 with a server really holding the endpoint is the race's loser, not a
/// collision: no second launch.
#[tokio::test]
async fn a_launch_that_lost_to_a_real_server_is_not_retried() {
    let fx = Fixture::new();
    fx.layout.prepare().unwrap();
    let held = hold_lock(&fx.layout.run, REVISION);
    let scripts = fx.dir.path().join("fake");
    std::fs::create_dir(&scripts).unwrap();
    let runs = fx.dir.path().join("runs");
    let bin = script(
        &scripts,
        "s",
        &format!("echo x >> {}; exit 20", runs.display()),
    );
    let h = harness_with(&fx, Mode::OptIn, Some(bin), REVISION);
    h.servers.ensure().await;
    // bring_up saw the lock held and did not launch at all.
    assert!(!runs.exists(), "a launch over a live server was attempted");
    held.let_go();
}

/// Silent past the bound is not gone: an older server that never answers but
/// still holds its lock is running agents the app can't see. It stays a draining
/// server of unknown count and is not reported unreachable.
#[tokio::test]
async fn a_silent_older_server_that_still_holds_its_lock_is_never_given_up_on() {
    let fx = Fixture::new();
    fx.layout.prepare().unwrap();
    let held = hold_lock(&fx.layout.run, 1);
    let _hung = hang_at(&fx.layout.socket_for(1));
    let h = harness_with(&fx, Mode::OptIn, None, 2);
    pretend_current_is_dead(&h.servers);
    h.servers.discover_legacy().await;
    assert!(!h.servers.complete());

    let slot = lock(&h.servers.draining).get(&1).cloned().unwrap();
    *lock(&slot.since) = Instant::now() - UNRESOLVED_BOUND - Duration::from_secs(1);
    h.servers.refresh_draining().await;
    assert_eq!(
        h.servers.status().draining.len(),
        1,
        "given up on while alive"
    );
    assert!(h.servers.unreachable_servers().is_empty());
    assert!(!h.servers.complete());

    // The process goes: nothing holds the lock, and the bound applies as ever.
    held.let_go();
    h.servers.refresh_draining().await;
    assert!(h.servers.status().draining.is_empty());
    assert_eq!(h.servers.unreachable_servers().len(), 1);
    assert!(h.servers.complete());
}

/// A process that takes the lock *shared* is invisible to the app's own probe
/// (which is shared too) and makes every server we launch exit "occupied". The
/// app says what is wrong and where, instead of a bare Down.
#[tokio::test]
async fn a_process_holding_the_lock_without_serving_is_named_in_the_reason() {
    use std::os::unix::io::AsRawFd;
    let fx = Fixture::new();
    fx.layout.prepare().unwrap();
    let lock_path = lock_beside(&fx.layout.socket_for(REVISION), REVISION);
    let squatter = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .unwrap();
    // SAFETY: a valid open fd.
    assert_eq!(
        unsafe { libc::flock(squatter.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB) },
        0
    );
    let h = harness(&fx);

    tokio::time::timeout(Duration::from_secs(60), h.servers.ensure())
        .await
        .expect("ensure hung on a lock held without serving");
    let state = h.servers.status().state;
    let reason = down_reason(&state);
    assert!(
        reason.contains(&lock_path.display().to_string())
            && reason.contains("another process holds")
            && reason.contains("then Start"),
        "{reason}"
    );
    // Nothing that serves holds an exclusive lock, so no agents are being hidden.
    assert!(h.servers.complete());
    assert_eq!(
        server_pids(&fx),
        Vec::<u32>::new(),
        "a server was left running"
    );

    // The squatter goes: Start works.
    drop(squatter);
    tokio::time::timeout(Duration::from_secs(60), h.servers.start())
        .await
        .expect("start hung")
        .unwrap();
    let pid = running_pid(&h.servers).expect("running");
    fx.track(pid);
}

// ── stop ────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn stop_leaves_the_server_stopped_and_only_start_brings_it_back() {
    let fx = Fixture::new();
    let h = harness(&fx);
    h.servers.ensure().await;
    let first = running_pid(&h.servers).expect("running");
    fx.track(first);
    let before = lock(&h.emitted).len();

    h.servers.stop().await.unwrap();
    // While a Stop runs the state says so; it never reads as a server starting.
    let during: Vec<ServerState> = lock(&h.emitted)[before..]
        .iter()
        .map(|s| s.state.clone())
        .collect();
    assert!(!during.contains(&ServerState::Starting), "{during:?}");
    assert_eq!(during.first(), Some(&ServerState::Stopping), "{during:?}");
    assert_eq!(h.servers.phase(), Phase::Stopped);
    assert!(
        down_reason(&h.servers.status().state).contains("stopped"),
        "{:?}",
        h.servers.status().state
    );
    until("the server to exit", 10, || !is_alive(first)).await;
    assert!(
        lock(&h.servers.budget).at.is_empty(),
        "a stop on purpose is not a crash"
    );

    // Nothing brings it back on its own: not the crash path, not an ensure.
    tokio::time::sleep(Duration::from_millis(600)).await;
    h.servers.ensure().await;
    assert!(
        matches!(h.servers.status().state, ServerState::Down { .. }),
        "{:?}",
        h.servers.status().state
    );
    assert!(server_pids(&fx).is_empty(), "no server was launched");
    assert!(h.servers.current().is_none(), "no pane opens on it");

    h.servers.start().await.unwrap();
    let second = running_pid(&h.servers).expect("running again");
    fx.track(second);
    assert_ne!(first, second);
}

#[tokio::test]
async fn stop_and_restart_are_refused_without_a_server_mode_or_once_quitting() {
    let fx = Fixture::new();
    let off = harness_with(&fx, Mode::Off, None, REVISION);
    assert!(off.servers.stop().await.is_err());
    assert!(off.servers.restart().await.is_err());

    let h = harness_with(&fx, Mode::OptIn, None, REVISION);
    h.servers.release();
    assert!(h.servers.stop().await.is_err());
    assert!(h.servers.restart().await.is_err());
}

// ── diagnostics ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn the_report_names_each_servers_info_and_what_was_refused() {
    let fx = Fixture::new();
    let h = harness(&fx);
    h.servers.ensure().await;
    let pid = running_pid(&h.servers).expect("running");
    fx.track(pid);
    lock(&h.servers.untrusted).insert(1, "peer is not santree's".into());
    lock(&h.servers.unreachable).insert(0, "never answered".into());

    let report = h.servers.report().await;
    assert!(
        report.contains(&format!("server r{REVISION} (current)")),
        "{report}"
    );
    assert!(report.contains("server.info: ServerInfo"), "{report}");
    assert!(report.contains(&format!("pid: {pid}")), "{report}");
    assert!(report.contains("r1 refused (not santree's): peer is not santree's"));
    assert!(report.contains("r0 unreachable: never answered"));
}

#[tokio::test]
async fn the_report_of_a_server_that_is_down_still_answers() {
    let fx = Fixture::new();
    let h = harness_with(&fx, Mode::OptIn, None, REVISION);
    let report = h.servers.report().await;
    assert!(report.contains("not connected"), "{report}");
}

// ── pruning ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn ensure_removes_the_installs_of_revisions_that_are_over() {
    let fx = Fixture::new();
    fx.layout.prepare().unwrap();
    let old = fx.layout.root.join(format!("r{}", REVISION - 1));
    std::fs::create_dir_all(&old).unwrap();
    std::fs::write(old.join("santree-server"), b"old").unwrap();

    let h = harness(&fx);
    h.servers.ensure().await;
    fx.track(running_pid(&h.servers).expect("running"));

    assert!(!old.exists(), "an older revision is over");
    assert!(fx.layout.bin.exists(), "the current install stays");
}

#[tokio::test]
async fn a_draining_servers_install_is_not_pruned() {
    let fx = Fixture::installed();
    let mut spawned = spawn::spawn_server(&fx.layout).unwrap();
    fx.track(spawned.pid);
    assert!(matches!(spawned.start().await, Start::Ready { .. }));
    let _owner = open_session(&fx.layout.socket_for(REVISION)).await;

    let h = harness_with(&fx, Mode::OptIn, None, REVISION + 1);
    h.servers.ensure_unless(false).await;
    assert_eq!(h.servers.status().draining.len(), 1);
    assert!(
        fx.layout.rev_dir.exists(),
        "the server holding sessions runs from it"
    );
}

#[tokio::test]
async fn stop_without_a_link_to_a_live_server_fails_and_keeps_its_panes() {
    let fx = Fixture::new();
    fx.layout.prepare().unwrap();
    // A server is alive (its lock is held) but nothing is connected to it.
    let _alive = hold_lock(&fx.layout.run, REVISION);
    let h = harness_with(&fx, Mode::OptIn, None, REVISION);
    let terminals = h.servers.current().expect("panes may queue");
    let (sinks, links) = screen();
    terminals
        .open(a_spec("tree:waiting"), "page".into(), (80, 24), None, sinks)
        .await
        .unwrap();
    let before = h.servers.status();

    let err = h.servers.stop().await.unwrap_err();
    assert!(err.to_string().contains("isn't reachable"), "{err:#}");
    assert!(
        !lock(&links).contains(&PaneLink::Lost),
        "its agents are still running: {:?}",
        lock(&links)
    );
    assert_eq!(h.servers.status(), before, "the state is unchanged");
}

#[tokio::test]
async fn stop_without_a_link_to_a_dead_server_is_a_stop_and_loses_its_panes() {
    let fx = Fixture::new();
    fx.layout.prepare().unwrap();
    let h = harness_with(&fx, Mode::OptIn, None, REVISION);
    let terminals = h.servers.current().expect("panes may queue");
    let (sinks, links) = screen();
    terminals
        .open(a_spec("tree:waiting"), "page".into(), (80, 24), None, sinks)
        .await
        .unwrap();
    h.servers.stop().await.unwrap();
    assert!(matches!(h.servers.status().state, ServerState::Down { .. }));
    assert!(lock(&links).contains(&PaneLink::Lost));
}
