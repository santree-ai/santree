//! The session layer end to end, over santree-host's own test daemon
//! (`FakeDaemon`: the production host behind an in-memory link, whose PTYs are a
//! real `PtyManager`): a Daedalus-profile and a local-server-profile
//! `RemoteTerminals` side by side in one [`Terminals`], and the in-app arm
//! beside them.
//!
//! Every wait is on a condition — bytes on a pane, a link state, a session in
//! the daemon's table — never on a guessed interval.

// Tests type into, open and close terminals directly: clippy.toml's PTY rules
// hold shipped code to its sanctioned sites.
#![allow(clippy::disallowed_methods)]

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::BoxFuture;

use santree_core::domain::AgentKind;
use santree_pty::{Anchor as PtyAnchor, PtyManager};
use santree_remote_client::fake::{FakeDaemon, FakeOptions};
use santree_remote_client::proto::{Anchor, ReplayMode};
use santree_remote_client::{
    ConnectError, Connector, HostOptions, HostStatus, Link, PeerTrust, RemoteClient, RemoteHost,
    Required,
};

use super::backend::{Local, Route, SeedPolicy, Terminals};
use super::ids::{HostKey, IdRegistry};
use super::remote::{Exited, Gone, OnExited, Profile, RemoteTerminals, Timing};
use super::testkit::{build, fast, run, start, until, Daemons, Screen, TestHosts, WAIT};
use super::{LiveTerminal, PaneLink, Spec};

