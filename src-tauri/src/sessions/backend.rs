//! The one handle the commands hold for terminals: [`Terminals`].
//!
//! A pane's process is in this app (`PtyManager`), on a local santree server,
//! or on Daedalus; the facade is where that stops mattering. Every operation
//! on an existing pane asks one question — where does this id live
//! ([`Terminals::target`]) — and then does the same thing wherever that is.
//! New panes name their own route ([`Route`]): the caller knows whether a
//! directory is a Daedalus project's.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use futures::future::BoxFuture;

use santree_pty::{Anchor, OpenOpts, PtyManager, ReplayMode};
use santree_remote_client::proto::{Anchor as WireAnchor, ReplayMode as WireMode};

use super::ids::{HostKey, IdRegistry};
use super::remote::RemoteTerminals;
use super::{Attached, LiveTerminal, Liveness, PaneId, Sinks, Spec, CONNECT_WAIT};
use crate::terminal::{AdoptedSession, Keystrokes, LaunchLine, PtyInput, TerminalSession};

/// How long adopting waits for a local server that is still coming up before
/// answering with what it has.
const ADOPT_WAIT: Duration = Duration::from_secs(10);

/// The longest a read of the local servers (`liveness`, `snapshot`,
/// `local_sessions`) may take. Each is polled at the rate the UI refreshes
/// agent state, and a server that is stopped (SIGSTOP) or wedged answers
/// nothing: the read gives up with what is known, flagged incomplete, so a stuck
/// server can never stall the commands that ask. A little over the per-host
/// listing bound ([`super::remote::Timing`]) it sits on top of.
const READ_DEADLINE: Duration = Duration::from_secs(4);

/// The longest launch line santree will type into a Daedalus terminal, whose
/// tty is the box's Linux one (`N_TTY_BUF_SIZE` 4096, halved by the same
/// reasoning as the local cap).
const REMOTE_SEED_CAP: usize = 2048;

/// Where a new pane's process goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// This Mac: in-app, or on the local server, whichever [`Local`] is.
    Local,
    /// A Daedalus project's checkout — a path on the server, never on this Mac.
    Daedalus,
}

/// The local servers behind [`Local::Server`]: the one new panes go to, and any
/// older ones still holding sessions. Implemented by the app's server module;
/// defined here so the facade can be tested without one.
pub trait LocalHosts: Send + Sync {
    /// The server new panes open on, when there is one right now.
    fn current(&self) -> Option<RemoteTerminals>;
    /// Every server holding panes, the current one included.
    fn all(&self) -> Vec<RemoteTerminals>;
    /// Resolves once every server has handed over what it holds, or is known
    /// to be down. Unbounded; the caller bounds it.
    fn adopt_ready(&self) -> BoxFuture<'_, ()>;
    /// Whether what [`LocalHosts::all`] says is the whole of what is running:
    /// false while a server that may hold sessions can't be reached.
    fn complete(&self) -> bool;
    /// The app is going away: let go of the servers, leaving them running.
    fn release(&self);
}

/// Where this Mac's own terminals run.
pub enum Local {
    /// In this process. They die with it.
    InApp(PtyManager),
    /// On a local santree server. They outlive it.
    Server(Arc<dyn LocalHosts>),
}

/// How a launch line may be prepared for a pane's tty.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeedPolicy {
    /// A local tty: a long line is spilled to a private script and a short
    /// reference typed instead.
    Spill,
    /// A tty that isn't this Mac's: a line over this many bytes is refused,
    /// never truncated and never spilled to a file the host can't see.
    Cap(usize),
}

/// What the Terminal settings panel lists.
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub sessions: Vec<TerminalSession>,
    /// False when a server that may hold more couldn't be asked.
    pub complete: bool,
}

/// The directories live panes run in, by host. See [`Terminals::live_cwds`].
#[derive(Debug, Clone, Default)]
pub struct LiveCwds {
    pub local: Vec<String>,
    pub daedalus: Vec<String>,
    pub complete: bool,
}

/// What an id resolved to.
enum Target {
    InApp(PtyManager),
    Remote(RemoteTerminals),
    /// A remote pane that is over (or whose host is gone): there is no such
    /// session, which a close or a detach of it has nothing left to do about.
    Ended,
    /// Nothing runs this id: an in-app-range id in server mode.
    Missing,
}

pub struct Terminals {
    ids: Arc<IdRegistry>,
    local: Local,
    daedalus: RemoteTerminals,
    read_deadline: Duration,
}

