//! [`LocalServers`]: the app's hold on its local santree servers.
//!
//! One *current* server (this build's revision: where new panes open) and any
//! number of *draining* ones (older revisions that still hold sessions: their
//! panes keep working, they get no new ones and are never respawned). Each is
//! a `RemoteHost` + `RemoteTerminals` pair — the same machinery Daedalus
//! uses — over a [`ServerConnector`].
//!
//! Ownership of the processes is deliberately thin. The app launches a server
//! detached and from then on only *talks* to it: quitting disconnects
//! ([`LocalServers::release`]) and never stops anything, and a server that dies
//! is relaunched within a crash budget, never silently forever.
//!
//! The state the UI shows ([`ServerStatus`]) is one `Phase` per current server,
//! changed in a few places and announced on every change.

use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use futures::future::BoxFuture;
use tokio::sync::watch;

use santree_core::domain::{DrainingServer, ServerState, ServerStatus, SessionCount};
use santree_remote_client::proto::{m, Empty, KeepAwakeParams, KeepAwakeResult, ServerInfo};
use santree_remote_client::{
    ClientOptions, ConnectError, Connector, HostConfig, HostOptions, HostStatus, RemoteClient,
    RemoteHost, Required,
};
use santree_server::{endpoint, REVISION};

use super::connector::{Expect, ServerConnector};
use super::layout::{plain_u32, Layout};
use super::lock::{lock_beside, probe_lock, wait_until_free, EndpointLock};
use super::spawn::{self, ExitInfo, Spawned, Start};
use crate::sessions::{HostKey, IdRegistry, LocalHosts, Mode, OnExited, Profile, RemoteTerminals};

/// Crashes the app answers with a relaunch, in [`CRASH_WINDOW`]. One more and
/// the server is `Failing`: something about it is wrong, and a relaunch loop
/// would hide that behind a spinner.
const CRASH_LIMIT: usize = 5;
const CRASH_WINDOW: Duration = Duration::from_secs(60);

/// How long a connect attempt gets to settle before the supervisor decides.
/// Past the host's own 3 s hello timeout.
const SETTLE: Duration = Duration::from_secs(5);
/// How long the verdict on a connected server (`server.info`, keep-awake) may
/// take.
const VERDICT_WAIT: Duration = Duration::from_secs(12);
/// One `server.*` call.
const CALL_WAIT: Duration = Duration::from_secs(3);
/// How long `adopt_ready` lets the servers come up, at most — the facade bounds
/// it too; this keeps a forgotten caller from waiting forever.
const ADOPT_WAIT: Duration = Duration::from_secs(12);
/// How often the live-session counts are refreshed, and drained servers that
/// emptied are let go.
const HOUSEKEEPING: Duration = Duration::from_secs(10);
/// How long a stop waits for the server to actually be gone.
const STOP_WAIT: Duration = Duration::from_secs(10);
/// The most older servers looked for at once, newest first. There is one per
/// revision that still held sessions when the app moved on; eight is years.
const LEGACY_MAX: usize = 8;
/// How long an older server that never answered is waited for before it is
/// given up on and reported instead of holding the app's liveness open.
const UNRESOLVED_BOUND: Duration = Duration::from_secs(5 * 60);

/// What the cut-over wires in.
pub struct ServerConfig {
    /// The Tauri app data dir; the server's own dirs are below it.
    pub app_data_dir: PathBuf,
    /// The app's log dir (`app_log_dir()`); the server's log goes beside the
    /// app's. `None`: there is none, and so no server.
    pub log_dir: Option<PathBuf>,
    /// The bundled `santree-server` (`resource_dir()/santree-server`; in dev
    /// `target/debug/santree-server`). `None`: nothing can be launched.
    pub bundled_binary: Option<PathBuf>,
    pub mode: Mode,
    /// The app's one pane-id registry (`DaedalusHost::ids()`).
    pub ids: Arc<IdRegistry>,
    /// Retires the rows of a session that ended while no app was attached —
    /// `hooks::retire_terminal`, bridged. The session is closed on the server
    /// once it returns.
    pub retire: OnExited,
    /// Told of every state change.
    pub emit: Arc<dyn Fn(ServerStatus) + Send + Sync>,
    /// The app's remembered Keep-awake setting, read on every (re)connect.
    pub keep_awake: Arc<dyn Fn() -> bool + Send + Sync>,
    /// Told whether the server holds the machine awake: its answer to each
    /// `server.keepAwake`, and `false` once it is gone.
    pub keep_awake_held: Arc<dyn Fn(bool) + Send + Sync>,
}

/// The current server's state, before it becomes the wire's [`ServerState`].
#[derive(Debug, Clone, PartialEq)]
enum Phase {
    /// Launching, connecting, or reconnecting after a loss; also before
    /// `ensure` has run.
    Starting,
    Running(Running),
    /// A stop the user asked for (Stop, or a Restart's first half) is under way.
    Stopping,
    /// The user stopped it: nothing brings it back but a Start.
    Stopped,
    Down(String),
    Failing(String),
    /// Mode `Off`: there is no server.
    Off,
}

#[derive(Debug, Clone, PartialEq)]
struct Running {
    version: String,
    pid: u32,
    started_at_ms: f64,
    live_sessions: u32,
}

impl Phase {
    /// Whether the supervisor has an answer (as opposed to still working it
    /// out).
    fn settled(&self) -> bool {
        matches!(
            self,
            Phase::Running(_) | Phase::Stopped | Phase::Down(_) | Phase::Failing(_) | Phase::Off
        )
    }
}

/// One server the app is connected to (or trying to be).
struct Slot {
    revision: u32,
    host: Arc<RemoteHost>,
    terminals: RemoteTerminals,
    config: HostConfig,
    /// The launch, while this app launched the current server.
    child: Mutex<Option<Spawned>>,
    /// Live sessions at the last look (draining servers). Meaningful only once
    /// `sessions_known`.
    sessions: AtomicU32,
    /// A draining server's sessions have been listed at least once. Until they
    /// have, it is held open as a server that may hold agents it can't show.
    sessions_known: AtomicBool,
    /// When the slot was made: how long an unresolved one has been waited for.
    /// A `Mutex` only so tests can backdate it.
    since: Mutex<Instant>,
    endpoint: Mutex<Endpoint>,
    /// `server-r<N>.lock`, beside the socket.
    lock: PathBuf,
    /// Its pid and version, as `server.info` last said (draining servers).
    identity: Mutex<Option<(u32, String)>>,
}

/// What is known of a server's endpoint. Written only by
/// [`Slot::observe_absent`] and [`Slot::observe_present`], so the rule that
/// matters most — a server is `Dead` only once its lock is free, or an agent
/// running fine reads as exited and is resumed twice — lives in one place.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Endpoint {
    /// Answering, just launched, or not looked at: what it holds is unknown.
    Unknown,
    /// Nothing answers and nothing holds its lock: whatever it held is gone.
    Dead,
    /// Its socket is gone but its lock is held: a server process is alive
    /// behind a socket nobody can dial (a same-uid agent can `rm` it). Neither
    /// dead nor reachable; it is never given up on.
    Orphaned,
}

/// Why a server that was stopped on purpose is down.
const STOPPED: &str = "the santree server was stopped; start it to use terminals";

/// Why the app is Down while something holds the server's lock and nothing
/// answers on its socket: a server whose socket was removed, or another process
/// that took the lock. It cannot be relaunched over (a new server would find the
/// endpoint occupied and exit), is not counted as a crash, and the app cannot
/// tell which it is — so the reason names the file and what to do about it.
fn socket_gone(lock: &Path) -> String {
    format!(
        "something holds the santree server's lock ({}) but nothing answers on its socket: \
         a server whose socket was removed, or another process. Quit it, or delete the \
         file if it is not a santree server, then Start",
        lock.display()
    )
}