/// Until the host has no live link.
async fn until_down(terminals: &RemoteTerminals) {
    let down = tokio::time::timeout(WAIT, async {
        while terminals.client_within(Duration::ZERO).await.is_some() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    assert!(down.is_ok(), "timed out waiting for the link to drop");
}

fn cwd() -> String {
    std::fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

fn spec(label: &str, agent_kind: Option<AgentKind>) -> Spec {
    super::testkit::shell(&cwd(), label, agent_kind)
}

fn alive(daemon: &FakeDaemon, label: &str) -> Vec<santree_pty::SessionInfo> {
    daemon
        .pty()
        .sessions()
        .into_iter()
        .filter(|s| s.label == label && s.alive)
        .collect()
}

fn exited_log() -> (OnExited, Arc<Mutex<Vec<Exited>>>) {
    let log: Arc<Mutex<Vec<Exited>>> = Arc::default();
    let sink = log.clone();
    let callback: OnExited = Arc::new(move |exited| {
        let sink = sink.clone();
        Box::pin(async move { sink.lock().unwrap().push(exited) })
    });
    (callback, log)
}

/// A local server's profile with nothing beneath its sessions' env.
fn local_profile(on_exited: Option<OnExited>) -> Profile {
    Profile {
        name: "santree server".into(),
        base_env: None,
        on_gone: Gone::Lost,
        adopt_all: true,
        on_exited,
    }
}

/// [`run`] with its own read pacing.
fn run_timed(
    daemons: &Daemons,
    ids: &Arc<IdRegistry>,
    key: HostKey,
    profile: Profile,
    timing: Timing,
) -> (RemoteTerminals, Arc<RemoteHost>) {
    let (terminals, host) = build(daemons, ids, key, profile, timing);
    start(&host);
    (terminals, host)
}

/// The link of an app run that has adopted for this boot. A run's adoption
/// sweeps whatever no pane holds when it lists, and it may list after the
/// test's first opens: a session that already exited, its pane gone, is then
/// retired and closed under the test (seen on Linux CI). Waiting it out on the
/// empty table first leaves those sessions for the next run to find.
async fn adopted_client(terminals: &RemoteTerminals) -> Option<Arc<RemoteClient>> {
    tokio::time::timeout(WAIT, terminals.adopt_ready())
        .await
        .expect("the run to adopt");
    terminals.client_within(Duration::ZERO).await
}

/// Reads that always ask the host, for tests that change its table behind the
/// app's back.
const UNCACHED: Timing = Timing {
    ttl: Duration::ZERO,
    failed_ttl: Duration::ZERO,
    timeout: Duration::from_secs(5),
    unbound_ttl: Duration::from_secs(45),
};

fn type_line(terminals: &Terminals, id: u32, line: &str) {
    terminals
        .write(id, crate::terminal::Keystrokes::typed(format!("{line}\n")))
        .unwrap();
}

// ── The facade, over both kinds of remote host ───────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_facade_runs_a_local_server_pane_and_a_daedalus_pane_side_by_side() {
    let _serial = crate::stream::pty_guard().await;
    let (local_daemon, box_daemon) = (FakeDaemon::new(), FakeDaemon::new());
    let ids = Arc::new(IdRegistry::default());
    let (local, _local_host) = run(
        &Daemons::of(&local_daemon),
        &ids,
        HostKey::Local { revision: 1 },
        local_profile(None),
    );
    let (daedalus, _daedalus_host) = run(
        &Daemons::of(&box_daemon),
        &ids,
        HostKey::Daedalus,
        Profile::daedalus(),
    );
    let hosts = TestHosts::of(vec![local.clone()]);
    let terminals = Terminals::new(Local::Server(hosts.clone()), daedalus.clone(), ids.clone());

    let here = Screen::new();
    let there = Screen::new();
    let a = terminals
        .open(
            Route::Local,
            spec("tree:A:tab:1", None),
            "page".into(),
            (80, 24),
            here.sinks(),
        )
        .await
        .unwrap();
    let b = terminals
        .open(
            Route::Daedalus,
            spec("tree:B:tab:1", None),
            "page".into(),
            (80, 24),
            there.sinks(),
        )
        .await
        .unwrap();
    assert!(local.holds(a) && !daedalus.holds(a), "on the local server");
    assert!(daedalus.holds(b) && !local.holds(b), "on Daedalus");
    assert_eq!(
        alive(&local_daemon, "tree:A:tab:1").len(),
        1,
        "on the local server"
    );
    assert!(alive(&local_daemon, "tree:B:tab:1").is_empty());
    assert_eq!(alive(&box_daemon, "tree:B:tab:1").len(), 1, "on Daedalus");
    assert!(alive(&box_daemon, "tree:A:tab:1").is_empty());
    assert_eq!(here.links(), [PaneLink::Live]);

    // Write and read, each through its own host.
    type_line(&terminals, a, "echo here-$((40+2))");
    type_line(&terminals, b, "echo there-$((50+5))");
    here.until("the local pane's output", |s| s.count("here-42") == 1)
        .await;
    there
        .until("the Daedalus pane's output", |s| s.count("there-55") == 1)
        .await;
    assert_eq!(here.count("there-55"), 0);

    // Detach, let it print unwatched, re-attach from where the screen stopped:
    // exactly the missed bytes come back, on both kinds of host.
    for (id, daemon, label, screen, command, marker) in [
        (
            a,
            &local_daemon,
            "tree:A:tab:1",
            &here,
            "echo away-$((3+3))",
            "away-6",
        ),
        (
            b,
            &box_daemon,
            "tree:B:tab:1",
            &there,
            "echo away-$((3+4))",
            "away-7",
        ),
    ] {
        let session = alive(daemon, label)[0].clone();
        let anchor = PtyAnchor::At {
            epoch: session.epoch.clone(),
            seq: screen.len(),
        };
        terminals.detach(id);
        daemon
            .pty()
            .write(session.id, format!("{command}\n").as_bytes())
            .unwrap();
        let again = Screen::new();
        let attached = terminals.attach(id, anchor, again.sinks()).await.unwrap();
        assert_eq!(attached.mode, ReplayMode::Exact, "{label}");
        again
            .until("the missed output", |s| s.count(marker) == 1)
            .await;
        assert!(!again.text().contains("here-42") && !again.text().contains("there-55"));
        type_line(&terminals, id, "echo typed-$((1+1))");
        again
            .until("typing works", |s| s.count("typed-2") == 1)
            .await;
    }

    // Close ends each on its own host.
    terminals.close(a).unwrap();
    terminals.close(b).unwrap();
    until("both sessions closed", || {
        alive(&local_daemon, "tree:A:tab:1").is_empty()
            && alive(&box_daemon, "tree:B:tab:1").is_empty()
    })
    .await;
    until("the panes forgotten", || {
        !local.holds(a) && !daedalus.holds(b)
    })
    .await;

    // Quitting a server-mode app lets go; it ends nothing.
    terminals.release();
    assert!(hosts.released.load(Ordering::SeqCst));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_in_app_arm_runs_a_shell_and_release_ends_it() {
    let _serial = crate::stream::pty_guard().await;
    let ids = Arc::new(IdRegistry::default());
    let manager = PtyManager::new();
    let daemon = FakeDaemon::new();
    let (daedalus, _host) = run(
        &Daemons::of(&daemon),
        &ids,
        HostKey::Daedalus,
        Profile::daedalus(),
    );
    let terminals = Terminals::new(Local::InApp(manager.clone()), daedalus, ids.clone());

    let screen = Screen::new();
    let id = terminals
        .open(
            Route::Local,
            spec("tree:A:tab:1", None),
            "page".into(),
            (80, 24),
            screen.sinks(),
        )
        .await
        .unwrap();
    assert!(id < 1 << 31, "an in-app id is the manager's own");
    assert!(!ids.minted(id), "in-app ids are never minted");
    assert_eq!(manager.sessions().len(), 1);
    assert_eq!(terminals.seed_policy(id), SeedPolicy::Spill);
    assert!(terminals.seed_wanted(id));

    type_line(&terminals, id, "echo in-app-$((20+1))");
    screen
        .until("the echo", |s| s.count("in-app-21") == 1)
        .await;
    terminals.resize(id, 100, 30).unwrap();

    // The replay is written before anything else the new sink is handed.
    terminals.detach(id);
    let again = Screen::new();
    let attached = terminals
        .attach(id, PtyAnchor::Fresh, again.sinks())
        .await
        .unwrap();
    assert_eq!(attached.mode, ReplayMode::Tail);
    assert!(again.text().contains("in-app-21"), "{:?}", again.text());

    let snapshot = terminals.snapshot().await;
    assert!(snapshot.complete);
    assert_eq!(snapshot.sessions.len(), 1);
    let liveness = terminals.liveness().await;
    assert!(liveness.complete);
    assert!(liveness.live.contains(&LiveTerminal {
        term_key: "tree:A:tab:1".into(),
        agent_kind: None
    }));

    // An unknown in-app id is an error, as the manager always said.
    assert!(terminals
        .write(999, crate::terminal::Keystrokes::typed("x"))
        .is_err());

    terminals.release();
    until("every in-app session closed", || {
        manager.sessions().is_empty()
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn in_server_mode_an_unregistered_in_app_id_is_no_session_and_an_ended_remote_one_says_so() {
    let _serial = crate::stream::pty_guard().await;
    let ids = Arc::new(IdRegistry::default());
    let daemon = FakeDaemon::new();
    let (local, _h1) = run(
        &Daemons::of(&daemon),
        &ids,
        HostKey::Local { revision: 1 },
        local_profile(None),
    );
    let (daedalus, _h2) = run(
        &Daemons::of(&daemon),
        &ids,
        HostKey::Daedalus,
        Profile::daedalus(),
    );
    let terminals = Terminals::new(Local::Server(TestHosts::of(vec![local])), daedalus, ids);
    assert!(terminals
        .write(7, crate::terminal::Keystrokes::typed("x"))
        .is_err());
    assert!(terminals.close(7).is_err());
    assert!(!terminals.seed_wanted(7));
    // A remote id no host holds any more is "no such session" — never handed
    // to the in-app manager, and never Daedalus's to cap: a seed for an ended
    // local-server pane must not be refused as too long for Daedalus.
    assert!(terminals
        .write(1 << 31, crate::terminal::Keystrokes::typed("x"))
        .is_err());
    assert_eq!(terminals.seed_policy(1 << 31), SeedPolicy::Spill);
    assert!(!terminals.seed_wanted(1 << 31));
    terminals.close(1 << 31).unwrap();
    terminals.detach(1 << 31);
}

// ── Boots: a restarted server is not the one the pane's session lived on ─────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restarted_local_server_loses_the_pane_and_never_attaches_to_a_strangers_session() {
    let _serial = crate::stream::pty_guard().await;
    let first = FakeDaemon::new();
    let daemons = Daemons::of(&first);
    let ids = Arc::new(IdRegistry::default());
    let (terminals, _host) = run(
        &daemons,
        &ids,
        HostKey::Local { revision: 1 },
        local_profile(None),
    );

    let screen = Screen::new();
    let client = terminals.client_within(Duration::from_secs(5)).await;
    let id = terminals
        .open(
            spec("tree:A:tab:1", None),
            "page".into(),
            (80, 24),
            client,
            screen.sinks(),
        )
        .await
        .unwrap();
    let first_id = alive(&first, "tree:A:tab:1")[0].id;
    assert_eq!(screen.links(), [PaneLink::Live]);

    // The server restarts: another daemon, another boot — and it already has a
    // session numbered 1 of its own.
    let second = FakeDaemon::new();
    assert_ne!(first.boot_id(), second.boot_id());
    let stranger = second
        .pty()
        .open(
            santree_pty::OpenOpts {
                cwd: None,
                command: "/bin/sh".into(),
                args: vec![],
                cols: 80,
                rows: 24,
                env: vec![],
                base_env: vec![],
                owner: "someone".into(),
                label: "tree:Z:tab:9".into(),
                agent_kind: None,
            },
            |_| {},
        )
        .unwrap();
    assert_eq!(
        stranger, first_id,
        "the new boot numbers its first session like the pane's"
    );
    daemons.set(Some(second.clone()));
    first.disconnect_all();

    screen
        .until("the pane to be told its session is lost", |s| {
            s.last_link() == Some(PaneLink::Lost)
        })
        .await;
    assert!(
        !screen.exited(),
        "a lost session is not an exit: the tab stays"
    );
    let asked = second.request_log();
    assert!(
        !asked
            .iter()
            .any(|m| m == "pty.attach" || m == "pty.detach" || m == "pty.close"),
        "the pane touched the new server's session 1: {asked:?}"
    );
    // By its address: adoption of the new boot may already have taken the
    // stranger's session, which is live and rightly listed.
    let live = terminals.live();
    assert!(
        live.iter().all(|t| t.term_key != "tree:A:tab:1"),
        "a lost pane is not live: {live:?}"
    );
    assert!(terminals
        .bound()
        .iter()
        .all(|(a, _)| a.term_key != "tree:A:tab:1"));

    // Typing goes nowhere; a view attaching later is told the same; closing it
    // drops the pane without touching anyone's session.
    terminals
        .write(id, crate::terminal::Keystrokes::typed("echo nope\n"))
        .unwrap();
    let later = Screen::new();
    terminals
        .attach(id, Anchor::Unknown, later.sinks())
        .await
        .unwrap();
    assert_eq!(later.last_link(), Some(PaneLink::Lost));
    terminals.close(id);
    until("the pane forgotten", || !terminals.holds(id)).await;
    assert!(
        second.pty().sessions()[0].alive,
        "the stranger's session was closed"
    );
    assert!(!second.request_log().iter().any(|m| m == "pty.close"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_the_host_no_longer_has_is_lost_on_a_local_server_and_over_on_daedalus() {
    let _serial = crate::stream::pty_guard().await;
    for (profile, lost) in [(local_profile(None), true), (Profile::daedalus(), false)] {
        let daemon = FakeDaemon::new();
        let ids = Arc::new(IdRegistry::default());
        let (terminals, host) = run(&Daemons::of(&daemon), &ids, HostKey::Daedalus, profile);
        let screen = Screen::new();
        let client = terminals.client_within(Duration::from_secs(5)).await;
        let id = terminals
            .open(
                spec("tree:A:tab:1", None),
                "page".into(),
                (80, 24),
                client,
                screen.sinks(),
            )
            .await
            .unwrap();
        // Detached, then the host loses the session (closed from elsewhere).
        terminals.detach(id);
        let remote = alive(&daemon, "tree:A:tab:1")[0].id;
        host.client().unwrap().pty_close(remote).await.unwrap();

        let again = Screen::new();
        terminals
            .attach(id, Anchor::Unknown, again.sinks())
            .await
            .unwrap();
        if lost {
            assert_eq!(again.last_link(), Some(PaneLink::Lost));
            assert!(!again.exited());
            assert!(
                terminals.adopt("other-page").iter().any(|a| a.id == id),
                "a lost pane is still there to be shown"
            );
        } else {
            assert!(
                again.exited(),
                "Daedalus: a session the box lost ends the pane"
            );
            assert!(terminals.adopt("other-page").is_empty());
        }
    }
}

/// Review addition: on a `Gone::End` host (Daedalus) a restart used to end the
/// pane through the exit sentinel (attach -> `not_found` -> end), which is what
/// closes the tab. `Lost` is only for hosts whose profile says so.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restarted_daedalus_host_ends_the_pane_as_it_always_has_and_never_says_lost() {
    let _serial = crate::stream::pty_guard().await;
    let first = FakeDaemon::new();
    let daemons = Daemons::of(&first);
    let ids = Arc::new(IdRegistry::default());
    let (terminals, _host) = run(&daemons, &ids, HostKey::Daedalus, Profile::daedalus());
    let screen = Screen::new();
    let client = terminals.client_within(Duration::from_secs(5)).await;
    let id = terminals
        .open(
            spec("tree:A:tab:1", None),
            "page".into(),
            (80, 24),
            client,
            screen.sinks(),
        )
        .await
        .unwrap();
    daemons.set(Some(FakeDaemon::new()));
    first.disconnect_all();
    screen.until("the pane to be ended", |s| s.exited()).await;
    assert!(
        !screen.links().contains(&PaneLink::Lost),
        "Daedalus never says Lost: {:?}",
        screen.links()
    );
    until("the pane forgotten", || !terminals.holds(id)).await;
}

// ── Adopting everything ──────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_relaunch_adopts_every_session_and_retires_the_ones_that_exited() {
    let _serial = crate::stream::pty_guard().await;
    let daemon = FakeDaemon::new();
    let daemons = Daemons::of(&daemon);
    let ids = Arc::new(IdRegistry::default());
    let key = HostKey::Local { revision: 1 };

    // The previous app run opens an agent's pane, a shell, and one that exits
    // while no app is there to hear it.
    let (before, before_host) = run(&daemons, &ids, key, local_profile(None));
    let client = adopted_client(&before).await;
    for (label, kind, command, args) in [
        ("tree:A", Some(AgentKind::Claude), "/bin/sh", vec![]),
        ("tree:B:tab:2", None, "/bin/sh", vec![]),
        (
            "tree:C",
            Some(AgentKind::Codex),
            "/bin/sh",
            vec!["-c".to_string(), "exit 0".to_string()],
        ),
    ] {
        let mut s = spec(label, kind);
        s.command = command.into();
        s.args = args;
        before
            .open(
                s,
                "old-page".into(),
                (90, 30),
                client.clone(),
                Screen::new().sinks(),
            )
            .await
            .unwrap();
    }
    until("tree:C to exit", || {
        daemon
            .pty()
            .sessions()
            .iter()
            .any(|s| s.label == "tree:C" && !s.alive)
    })
    .await;
    // The app goes away.
    before_host.stop();
    daemon.disconnect_all();
    until("the daemon to see the app gone", || {
        daemon.connection_count() == 0
    })
    .await;

    // A new app run, with its own registry.
    let ids = Arc::new(IdRegistry::default());
    let (callback, retired) = exited_log();
    let (after, _host) = run(&daemons, &ids, key, local_profile(Some(callback)));
    tokio::time::timeout(WAIT, after.adopt_ready())
        .await
        .expect("adoption to finish");

    let mut adopted = after.adopt("new-page");
    adopted.sort_by(|a, b| a.label.cmp(&b.label));
    assert_eq!(
        adopted
            .iter()
            .map(|a| (a.label.as_str(), a.agent_kind))
            .collect::<Vec<_>>(),
        [("tree:A", Some(AgentKind::Claude)), ("tree:B:tab:2", None)]
    );
    assert_eq!(adopted[0].cwd.as_deref(), Some(&*cwd()));
    assert_eq!(adopted[0].command, "/bin/sh");
    assert!(adopted.iter().all(|a| after.holds(a.id)));
    assert!(after.adopt("new-page").is_empty(), "handed over once");

    // The exited one was handed to the callback and closed on the host.
    assert_eq!(
        *retired.lock().unwrap(),
        [Exited {
            label: "tree:C".into(),
            agent_kind: Some(AgentKind::Codex),
            cwd: Some(cwd()),
        }]
    );
    assert!(
        daemon.pty().sessions().iter().all(|s| s.label != "tree:C"),
        "closed on the host"
    );

    // An adopted pane is a real pane: attach it and type.
    let pane = adopted[1].id;
    let screen = Screen::new();
    after
        .attach(pane, Anchor::Fresh, screen.sinks())
        .await
        .unwrap();
    assert_eq!(screen.last_link(), Some(PaneLink::Live));
    after
        .write(
            pane,
            crate::terminal::Keystrokes::typed("echo adopted-$((8+1))\n"),
        )
        .unwrap();
    screen
        .until("typing reaches it", |s| s.count("adopted-9") == 1)
        .await;
    // Nothing was typed on its behalf: its launch ran long ago.
    assert!(!after.seed_wanted(pane));
    assert_eq!(
        alive(&daemon, "tree:B:tab:2").len(),
        1,
        "adopted, not opened again"
    );

    // The same boot reconnecting adopts nothing twice.
    daemon.disconnect_all();
    screen
        .until("live again", |s| {
            s.links().len() >= 3 && s.last_link() == Some(PaneLink::Live)
        })
        .await;
    assert_eq!(retired.lock().unwrap().len(), 1);
    assert!(after.adopt("new-page").is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pane_opening_under_an_address_finds_its_session_and_adoption_takes_the_rest() {
    let _serial = crate::stream::pty_guard().await;
    let daemon = FakeDaemon::new();
    let daemons = Daemons::of(&daemon);
    let key = HostKey::Local { revision: 1 };
    let (before, before_host) = run(
        &daemons,
        &Arc::new(IdRegistry::default()),
        key,
        local_profile(None),
    );
    let client = adopted_client(&before).await;
    for label in ["tree:A", "tree:B"] {
        before
            .open(
                spec(label, None),
                "old".into(),
                (80, 24),
                client.clone(),
                Screen::new().sinks(),
            )
            .await
            .unwrap();
    }
    before_host.stop();
    daemon.disconnect_all();
    until("the app gone", || daemon.connection_count() == 0).await;

    // The new run's pane asks for tree:A before the link is up, so it waits;
    // the connect gives it the session by its address first, and adoption takes
    // what is left.
    let ids = Arc::new(IdRegistry::default());
    let (after, host) = build(&daemons, &ids, key, local_profile(None), Timing::default());
    let screen = Screen::new();
    let id = after
        .open(
            spec("tree:A", None),
            "new".into(),
            (80, 24),
            None,
            screen.sinks(),
        )
        .await
        .unwrap();
    assert_eq!(screen.links(), [PaneLink::Reconnecting]);
    after
        .seed(
            id,
            crate::terminal::LaunchLine::typed("echo seeded-$((6+6))\r"),
        )
        .unwrap();
    start(&host);
    screen
        .until("the pane to be live on its found session", |s| {
            s.last_link() == Some(PaneLink::Live)
        })
        .await;
    // Found, not opened again — and its launch is not typed a second time.
    assert_eq!(alive(&daemon, "tree:A").len(), 1);
    assert!(!after.seed_wanted(id));
    tokio::time::timeout(WAIT, after.adopt_ready())
        .await
        .unwrap();
    assert_eq!(screen.count("seeded-12"), 0);
    let rest = after.adopt("new");
    assert_eq!(
        rest.iter().map(|a| a.label.as_str()).collect::<Vec<_>>(),
        ["tree:B"],
        "the pane that asked for tree:A holds it; adoption takes only what no pane does"
    );
    let fresh = after
        .open(
            spec("tree:D", None),
            "new".into(),
            (80, 24),
            after.client_within(WAIT).await,
            Screen::new().sinks(),
        )
        .await
        .unwrap();
    assert!(
        after.seed_wanted(fresh),
        "a session this pane opened itself takes its launch line"
    );
}

// ── Liveness ─────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn liveness_reads_the_host_and_is_incomplete_while_it_cannot_be_asked() {
    let _serial = crate::stream::pty_guard().await;
    let daemon = FakeDaemon::new();
    let daemons = Daemons::of(&daemon);
    let key = HostKey::Local { revision: 1 };
    let ids = Arc::new(IdRegistry::default());

    // Before a host has been started there is nothing to wait for.
    let idle = Arc::new(RemoteHost::new(daemons.connector(), fast()));
    let never = RemoteTerminals::new(idle, key, ids.clone(), local_profile(None));
    tokio::time::timeout(Duration::from_secs(1), never.adopt_ready())
        .await
        .expect("a stopped host is known down");
    assert!(!never.liveness().await.complete);

    let (before, before_host) = run(&daemons, &ids, key, local_profile(None));
    let client = adopted_client(&before).await;
    for label in ["tree:A", "tree:B"] {
        let mut s = spec(label, Some(AgentKind::Claude));
        s.command = "/bin/sh".into();
        before
            .open(
                s,
                "old".into(),
                (80, 24),
                client.clone(),
                Screen::new().sinks(),
            )
            .await
            .unwrap();
    }
    before_host.stop();
    daemon.disconnect_all();
    until("the app gone", || daemon.connection_count() == 0).await;

    // Uncached: the test ends a session behind the app's back, which nothing
    // in the app would hear (the production reuse is `a_listing_is_reused_…`).
    let (after, _host) = run_timed(
        &daemons,
        &Arc::new(IdRegistry::default()),
        key,
        local_profile(None),
        UNCACHED,
    );
    tokio::time::timeout(WAIT, after.adopt_ready())
        .await
        .unwrap();
    let address = |label: &str| LiveTerminal {
        term_key: label.into(),
        agent_kind: Some(AgentKind::Claude),
    };
    let all = after.liveness().await;
    assert!(all.complete);
    assert_eq!(
        all.live,
        HashSet::from([address("tree:A"), address("tree:B")])
    );

    // tree:A's process exits. Nothing watches an adopted pane, so only asking
    // the host can say so.
    let session = alive(&daemon, "tree:A")[0].id;
    daemon.pty().write(session, b"exit\n").unwrap();
    until("tree:A to exit", || alive(&daemon, "tree:A").is_empty()).await;
    let after_exit = after.liveness().await;
    assert!(after_exit.complete);
    assert_eq!(after_exit.live, HashSet::from([address("tree:B")]));

    // The server goes away: what is known is returned, flagged incomplete —
    // "not seen" must never read as "exited".
    daemons.set(None);
    daemon.disconnect_all();
    until_down(&after).await;
    let down = after.liveness().await;
    assert!(!down.complete);
    assert!(down.live.contains(&address("tree:B")));
    tokio::time::timeout(WAIT, after.adopt_ready())
        .await
        .expect("a down host is known down");
}

/// Review addition: a host that answers is not yet a host whose sessions are
/// known — until this boot's sessions are adopted, a missing agent may just be
/// one the sweep hasn't reached, and `complete` must say so.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn liveness_is_incomplete_between_connecting_and_adopting() {
    let _serial = crate::stream::pty_guard().await;
    let daemon = FakeDaemon::new();
    let daemons = Daemons::of(&daemon);
    let key = HostKey::Local { revision: 1 };

    // A session that exited while no app was there to hear it.
    let (before, before_host) = run(
        &daemons,
        &Arc::new(IdRegistry::default()),
        key,
        local_profile(None),
    );
    let client = adopted_client(&before).await;
    let mut gone = spec("tree:A", None);
    gone.args = vec!["-c".into(), "exit 0".into()];
    before
        .open(gone, "old".into(), (80, 24), client, Screen::new().sinks())
        .await
        .unwrap();
    until("tree:A to exit", || {
        daemon
            .pty()
            .sessions()
            .iter()
            .any(|s| s.label == "tree:A" && !s.alive)
    })
    .await;
    before_host.stop();
    daemon.disconnect_all();
    until("the app gone", || daemon.connection_count() == 0).await;

    // The new run's adoption is stuck on retiring that session's rows.
    let gate = Arc::new(tokio::sync::Notify::new());
    let stuck: OnExited = {
        let gate = gate.clone();
        Arc::new(move |_| {
            let gate = gate.clone();
            Box::pin(async move { gate.notified().await })
        })
    };
    let (after, _host) = run(
        &daemons,
        &Arc::new(IdRegistry::default()),
        key,
        local_profile(Some(stuck)),
    );
    assert!(after.client_within(WAIT).await.is_some(), "connected");
    assert!(
        !after.liveness().await.complete,
        "connected, but this boot's sessions are not adopted: not the whole truth"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(300), after.adopt_ready())
            .await
            .is_err(),
        "adopt_ready waits for the sweep, not just the link"
    );
    gate.notify_one();
    tokio::time::timeout(WAIT, after.adopt_ready())
        .await
        .expect("adoption to finish once its callback does");
    assert!(after.liveness().await.complete);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_daedalus_pane_waiting_out_a_dropped_link_still_counts_as_live() {
    let _serial = crate::stream::pty_guard().await;
    let daemon = FakeDaemon::new();
    let daemons = Daemons::of(&daemon);
    let ids = Arc::new(IdRegistry::default());
    let (terminals, _host) = run(&daemons, &ids, HostKey::Daedalus, Profile::daedalus());
    let client = terminals.client_within(WAIT).await;
    terminals
        .open(
            spec("tree:A", None),
            "page".into(),
            (80, 24),
            client,
            Screen::new().sinks(),
        )
        .await
        .unwrap();
    daemons.set(None);
    daemon.disconnect_all();
    until_down(&terminals).await;
    let liveness = terminals.liveness().await;
    assert!(
        liveness.complete,
        "Daedalus's panes are authoritative while the link is down"
    );
    assert_eq!(liveness.live.len(), 1);
}

// ── What a local server's sessions inherit ───────────────────────────────────

/// A session inherits its host's environment beneath its own: the project's
/// `env` wins over the profile's `base_env`, and nothing of the pane's own goes
/// anywhere but `env`. A host whose profile takes none — Daedalus — is sent
/// none of this Mac's.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_inherits_its_hosts_base_env_beneath_its_own_env() {
    let _serial = crate::stream::pty_guard().await;
    assert!(Profile::daedalus().base_env.is_none());
    fn from_profile() -> Vec<(String, String)> {
        vec![
            ("FROM_PROFILE".into(), "profile".into()),
            ("API_KEY".into(), "from-the-mac".into()),
        ]
    }
    let daemon = FakeDaemon::new();
    let ids = Arc::new(IdRegistry::default());
    let mut profile = local_profile(None);
    profile.base_env = Some(from_profile);
    let (terminals, _host) = run(
        &Daemons::of(&daemon),
        &ids,
        HostKey::Local { revision: 1 },
        profile,
    );
    let screen = Screen::new();
    let mut with_env = spec("tree:A", None);
    with_env.env = vec![("API_KEY".into(), "hunter2".into())];
    let id = terminals
        .open(
            with_env,
            "page".into(),
            (80, 24),
            terminals.client_within(WAIT).await,
            screen.sinks(),
        )
        .await
        .unwrap();
    terminals
        .write(
            id,
            crate::terminal::Keystrokes::typed("echo [${FROM_PROFILE-unset}][${API_KEY-unset}]\n"),
        )
        .unwrap();
    screen
        .until("the profile's env beneath the pane's own", |s| {
            s.count("[profile][hunter2]") == 1
        })
        .await;
}

// ── Host trust: nothing crosses a link the profile does not trust ────────────

/// A link below the host's required trust is dropped before any byte, so a
/// pane waiting for it never sends one: no `pty.*` call, no session, and every
/// read is incomplete rather than empty.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pane_over_a_link_below_the_hosts_trust_sends_nothing() {
    let _serial = crate::stream::pty_guard().await;
    for (required, peer) in [
        (Required::UidOnly, PeerTrust::Unverified),
        // Daedalus's own bar (`DaedalusHost::default`): only the agent.
        (Required::Agent, PeerTrust::UidOnly),
    ] {
        let daemon = FakeDaemon::with_options(FakeOptions {
            peer,
            ..FakeOptions::default()
        });
        let host = Arc::new(RemoteHost::new(
            Daemons::of(&daemon).connector(),
            HostOptions {
                require: required,
                ..fast()
            },
        ));
        let terminals = RemoteTerminals::new(
            host.clone(),
            HostKey::Local { revision: 1 },
            Arc::new(IdRegistry::default()),
            local_profile(None),
        );
        terminals.watch();
        let screen = Screen::new();
        let mut secret = spec("tree:W", Some(AgentKind::Claude));
        secret.env = vec![("API_KEY".into(), "hunter2".into())];
        terminals
            .open(secret, "page".into(), (80, 24), None, screen.sinks())
            .await
            .unwrap();
        start(&host);
        until("the link refused", || {
            matches!(
                host.current_status(),
                HostStatus::Down(ConnectError::Untrusted(_))
            )
        })
        .await;
        assert!(terminals.client_within(Duration::ZERO).await.is_none());
        tokio::time::timeout(Duration::from_secs(2), terminals.adopt_ready())
            .await
            .expect("a refused link is a known state");
        assert!(!terminals.liveness().await.complete);
        assert!(terminals.held_sessions().await.is_none());
        assert_eq!(daemon.request_log(), Vec::<String>::new(), "{required:?}");
        assert!(alive(&daemon, "tree:W").is_empty());
        host.stop();
        daemon.shutdown();
    }
}

// ── Claiming what adoption took ──────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tab_opening_after_adoption_claims_the_adopted_pane_and_never_starts_a_second_session() {
    let _serial = crate::stream::pty_guard().await;
    let daemon = FakeDaemon::new();
    let daemons = Daemons::of(&daemon);
    let key = HostKey::Local { revision: 1 };
    // The previous run's agent.
    let (before, before_host) = run(
        &daemons,
        &Arc::new(IdRegistry::default()),
        key,
        local_profile(None),
    );
    let client = adopted_client(&before).await;
    for label in ["tree:A", "tree:B"] {
        before
            .open(
                spec(label, Some(AgentKind::Claude)),
                "old".into(),
                (80, 24),
                client.clone(),
                Screen::new().sinks(),
            )
            .await
            .unwrap();
    }
    before_host.stop();
    daemon.disconnect_all();
    until("the app gone", || daemon.connection_count() == 0).await;

    // Relaunch: adopt-all runs first, then the tab's own open arrives.
    let ids = Arc::new(IdRegistry::default());
    let (after, _host) = run(&daemons, &ids, key, local_profile(None));
    tokio::time::timeout(WAIT, after.adopt_ready())
        .await
        .unwrap();
    let screen = Screen::new();
    let id = after
        .open(
            spec("tree:A", Some(AgentKind::Claude)),
            "new".into(),
            (80, 24),
            after.client_within(WAIT).await,
            screen.sinks(),
        )
        .await
        .unwrap();
    // The tab's launch line must not be typed: the agent is already running.
    assert!(!after.seed_wanted(id));
    after
        .seed(
            id,
            crate::terminal::LaunchLine::typed("echo seeded-$((6+6))\r"),
        )
        .unwrap();
    screen
        .until("the claimed pane to be live", |s| {
            s.last_link() == Some(PaneLink::Live)
        })
        .await;
    after
        .write(
            id,
            crate::terminal::Keystrokes::typed("echo marker-$((4+4))\n"),
        )
        .unwrap();
    screen
        .until("typing reaches it", |s| s.count("marker-8") == 1)
        .await;
    assert_eq!(screen.count("seeded-12"), 0, "no seed was typed");
    assert_eq!(alive(&daemon, "tree:A").len(), 1, "one session, not two");
    assert_eq!(
        after
            .adopt("new")
            .iter()
            .map(|a| a.label.as_str())
            .collect::<Vec<_>>(),
        ["tree:B"],
        "the claimed pane is the tab's now; only the unclaimed one is left to hand over"
    );
    // A different address opens as it always did.
    let fresh = after
        .open(
            spec("tree:D", Some(AgentKind::Claude)),
            "new".into(),
            (80, 24),
            after.client_within(WAIT).await,
            Screen::new().sinks(),
        )
        .await
        .unwrap();
    assert!(after.seed_wanted(fresh));
    assert_eq!(alive(&daemon, "tree:D").len(), 1);
}

// ── Reading the host by boot ─────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bound_lists_only_panes_bound_on_the_boot_now_answering() {
    let _serial = crate::stream::pty_guard().await;
    let first = FakeDaemon::new();
    let daemons = Daemons::of(&first);
    let key = HostKey::Local { revision: 1 };
    let (before, before_host) = run(
        &daemons,
        &Arc::new(IdRegistry::default()),
        key,
        local_profile(None),
    );
    let client = adopted_client(&before).await;
    before
        .open(
            spec("tree:A", None),
            "old".into(),
            (80, 24),
            client,
            Screen::new().sinks(),
        )
        .await
        .unwrap();
    before_host.stop();
    first.disconnect_all();
    until("the app gone", || first.connection_count() == 0).await;

    // Adopted, never shown: no view, so nothing re-binds it on a reconnect.
    let (after, host) = run(
        &daemons,
        &Arc::new(IdRegistry::default()),
        key,
        local_profile(None),
    );
    tokio::time::timeout(WAIT, after.adopt_ready())
        .await
        .unwrap();
    assert_eq!(after.bound().len(), 1);

    // The server restarts: a new boot, whose session 1 is somebody else's.
    let second = FakeDaemon::new();
    daemons.set(Some(second.clone()));
    first.disconnect_all();
    until("the new boot", || host.generation() >= 2).await;
    tokio::time::timeout(WAIT, after.adopt_ready())
        .await
        .unwrap();
    assert!(
        after.bound().is_empty(),
        "the old boot's session ids mean nothing here: {:?}",
        after.bound()
    );
}

// ── Adoption: retiring, retrying, ordering ───────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_exited_session_does_not_retire_the_row_of_a_live_agent_with_its_address() {
    let _serial = crate::stream::pty_guard().await;
    let daemon = FakeDaemon::new();
    let daemons = Daemons::of(&daemon);
    let key = HostKey::Local { revision: 1 };
    let (before, before_host) = run(
        &daemons,
        &Arc::new(IdRegistry::default()),
        key,
        local_profile(None),
    );
    let client = adopted_client(&before).await;
    // The same agent address twice: a run that exited, and its resumed
    // successor, still going. Plus one address that only has an exited run.
    for (label, args) in [
        ("tree:A", vec!["-c".to_string(), "exit 0".to_string()]),
        ("tree:Z", vec!["-c".to_string(), "exit 0".to_string()]),
        ("tree:A", vec![]),
    ] {
        let mut s = spec(label, Some(AgentKind::Claude));
        s.args = args;
        before
            .open(
                s,
                "old".into(),
                (80, 24),
                client.clone(),
                Screen::new().sinks(),
            )
            .await
            .unwrap();
    }
    // Each address's `exit 0` run, by label: a count of exactly two would
    // never hold if the live run had died too, and would time out saying
    // nothing of which one.
    until("both to have exited", || {
        let sessions = daemon.pty().sessions();
        ["tree:A", "tree:Z"]
            .iter()
            .all(|label| sessions.iter().any(|s| s.label == *label && !s.alive))
    })
    .await;
    assert_eq!(
        alive(&daemon, "tree:A").len(),
        1,
        "{:?}",
        daemon.pty().sessions()
    );
    before_host.stop();
    daemon.disconnect_all();
    until("the app gone", || daemon.connection_count() == 0).await;

    let (callback, retired) = exited_log();
    let (after, _host) = run(
        &daemons,
        &Arc::new(IdRegistry::default()),
        key,
        local_profile(Some(callback)),
    );
    tokio::time::timeout(WAIT, after.adopt_ready())
        .await
        .unwrap();
    assert_eq!(
        retired
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.label.as_str())
            .collect::<Vec<_>>(),
        ["tree:Z"],
        "tree:A has a live run: its row is the live agent's, not the dead one's"
    );
    assert_eq!(alive(&daemon, "tree:A").len(), 1);
    assert!(
        daemon.pty().sessions().iter().all(|s| s.alive),
        "the exited ones are closed on the host all the same"
    );
}