impl Terminals {
    pub fn new(local: Local, daedalus: RemoteTerminals, ids: Arc<IdRegistry>) -> Self {
        Self {
            ids,
            local,
            daedalus,
            read_deadline: READ_DEADLINE,
        }
    }

    /// These terminals with their own bound on a read of the local servers.
    #[cfg(test)]
    pub fn with_read_deadline(mut self, deadline: Duration) -> Self {
        self.read_deadline = deadline;
        self
    }

    /// `read`, or `otherwise` if it takes longer than the read deadline.
    async fn bounded<T>(&self, what: &str, read: impl Future<Output = T>, otherwise: T) -> T {
        match tokio::time::timeout(self.read_deadline, read).await {
            Ok(answer) => answer,
            Err(_) => {
                log::warn!(
                    "reading {what} from the santree server took over {:?}; answering with what is known",
                    self.read_deadline
                );
                otherwise
            }
        }
    }

    /// The one place an id becomes a host: the in-app manager for its own
    /// range, else whichever remote host holds the pane.
    fn target(&self, id: PaneId) -> Target {
        if !self.ids.minted(id) {
            return match &self.local {
                Local::InApp(manager) => Target::InApp(manager.clone()),
                Local::Server(_) => Target::Missing,
            };
        }
        if self.daedalus.holds(id) {
            return Target::Remote(self.daedalus.clone());
        }
        let local = match &self.local {
            Local::Server(hosts) => hosts.all().into_iter().find(|host| host.holds(id)),
            Local::InApp(_) => None,
        };
        local.map_or(Target::Ended, Target::Remote)
    }

    fn no_session(id: PaneId) -> anyhow::Error {
        anyhow!("no terminal session {id}")
    }

    /// Open a pane running `spec` on `route`. A refusal by the host is this
    /// call's error; a host that can't be reached right now leaves a Daedalus
    /// pane waiting, `Reconnecting`, to open on the next connect.
    ///
    /// The facade's arms are the sanctioned callers of the hosts' lifecycle
    /// methods (clippy.toml): this, [`Terminals::close`], [`Terminals::attach`]
    /// and [`Terminals::adopt`].
    #[allow(clippy::disallowed_methods)]
    pub async fn open(
        &self,
        route: Route,
        spec: Spec,
        owner: String,
        size: (u16, u16),
        sinks: Sinks,
    ) -> Result<PaneId> {
        let remote = match (route, &self.local) {
            (Route::Daedalus, _) => self.daedalus.clone(),
            (Route::Local, Local::Server(hosts)) => hosts
                .current()
                .ok_or_else(|| anyhow!("the santree server isn't running"))?,
            (Route::Local, Local::InApp(manager)) => {
                let opts = OpenOpts {
                    cwd: spec.cwd,
                    command: spec.command,
                    args: spec.args,
                    cols: size.0,
                    rows: size.1,
                    env: spec.env,
                    // It inherits this process's environment ambiently.
                    base_env: Vec::new(),
                    owner,
                    label: spec.label,
                    agent_kind: spec.agent_kind,
                };
                let manager = manager.clone();
                let output = sinks.output;
                return tokio::task::spawn_blocking(move || {
                    manager.open(opts, move |bytes| output(bytes))
                })
                .await?;
            }
        };
        let client = remote.client_within(CONNECT_WAIT).await;
        remote.open(spec, owner, size, client, sinks).await
    }

    /// The user's keystrokes, verbatim.
    pub fn write(&self, id: PaneId, keys: Keystrokes) -> Result<()> {
        match self.target(id) {
            Target::InApp(manager) => write_in_app(&manager, id, keys.into()),
            Target::Remote(remote) => remote.write(id, keys),
            Target::Ended | Target::Missing => Err(Self::no_session(id)),
        }
    }

    /// The one launch line, with its Enter. A remote pane types it only into a
    /// session it opened itself.
    pub fn seed(&self, id: PaneId, line: LaunchLine) -> Result<()> {
        match self.target(id) {
            Target::InApp(manager) => write_in_app(&manager, id, line.into()),
            Target::Remote(remote) => remote.seed(id, line),
            Target::Ended | Target::Missing => Err(Self::no_session(id)),
        }
    }