/// Why a launch failed when the lock is held by a process that is not a serving
/// server (it can hold a shared lock, which the probe can't see): the server we
/// started waited out a brief hold, still found the endpoint occupied, and there
/// is no socket to show for it.
fn lock_held_elsewhere(lock: &Path) -> String {
    format!(
        "another process holds {}, the santree server's lock, and no server answers: quit \
         that process, or delete the file, then Start",
        lock.display()
    )
}

impl Slot {
    /// Nothing listens on this server's socket: is anything alive behind it?
    /// Its lock says. Held: `Orphaned`, whatever it holds is unknown, not gone.
    /// Free: `Dead`.
    fn observe_absent(&self) -> Endpoint {
        let now = match probe_lock(&self.lock) {
            EndpointLock::Held => Endpoint::Orphaned,
            EndpointLock::Free => Endpoint::Dead,
        };
        *lock(&self.endpoint) = now;
        now
    }

    /// A server is on the socket (connected, or one was just launched): what it
    /// holds is unknown again.
    fn observe_present(&self) {
        *lock(&self.endpoint) = Endpoint::Unknown;
    }

    fn endpoint(&self) -> Endpoint {
        *lock(&self.endpoint)
    }

    fn kick(&self) {
        self.host.configure(Some(self.config.clone()));
    }

    fn dead_or_connected(&self) -> bool {
        matches!(self.host.current_status(), HostStatus::Connected { .. })
            || self.endpoint() == Endpoint::Dead
    }
}

/// Crashes in a sliding window.
#[derive(Debug, Default)]
struct CrashBudget {
    at: VecDeque<Instant>,
}

impl CrashBudget {
    /// Record a crash the app is about to answer with a relaunch. `false`: the
    /// budget is spent — this is the one too many.
    fn allow(&mut self, now: Instant) -> bool {
        while self
            .at
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) >= CRASH_WINDOW)
        {
            self.at.pop_front();
        }
        if self.at.len() >= CRASH_LIMIT {
            return false;
        }
        self.at.push_back(now);
        true
    }

    fn reset(&mut self) {
        self.at.clear();
    }
}

pub struct LocalServers {
    cfg: ServerConfig,
    /// The revision this build runs; a field so tests can stand another in.
    revision: u32,
    layout: Result<Layout, String>,
    current: Arc<Slot>,
    draining: Mutex<BTreeMap<u32, Arc<Slot>>>,
    phase: watch::Sender<Phase>,
    /// Legacy discovery has run at least once.
    discovered: watch::Sender<bool>,
    emitted: Mutex<Option<ServerStatus>>,
    /// Held across a bring-up, stop or restart: one at a time.
    gate: tokio::sync::Mutex<()>,
    /// The app is going: nothing is relaunched, nothing is started.
    released: AtomicBool,
    monitoring: AtomicBool,
    /// How long a stop waits for the server's socket, and then its lock, to be
    /// let go (milliseconds; tests shorten it).
    stop_wait_ms: AtomicU64,
    budget: Mutex<CrashBudget>,
    /// Older sockets whose peer failed verification outright: not santree's
    /// server, so nothing santree holds is on them (see `adopt_legacy`). Only
    /// the diagnostics report lists them, with `unreachable`.
    untrusted: Mutex<BTreeMap<u32, String>>,
    /// Older servers that never answered within [`UNRESOLVED_BOUND`].
    unreachable: Mutex<BTreeMap<u32, String>>,
    /// What the current server was last told about keep-awake, so a change is
    /// sent once and an unchanged setting costs no round trip.
    keep_awake_sent: Mutex<Option<bool>>,
    /// Tests: the connector an older server's slot dials through.
    #[cfg(test)]
    legacy_connector: Mutex<Option<TestConnectors>>,
}