/// What a [`sessions_proxy`] does with one request.
#[derive(Clone)]
enum Tamper {
    /// Pass it to the daemon.
    Pass,
    /// Answer it with an `io` error of its own (not a disconnect).
    Fail,
    /// Never answer it: a server that is stopped (SIGSTOP) or wedged.
    Swallow,
    /// Pass it on only once the test says so, while later requests go through:
    /// a call the daemon is slow to answer.
    Delay(Arc<tokio::sync::Notify>),
}

/// A proxy in front of `daemon` that decides, per request (by method name), what
/// to do with it.
fn sessions_proxy(
    daemon: &FakeDaemon,
    tamper: impl Fn(&str) -> Tamper + Send + Sync + 'static,
) -> Arc<dyn Connector> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let daemon = daemon.clone();
    let tamper = Arc::new(tamper);
    Arc::new(move || -> BoxFuture<'static, Result<Link, ConnectError>> {
        let upstream = daemon.connect();
        let (app, proxy) = tokio::io::duplex(256 * 1024);
        let (app_read, app_write) = tokio::io::split(app);
        let (proxy_read, proxy_write) = tokio::io::split(proxy);
        let proxy_write = Arc::new(tokio::sync::Mutex::new(proxy_write));
        let Link {
            reader: mut up_read,
            writer: up_write,
            ..
        } = upstream;
        let up_write = Arc::new(tokio::sync::Mutex::new(up_write));
        let tamper = tamper.clone();
        {
            let proxy_write = proxy_write.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(proxy_read).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let request: serde_json::Value =
                        serde_json::from_str(&line).unwrap_or_default();
                    let what = tamper(request["m"].as_str().unwrap_or_default());
                    match what {
                        Tamper::Fail => {
                            let reply = format!(
                                "{{\"id\":{},\"err\":{{\"code\":\"io\",\"msg\":\"injected\"}}}}\n",
                                request["id"]
                            );
                            let _ = proxy_write.lock().await.write_all(reply.as_bytes()).await;
                        }
                        Tamper::Swallow => {}
                        Tamper::Delay(release) => {
                            let up_write = up_write.clone();
                            tokio::spawn(async move {
                                release.notified().await;
                                let _ = up_write
                                    .lock()
                                    .await
                                    .write_all(format!("{line}\n").as_bytes())
                                    .await;
                            });
                        }
                        Tamper::Pass => {
                            if up_write
                                .lock()
                                .await
                                .write_all(format!("{line}\n").as_bytes())
                                .await
                                .is_err()
                            {
                                return;
                            }
                        }
                    }
                }
            });
        }
        tokio::spawn(async move {
            let mut lines = BufReader::new(&mut up_read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut out = proxy_write.lock().await;
                if out.write_all(format!("{line}\n").as_bytes()).await.is_err() {
                    return;
                }
            }
        });
        Box::pin(async move {
            Ok(Link {
                reader: Box::new(app_read),
                writer: Box::new(app_write),
                agent: None,
                peer: PeerTrust::UidOnly,
            })
        })
    })
}