    /// Whether a launch line for `id` would be typed — asked before preparing
    /// one, so a seed that will be refused leaves nothing behind.
    pub fn seed_wanted(&self, id: PaneId) -> bool {
        match self.target(id) {
            Target::InApp(manager) => manager.sessions().iter().any(|s| s.id == id),
            Target::Remote(remote) => remote.seed_wanted(id),
            Target::Ended | Target::Missing => false,
        }
    }

    /// How a launch line for `id` is prepared: capped on Daedalus, spilled on
    /// this Mac. A pane that is over is neither's; it is spilled, which
    /// prepares nothing — [`Terminals::seed_wanted`] refuses it first, as "no
    /// terminal session", without blaming a host it never ran on.
    pub fn seed_policy(&self, id: PaneId) -> SeedPolicy {
        if self.ids.minted(id) && self.daedalus.holds(id) {
            SeedPolicy::Cap(REMOTE_SEED_CAP)
        } else {
            SeedPolicy::Spill
        }
    }

    pub fn resize(&self, id: PaneId, cols: u16, rows: u16) -> Result<()> {
        match self.target(id) {
            Target::InApp(manager) => manager.resize(id, cols, rows),
            Target::Remote(remote) => remote.resize(id, cols, rows),
            Target::Ended | Target::Missing => Err(Self::no_session(id)),
        }
    }

    /// End a pane's process. A remote one as soon as its host can be told.
    #[allow(clippy::disallowed_methods)]
    pub fn close(&self, id: PaneId) -> Result<()> {
        match self.target(id) {
            Target::InApp(manager) => manager.close(id),
            Target::Remote(remote) => {
                remote.close(id);
                Ok(())
            }
            // Already over: closing it again is what the caller wanted.
            Target::Ended => Ok(()),
            Target::Missing => Err(Self::no_session(id)),
        }
    }

    /// Stop delivering a pane's output without ending it.
    pub fn detach(&self, id: PaneId) {
        match self.target(id) {
            Target::InApp(manager) => manager.detach(id),
            Target::Remote(remote) => remote.detach(id),
            Target::Ended | Target::Missing => {}
        }
    }

    /// Point `id`'s output at `sinks` and catch it up from `anchor`. For an
    /// in-app pane the catch-up is written before anything else the new sink is
    /// handed meanwhile, so the pane reads it first and an exit last.
    #[allow(clippy::disallowed_methods)]
    pub async fn attach(&self, id: PaneId, anchor: Anchor, sinks: Sinks) -> Result<Attached> {
        match self.target(id) {
            Target::InApp(manager) => {
                let replay = attach_in_order(&manager, id, &anchor, sinks)?;
                Ok(Attached {
                    epoch: replay.epoch,
                    seq: replay.seq,
                    mode: match replay.mode {
                        ReplayMode::Exact => WireMode::Exact,
                        ReplayMode::Tail => WireMode::Tail,
                        ReplayMode::Reanchor => WireMode::Reanchor,
                    },
                })
            }
            Target::Remote(remote) => remote.attach(id, wire(anchor), sinks).await,
            Target::Ended | Target::Missing => Err(Self::no_session(id)),
        }
    }

    /// Claim the panes an earlier page load left running, and say which they
    /// are. On a local server, first waits (bounded) for it to hand over what
    /// it holds, so a relaunch restores every session and not just the ones a
    /// view already asked for.
    #[allow(clippy::disallowed_methods)]
    pub async fn adopt(&self, owner: &str) -> Vec<AdoptedSession> {
        let mut adopted = Vec::new();
        match &self.local {
            Local::InApp(manager) => {
                adopted.extend(manager.adopt_others(owner).into_iter().map(|info| {
                    AdoptedSession {
                        id: info.id,
                        label: info.label,
                        agent_kind: info.agent_kind,
                        cwd: info.cwd,
                        command: info.command,
                    }
                }));
            }
            Local::Server(hosts) => {
                if tokio::time::timeout(ADOPT_WAIT, hosts.adopt_ready())
                    .await
                    .is_err()
                {
                    log::warn!("the santree server hadn't handed over its sessions in time");
                }
                for host in hosts.all() {
                    adopted.extend(host.adopt(owner));
                }
            }
        }
        adopted.extend(self.daedalus.adopt(owner));
        adopted
    }