/// Makes the connector for an older server's socket (tests only).
#[cfg(test)]
type TestConnectors = Arc<dyn Fn(&Path) -> Arc<dyn Connector> + Send + Sync>;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl LocalServers {
    pub fn new(cfg: ServerConfig) -> Arc<Self> {
        let layout = match &cfg.log_dir {
            Some(logs) => Layout::resolve(&cfg.app_data_dir, cfg.mode, logs),
            None => Err(anyhow!("there is no log dir for the server's log")),
        }
        .map_err(|e| format!("{e:#}"));
        Self::build(cfg, layout, REVISION)
    }

    /// [`LocalServers::new`] over a test's own layout. Never the resolved one
    /// in a test: that scans the real `$TMPDIR` run dir, where the user's own
    /// opt-in dev server lives, and an older revision there would be adopted
    /// as a draining server, sessions and all.
    #[cfg(test)]
    pub(crate) fn in_layout(cfg: ServerConfig, layout: Layout) -> Arc<Self> {
        Self::build(cfg, Ok(layout), REVISION)
    }

    /// [`LocalServers::new`] over a layout and revision the caller chose, for
    /// tests: a scratch dir, and a stand-in revision to discover the real
    /// server as an older one.
    fn build(cfg: ServerConfig, layout: Result<Layout, String>, revision: u32) -> Arc<Self> {
        let owner = uuid::Uuid::new_v4().to_string();
        let socket = layout
            .as_ref()
            .map(|l| l.socket_for(revision))
            .unwrap_or_default();
        let current = build_slot(&cfg, revision, socket, &owner);
        let (phase, _) = watch::channel(if cfg.mode == Mode::Off {
            Phase::Off
        } else {
            Phase::Starting
        });
        Arc::new(Self {
            cfg,
            revision,
            layout,
            current,
            draining: Mutex::new(BTreeMap::new()),
            phase,
            discovered: watch::channel(false).0,
            emitted: Mutex::new(None),
            gate: tokio::sync::Mutex::new(()),
            released: AtomicBool::new(false),
            monitoring: AtomicBool::new(false),
            stop_wait_ms: AtomicU64::new(STOP_WAIT.as_millis() as u64),
            budget: Mutex::new(CrashBudget::default()),
            untrusted: Mutex::new(BTreeMap::new()),
            unreachable: Mutex::new(BTreeMap::new()),
            keep_awake_sent: Mutex::new(None),
            #[cfg(test)]
            legacy_connector: Mutex::new(None),
        })
    }

    /// A slot for the older server of `revision` on `socket`.
    fn legacy_slot(&self, revision: u32, socket: PathBuf) -> Arc<Slot> {
        #[cfg(test)]
        if let Some(make) = lock(&self.legacy_connector).clone() {
            return build_slot_over(
                &self.cfg,
                revision,
                &socket,
                make(&socket),
                &self.current.config.owner,
            );
        }
        build_slot(&self.cfg, revision, socket, &self.current.config.owner)
    }

    /// Older sockets that failed the peer check (revision, why): something
    /// other than santree's server is bound there. Reported, not held open.
    fn untrusted_servers(&self) -> Vec<(u32, String)> {
        lock(&self.untrusted)
            .iter()
            .map(|(r, w)| (*r, w.clone()))
            .collect()
    }

    /// Older servers given up on after never answering (revision, why).
    fn unreachable_servers(&self) -> Vec<(u32, String)> {
        lock(&self.unreachable)
            .iter()
            .map(|(r, w)| (*r, w.clone()))
            .collect()
    }

    // ── state ───────────────────────────────────────────────────────────────

    /// What the UI shows, from the supervisor's own state: no I/O.
    pub fn status(&self) -> ServerStatus {
        let state = match &*self.phase.borrow() {
            Phase::Off => ServerState::Off,
            Phase::Starting => ServerState::Starting,
            Phase::Stopping => ServerState::Stopping,
            Phase::Stopped => ServerState::Down {
                reason: STOPPED.into(),
            },
            Phase::Running(r) => ServerState::Running {
                revision: self.revision,
                version: r.version.clone(),
                pid: r.pid,
                started_at_ms: r.started_at_ms,
                live_sessions: r.live_sessions,
            },
            Phase::Down(reason) => ServerState::Down {
                reason: reason.clone(),
            },
            Phase::Failing(reason) => ServerState::Failing {
                reason: reason.clone(),
            },
        };
        let draining = lock(&self.draining)
            .values()
            .map(|slot| {
                let identity = lock(&slot.identity).clone();
                DrainingServer {
                    revision: slot.revision,
                    // A count nobody has read is not a count of zero: that
                    // reads as "safe to end" for a server that may hold agents.
                    sessions: if slot.sessions_known.load(Ordering::SeqCst) {
                        SessionCount::Known {
                            count: slot.sessions.load(Ordering::SeqCst),
                        }
                    } else {
                        SessionCount::Unknown
                    },
                    pid: identity.as_ref().map(|(pid, _)| *pid),
                    version: identity.map(|(_, version)| version),
                }
            })
            .collect();
        ServerStatus { state, draining }
    }

    fn set_phase(&self, phase: Phase) {
        log::info!("santree server: {phase:?}");
        let gave_up = matches!(phase, Phase::Down(_) | Phase::Failing(_) | Phase::Stopped);
        self.phase.send_if_modified(|current| {
            let changed = *current != phase;
            *current = phase;
            changed
        });
        if gave_up {
            // A server that is gone holds nothing awake.
            (self.cfg.keep_awake_held)(false);
            // Tabs opened while the server was coming up were waiting for it. It
            // isn't coming, and a later "Start" must not make them type a launch
            // line the user asked for long ago: nothing starts on its own. The
            // flag first, so a tab still on its way in is refused too.
            self.current.terminals.refuse_unbound(true);
            self.current.terminals.lose_unbound();
        } else {
            self.current.terminals.refuse_unbound(false);
        }
        self.emit();
    }

    /// Announce the status if it differs from the last one announced. Read
    /// under the lock, so two racing announcements can't land out of order.
    fn emit(&self) {
        let mut last = lock(&self.emitted);
        let status = self.status();
        if last.as_ref() != Some(&status) {
            *last = Some(status.clone());
            (self.cfg.emit)(status);
        }
    }

    fn phase(&self) -> Phase {
        self.phase.borrow().clone()
    }

    fn host_status(&self) -> HostStatus {
        self.current.host.current_status()
    }

    // ── bring-up ────────────────────────────────────────────────────────────

    /// Connect to the current server, launching it if it isn't running, and
    /// find the older ones still holding sessions. Settles into `Running`,
    /// `Down` or `Failing`; never errors (the state is the answer). Not called
    /// under `SANTREE_SMOKE`: the smoke run asserts the bundle
    /// ([`spawn::smoke_assert`]) without starting anything.
    pub async fn ensure(self: &Arc<Self>) {
        self.ensure_unless(super::smoke_enabled()).await;
    }

    /// [`LocalServers::ensure`] with the smoke decision made by the caller, so
    /// a test can exercise the guard without touching the environment.
    async fn ensure_unless(self: &Arc<Self>, smoke: bool) {
        if smoke || self.cfg.mode == Mode::Off || self.released.load(Ordering::SeqCst) {
            return;
        }
        let _gate = self.gate.lock().await;
        // Stopped on purpose (`stop`): only a "Start" brings it back.
        if self.phase() == Phase::Stopped {
            return;
        }
        self.bring_up_all().await;
    }

    /// The user's "Start": a fresh crash budget, then [`LocalServers::ensure`]'s
    /// work. `Err` with the reason when the server still isn't running. Not under
    /// `SANTREE_SMOKE` either, for the same reason as `ensure`.
    pub async fn start(self: &Arc<Self>) -> Result<()> {
        self.start_unless(super::smoke_enabled()).await
    }

    /// [`LocalServers::start`] with the smoke decision made by the caller.
    async fn start_unless(self: &Arc<Self>, smoke: bool) -> Result<()> {
        if smoke {
            bail!("the smoke run starts no santree server");
        }
        if self.cfg.mode == Mode::Off {
            bail!("the santree server isn't enabled in this build");
        }
        if self.released.load(Ordering::SeqCst) {
            bail!("santree is quitting");
        }
        let _gate = self.gate.lock().await;
        lock(&self.budget).reset();
        self.bring_up_all().await;
        self.running_or_reason()
    }

    /// Stop the current server (closing every session it holds) and start a
    /// fresh one. A stop on purpose: not counted as a crash.
    pub async fn restart(self: &Arc<Self>) -> Result<()> {
        if self.cfg.mode == Mode::Off {
            bail!("the santree server isn't enabled in this build");
        }
        if self.released.load(Ordering::SeqCst) {
            bail!("santree is quitting");
        }
        let _gate = self.gate.lock().await;
        self.stop_current().await?;
        lock(&self.budget).reset();
        self.bring_up_all().await;
        self.running_or_reason()
    }

    /// Stop the current server (closing every session it holds) and leave it
    /// stopped: not a crash, and nothing relaunches it until [`start`]. Its
    /// panes are lost, as after any server that is gone. `Err` with the reason
    /// when it didn't stop.
    ///
    /// [`start`]: LocalServers::start
    pub async fn stop(self: &Arc<Self>) -> Result<()> {
        if self.cfg.mode == Mode::Off {
            bail!("the santree server isn't enabled in this build");
        }
        if self.released.load(Ordering::SeqCst) {
            bail!("santree is quitting");
        }
        let _gate = self.gate.lock().await;
        // No link is not "no server": a reconnect in progress, a peer check that
        // timed out or a removed socket all leave a process alive that cannot be
        // asked. Only a free lock says nothing is there to stop; otherwise this
        // would report a stop that never happened and lose panes whose agents
        // are still running.
        if self.current.host.client().is_none()
            && probe_lock(&self.current.lock) == EndpointLock::Held
        {
            bail!("the santree server isn't reachable to be stopped");
        }
        // On an error it is still running (or not known to be gone), and left
        // to recover like any server that was never asked to stop.
        self.stop_current().await?;
        self.current.host.stop();
        self.current.terminals.lose_all();
        self.set_phase(Phase::Stopped);
        Ok(())
    }

    /// `Ok` once the phase is `Running`, else the reason it isn't.
    fn running_or_reason(&self) -> Result<()> {
        match self.phase() {
            Phase::Running(_) => Ok(()),
            Phase::Down(reason) | Phase::Failing(reason) => Err(anyhow!(reason)),
            _ => Err(anyhow!("the santree server didn't come up in time")),
        }
    }

    /// Ask the current server to stop and wait until it is gone.
    async fn stop_current(self: &Arc<Self>) -> Result<()> {
        self.set_phase(Phase::Stopping);
        let Some(client) = self.current.host.client() else {
            // Not connected: there is nothing of ours to ask. A server that is
            // running but unreachable is the next bring-up's to find.
            return Ok(());
        };
        // Its answer doesn't matter: whether it went does.
        let _ = tokio::time::timeout(CALL_WAIT, client.call::<m::ServerStop>(&Empty)).await;
        match stop_and_confirm(&self.current, self.stop_wait()).await {
            StopEnd::Gone => Ok(()),
            StopEnd::Answering => {
                self.set_phase(Phase::Down(
                    "the santree server didn't stop when asked".into(),
                ));
                bail!("the santree server didn't stop when asked");
            }
            StopEnd::Holding => {
                self.set_phase(Phase::Down(socket_gone(&self.current.lock)));
                bail!("the santree server didn't exit when asked");
            }
        }
    }

    fn stop_wait(&self) -> Duration {
        Duration::from_millis(self.stop_wait_ms.load(Ordering::SeqCst))
    }

    /// A server that is up and answering needs nothing: reconnecting it would
    /// drop every pane's link for no reason.
    fn healthy(&self) -> bool {
        matches!(self.phase(), Phase::Running(_))
            && matches!(self.host_status(), HostStatus::Connected { .. })
    }

    async fn bring_up_all(self: &Arc<Self>) {
        if self.healthy() {
            self.discover_legacy().await;
        } else {
            tokio::join!(self.bring_up(), self.discover_legacy());
        }
        self.discovered.send_replace(true);
        self.prune_old_installs().await;
    }

    /// Remove the install dirs of revisions that are over (see
    /// [`spawn::prune_old_revisions`]). After discovery, so the servers it kept
    /// draining are spared. A launch that failed to find a layout has none.
    async fn prune_old_installs(&self) {
        let Ok(layout) = self.layout.clone() else {
            return;
        };
        let keep: Vec<u32> = lock(&self.draining).keys().copied().collect();
        let current = self.revision;
        let _ = tokio::task::spawn_blocking(move || {
            spawn::prune_old_revisions(&layout, current, &keep)
        })
        .await;
    }

    /// Get the current server connected, launching it when nothing answers.
    async fn bring_up(self: &Arc<Self>) {
        let layout = match &self.layout {
            Ok(layout) => layout.clone(),
            Err(why) => {
                self.set_phase(Phase::Down(format!(
                    "can't find a place for the santree server: {why}"
                )));
                return;
            }
        };
        self.set_phase(Phase::Starting);
        {
            let layout = layout.clone();
            let prepared = tokio::task::spawn_blocking(move || layout.prepare()).await;
            if let Err(e) = prepared.map_err(anyhow::Error::from).and_then(|r| r) {
                self.set_phase(Phase::Down(format!(
                    "can't prepare the santree server's folders: {e:#}"
                )));
                return;
            }
        }
        // Listening before the host starts, so no connect is missed.
        self.start_monitor();
        self.current.terminals.watch();
        self.current.kick();

        match settle(&self.current.host, SETTLE).await {
            HostStatus::Connected { .. } => {}
            HostStatus::Down(ConnectError::NotRunning) => {
                // No socket is a dead server only if nothing holds its lock: a
                // live one behind a removed socket must not be launched over
                // (the new one would exit "occupied").
                if self.current.observe_absent() == Endpoint::Orphaned {
                    self.set_phase(Phase::Down(socket_gone(&self.current.lock)));
                    return;
                }
                if !self.launch(&layout).await {
                    return;
                }
            }
            // A peer check that ran out of time says nothing about the server;
            // it keeps running, and the host's next attempt (a few seconds on)
            // finds its answer cached. Wait for that rather than report Down.
            HostStatus::Down(ConnectError::Unverified { slow: true, .. }) => {}
            other => {
                self.down_for(other);
                return;
            }
        }
        // The monitor judges the connected server (`server.info`, keep-awake)
        // and says so by changing the phase.
        let mut phase = self.phase.subscribe();
        if tokio::time::timeout(VERDICT_WAIT, phase.wait_for(Phase::settled))
            .await
            .is_err()
        {
            match self.host_status() {
                HostStatus::Connected { .. } => self.set_phase(Phase::Down(
                    "the santree server connected but didn't answer in time".into(),
                )),
                other => self.down_for(other),
            }
        }
    }

    /// Down for the reason `status` gives. An untrusted server keeps being
    /// retried at the slow pace (it may be replaced); the rest are the user's
    /// to start again.
    fn down_for(&self, status: HostStatus) {
        if matches!(
            status,
            HostStatus::Connecting | HostStatus::Stopped | HostStatus::Connected { .. }
        ) {
            self.current.host.stop();
        }
        self.set_phase(Phase::Down(reason_of(&status)));
    }

    /// Install the bundled binary and start it; on success the host is
    /// connected, or this says why not. `false`: the phase is already `Down`.
    async fn launch(self: &Arc<Self>, layout: &Layout) -> bool {
        let Some(bundled) = self.cfg.bundled_binary.clone() else {
            self.current.host.stop();
            self.set_phase(Phase::Down(
                "this build has no santree server to start".into(),
            ));
            return false;
        };
        let spawned = {
            let (layout, bundled) = (layout.clone(), bundled.clone());
            tokio::task::spawn_blocking(move || -> Result<Option<Spawned>> {
                // A server that came up since the dial is not ours to replace
                // or duplicate: just connect to it.
                if spawn::install_binary(&layout, &bundled)?.is_none() {
                    return Ok(None);
                }
                spawn::spawn_server(&layout).map(Some)
            })
            .await
            .map_err(anyhow::Error::from)
            .and_then(|r| r)
        };
        let spawned = match spawned {
            Ok(spawned) => spawned,
            Err(e) => {
                self.current.host.stop();
                self.set_phase(Phase::Down(format!(
                    "can't start the santree server: {e:#}"
                )));
                return false;
            }
        };
        if let Some(mut spawned) = spawned {
            let started = spawned.start().await;
            let failure = match &started {
                Start::Ready { .. } => None,
                // The loser of a race: the winner holds the endpoint. With no
                // socket and nobody holding the lock exclusively, a process holds
                // it shared without serving, and every launch will lose to it.
                Start::Occupied
                | Start::Exited(ExitInfo {
                    code: Some(santree_server::EXIT_OCCUPIED),
                    ..
                }) => (!layout.socket_for(self.revision).exists()
                    && probe_lock(&self.current.lock) == EndpointLock::Free)
                    .then(|| lock_held_elsewhere(&self.current.lock)),
                Start::Exited(exit) => Some(exit.describe(&spawned.stderr_tail())),
                Start::TimedOut => Some(with_tail(
                    "the santree server didn't start in time",
                    &spawned.stderr_tail(),
                )),
                Start::Garbled => Some("the santree server answered its launcher oddly".into()),
            };
            *lock(&self.current.child) = Some(spawned);
            if let Some(reason) = failure {
                self.current.host.stop();
                self.set_phase(Phase::Down(reason));
                return false;
            }
        }
        // Ours, or someone else's: a server is on the socket whose sessions are
        // unknown to us. A connect that finds it gone says so again.
        self.current.observe_present();
        // A fresh backoff: the host has been failing to find it while it started.
        self.current.kick();
        match self.settle_started().await {
            HostStatus::Connected { .. } => true,
            // As in `bring_up`: a slow check is waited out, not reported.
            HostStatus::Down(ConnectError::Unverified { slow: true, .. }) => true,
            other => {
                if matches!(other, HostStatus::Down(ConnectError::NotRunning))
                    && self.current.observe_absent() == Endpoint::Orphaned
                {
                    self.set_phase(Phase::Down(socket_gone(&self.current.lock)));
                    return false;
                }
                self.down_for(other);
                false
            }
        }
    }

    /// [`settle`] after a launch, for the connection to the server that is
    /// now (or is about to be) on the socket. The loser of a launch race exits
    /// "occupied" before the winner has bound its socket: a dial in between finds
    /// nothing, with the winner's lock held. That is a server still starting, not
    /// one whose socket was removed, so a held lock is waited on — for as long as
    /// a connect attempt gets — before the absence is believed.
    async fn settle_started(&self) -> HostStatus {
        let deadline = Instant::now() + SETTLE;
        loop {
            let status = settle(&self.current.host, SETTLE).await;
            let not_yet = matches!(status, HostStatus::Down(ConnectError::NotRunning))
                && probe_lock(&self.current.lock) == EndpointLock::Held;
            if !not_yet || Instant::now() >= deadline {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    // ── watching the current server ────────────────────────────────────────

    fn start_monitor(self: &Arc<Self>) {
        if self.monitoring.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak: Weak<Self> = Arc::downgrade(self);
        let mut reconnected = self.current.host.reconnected();
        let mut status = self.current.host.status();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(HOUSEKEEPING);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            tick.tick().await;
            loop {
                tokio::select! {
                    got = reconnected.recv() => {
                        use tokio::sync::broadcast::error::RecvError;
                        if matches!(got, Err(RecvError::Closed)) {
                            return;
                        }
                        let Some(me) = weak.upgrade() else { return };
                        me.on_connected().await;
                    }
                    changed = status.changed() => {
                        if changed.is_err() {
                            return;
                        }
                        let now = status.borrow_and_update().clone();
                        let Some(me) = weak.upgrade() else { return };
                        me.on_status(now);
                    }
                    _ = tick.tick() => {
                        let Some(me) = weak.upgrade() else { return };
                        me.housekeeping().await;
                    }
                }
            }
        });
    }

    /// The current server's link came up: is it the server we meant, and what
    /// does it need told?
    async fn on_connected(self: &Arc<Self>) {
        let host = &self.current.host;
        let Some(client) = host.client() else {
            return;
        };
        self.current.observe_present();
        let info = match tokio::time::timeout(CALL_WAIT, client.call::<m::ServerInfo>(&Empty)).await
        {
            Ok(Ok(info)) => info,
            // The link dropped under the question: the next connect asks again.
            Ok(Err(e)) if e.is_disconnected() => return,
            Ok(Err(e)) => {
                self.set_phase(Phase::Down(format!(
                    "the santree server didn't answer server.info: {e}"
                )));
                return;
            }
            Err(_) => {
                self.set_phase(Phase::Down(
                    "the santree server didn't answer server.info in time".into(),
                ));
                return;
            }
        };
        if let Err(why) = check_info(&info, self.revision) {
            // Verified as the app's own server, but not the revision this build
            // runs: not a server to put new terminals on.
            host.stop();
            self.set_phase(Phase::Down(why));
            return;
        }
        // Applied on every connect: a server that outlived the app, and the
        // setting that changed while it was away.
        if let Err(e) = self.apply_keep_awake().await {
            log::warn!("santree server: keep-awake not applied: {e:#}");
        }
        self.set_phase(Phase::Running(running_of(&info)));
    }

    fn on_status(self: &Arc<Self>, status: HostStatus) {
        match status {
            HostStatus::Down(ConnectError::NotRunning) => {
                // A stop on purpose, the app going away, or a bring-up that is
                // already on it: the socket's absence is theirs to judge.
                if matches!(self.phase(), Phase::Stopping | Phase::Stopped)
                    || self.released.load(Ordering::SeqCst)
                    || self.gate.try_lock().is_err()
                {
                    return;
                }
                if self.current.observe_absent() == Endpoint::Orphaned {
                    // Alive behind a socket that is gone: no relaunch (it would
                    // find the endpoint occupied), no crash counted.
                    self.set_phase(Phase::Down(socket_gone(&self.current.lock)));
                    return;
                }
                // Its own task: the relaunch waits for the monitor to judge the
                // new connection, so it must not run on the monitor itself.
                let me = self.clone();
                tokio::spawn(async move { me.recover().await });
            }
            // The link dropped on a running server: reconnecting until it
            // answers, or turns out to be gone.
            HostStatus::Connecting if matches!(self.phase(), Phase::Running(_)) => {
                self.set_phase(Phase::Starting);
            }
            // A reconnect that fails for any other reason (the host answers
            // nothing, speaks another protocol, is refused) while nothing else
            // is working on it: say so, rather than read "starting" for good.
            // A slow peer check isn't a verdict; the host retries it itself.
            // (`try_lock` only asks whether a bring-up holds the gate; a later
            // event corrects a wrong guess.)
            HostStatus::Down(ConnectError::Unverified { slow: true, .. }) => {}
            HostStatus::Down(_) | HostStatus::VersionMismatch { .. }
                if matches!(self.phase(), Phase::Starting) && self.gate.try_lock().is_ok() =>
            {
                self.set_phase(Phase::Down(reason_of(&status)));
            }
            _ => {}
        }
    }

    /// The current server is gone without anyone asking: relaunch it, within
    /// the budget.
    async fn recover(self: &Arc<Self>) {
        let Ok(_gate) = self.gate.try_lock() else {
            // A bring-up, stop or restart is already on it.
            return;
        };
        if self.released.load(Ordering::SeqCst)
            || !matches!(self.phase(), Phase::Running(_) | Phase::Starting)
        {
            return;
        }
        // The event that brought us here may be old: act only on what is true now.
        if !matches!(
            self.host_status(),
            HostStatus::Down(ConnectError::NotRunning)
        ) {
            return;
        }
        if !lock(&self.budget).allow(Instant::now()) {
            self.current.host.stop();
            self.set_phase(Phase::Failing(format!(
                "the santree server stopped {} times in {} seconds; it won't be restarted automatically",
                CRASH_LIMIT + 1,
                CRASH_WINDOW.as_secs()
            )));
            return;
        }
        let exit = lock(&self.current.child)
            .as_ref()
            .and_then(Spawned::exit)
            .map(|e: ExitInfo| e.describe(""));
        log::warn!(
            "santree server: gone ({}); starting it again",
            exit.as_deref().unwrap_or("not a server this app launched")
        );
        self.bring_up().await;
    }

    /// Refresh the live-session counts and let go of drained servers.
    async fn housekeeping(self: &Arc<Self>) {
        // A server that was alive behind a removed socket: the host's repeated
        // failed dials publish no new status, so the lock is looked at again here.
        // Once nobody holds it the server really is gone, and what it held with it.
        if self.current.endpoint() == Endpoint::Orphaned
            && matches!(self.phase(), Phase::Down(_))
            && self.current.observe_absent() == Endpoint::Dead
        {
            self.set_phase(Phase::Down(
                "the santree server is gone; start it again".into(),
            ));
        }
        if matches!(self.phase(), Phase::Running(_)) {
            if let Some(client) = self.current.host.client() {
                if let Ok(Ok(info)) =
                    tokio::time::timeout(CALL_WAIT, client.call::<m::ServerInfo>(&Empty)).await
                {
                    if info.revision == self.revision && matches!(self.phase(), Phase::Running(_)) {
                        self.set_phase(Phase::Running(running_of(&info)));
                    }
                }
            }
        }
        self.sync_keep_awake().await;
        self.refresh_draining().await;
    }

    // ── older servers ───────────────────────────────────────────────────────

    /// Look for servers of older revisions on their sockets: one still holding
    /// sessions becomes a draining server (its panes keep working, it gets no
    /// new ones); one holding none is let go, and retires itself.
    ///
    /// Only an *older* server counts, at most [`LEGACY_MAX`] of them, and only in
    /// a run dir that is this user's own and private, with its lock file beside
    /// it: a socket (or, for a server whose socket was removed, a lock that is
    /// still held). The directory is the user's own, which a same-uid agent can
    /// write to: the names in it are only leads, nothing is trusted about them,
    /// and the connector's signature check on whoever answers is the real guard.
    async fn discover_legacy(self: &Arc<Self>) {
        let Ok(layout) = &self.layout else {
            return;
        };
        let mut found: BTreeMap<u32, PathBuf> = BTreeMap::new();
        for dir in layout.run_dirs() {
            // A dir that doesn't exist has nothing; one that exists must be ours
            // and private before its contents are believed. (`prepare_run_dir`
            // would create a missing one, which a scan must not.)
            if std::fs::symlink_metadata(dir).is_err() {
                continue;
            }
            if let Err(e) = endpoint::prepare_run_dir(dir) {
                log::warn!(
                    "santree server: not looking for older servers in {}: {e:#}",
                    dir.display()
                );
                continue;
            }
            for (revision, socket) in legacy_sockets(dir, self.revision) {
                found.entry(revision).or_insert(socket);
            }
        }
        // A problem is about a socket that was there: once the socket (and its
        // lock) is gone, so is the problem.
        lock(&self.untrusted).retain(|revision, _| found.contains_key(revision));
        lock(&self.unreachable).retain(|revision, _| found.contains_key(revision));
        let known: Vec<u32> = lock(&self.draining).keys().copied().collect();
        let pending = pick_legacy(found)
            .into_iter()
            .filter(|(revision, _)| !known.contains(revision))
            .map(|(revision, socket)| self.adopt_legacy(revision, socket));
        futures::future::join_all(pending).await;
    }

    /// Connect to the older server of `revision` and decide what it is.
    ///
    /// **Only a server known to hold nothing may be let go**: one whose socket
    /// refuses the connection (a stale file, so whatever it held is gone), or
    /// one that answered and listed no sessions. Anything else — a `hello` that
    /// timed out, a slow peer check, a listing that failed — is a server that
    /// may be running agents we can't see, and reading its silence as "they have
    /// exited" is how a conversation gets resumed twice. It is kept as a
    /// draining server with an unknown session count (so `complete()` stays
    /// false) and asked again until it answers, [`UNRESOLVED_BOUND`] at most.
    ///
    /// A peer that *fails* the check (not one that is slow) is something else
    /// bound to santree's socket name: not santree's server, so no session of
    /// santree's is on it. It is reported (in the diagnostics report)
    /// and does not hold liveness open — a squatter must not be able to wedge
    /// the app's picture of its own agents.
    async fn adopt_legacy(self: &Arc<Self>, revision: u32, socket: PathBuf) {
        enum Outcome {
            LetGo,
            Keep {
                known: Option<u32>,
                identity: Option<(u32, String)>,
            },
            Untrusted(String),
        }
        let slot = self.legacy_slot(revision, socket);
        slot.kick();
        let outcome = match settle(&slot.host, SETTLE).await {
            HostStatus::Connected { .. } => match held(&slot.host).await {
                Some(held) => {
                    if held.revision != revision {
                        log::warn!(
                            "santree server: the socket of r{revision} answered as r{}",
                            held.revision
                        );
                    }
                    if held.total > 0 {
                        Outcome::Keep {
                            known: Some(held.alive),
                            identity: Some((held.pid, held.version)),
                        }
                    } else {
                        Outcome::LetGo
                    }
                }
                None => Outcome::Keep {
                    known: None,
                    identity: None,
                },
            },
            // Nothing on the socket. Only a lock nobody holds makes that a dead
            // server: a held one is alive behind a socket that was removed.
            HostStatus::Down(ConnectError::NotRunning) => {
                if slot.observe_absent() == Endpoint::Orphaned {
                    Outcome::Keep {
                        known: None,
                        identity: None,
                    }
                } else {
                    Outcome::LetGo
                }
            }
            // Only a verdict makes it a squatter. A check that timed out,
            // blew up or couldn't read the peer (`Unverified`) says nothing, and
            // what answers may be the real server holding agents: keep it,
            // unknown.
            HostStatus::Down(ConnectError::Untrusted(why)) => Outcome::Untrusted(why),
            _ => Outcome::Keep {
                known: None,
                identity: None,
            },
        };
        // Whatever it was before, this look supersedes it.
        if !matches!(outcome, Outcome::Untrusted(_)) {
            lock(&self.untrusted).remove(&revision);
        }
        // It answered (or is gone for good): no longer "never answered". A silent
        // one stays reported until it speaks.
        if matches!(
            outcome,
            Outcome::LetGo | Outcome::Keep { known: Some(_), .. }
        ) {
            lock(&self.unreachable).remove(&revision);
        }
        match outcome {
            Outcome::Keep { known, identity } => {
                *lock(&slot.identity) = identity;
                if let Some(alive) = known {
                    slot.sessions.store(alive, Ordering::SeqCst);
                    slot.sessions_known.store(true, Ordering::SeqCst);
                }
                // After the decision, so a server that is let go never leaves a
                // watcher behind.
                slot.terminals.watch();
                lock(&self.draining).insert(revision, slot.clone());
                self.watch_draining(slot);
                log::info!(
                    "santree server: r{revision} is draining{}",
                    if known.is_some() {
                        ""
                    } else {
                        " (sessions unknown: it didn't answer)"
                    }
                );
                self.emit();
            }
            Outcome::LetGo => slot.host.stop(),
            Outcome::Untrusted(why) => {
                slot.host.stop();
                log::warn!("santree server: the socket of r{revision} is not santree's: {why}");
                lock(&self.untrusted).insert(revision, why);
            }
        }
    }

    /// Follow a draining server's link: the moment nothing answers on its
    /// socket it is dead, and everything the app held of it is lost — said to
    /// its panes before the slot is dropped, or they would never learn.
    fn watch_draining(self: &Arc<Self>, slot: Arc<Slot>) {
        let weak = Arc::downgrade(self);
        let mut status = slot.host.status();
        tokio::spawn(async move {
            loop {
                let now = status.borrow_and_update().clone();
                match now {
                    HostStatus::Down(ConnectError::NotRunning) => {
                        let Some(me) = weak.upgrade() else { return };
                        if slot.observe_absent() == Endpoint::Orphaned {
                            // Alive, its socket removed: still holding what it
                            // held, count unknown. The host keeps dialling, and
                            // the next look at the lock settles it.
                            slot.sessions_known.store(false, Ordering::SeqCst);
                            me.emit();
                        } else {
                            me.retire_draining(&slot);
                            return;
                        }
                    }
                    // Let go on purpose (`host.stop()`).
                    HostStatus::Stopped => return,
                    _ => {}
                }
                if status.changed().await.is_err() {
                    return;
                }
            }
        });
    }

    /// A draining server is dead (or given up on): everything the app held of
    /// it is lost — said to its panes before the slot is dropped, or they would
    /// never learn.
    fn retire_draining(&self, slot: &Slot) {
        slot.terminals.lose_all();
        slot.host.stop();
        lock(&self.draining).remove(&slot.revision);
        self.emit();
    }

    async fn refresh_draining(self: &Arc<Self>) {
        let slots: Vec<Arc<Slot>> = lock(&self.draining).values().cloned().collect();
        for slot in slots {
            if let Some(client) = slot.host.client() {
                if let Ok(Ok(sessions)) =
                    tokio::time::timeout(CALL_WAIT, client.pty_sessions()).await
                {
                    slot.observe_present();
                    let alive = sessions.iter().filter(|s| s.alive).count() as u32;
                    slot.sessions.store(alive, Ordering::SeqCst);
                    slot.sessions_known.store(true, Ordering::SeqCst);
                    if sessions.is_empty() {
                        // Nothing left in it: disconnecting is what lets it retire.
                        slot.host.stop();
                        lock(&self.draining).remove(&slot.revision);
                        log::info!("santree server: r{} drained", slot.revision);
                    }
                }
                continue;
            }
            // No socket is a dead server only if its lock is free.
            if matches!(
                slot.host.current_status(),
                HostStatus::Down(ConnectError::NotRunning)
            ) && slot.observe_absent() == Endpoint::Dead
            {
                self.retire_draining(&slot);
                log::info!("santree server: r{} is gone", slot.revision);
            } else if !slot.sessions_known.load(Ordering::SeqCst)
                && slot.endpoint() != Endpoint::Orphaned
                && lock(&slot.since).elapsed() > UNRESOLVED_BOUND
                // Silent is not gone: a server that still holds its lock is
                // running agents we can't see, so it stays a draining server of
                // unknown count — never "unreachable", which is for what has no
                // process behind it.
                && probe_lock(&slot.lock) == EndpointLock::Free
            {
                // Never answered: stop holding the app's picture open for it,
                // and say so.
                let why = format!(
                    "r{} never answered in {} minutes",
                    slot.revision,
                    UNRESOLVED_BOUND.as_secs() / 60
                );
                log::warn!("santree server: giving up on {why}");
                lock(&self.unreachable).insert(slot.revision, why);
                self.retire_draining(&slot);
            }
        }
        self.emit();
    }

    /// Stop a draining server and the sessions it still holds. The user's
    /// call, behind a confirm.
    ///
    /// The slot is dropped only once nothing answers on the socket and nothing
    /// holds its lock. A server that said yes and carried on, or one that can't
    /// be asked, stays — it is running — and this says so.
    pub async fn end_draining(&self, revision: u32) -> Result<()> {
        let slot = lock(&self.draining)
            .get(&revision)
            .cloned()
            .ok_or_else(|| anyhow!("no older santree server (r{revision}) is running"))?;
        let client = slot.host.client().ok_or_else(|| {
            anyhow!("the older santree server (r{revision}) isn't reachable to be stopped")
        })?;
        tokio::time::timeout(CALL_WAIT, client.call::<m::ServerStop>(&Empty))
            .await
            .map_err(|_| anyhow!("the older santree server didn't answer"))??;
        match stop_and_confirm(&slot, self.stop_wait()).await {
            StopEnd::Gone => {
                self.retire_draining(&slot);
                Ok(())
            }
            StopEnd::Answering => {
                bail!("the older santree server (r{revision}) didn't stop when asked")
            }
            StopEnd::Holding => {
                slot.sessions_known.store(false, Ordering::SeqCst);
                bail!("the older santree server (r{revision}) is still running")
            }
        }
    }

    // ── diagnostics ─────────────────────────────────────────────────────────

    /// What a bug report needs to know about the servers, as text: the state,
    /// each server's `server.info` (as it answers now), and the sockets that
    /// were refused or never answered. Bounded: each question waits at most
    /// [`CALL_WAIT`], and nothing here changes anything.
    pub async fn report(&self) -> String {
        use std::fmt::Write as _;
        let mut out = String::new();
        let status = self.status();
        let _ = writeln!(out, "mode: {:?}", self.cfg.mode);
        let _ = writeln!(out, "revision (this build): {}", self.revision);
        let _ = writeln!(out, "state: {:?}", status.state);
        let mut slots = vec![self.current.clone()];
        slots.extend(lock(&self.draining).values().cloned());
        for (i, slot) in slots.iter().enumerate() {
            let role = if i == 0 { "current" } else { "draining" };
            let _ = writeln!(out, "\nserver r{} ({role})", slot.revision);
            let _ = writeln!(out, "  link: {:?}", slot.host.current_status());
            let info = match slot.host.client() {
                Some(client) => {
                    match tokio::time::timeout(CALL_WAIT, client.call::<m::ServerInfo>(&Empty))
                        .await
                    {
                        Ok(Ok(info)) => format!("{info:?}"),
                        Ok(Err(e)) => format!("server.info failed: {e}"),
                        Err(_) => "server.info timed out".to_string(),
                    }
                }
                None => "not connected".to_string(),
            };
            let _ = writeln!(out, "  server.info: {info}");
        }
        for (revision, why) in self.untrusted_servers() {
            let _ = writeln!(out, "\nr{revision} refused (not santree's): {why}");
        }
        for (revision, why) in self.unreachable_servers() {
            let _ = writeln!(out, "\nr{revision} unreachable: {why}");
        }
        out
    }

    // ── keep-awake ──────────────────────────────────────────────────────────

    /// Tell the current server whether to hold the machine awake, per the
    /// app's setting. `None` when it isn't connected or doesn't offer it.
    pub async fn apply_keep_awake(&self) -> Result<Option<KeepAwakeResult>> {
        let on = (self.cfg.keep_awake)();
        let result = self.send_keep_awake(on).await?;
        if let Some(result) = &result {
            *lock(&self.keep_awake_sent) = Some(on);
            (self.cfg.keep_awake_held)(result.active);
        }
        Ok(result)
    }

    /// Tell the server again only if the app's hold differs from what the server
    /// was last told: the hold can change without the toggle command running
    /// (a restore, another window), and a server that came back from a reconnect
    /// is told on connect anyway. Cheap when nothing changed: no I/O.
    async fn sync_keep_awake(&self) {
        if !matches!(self.phase(), Phase::Running(_)) {
            return;
        }
        if *lock(&self.keep_awake_sent) == Some((self.cfg.keep_awake)()) {
            return;
        }
        if let Err(e) = self.apply_keep_awake().await {
            log::warn!("santree server: keep-awake not applied: {e:#}");
        }
    }

    async fn send_keep_awake(&self, on: bool) -> Result<Option<KeepAwakeResult>> {
        let host = &self.current.host;
        let (Some(client), Some(hello)) = (host.client(), host.hello()) else {
            return Ok(None);
        };
        if !hello.supports::<m::ServerKeepAwake>() {
            return Ok(None);
        }
        let result = tokio::time::timeout(
            CALL_WAIT,
            client.call::<m::ServerKeepAwake>(&KeepAwakeParams { on }),
        )
        .await
        .map_err(|_| anyhow!("the santree server didn't answer server.keepAwake"))??;
        Ok(Some(result))
    }
}

impl LocalHosts for LocalServers {
    fn current(&self) -> Option<RemoteTerminals> {
        match self.phase() {
            Phase::Starting | Phase::Stopping | Phase::Running(_) => {
                Some(self.current.terminals.clone())
            }
            Phase::Stopped | Phase::Down(_) | Phase::Failing(_) | Phase::Off => None,
        }
    }

    fn all(&self) -> Vec<RemoteTerminals> {
        if self.cfg.mode == Mode::Off {
            return Vec::new();
        }
        std::iter::once(self.current.terminals.clone())
            .chain(lock(&self.draining).values().map(|s| s.terminals.clone()))
            .collect()
    }

    fn adopt_ready(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if self.cfg.mode == Mode::Off {
                return;
            }
            let _ = tokio::time::timeout(ADOPT_WAIT, async {
                // Until the supervisor has an answer and has looked for older
                // servers. A host that is still being launched looks `Down` for a
                // moment, and so does one that failed a reconnect and will be
                // retried: only a `Down` that is *known* dead (nothing listens)
                // ends the wait early, because only then is there nothing to
                // adopt.
                let mut discovered = self.discovered.subscribe();
                let _ = discovered.wait_for(|d| *d).await;
                loop {
                    let phase = self.phase();
                    let settled = match &phase {
                        Phase::Running(_) | Phase::Off => true,
                        // Nothing to adopt: it is known dead, or alive behind a
                        // socket that is gone (and cannot be asked).
                        Phase::Stopped | Phase::Down(_) | Phase::Failing(_) => {
                            self.current.endpoint() != Endpoint::Unknown
                        }
                        Phase::Starting | Phase::Stopping => false,
                    };
                    if settled {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                let slots: Vec<RemoteTerminals> = if matches!(self.phase(), Phase::Running(_)) {
                    self.all()
                } else {
                    lock(&self.draining)
                        .values()
                        .map(|s| s.terminals.clone())
                        .collect()
                };
                futures::future::join_all(slots.iter().map(|t| t.adopt_ready())).await;
            })
            .await;
        })
    }

    fn complete(&self) -> bool {
        if self.cfg.mode == Mode::Off {
            return true;
        }
        let current = match self.phase() {
            Phase::Running(_) => matches!(self.host_status(), HostStatus::Connected { .. }),
            // Down for good with nothing listening: whatever it held is gone.
            Phase::Stopped | Phase::Down(_) | Phase::Failing(_) => {
                self.current.endpoint() == Endpoint::Dead
            }
            Phase::Starting | Phase::Stopping => false,
            Phase::Off => true,
        };
        current && lock(&self.draining).values().all(|s| s.dead_or_connected())
    }

    /// Disconnect from every server and stop relaunching; never stop one.
    fn release(&self) {
        self.released.store(true, Ordering::SeqCst);
        self.current.host.stop();
        for slot in lock(&self.draining).values() {
            slot.host.stop();
        }
    }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/// What a mode demands of the far end of the link: who the connector checks
/// for, and the least trust the host insists on before a byte is written. One
/// function so the two places that must agree — the connector and the host's
/// `require` — can't drift apart; a test pins the pairing.
fn trust_for(mode: Mode) -> (Expect, Required) {
    match mode {
        Mode::Signed { team } => (Expect::Team(team.to_string()), Required::Signed),
        Mode::OptIn | Mode::Off => (Expect::UidOnly, Required::UidOnly),
    }
}

/// A host + terminals over the socket of `revision`.
fn build_slot(cfg: &ServerConfig, revision: u32, socket: PathBuf, owner: &str) -> Arc<Slot> {
    let (expect, _) = trust_for(cfg.mode);
    build_slot_over(
        cfg,
        revision,
        &socket.clone(),
        Arc::new(ServerConnector::new(socket, expect)),
        owner,
    )
}

/// [`build_slot`] over a connector of the caller's (the tests').
fn build_slot_over(
    cfg: &ServerConfig,
    revision: u32,
    socket: &Path,
    connector: Arc<dyn Connector>,
    owner: &str,
) -> Arc<Slot> {
    let (_, requires) = trust_for(cfg.mode);
    let host = Arc::new(RemoteHost::new(
        connector,
        HostOptions {
            backoff_min: Duration::from_millis(250),
            backoff_max: Duration::from_secs(5),
            hello_timeout: Duration::from_secs(3),
            // A PTY-only server rejects `hooks.subscribe`; agent hooks reach
            // the app's DB through santree-hook, not this link.
            hooks: false,
            // Nothing is written to a host that falls short, `hello`
            // included; the terminals speak only over a link that passed.
            require: requires,
            client: ClientOptions::default(),
        },
    ));
    let terminals = RemoteTerminals::new(
        host.clone(),
        HostKey::Local { revision },
        cfg.ids.clone(),
        Profile::local_server(revision, cfg.retire.clone()),
    );
    Arc::new(Slot {
        revision,
        host,
        terminals,
        config: HostConfig {
            client: format!("santree/{}", env!("CARGO_PKG_VERSION")),
            owner: owner.to_string(),
            hook_cursor: None,
            boot_id: None,
        },
        child: Mutex::new(None),
        sessions: AtomicU32::new(0),
        sessions_known: AtomicBool::new(false),
        since: Mutex::new(Instant::now()),
        endpoint: Mutex::new(Endpoint::Unknown),
        lock: lock_beside(socket, revision),
        identity: Mutex::new(None),
    })
}

/// How a stop that was asked for ended.
enum StopEnd {
    /// Nothing answers and nothing holds its lock: gone, with all it held.
    Gone,
    /// It still answers on its socket.
    Answering,
    /// Its socket went quiet but its lock is held: it is still running (or
    /// still closing its sessions), and its sessions are not over.
    Holding,
}

/// After `server.stop` was sent to `slot`'s server: wait up to `wait` for its
/// link to find nothing to dial, as long again for its lock to be let go, and
/// record what that leaves. The socket going quiet alone is also what a removed
/// socket looks like: only a free lock makes it gone.
async fn stop_and_confirm(slot: &Slot, wait: Duration) -> StopEnd {
    let mut status = slot.host.status();
    // Scoped: the wait's `Ref` holds the status channel's read lock, which must
    // not be carried across an await (nor held while the host is stopped).
    let quiet = {
        // `Stopped`: a draining slot's watcher saw it go first and let go of it.
        let gone = tokio::time::timeout(
            wait,
            status.wait_for(|s| {
                matches!(
                    s,
                    HostStatus::Down(ConnectError::NotRunning) | HostStatus::Stopped
                )
            }),
        )
        .await;
        matches!(gone, Ok(Ok(_)))
    };
    if !quiet {
        return StopEnd::Answering;
    }
    wait_until_free(&slot.lock, wait).await;
    match slot.observe_absent() {
        Endpoint::Orphaned => StopEnd::Holding,
        Endpoint::Dead | Endpoint::Unknown => StopEnd::Gone,
    }
}

/// Why `status` is down, for the state the user reads.
fn reason_of(status: &HostStatus) -> String {
    match status {
        HostStatus::Down(ConnectError::Untrusted(why) | ConnectError::Unverified { why, .. }) => {
            why.clone()
        }
        HostStatus::Down(e) => format!("can't reach the santree server: {e}"),
        HostStatus::VersionMismatch { theirs } => format!(
            "the santree server speaks another protocol version{}",
            theirs.map_or(String::new(), |v| format!(" ({v})"))
        ),
        HostStatus::Connecting | HostStatus::Stopped | HostStatus::Connected { .. } => {
            "the santree server didn't answer in time".into()
        }
    }
}

/// The host's status once its current attempt has an outcome, or
/// `Connecting` if `within` ran out first.
async fn settle(host: &RemoteHost, within: Duration) -> HostStatus {
    let mut status = host.status();
    let _ = tokio::time::timeout(
        within,
        status.wait_for(|s| !matches!(s, HostStatus::Connecting)),
    )
    .await;
    host.current_status()
}

/// `server.info` answered the revision this build runs.
fn check_info(info: &ServerInfo, expected: u32) -> Result<(), String> {
    if info.revision == expected {
        Ok(())
    } else {
        Err("unexpected server revision".into())
    }
}

fn running_of(info: &ServerInfo) -> Running {
    Running {
        version: info.version.clone(),
        pid: info.pid,
        started_at_ms: info.started_at_ms as f64,
        live_sessions: u32::try_from(info.live_sessions).unwrap_or(u32::MAX),
    }
}

fn with_tail(what: &str, tail: &str) -> String {
    if tail.is_empty() {
        what.to_string()
    } else {
        format!("{what}: {tail}")
    }
}

/// What an older server holds: whose revision it says it is, and its sessions
/// (exited ones included: they carry rows to retire).
struct Held {
    revision: u32,
    pid: u32,
    version: String,
    alive: u32,
    total: usize,
}

async fn held(host: &RemoteHost) -> Option<Held> {
    let client: Arc<RemoteClient> = host.client()?;
    let info = tokio::time::timeout(CALL_WAIT, client.call::<m::ServerInfo>(&Empty))
        .await
        .ok()?
        .ok()?;
    let sessions = tokio::time::timeout(CALL_WAIT, client.pty_sessions())
        .await
        .ok()?
        .ok()?;
    Some(Held {
        revision: info.revision,
        pid: info.pid,
        version: info.version,
        alive: sessions.iter().filter(|s| s.alive).count() as u32,
        total: sessions.len(),
    })
}

/// The newest [`LEGACY_MAX`] of the older servers found.
fn pick_legacy(found: BTreeMap<u32, PathBuf>) -> Vec<(u32, PathBuf)> {
    found.into_iter().rev().take(LEGACY_MAX).collect()
}

/// The revision in a `server-r<N>.sock` file name.
fn parse_revision(name: &str) -> Option<u32> {
    plain_u32(name.strip_prefix("server-r")?.strip_suffix(".sock")?)
}

/// Older servers than `current` in `dir`, as `(revision, socket path)`: a plain
/// socket file with a `server-r<N>.lock` file beside it (a server that ever ran
/// holds one), and — for a server whose socket was removed by someone with the
/// user's uid — a plain lock that is still *held*, with the socket path it would
/// have had (the dial finds nothing, and the held lock says why).
fn legacy_sockets(dir: &Path, current: u32) -> Vec<(u32, PathBuf)> {
    use std::os::unix::fs::FileTypeExt;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: BTreeMap<u32, PathBuf> = BTreeMap::new();
    let mut locks: Vec<u32> = Vec::new();
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if let Some(revision) = parse_revision(&name).filter(|r| *r < current) {
            if kind.is_socket()
                && std::fs::symlink_metadata(dir.join(endpoint::lock_name(revision)))
                    .is_ok_and(|m| m.is_file())
            {
                found.insert(revision, entry.path());
            }
        } else if let Some(revision) = parse_lock_revision(&name).filter(|r| *r < current) {
            if kind.is_file() {
                locks.push(revision);
            }
        }
    }
    for revision in locks {
        if !found.contains_key(&revision)
            && probe_lock(&dir.join(endpoint::lock_name(revision))) == EndpointLock::Held
        {
            found.insert(revision, dir.join(endpoint::socket_name(revision)));
        }
    }
    found.into_iter().collect()
}

/// The revision in a `server-r<N>.lock` file name.
fn parse_lock_revision(name: &str) -> Option<u32> {
    plain_u32(name.strip_prefix("server-r")?.strip_suffix(".lock")?)
}

#[cfg(test)]
mod tests;