/// A proxy in front of `daemon` that answers the first `failures` calls of
/// `pty.sessions` with an error of its own (`io`, not a disconnect) and passes
/// everything else through untouched.
fn flaky_sessions_connector(daemon: &FakeDaemon, failures: usize) -> Arc<dyn Connector> {
    use std::sync::atomic::AtomicUsize;
    let left = AtomicUsize::new(failures);
    sessions_proxy(daemon, move |method| {
        if method != "pty.sessions" {
            return Tamper::Pass;
        }
        match left.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1)) {
            Ok(_) => Tamper::Fail,
            Err(_) => Tamper::Pass,
        }
    })
}

/// A proxy in front of `daemon` that, while `wedged` is set, swallows every
/// `pty.sessions` request — counting them in `asked` — and passes the rest.
fn wedgeable_connector(
    daemon: &FakeDaemon,
    wedged: &Arc<AtomicBool>,
    asked: &Arc<std::sync::atomic::AtomicUsize>,
) -> Arc<dyn Connector> {
    let (wedged, asked) = (wedged.clone(), asked.clone());
    sessions_proxy(daemon, move |method| {
        if method == "pty.sessions" && wedged.load(Ordering::SeqCst) {
            asked.fetch_add(1, Ordering::SeqCst);
            Tamper::Swallow
        } else {
            Tamper::Pass
        }
    })
}