    /// This Mac's sessions, for the Terminal settings panel. Daedalus's are
    /// its own to list.
    pub async fn snapshot(&self) -> Snapshot {
        match &self.local {
            Local::InApp(manager) => Snapshot {
                sessions: manager
                    .sessions()
                    .into_iter()
                    .map(|info| terminal_session(info, None))
                    .collect(),
                complete: true,
            },
            Local::Server(hosts) => {
                // Each host within its own bound: one that is wedged answers `None`
                // (the whole incomplete) and the others' answers stand.
                let mut snapshot = Snapshot {
                    sessions: Vec::new(),
                    complete: hosts.complete(),
                };
                for (revision, answer) in self.held_by_host(hosts).await {
                    match answer {
                        Some(held) => snapshot.sessions.extend(
                            held.into_iter()
                                .map(|info| terminal_session(info, revision)),
                        ),
                        None => snapshot.complete = false,
                    }
                }
                snapshot
            }
        }
    }

    /// What each local host holds, every one asked at once and none for longer
    /// than the read deadline: `None` for a host that couldn't be asked in time.
    /// Each session under its pane's id, beside its server's revision.
    async fn held_by_host(
        &self,
        hosts: &Arc<dyn LocalHosts>,
    ) -> Vec<(Option<u32>, Option<Vec<santree_pty::SessionInfo>>)> {
        futures::future::join_all(hosts.all().into_iter().map(|host| async move {
            let revision = match host.key() {
                HostKey::Local { revision } => Some(revision),
                HostKey::Daedalus => None,
            };
            let held = self
                .bounded("the server's sessions", host.held_sessions(), None)
                .await;
            let held = held.map(|held| {
                held.into_iter()
                    .map(|(id, info)| pty_info(id, info))
                    .collect()
            });
            (revision, held)
        }))
        .await
    }

    /// Pane `id`'s address (term key and provider) and the directory it was
    /// opened in, from the host that runs it — never from IPC, which could name
    /// another surface's terminal. What re-wraps a pane's exit retirement when
    /// its view re-attaches.
    pub fn address(&self, id: PaneId) -> Option<(LiveTerminal, Option<String>)> {
        match self.target(id) {
            Target::InApp(manager) => {
                manager
                    .sessions()
                    .into_iter()
                    .find(|s| s.id == id)
                    .map(|s| {
                        (
                            LiveTerminal {
                                term_key: s.label,
                                agent_kind: s.agent_kind,
                            },
                            s.cwd,
                        )
                    })
            }
            Target::Remote(remote) => remote.address(id),
            Target::Ended | Target::Missing => None,
        }
    }

    /// This Mac's sessions with their process ids, for the readers that walk
    /// the host's process table from each pane's root (resource accounting,
    /// agent detection). Under a server the pids are the server's children, not
    /// this app's.
    pub async fn local_sessions(&self) -> Vec<santree_pty::SessionInfo> {
        match &self.local {
            Local::InApp(manager) => manager.sessions(),
            Local::Server(hosts) => {
                // A host that can't be asked contributes nothing: these are
                // display and identity reads, never a liveness verdict.
                self.held_by_host(hosts)
                    .await
                    .into_iter()
                    .flat_map(|(_, held)| held.unwrap_or_default())
                    .collect()
            }
        }
    }

    /// Which panes have a live process, and whether that is everything. An
    /// in-app answer is a live read of the manager and always complete; a
    /// server's is as complete as the server could be asked.
    pub async fn liveness(&self) -> Liveness {
        let mut all = match &self.local {
            Local::InApp(manager) => Liveness {
                live: manager
                    .sessions()
                    .into_iter()
                    .filter(|s| s.alive)
                    .map(|s| LiveTerminal {
                        term_key: s.label,
                        agent_kind: s.agent_kind,
                    })
                    .collect(),
                complete: true,
            },
            Local::Server(hosts) => {
                // Each host within its own bound: one that never answers
                // contributes nothing and makes the whole incomplete — its agents
                // keep their state, and no resume is allowed — while the others'
                // answers stand.
                let asked =
                    futures::future::join_all(hosts.all().into_iter().map(|host| async move {
                        self.bounded(
                            "the server's liveness",
                            host.liveness(),
                            Liveness {
                                live: Default::default(),
                                complete: false,
                            },
                        )
                        .await
                    }));
                let mut all = Liveness {
                    live: Default::default(),
                    complete: hosts.complete(),
                };
                for answer in asked.await {
                    all.merge(answer);
                }
                all
            }
        };
        all.merge(self.daedalus.liveness().await);
        all
    }

    /// Where every live pane was opened, this Mac's apart from Daedalus's (a
    /// server path can share its spelling with a local one), and whether that
    /// is every pane there is. What refuses forgetting a project something still
    /// runs in: an incomplete answer can't say that nothing does.
    pub async fn live_cwds(&self) -> LiveCwds {
        let local = self.snapshot().await;
        let daedalus = self.daedalus.liveness().await;
        LiveCwds {
            local: local
                .sessions
                .into_iter()
                .filter(|s| s.alive)
                .filter_map(|s| s.cwd)
                .collect(),
            daedalus: self.daedalus.live_cwds(),
            complete: local.complete && daedalus.complete,
        }
    }

    /// How many of this Mac's terminals quitting the app would end: the live
    /// in-app ones. With a local server the answer is none — quitting only lets
    /// go of it, and every session keeps running (docs/server.md). What the quit
    /// guard warns about.
    pub fn ends_on_quit(&self) -> u32 {
        match &self.local {
            Local::InApp(manager) => manager.sessions().iter().filter(|s| s.alive).count() as u32,
            Local::Server(_) => 0,
        }
    }

    /// The app is exiting or updating. In-app terminals end with it; a server's
    /// are let go and keep running — quitting never stops them.
    pub fn release(&self) {
        match &self.local {
            Local::InApp(manager) => manager.close_all(),
            Local::Server(hosts) => hosts.release(),
        }
    }
}

/// A host's record of a session, as this Mac's own PTY layer names one: the
/// same fields, under the pane's app-side id.
fn pty_info(
    id: PaneId,
    info: santree_remote_client::proto::SessionInfo,
) -> santree_pty::SessionInfo {
    santree_pty::SessionInfo {
        id,
        pid: info.pid,
        cwd: info.cwd,
        command: info.command,
        owner: info.owner,
        label: info.label,
        agent_kind: info.agent_kind,
        cols: info.cols,
        rows: info.rows,
        attached: info.attached,
        alive: info.alive,
        epoch: info.epoch,
    }
}

/// A session as the Terminal settings panel lists it.
fn terminal_session(
    info: santree_pty::SessionInfo,
    server_revision: Option<u32>,
) -> TerminalSession {
    TerminalSession {
        server_revision,
        id: info.id,
        label: info.label,
        cwd: info.cwd,
        command: info.command,
        pid: info.pid,
        cols: info.cols,
        rows: info.rows,
        attached: info.attached,
        alive: info.alive,
    }
}

fn wire(anchor: Anchor) -> WireAnchor {
    match anchor {
        Anchor::At { epoch, seq } => WireAnchor::At { epoch, seq },
        Anchor::Fresh => WireAnchor::Fresh,
        Anchor::Unknown => WireAnchor::Unknown,
    }
}

/// The one place bytes enter an in-app PTY: the sanctioned exception to
/// clippy.toml's `PtyManager::write` rule, taking only a [`PtyInput`].
#[allow(clippy::disallowed_methods)]
fn write_in_app(manager: &PtyManager, id: PaneId, input: PtyInput) -> Result<()> {
    manager.write(id, input.as_bytes())
}

/// Attach an in-app session with a sink into `sinks`, and write its replay to
/// `sinks.output` ahead of anything the sink is handed meanwhile.
fn attach_in_order(
    manager: &PtyManager,
    id: PaneId,
    anchor: &Anchor,
    sinks: Sinks,
) -> Result<santree_pty::Replay> {
    hold_back(&sinks.output, |forward| manager.attach(id, anchor, forward))
}

type OutputForward = Box<dyn Fn(Vec<u8>) + Send + Sync>;

/// Run `attach` with a sink into `output`, and write its replay to `output`
/// ahead of anything that sink is handed meanwhile.
///
/// Output the new sink is handed before the replay is sent — a chunk racing
/// the attach, or the exit of a session that already ended, which the manager
/// sends from inside `attach` — waits here, so the pane reads the catch-up
/// first and the exit last. A failed attach sends nothing. The replay comes
/// back with its bytes taken: they are on the channel already.
fn hold_back(
    output: &Arc<dyn Fn(Vec<u8>) + Send + Sync>,
    attach: impl FnOnce(OutputForward) -> Result<santree_pty::Replay>,
) -> Result<santree_pty::Replay> {
    use std::sync::Mutex;
    let held: Arc<Mutex<Option<Vec<Vec<u8>>>>> = Arc::new(Mutex::new(Some(Vec::new())));
    let forward: OutputForward = {
        let output = output.clone();
        let held = held.clone();
        Box::new(move |bytes: Vec<u8>| {
            let mut held = held.lock().unwrap_or_else(|e| e.into_inner());
            match held.as_mut() {
                Some(pending) => pending.push(bytes),
                None => output(bytes),
            }
        })
    };
    let mut replay = attach(forward)?;
    let mut held = held.lock().unwrap_or_else(|e| e.into_inner());
    // Never send an empty chunk: empty is the exit sentinel, and an `Exact`
    // attach with no gap (or any `Reanchor`) legitimately has nothing to write.
    let bytes = std::mem::take(&mut replay.bytes);
    if !bytes.is_empty() {
        output(bytes);
    }
    for bytes in held.take().unwrap_or_default() {
        output(bytes);
    }
    Ok(replay)
}