/// A previous app run's one live session at `label` (running `agent_kind`), left
/// on `daemon` as the app quit.
async fn leave_behind(daemon: &FakeDaemon, label: &str, agent_kind: Option<AgentKind>) {
    let (before, before_host) = run(
        &Daemons::of(daemon),
        &Arc::new(IdRegistry::default()),
        HostKey::Local { revision: 1 },
        local_profile(None),
    );
    let client = adopted_client(&before).await;
    before
        .open(
            spec(label, agent_kind),
            "old".into(),
            (80, 24),
            client,
            Screen::new().sinks(),
        )
        .await
        .unwrap();
    before_host.stop();
    daemon.disconnect_all();
    until("the app gone", || daemon.connection_count() == 0).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_listing_is_retried_once_and_adoption_then_completes() {
    let _serial = crate::stream::pty_guard().await;
    let daemon = FakeDaemon::new();
    leave_behind(&daemon, "tree:A", None).await;

    let host = Arc::new(RemoteHost::new(
        flaky_sessions_connector(&daemon, 1),
        fast(),
    ));
    let terminals = RemoteTerminals::new(
        host.clone(),
        HostKey::Local { revision: 1 },
        Arc::new(IdRegistry::default()),
        local_profile(None),
    );
    terminals.watch();
    start(&host);
    tokio::time::timeout(WAIT, terminals.adopt_ready())
        .await
        .unwrap();
    assert_eq!(
        terminals
            .adopt("page")
            .iter()
            .map(|a| a.label.as_str())
            .collect::<Vec<_>>(),
        ["tree:A"],
        "the one failed listing did not leave this boot unadopted"
    );
    assert!(terminals.liveness().await.complete);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_listing_that_keeps_failing_leaves_adoption_unfinished_but_the_wait_over() {
    let _serial = crate::stream::pty_guard().await;
    let daemon = FakeDaemon::new();
    leave_behind(&daemon, "tree:A", None).await;

    let host = Arc::new(RemoteHost::new(
        flaky_sessions_connector(&daemon, usize::MAX),
        fast(),
    ));
    let terminals = RemoteTerminals::new(
        host.clone(),
        HostKey::Local { revision: 1 },
        Arc::new(IdRegistry::default()),
        local_profile(None),
    );
    terminals.watch();
    start(&host);
    tokio::time::timeout(WAIT, terminals.adopt_ready())
        .await
        .expect("a host that can't list is not waited on for ever");
    assert!(
        !terminals.liveness().await.complete,
        "an unadopted boot must not read as 'nothing else is running'"
    );
    assert!(terminals.adopt("page").is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn configuring_the_host_before_watching_it_loses_nothing() {
    let _serial = crate::stream::pty_guard().await;
    let daemon = FakeDaemon::new();
    leave_behind(&daemon, "tree:A", None).await;

    let daemons = Daemons::of(&daemon);
    let host = Arc::new(RemoteHost::new(daemons.connector(), fast()));
    let terminals = RemoteTerminals::new(
        host.clone(),
        HostKey::Local { revision: 1 },
        Arc::new(IdRegistry::default()),
        local_profile(None),
    );
    // The link comes up and announces itself before anyone is watching.
    start(&host);
    until("the first connect", || host.hello().is_some()).await;
    terminals.watch();
    tokio::time::timeout(Duration::from_secs(5), terminals.adopt_ready())
        .await
        .expect("the connect that preceded watch() is still adopted");
    assert_eq!(terminals.adopt("page").len(), 1);
}

// ── Reads of a server that can't answer ──────────────────────────────────────

/// Pacing that gives up on a host that isn't answering within a quarter second.
const QUICK: Timing = Timing {
    ttl: Duration::from_secs(10),
    failed_ttl: Duration::from_secs(5),
    timeout: Duration::from_millis(250),
    unbound_ttl: Duration::from_secs(45),
};

/// A facade in Server mode over `local`, with an idle Daedalus beside it.
fn server_terminals(
    local: RemoteTerminals,
    ids: &Arc<IdRegistry>,
    complete: bool,
) -> (Terminals, Arc<TestHosts>) {
    let (daedalus, _host) = build(
        &Daemons::default(),
        ids,
        HostKey::Daedalus,
        Profile::daedalus(),
        Timing::default(),
    );
    let hosts = TestHosts::of(vec![local]);
    hosts.complete.store(complete, Ordering::SeqCst);
    (
        Terminals::new(Local::Server(hosts.clone()), daedalus, ids.clone()),
        hosts,
    )
}

/// A database holding one running Claude session, `s1`, bound to `term_key`.
async fn db_with_agent(term_key: &str) -> (crate::db::Db, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let db = crate::db::init(dir.path().join("test.db")).await.unwrap();
    sqlx::query(
        "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, agent_kind) \
         VALUES ('repo', ?, '/w', 's1', 'Claude')",
    )
    .bind(term_key)
    .execute(&db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO session_state (session_id, state, event, cwd, updated_at_ms) \
         VALUES ('s1', 'active', 'UserPromptSubmit', '/w', ?)",
    )
    .bind(crate::db::now_ms())
    .execute(&db)
    .await
    .unwrap();
    (db, dir)
}

async fn state_of_s1(
    db: &crate::db::Db,
    terminals: &Terminals,
) -> santree_core::domain::AgentState {
    crate::hooks::session_states(db, terminals.liveness().await)
        .await
        .unwrap()
        .into_iter()
        .find(|s| s.session_id == "s1")
        .expect("s1 is on the registry")
        .state
}

/// A server that has stopped answering (SIGSTOP, a wedge) must not stall the
/// reads the UI polls: each gives up after the host's bound with what is known,
/// flagged incomplete, and a host that failed once isn't asked again by every
/// caller in turn.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_wedged_server_cannot_stall_a_read_and_every_read_says_it_is_incomplete() {
    use std::sync::atomic::AtomicUsize;
    let _serial = crate::stream::pty_guard().await;
    let daemon = FakeDaemon::new();
    leave_behind(&daemon, "tree:A", Some(AgentKind::Claude)).await;
    let (wedged, asked) = (
        Arc::new(AtomicBool::new(true)),
        Arc::new(AtomicUsize::new(0)),
    );
    let host = Arc::new(RemoteHost::new(
        wedgeable_connector(&daemon, &wedged, &asked),
        fast(),
    ));
    let ids = Arc::new(IdRegistry::default());
    let local = RemoteTerminals::with_timing(
        host.clone(),
        HostKey::Local { revision: 1 },
        ids.clone(),
        local_profile(None),
        QUICK,
    );
    local.watch();
    start(&host);
    assert!(local.client_within(WAIT).await.is_some(), "connected");
    until("adoption to ask for the table", || {
        asked.load(Ordering::SeqCst) >= 1
    })
    .await;
    let (terminals, _hosts) = server_terminals(local, &ids, true);

    let began = std::time::Instant::now();
    let liveness = terminals.liveness().await;
    assert!(
        !liveness.complete,
        "a host that can't answer is not complete"
    );
    let snapshot = terminals.snapshot().await;
    assert!(!snapshot.complete);
    assert!(snapshot.sessions.is_empty());
    assert!(terminals.local_sessions().await.is_empty());
    assert!(
        began.elapsed() < Duration::from_secs(2),
        "three reads of a wedged server took {:?}",
        began.elapsed()
    );
    assert_eq!(
        asked.load(Ordering::SeqCst),
        2,
        "adoption's listing and one read's: the failure was reused, not retried by each caller"
    );
}

/// Reads share one listing; whatever changes the table drops it, so a session
/// just started is never reported missing, and an old one expires.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_listing_is_reused_until_the_table_changes_or_it_expires() {
    let _serial = crate::stream::pty_guard().await;
    let daemon = FakeDaemon::new();
    let ids = Arc::new(IdRegistry::default());
    let (local, _host) = run_timed(
        &Daemons::of(&daemon),
        &ids,
        HostKey::Local { revision: 1 },
        local_profile(None),
        // Long enough that no load makes a reuse look like an expiry.
        Timing {
            ttl: Duration::from_secs(60),
            ..QUICK
        },
    );
    tokio::time::timeout(WAIT, local.adopt_ready())
        .await
        .unwrap();
    let listings = || {
        daemon
            .request_log()
            .iter()
            .filter(|m| m.as_str() == "pty.sessions")
            .count()
    };
    let (terminals, _hosts) = server_terminals(local.clone(), &ids, true);

    let before = listings();
    for _ in 0..3 {
        assert!(terminals.liveness().await.complete);
        terminals.snapshot().await;
    }
    assert_eq!(listings(), before + 1, "six reads, one listing");

    // A pane opened now is found alive at once, not after the old listing
    // expires: opening drops it.
    let screen = Screen::new();
    terminals
        .open(
            Route::Local,
            spec("tree:B", Some(AgentKind::Claude)),
            "page".into(),
            (80, 24),
            screen.sinks(),
        )
        .await
        .unwrap();
    let live = terminals.liveness().await;
    assert!(
        live.live.contains(&LiveTerminal {
            term_key: "tree:B".into(),
            agent_kind: Some(AgentKind::Claude)
        }),
        "a session just started was reported missing: {:?}",
        live.live
    );

    let seen = listings();
    terminals.liveness().await;
    assert_eq!(listings(), seen, "still fresh");

    // Left alone past its ttl it expires. Only the safe direction is timed:
    // waiting longer can only make it more expired.
    let (short, _short_host) = run_timed(
        &Daemons::of(&daemon),
        &ids,
        HostKey::Local { revision: 2 },
        local_profile(None),
        Timing {
            ttl: Duration::from_millis(50),
            ..QUICK
        },
    );
    tokio::time::timeout(WAIT, short.adopt_ready())
        .await
        .unwrap();
    short.liveness().await;
    let seen = listings();
    tokio::time::sleep(Duration::from_millis(150)).await;
    short.liveness().await;
    assert_eq!(listings(), seen + 1, "expired, asked again");
    terminals
        .close(
            *terminals
                .snapshot()
                .await
                .sessions
                .first()
                .map(|s| &s.id)
                .unwrap(),
        )
        .unwrap();
}

/// Right after a relaunch the agent is still running on the server and the app
/// has not adopted it: nothing may read it as exited, and it must not be resumed
/// into a second tab.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn before_adoption_a_running_agent_keeps_its_state_and_cannot_be_resumed_twice() {
    use crate::session::{occupancy, Occupancy};
    use santree_core::domain::AgentState;
    let _serial = crate::stream::pty_guard().await;
    let daemon = FakeDaemon::new();
    leave_behind(&daemon, "tree:AK-1:tab:a", Some(AgentKind::Claude)).await;
    let (db, _dir) = db_with_agent("tree:AK-1:tab:a").await;

    // The relaunch: connected, but the table is never answered, so adoption
    // can't have finished.
    let (wedged, asked) = (
        Arc::new(AtomicBool::new(true)),
        Arc::new(std::sync::atomic::AtomicUsize::new(0)),
    );
    let host = Arc::new(RemoteHost::new(
        wedgeable_connector(&daemon, &wedged, &asked),
        fast(),
    ));
    let ids = Arc::new(IdRegistry::default());
    let local = RemoteTerminals::with_timing(
        host.clone(),
        HostKey::Local { revision: 1 },
        ids.clone(),
        local_profile(None),
        QUICK,
    );
    local.watch();
    start(&host);
    assert!(local.client_within(WAIT).await.is_some(), "connected");
    let (terminals, _hosts) = server_terminals(local, &ids, true);

    assert_eq!(
        state_of_s1(&db, &terminals).await,
        AgentState::Active,
        "an agent the app can't see yet was declared exited"
    );
    let live = terminals.liveness().await;
    assert!(!live.complete);
    assert_eq!(
        occupancy(&db, "repo", "s1", AgentKind::Claude, &live)
            .await
            .unwrap(),
        Occupancy::Unknown,
        "a resume would start the conversation twice"
    );
}

/// A server that is down or still starting is the same: unknown, not empty.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_server_that_is_down_or_starting_keeps_agents_and_refuses_a_resume() {
    use crate::session::{occupancy, Occupancy};
    use santree_core::domain::AgentState;
    let _serial = crate::stream::pty_guard().await;
    let (db, _dir) = db_with_agent("tree:AK-1:tab:a").await;
    let ids = Arc::new(IdRegistry::default());

    // Down: the connector can't reach it. The supervisor says so (`complete`).
    let (down, _host) = run(
        &Daemons::default(),
        &ids,
        HostKey::Local { revision: 1 },
        local_profile(None),
    );
    let (terminals, _hosts) = server_terminals(down, &ids, false);
    assert_eq!(state_of_s1(&db, &terminals).await, AgentState::Active);
    let live = terminals.liveness().await;
    assert!(!live.complete);
    assert_eq!(
        occupancy(&db, "repo", "s1", AgentKind::Claude, &live)
            .await
            .unwrap(),
        Occupancy::Unknown
    );

    // Starting: the host hasn't been started at all.
    let (idle, _host) = build(
        &Daemons::default(),
        &ids,
        HostKey::Local { revision: 2 },
        local_profile(None),
        Timing::default(),
    );
    let (terminals, _hosts) = server_terminals(idle, &ids, false);
    assert_eq!(state_of_s1(&db, &terminals).await, AgentState::Active);
    assert!(!terminals.liveness().await.complete);
}

/// And a complete answer is the join it always was: an agent whose terminal is
/// gone reads as exited and its session is free to resume.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_complete_answer_declares_the_dead_exited_and_frees_their_session() {
    use crate::session::{occupancy, Occupancy};
    use santree_core::domain::AgentState;
    let _serial = crate::stream::pty_guard().await;
    let daemon = FakeDaemon::new();
    leave_behind(&daemon, "tree:AK-1:tab:a", Some(AgentKind::Claude)).await;
    let (db, _dir) = db_with_agent("tree:AK-1:tab:a").await;
    let ids = Arc::new(IdRegistry::default());
    let (local, _host) = run_timed(
        &Daemons::of(&daemon),
        &ids,
        HostKey::Local { revision: 1 },
        local_profile(None),
        UNCACHED,
    );
    tokio::time::timeout(WAIT, local.adopt_ready())
        .await
        .unwrap();
    let (terminals, _hosts) = server_terminals(local, &ids, true);

    assert_eq!(state_of_s1(&db, &terminals).await, AgentState::Active);
    let live = terminals.liveness().await;
    assert!(live.complete);
    assert_eq!(
        occupancy(&db, "repo", "s1", AgentKind::Claude, &live)
            .await
            .unwrap(),
        Occupancy::Running
    );

    // The agent's process ends while the app is looking elsewhere.
    let session = alive(&daemon, "tree:AK-1:tab:a")[0].id;
    daemon.pty().write(session, b"exit\n").unwrap();
    until("the agent to exit", || {
        alive(&daemon, "tree:AK-1:tab:a").is_empty()
    })
    .await;
    assert_eq!(state_of_s1(&db, &terminals).await, AgentState::Exited);
    let live = terminals.liveness().await;
    assert!(live.complete);
    assert_eq!(
        occupancy(&db, "repo", "s1", AgentKind::Claude, &live)
            .await
            .unwrap(),
        Occupancy::Free
    );
}

// ── A pane lets go of its secrets once its session exists ────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pane_keeps_its_env_only_until_its_session_exists_and_reconnects_still_work() {
    let _serial = crate::stream::pty_guard().await;
    let daemon = FakeDaemon::new();
    let daemons = Daemons::of(&daemon);
    let ids = Arc::new(IdRegistry::default());
    let (local, host) = build(
        &daemons,
        &ids,
        HostKey::Local { revision: 1 },
        local_profile(None),
        Timing::default(),
    );

    // Opened while the host is not there: it waits, and the env it will be
    // started with waits with it.
    let mut waiting = spec("tree:A", None);
    waiting.env = vec![("SANTREE_TEST_SECRET".into(), "s3cr3t".into())];
    let screen = Screen::new();
    let id = local
        .open(waiting, "page".into(), (80, 24), None, screen.sinks())
        .await
        .unwrap();
    assert!(local.retains_launch_env(id), "the session hasn't started");

    start(&host);
    screen
        .until("the pane to go live", |s| {
            s.last_link() == Some(PaneLink::Live)
        })
        .await;
    assert!(
        !local.retains_launch_env(id),
        "the session exists; its env had no business staying"
    );
    let session = alive(&daemon, "tree:A")[0].id;
    daemon
        .pty()
        .write(session, b"echo secret-${SANTREE_TEST_SECRET}\n")
        .unwrap();
    screen
        .until("the env to have reached the session", |s| {
            s.text().contains("secret-s3cr3t")
        })
        .await;

    // The link drops and returns: the pane attaches again — it does not need
    // (and no longer has) the env to do so.
    let before = screen.links().len();
    daemon.disconnect_all();
    screen
        .until("the pane to notice and recover", |s| {
            s.links().len() > before + 1 && s.last_link() == Some(PaneLink::Live)
        })
        .await;
    assert_eq!(
        alive(&daemon, "tree:A").len(),
        1,
        "a second session was started"
    );
    assert!(!local.retains_launch_env(id));
}

// ── A pane that never got a link doesn't keep its launch line forever ────────

/// A launch line is typed when its pane's session starts. A pane opened while
/// the server was not there (still starting, or stuck verifying) used to hold
/// its line until some later connect, however long after the user asked: a
/// command typed into a shell they had long forgotten. After the wait it is
/// lost instead, and says so.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pane_that_waits_too_long_for_a_server_is_lost_and_never_types_its_old_line() {
    let _serial = crate::stream::pty_guard().await;
    let daemon = FakeDaemon::new();
    let daemons = Daemons::default(); // no server yet
    let ids = Arc::new(IdRegistry::default());
    let host = Arc::new(RemoteHost::new(daemons.connector(), fast()));
    let local = RemoteTerminals::with_timing(
        host.clone(),
        HostKey::Local { revision: 1 },
        ids.clone(),
        local_profile(None),
        Timing {
            unbound_ttl: Duration::from_millis(300),
            ..UNCACHED
        },
    );
    local.watch();
    start(&host);

    let stale = Screen::new();
    let fresh = Screen::new();
    let id = local
        .open(
            spec("tree:A", None),
            "page".into(),
            (80, 24),
            None,
            stale.sinks(),
        )
        .await
        .unwrap();
    local
        .seed(
            id,
            crate::terminal::LaunchLine::typed("echo launched-long-ago\n"),
        )
        .unwrap();
    assert_eq!(stale.last_link(), Some(PaneLink::Reconnecting));

    stale
        .until("the wait to run out", |s| {
            s.last_link() == Some(PaneLink::Lost)
        })
        .await;

    // The server arrives, late. Nothing was started or typed on the old pane's
    // behalf…
    daemons.set(Some(daemon.clone()));
    until("the server to be reached", || host.client().is_some()).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        alive(&daemon, "tree:A").is_empty(),
        "a session was started late"
    );
    assert!(!stale.text().contains("launched-long-ago"));

    // …and a pane opened now, with the server up, is unaffected.
    let id2 = local
        .open(
            spec("tree:B", None),
            "page".into(),
            (80, 24),
            local.client_within(WAIT).await,
            fresh.sinks(),
        )
        .await
        .unwrap();
    local
        .seed(
            id2,
            crate::terminal::LaunchLine::typed("echo launched-now\n"),
        )
        .unwrap();
    fresh
        .until("the fresh pane's own line", |s| {
            s.text().contains("launched-now")
        })
        .await;
}