#[cfg(test)]
mod hold_back_tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Duration;

    type Sent = Arc<Mutex<Vec<Vec<u8>>>>;
    type Output = Arc<dyn Fn(Vec<u8>) + Send + Sync>;

    /// A sink whose messages land in a list, in send order.
    fn recording_sink() -> (Output, Sent) {
        let got: Sent = Arc::default();
        let into = got.clone();
        (Arc::new(move |bytes| into.lock().unwrap().push(bytes)), got)
    }

    fn replay_of(bytes: &[u8]) -> santree_pty::Replay {
        santree_pty::Replay {
            mode: ReplayMode::Tail,
            epoch: "e".into(),
            seq: bytes.len() as u64,
            bytes: bytes.to_vec(),
        }
    }

    /// The pane reads the catch-up first. What the new sink is handed while
    /// the attach runs — a chunk racing it, or the exit `PtyManager::attach`
    /// sends a session that already ended — follows the replay, in order, and
    /// what comes after the attach goes straight through behind it.
    #[test]
    fn an_attach_writes_its_catch_up_before_what_reached_it_meanwhile() {
        let (output, got) = recording_sink();
        let sink: Arc<Mutex<Option<OutputForward>>> = Arc::default();
        let replay = hold_back(&output, |forward| {
            forward(b"raced".to_vec());
            *sink.lock().unwrap() = Some(forward);
            Ok(replay_of(b"caught up"))
        })
        .expect("attach");
        assert!(
            replay.bytes.is_empty(),
            "the replay's bytes went to the channel"
        );
        (sink.lock().unwrap().as_ref().unwrap())(b"live".to_vec());
        (sink.lock().unwrap().as_ref().unwrap())(Vec::new());
        assert_eq!(
            *got.lock().unwrap(),
            vec![
                b"caught up".to_vec(),
                b"raced".to_vec(),
                b"live".to_vec(),
                Vec::new()
            ]
        );

        // An owed exit, sent from inside the attach, is the last thing read.
        let (output, got) = recording_sink();
        hold_back(&output, |forward| {
            forward(Vec::new());
            Ok(replay_of(b"the end of it"))
        })
        .expect("attach");
        assert_eq!(
            *got.lock().unwrap(),
            vec![b"the end of it".to_vec(), Vec::new()]
        );

        // Nothing to catch up on sends no chunk: empty is the exit sentinel.
        let (output, got) = recording_sink();
        hold_back(&output, |_| Ok(replay_of(b""))).expect("attach");
        assert!(got.lock().unwrap().is_empty());

        // A failed attach sends nothing, even what its sink was handed.
        let (output, got) = recording_sink();
        assert!(hold_back(&output, |forward| {
            forward(b"stray".to_vec());
            Err(anyhow!("no terminal session 9"))
        })
        .is_err());
        assert!(got.lock().unwrap().is_empty());
    }

    /// The same against a reader still running when the attach returns: the
    /// replay, then every chunk once and in order, wherever the hand-over
    /// from holding to sending fell.
    #[test]
    fn a_reader_running_across_the_attach_stays_in_order_behind_the_replay() {
        let (output, got) = recording_sink();
        let mut reader = None;
        hold_back(&output, |forward| {
            reader = Some(std::thread::spawn(move || {
                for i in 0..2000u32 {
                    forward(i.to_string().into_bytes());
                }
            }));
            std::thread::sleep(Duration::from_millis(1));
            Ok(replay_of(b"caught up"))
        })
        .expect("attach");
        reader.unwrap().join().expect("reader");
        let mut want = vec![b"caught up".to_vec()];
        want.extend((0..2000u32).map(|i| i.to_string().into_bytes()));
        assert_eq!(*got.lock().unwrap(), want);
    }
}