/// A pane that gets its link inside the wait is not touched when the wait ends.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pane_that_finds_its_server_in_time_is_not_lost_when_the_wait_ends() {
    let _serial = crate::stream::pty_guard().await;
    let daemon = FakeDaemon::new();
    let daemons = Daemons::of(&daemon);
    let ids = Arc::new(IdRegistry::default());
    let host = Arc::new(RemoteHost::new(daemons.connector(), fast()));
    let local = RemoteTerminals::with_timing(
        host.clone(),
        HostKey::Local { revision: 1 },
        ids.clone(),
        local_profile(None),
        Timing {
            unbound_ttl: Duration::from_millis(600),
            ..UNCACHED
        },
    );
    local.watch();

    let screen = Screen::new();
    let id = local
        .open(
            spec("tree:A", None),
            "page".into(),
            (80, 24),
            None,
            screen.sinks(),
        )
        .await
        .unwrap();
    local
        .seed(id, crate::terminal::LaunchLine::typed("echo on-time\n"))
        .unwrap();
    start(&host);
    screen
        .until("the line to run", |s| s.text().contains("on-time"))
        .await;
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert_eq!(
        screen.last_link(),
        Some(PaneLink::Live),
        "{:?}",
        screen.links()
    );
    assert!(!screen.links().contains(&PaneLink::Lost));
}

/// Daedalus keeps its documented behaviour: a pane opened while the link is
/// down waits for it, however long.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_daedalus_pane_still_waits_for_its_link_as_long_as_it_takes() {
    let _serial = crate::stream::pty_guard().await;
    let ids = Arc::new(IdRegistry::default());
    let host = Arc::new(RemoteHost::new(Daemons::default().connector(), fast()));
    let daedalus = RemoteTerminals::with_timing(
        host,
        HostKey::Daedalus,
        ids,
        Profile::daedalus(),
        Timing {
            unbound_ttl: Duration::from_millis(100),
            ..UNCACHED
        },
    );
    let screen = Screen::new();
    daedalus
        .open(
            spec("tree:A", None),
            "page".into(),
            (80, 24),
            None,
            screen.sinks(),
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(screen.last_link(), Some(PaneLink::Reconnecting));
}

// ── Fix pass: bounds on the calls that hold `opening`, the lost-pane race, and
//    the rest of the review's findings ────────────────────────────────────────

/// A wedged host is asked to list or to open and never answers. Both calls are
/// made while holding `opening` (and a pane's turn), so without a bound every
/// other open on that host queues behind the first for as long as the link
/// takes to be declared dead. With one, each gives up after the host's bound,
/// the pane waits (no error), and the next open gets its turn.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_wedged_host_cannot_hold_every_other_open_behind_it() {
    use std::sync::atomic::AtomicUsize;
    let _serial = crate::stream::pty_guard().await;
    let daemon = FakeDaemon::new();
    leave_behind(&daemon, "tree:OLD", Some(AgentKind::Claude)).await;
    let (wedged, asked) = (
        Arc::new(AtomicBool::new(true)),
        Arc::new(AtomicUsize::new(0)),
    );
    let host = Arc::new(RemoteHost::new(
        wedgeable_connector(&daemon, &wedged, &asked),
        fast(),
    ));
    let ids = Arc::new(IdRegistry::default());
    let local = RemoteTerminals::with_timing(
        host.clone(),
        HostKey::Local { revision: 1 },
        ids,
        local_profile(None),
        QUICK,
    );
    local.watch();
    start(&host);
    let client = local.client_within(WAIT).await.expect("connected");

    // Adoption's own listing is swallowed and holds `opening`; two opens queue
    // behind it. All three must be done within a few of the host's bounds.
    let (a, b) = (Screen::new(), Screen::new());
    let began = std::time::Instant::now();
    let both = tokio::time::timeout(Duration::from_secs(8), async {
        tokio::join!(
            local.open(
                spec("tree:A", None),
                "page".into(),
                (80, 24),
                Some(client.clone()),
                a.sinks()
            ),
            local.open(
                spec("tree:B", None),
                "page".into(),
                (80, 24),
                Some(client.clone()),
                b.sinks()
            ),
        )
    })
    .await
    .expect("opens were held behind a host that never answers");
    let (ida, idb) = (
        both.0.expect("no error is shown"),
        both.1.expect("no error is shown"),
    );
    assert!(began.elapsed() < Duration::from_secs(8));
    assert_ne!(ida, idb);
    for screen in [&a, &b] {
        assert_ne!(screen.last_link(), Some(PaneLink::Live));
        assert!(!screen.exited(), "a wait is not an exit");
    }
}

/// Same for the open itself: a host that swallows `pty.open` is given the
/// bound, not the link's idle timeout.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_open_the_host_never_answers_gives_up_and_the_pane_waits() {
    let _serial = crate::stream::pty_guard().await;
    let daemon = FakeDaemon::new();
    let swallow = Arc::new(AtomicBool::new(true));
    let host = Arc::new(RemoteHost::new(
        {
            let swallow = swallow.clone();
            sessions_proxy(&daemon, move |method| {
                if method == "pty.open" && swallow.load(Ordering::SeqCst) {
                    Tamper::Swallow
                } else {
                    Tamper::Pass
                }
            })
        },
        fast(),
    ));
    let local = RemoteTerminals::with_timing(
        host.clone(),
        HostKey::Local { revision: 1 },
        Arc::new(IdRegistry::default()),
        local_profile(None),
        QUICK,
    );
    local.watch();
    start(&host);
    tokio::time::timeout(WAIT, local.adopt_ready())
        .await
        .unwrap();
    let client = local.client_within(WAIT).await;
    let screen = Screen::new();
    tokio::time::timeout(
        Duration::from_secs(5),
        local.open(
            spec("tree:A", None),
            "page".into(),
            (80, 24),
            client,
            screen.sinks(),
        ),
    )
    .await
    .expect("the open was not bounded")
    .expect("a timeout is a wait, not an error");
    assert!(!screen.exited());

    // The link was dropped and comes back: the pane binds then.
    swallow.store(false, Ordering::SeqCst);
    screen
        .until("the pane to bind on the next connect", |s| {
            s.last_link() == Some(PaneLink::Live)
        })
        .await;
}

/// A pane whose wait ran out while the host was opening its session: nobody
/// will attach to, type into or close that session, so it is closed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pane_lost_while_the_host_opens_its_session_has_that_session_closed() {
    use std::sync::atomic::AtomicUsize;
    let _serial = crate::stream::pty_guard().await;
    let daemon = FakeDaemon::new();
    let release = Arc::new(tokio::sync::Notify::new());
    let in_flight = Arc::new(AtomicUsize::new(0));
    let host = Arc::new(RemoteHost::new(
        {
            let (release, in_flight) = (release.clone(), in_flight.clone());
            sessions_proxy(&daemon, move |method| {
                if method == "pty.open" {
                    in_flight.fetch_add(1, Ordering::SeqCst);
                    Tamper::Delay(release.clone())
                } else {
                    Tamper::Pass
                }
            })
        },
        fast(),
    ));
    let local = RemoteTerminals::with_timing(
        host.clone(),
        HostKey::Local { revision: 1 },
        Arc::new(IdRegistry::default()),
        local_profile(None),
        Timing {
            timeout: Duration::from_secs(30),
            ..UNCACHED
        },
    );
    local.watch();
    start(&host);
    tokio::time::timeout(WAIT, local.adopt_ready())
        .await
        .unwrap();
    let client = local.client_within(WAIT).await;

    let screen = Screen::new();
    let opening = {
        let local = local.clone();
        let sinks = screen.sinks();
        tokio::spawn(async move {
            local
                .open(spec("tree:A", None), "page".into(), (80, 24), client, sinks)
                .await
        })
    };
    until("the open to be on its way", || {
        in_flight.load(Ordering::SeqCst) > 0
    })
    .await;

    // Its wait runs out while the host is still opening the session.
    local.lose_unbound();
    assert_eq!(screen.last_link(), Some(PaneLink::Lost));
    release.notify_one();
    opening.await.unwrap().expect("open");

    until("the session opened for a lost pane to be closed", || {
        alive(&daemon, "tree:A").is_empty()
    })
    .await;
    assert!(
        daemon
            .pty()
            .sessions()
            .iter()
            .all(|s| s.label != "tree:A" || !s.alive),
        "an idle shell nobody can close was left on the server"
    );
    assert_eq!(screen.last_link(), Some(PaneLink::Lost));
}

/// An attach the host never answers is given up on like an open is: the link is
/// dropped and the pane waits, `Reconnecting`, instead of holding its turn —
/// and the open that asked — until the link's idle timeout.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_attach_the_host_never_answers_gives_up_and_the_pane_waits() {
    let _serial = crate::stream::pty_guard().await;
    let daemon = FakeDaemon::new();
    let never = Arc::new(tokio::sync::Notify::new());
    let host = Arc::new(RemoteHost::new(
        {
            let never = never.clone();
            sessions_proxy(&daemon, move |method| {
                if method == "pty.attach" {
                    Tamper::Delay(never.clone())
                } else {
                    Tamper::Pass
                }
            })
        },
        fast(),
    ));
    let local = RemoteTerminals::with_timing(
        host.clone(),
        HostKey::Local { revision: 1 },
        Arc::new(IdRegistry::default()),
        local_profile(None),
        QUICK,
    );
    local.watch();
    start(&host);
    tokio::time::timeout(WAIT, local.adopt_ready())
        .await
        .unwrap();
    let screen = Screen::new();
    let opened = tokio::time::timeout(
        Duration::from_secs(5),
        local.open(
            spec("tree:B", None),
            "page".into(),
            (80, 24),
            local.client_within(WAIT).await,
            screen.sinks(),
        ),
    )
    .await
    .expect("an attach nobody answers held the open");
    opened.expect("the pane waits rather than fails");
    assert_eq!(screen.last_link(), Some(PaneLink::Reconnecting));
    assert_eq!(
        alive(&daemon, "tree:B").len(),
        1,
        "the session was opened once"
    );
}

/// The listing is dropped the moment the host has opened a session, not only
/// when the whole bind ends: a read in between must not find the pane bound to a
/// session an older listing doesn't have.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_just_opened_is_alive_to_a_read_before_its_attach_returns() {
    use std::sync::atomic::AtomicUsize;
    let _serial = crate::stream::pty_guard().await;
    let daemon = FakeDaemon::new();
    let release = Arc::new(tokio::sync::Notify::new());
    let attaching = Arc::new(AtomicUsize::new(0));
    let host = Arc::new(RemoteHost::new(
        {
            let (release, attaching) = (release.clone(), attaching.clone());
            sessions_proxy(&daemon, move |method| {
                if method == "pty.attach" {
                    attaching.fetch_add(1, Ordering::SeqCst);
                    Tamper::Delay(release.clone())
                } else {
                    Tamper::Pass
                }
            })
        },
        fast(),
    ));
    let ids = Arc::new(IdRegistry::default());
    let local = RemoteTerminals::with_timing(
        host.clone(),
        HostKey::Local { revision: 1 },
        ids.clone(),
        local_profile(None),
        // The attach is held for as long as the test looks: well inside the
        // bound a host gets to answer it.
        Timing {
            timeout: Duration::from_secs(10),
            ..QUICK
        },
    );
    local.watch();
    start(&host);
    tokio::time::timeout(WAIT, local.adopt_ready())
        .await
        .unwrap();
    let (terminals, _hosts) = server_terminals(local.clone(), &ids, true);
    // A fresh listing, without the session about to be opened.
    assert!(terminals.liveness().await.complete);

    let client = local.client_within(WAIT).await;
    let screen = Screen::new();
    let opening = {
        let local = local.clone();
        let sinks = screen.sinks();
        tokio::spawn(async move {
            local
                .open(
                    spec("tree:B", Some(AgentKind::Claude)),
                    "page".into(),
                    (80, 24),
                    client,
                    sinks,
                )
                .await
        })
    };
    until("the attach to be on its way", || {
        attaching.load(Ordering::SeqCst) > 0
    })
    .await;

    // The session is open and the pane is bound to it; the attach has not come
    // back. A read now must see it alive.
    let live = terminals.liveness().await;
    assert!(live.complete);
    assert!(
        live.live.contains(&LiveTerminal {
            term_key: "tree:B".into(),
            agent_kind: Some(AgentKind::Claude)
        }),
        "a session the host had just opened read as not alive: {:?}",
        live.live
    );
    release.notify_one();
    opening.await.unwrap().expect("open");
}

/// A lost or ended pane has nothing left to start, so it lets go of its secrets
/// and its queued launch line; a lost pane's line is not left to be typed by
/// anything.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lost_or_ended_pane_lets_go_of_its_secrets_and_its_queued_line() {
    let _serial = crate::stream::pty_guard().await;
    let ids = Arc::new(IdRegistry::default());
    let (local, _host) = build(
        &Daemons::default(),
        &ids,
        HostKey::Local { revision: 1 },
        local_profile(None),
        Timing::default(),
    );
    let with_secret = || {
        let mut s = spec("tree:A", None);
        s.env = vec![("SANTREE_TEST_SECRET".into(), "s3cr3t".into())];
        s
    };
    let mut ids_made = Vec::new();
    for _ in 0..3 {
        let id = local
            .open(
                with_secret(),
                "page".into(),
                (80, 24),
                None,
                Screen::new().sinks(),
            )
            .await
            .unwrap();
        local
            .seed(id, crate::terminal::LaunchLine::typed("echo queued\n"))
            .unwrap();
        assert!(local.retains_launch_env(id) && local.retains_seed(id));
        ids_made.push(id);
    }

    // The host is given up on (the sweep the supervisor runs).
    local.lose_unbound();
    for id in &ids_made {
        assert!(
            !local.retains_launch_env(*id),
            "a lost pane kept its secrets"
        );
        assert!(!local.retains_seed(*id), "a lost pane kept its launch line");
    }

    // The same for every other way a pane ends: the host is gone for good…
    let id = local
        .open(
            with_secret(),
            "page".into(),
            (80, 24),
            None,
            Screen::new().sinks(),
        )
        .await
        .unwrap();
    local.lose_all();
    assert!(!local.retains_launch_env(id));

    // …and a pane whose wait runs out (the timer, not the sweep).
    let (timed, _host) = build(
        &Daemons::default(),
        &ids,
        HostKey::Local { revision: 2 },
        local_profile(None),
        Timing {
            unbound_ttl: Duration::from_millis(150),
            ..UNCACHED
        },
    );
    let screen = Screen::new();
    let id = timed
        .open(with_secret(), "page".into(), (80, 24), None, screen.sinks())
        .await
        .unwrap();
    assert!(timed.retains_launch_env(id));
    screen
        .until("the wait to run out", |s| {
            s.last_link() == Some(PaneLink::Lost)
        })
        .await;
    assert!(
        !timed.retains_launch_env(id),
        "an expired pane kept its secrets"
    );
}

/// A launch line queued on a pane that has a session, while its link is down,
/// is typed on the next attach: so it must not be typed after a long outage.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_launch_line_queued_across_a_long_outage_is_not_typed_when_the_link_returns() {
    let _serial = crate::stream::pty_guard().await;
    let daemon = FakeDaemon::new();
    let daemons = Daemons::of(&daemon);
    let ids = Arc::new(IdRegistry::default());
    let (local, host) = run_timed(
        &daemons,
        &ids,
        HostKey::Local { revision: 1 },
        local_profile(None),
        Timing {
            unbound_ttl: Duration::from_millis(1500),
            ..UNCACHED
        },
    );
    let client = local.client_within(WAIT).await;
    let screen = Screen::new();
    let id = local
        .open(
            spec("tree:A", None),
            "page".into(),
            (80, 24),
            client,
            screen.sinks(),
        )
        .await
        .unwrap();
    screen
        .until("the pane to go live", |s| {
            s.last_link() == Some(PaneLink::Live)
        })
        .await;

    // A short outage: the line queued meanwhile is typed on the way back.
    daemons.set(None);
    daemon.disconnect_all();
    until_down(&local).await;
    local
        .seed(
            id,
            crate::terminal::LaunchLine::typed("echo fresh-$((20+1))\n"),
        )
        .unwrap();
    daemons.set(Some(daemon.clone()));
    screen
        .until("the fresh line", |s| s.text().contains("fresh-21"))
        .await;

    // A long one: by the time the link is back the line is nobody's request.
    daemons.set(None);
    daemon.disconnect_all();
    until_down(&local).await;
    local
        .seed(
            id,
            crate::terminal::LaunchLine::typed("echo stale-$((30+1))\n"),
        )
        .unwrap();
    assert!(local.retains_seed(id));
    tokio::time::sleep(Duration::from_millis(1800)).await;
    daemons.set(Some(daemon.clone()));
    until("the host to be reachable", || host.client().is_some()).await;
    screen
        .until("the pane to go live again", |s| {
            s.last_link() == Some(PaneLink::Live)
        })
        .await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(
        !screen.text().contains("stale-31"),
        "a launch line queued long ago was typed: {:?}",
        screen.text()
    );
}

/// A listing being fetched while the table changes must not be kept: it may
/// predate the change.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_listing_fetched_across_an_invalidation_is_not_cached() {
    use std::sync::atomic::AtomicUsize;
    let _serial = crate::stream::pty_guard().await;
    let daemon = FakeDaemon::new();
    let release = Arc::new(tokio::sync::Notify::new());
    let listings = Arc::new(AtomicUsize::new(0));
    let delay_next = Arc::new(AtomicBool::new(false));
    let host = Arc::new(RemoteHost::new(
        {
            let (release, listings, delay_next) =
                (release.clone(), listings.clone(), delay_next.clone());
            sessions_proxy(&daemon, move |method| {
                if method != "pty.sessions" {
                    return Tamper::Pass;
                }
                listings.fetch_add(1, Ordering::SeqCst);
                if delay_next.swap(false, Ordering::SeqCst) {
                    Tamper::Delay(release.clone())
                } else {
                    Tamper::Pass
                }
            })
        },
        fast(),
    ));
    let ids = Arc::new(IdRegistry::default());
    let local = RemoteTerminals::with_timing(
        host.clone(),
        HostKey::Local { revision: 1 },
        ids,
        local_profile(None),
        QUICK,
    );
    local.watch();
    start(&host);
    tokio::time::timeout(WAIT, local.adopt_ready())
        .await
        .unwrap();

    // A read begins; the table changes while its answer is on the way.
    delay_next.store(true, Ordering::SeqCst);
    let read = {
        let local = local.clone();
        tokio::spawn(async move { local.held_sessions().await })
    };
    until("the listing to be in flight", || {
        !delay_next.load(Ordering::SeqCst)
    })
    .await;
    local.invalidate_listing_for_test();
    release.notify_one();
    read.await.unwrap().expect("the read still answers");

    // What it fetched predates the change, so it was not kept: the next read
    // asks the host again.
    let before = listings.load(Ordering::SeqCst);
    local.held_sessions().await.expect("answers");
    assert_eq!(
        listings.load(Ordering::SeqCst),
        before + 1,
        "a listing that straddled an invalidation was served from the cache"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_wedged_server_does_not_discard_the_healthy_ones_answers() {
    use std::sync::atomic::AtomicUsize;
    let _serial = crate::stream::pty_guard().await;
    let (healthy_daemon, wedged_daemon) = (FakeDaemon::new(), FakeDaemon::new());
    leave_behind(&healthy_daemon, "tree:HEALTHY", Some(AgentKind::Claude)).await;
    let ids = Arc::new(IdRegistry::default());

    let (healthy, _h) = run(
        &Daemons::of(&healthy_daemon),
        &ids,
        HostKey::Local { revision: 2 },
        local_profile(None),
    );
    tokio::time::timeout(WAIT, healthy.adopt_ready())
        .await
        .unwrap();

    let (wedged_flag, asked) = (
        Arc::new(AtomicBool::new(true)),
        Arc::new(AtomicUsize::new(0)),
    );
    let wedged_host = Arc::new(RemoteHost::new(
        wedgeable_connector(&wedged_daemon, &wedged_flag, &asked),
        fast(),
    ));
    let wedged = RemoteTerminals::with_timing(
        wedged_host.clone(),
        HostKey::Local { revision: 1 },
        ids.clone(),
        local_profile(None),
        // Its own bound would wait a minute: the facade's is what holds.
        Timing {
            timeout: Duration::from_secs(60),
            ..QUICK
        },
    );
    wedged.watch();
    start(&wedged_host);
    assert!(wedged.client_within(WAIT).await.is_some(), "connected");

    let (daedalus, _d) = build(
        &Daemons::default(),
        &ids,
        HostKey::Daedalus,
        Profile::daedalus(),
        Timing::default(),
    );
    let terminals = Terminals::new(
        Local::Server(TestHosts::of(vec![healthy, wedged])),
        daedalus,
        ids,
    )
    .with_read_deadline(Duration::from_millis(500));

    let began = std::time::Instant::now();
    let liveness = terminals.liveness().await;
    assert!(
        !liveness.complete,
        "a host that never answered is not complete"
    );
    assert!(
        liveness.live.contains(&LiveTerminal {
            term_key: "tree:HEALTHY".into(),
            agent_kind: Some(AgentKind::Claude)
        }),
        "the healthy server's answer was thrown away with the wedged one's: {:?}",
        liveness.live
    );
    let snapshot = terminals.snapshot().await;
    assert!(!snapshot.complete);
    assert_eq!(
        snapshot
            .sessions
            .iter()
            .map(|s| s.label.as_str())
            .collect::<Vec<_>>(),
        ["tree:HEALTHY"]
    );
    let held = terminals.local_sessions().await;
    assert_eq!(
        held.iter().map(|s| s.label.as_str()).collect::<Vec<_>>(),
        ["tree:HEALTHY"]
    );
    assert!(
        began.elapsed() < Duration::from_secs(5),
        "{:?}",
        began.elapsed()
    );
}
