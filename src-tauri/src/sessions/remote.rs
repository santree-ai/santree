//! Terminals whose process runs on a session host rather than in this one:
//! the panes of a Daedalus project, and the panes of a local santree server.
//! Each is a PTY on the host reached through a link (docs/remote.md, "Terminals
//! on the box"; docs/terminals.md, "Remote sessions"; docs/server.md).
//!
//! The frontend sees the same terminal it always does — an id, a byte channel,
//! attach/detach — and one more signal, [`PaneLink`]: whether the pane is
//! reaching its session right now. One [`RemoteTerminals`] per host; what
//! differs between hosts is a [`Profile`], never a branch on which host it is:
//!
//! - **Ids.** A pane is named by an app-side id from the app's one
//!   [`IdRegistry`] counter, unique across hosts, so a command handed only an id
//!   finds the host that holds it ([`RemoteTerminals::holds`]). The host's own
//!   session id is bound to it once opened (or found).
//! - **Boots.** A host numbers its sessions from 1 on every start. A pane
//!   therefore remembers the `bootId` it bound under, and a host that answers
//!   with another one is not the host the pane's session lived on: the pane is
//!   [`PaneLink::Lost`], and nothing is attached — id 1 there is a stranger.
//! - **Anchors.** Every byte forwarded advances the pane's anchor; a link that
//!   drops leaves the pane `Reconnecting` (never exited — only `pty.exit`, or a
//!   host that no longer has the session, ends one), and every [`Reconnected`]
//!   re-attaches it with that anchor, so the host replays exactly what was
//!   missed.
//! - **Finding a session again.** A pane with nothing bound — opened while the
//!   link was down, or after santree was relaunched — looks for a live session
//!   on the host with its own address (label and provider, `pty.sessions`)
//!   before opening a new one. That is what makes a remote pane survive
//!   santree quitting: the process never stopped, and the new app finds it by
//!   the same identity the old one opened it under.
//! - **Adopting everything.** A host that outlives the app by design (the local
//!   server) is asked, on its first connect per boot, for every session it
//!   holds: each live one becomes a pane no view is showing yet, so a relaunch
//!   restores agents in worktrees nobody has opened; each one that exited while
//!   the app was away is handed to [`Profile::on_exited`] and closed.
//! - **Order.** The network half of attach, detach and close runs one at a time
//!   per pane (`turn`), so the host sees them in the order they were asked;
//!   keystrokes go through one writer per pane, coalesced, in order. Input
//!   typed while the pane can't reach its session is dropped, never replayed
//!   later into whatever the program is doing by then.
//!
//! [`Reconnected`]: santree_remote_client::Reconnected

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use futures::future::BoxFuture;
use tokio::sync::{broadcast, mpsc, watch};

use santree_core::domain::AgentKind;
use santree_remote_client::proto::{
    feature, Anchor, ErrorCode, HelloResult, PtyOpenParams, ReplayMode, SessionId as BoxSessionId,
    SessionInfo,
};
use santree_remote_client::{HostStatus, PtyEvent, RemoteClient, RemoteError, RemoteHost};

use super::ids::{HostKey, IdRegistry};
use super::{Attached, EnvVars, LiveTerminal, Liveness, PaneId, PaneLink, Sinks, Spec};
use crate::terminal::{AdoptedSession, Keystrokes, LaunchLine, PtyInput};

/// What a host does to a pane whose session it no longer has.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gone {
    /// The process is gone and the pane is over: the exit sentinel closes its
    /// tab. Daedalus — a box that lost a session lost it for good, and the
    /// agent's own state says so.
    End,
    /// The pane stays, [`PaneLink::Lost`], saying why. A local server that was
    /// stopped or killed took its agents with it, and the tab is where the user
    /// resumes them — a human's click, never santree's.
    Lost,
}

/// A session that ended while no app was attached to hear it: what its rows
/// are retired by (`hooks::retire_terminal`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exited {
    pub label: String,
    pub agent_kind: Option<AgentKind>,
    pub cwd: Option<String>,
}

/// Told of each session found already exited on a host's first connect. Async
/// because retiring rows is a database write; the session is closed on the
/// host once it returns.
pub type OnExited = Arc<dyn Fn(Exited) -> BoxFuture<'static, ()> + Send + Sync>;

/// What differs between the hosts a [`RemoteTerminals`] serves.
///
/// What a link must be trusted with is not here: the [`RemoteHost`] refuses a
/// link below its `HostOptions::require` before any byte, `hello` included, so
/// a live client is always one this host may speak over.
#[derive(Clone)]
pub struct Profile {
    /// For logs: "daedalus", "santree server r3".
    pub name: String,
    /// The environment sessions on this host inherit beneath the pane's own
    /// `env`, read when the host opens one. `None` for a host whose
    /// environment is its own (Daedalus): this Mac's never reaches it.
    pub base_env: Option<fn() -> EnvVars>,
    pub on_gone: Gone,
    /// Take over every session the host holds on its first connect per boot.
    pub adopt_all: bool,
    /// Told of the sessions adoption finds already exited.
    pub on_exited: Option<OnExited>,
}

impl Profile {
    /// Daedalus: its own environment, a session it lost is over, and only the
    /// panes this app opened are its to hold.
    pub fn daedalus() -> Self {
        Self {
            name: "daedalus".into(),
            base_env: None,
            on_gone: Gone::End,
            adopt_all: false,
            on_exited: None,
        }
    }

    /// A local santree server of `revision`: the app's environment beneath each
    /// session, a session it lost stays to say so, everything it holds is taken
    /// over, and `on_exited` is told of what ended while no app was attached.
    pub fn local_server(revision: u32, on_exited: OnExited) -> Self {
        Self {
            name: format!("santree server r{revision}"),
            base_env: Some(super::env::server_base_env),
            on_gone: Gone::Lost,
            adopt_all: true,
            on_exited: Some(on_exited),
        }
    }
}

/// How the reads of a host's session table are paced, and how long a pane may
/// wait for a link that isn't there.
///
/// `liveness` and `held_sessions` are asked at the rate the UI polls agent
/// state, and each would be a `pty.sessions` round trip to a process that may
/// not be answering (a server that is stopped, or wedged). So a listing is
/// reused for a while, asked of the host at most once at a time, and abandoned
/// when the host is slow: a read that can't be answered is incomplete, never a
/// hang.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    /// How long a listing is reused. Longer than a poll, short enough that the
    /// one thing it can miss — an exit nobody watched — is seen within a beat.
    /// Everything that changes the table from here (an open, an attach, a close,
    /// an adoption, an exit, a reconnect) drops it at once.
    pub ttl: Duration,
    /// How long a listing that failed is reused, so a host that isn't answering
    /// costs one timeout per this interval and not one per caller.
    pub failed_ttl: Duration,
    /// How long one `pty.sessions` may take before it counts as failed.
    pub timeout: Duration,
    /// How long a pane opened with no link to open on keeps waiting for one
    /// before it is lost ([`PaneLink::Lost`]) — on a host that does that to a
    /// session it can't find. Its launch line is typed when the session starts,
    /// and a line typed long after the user asked for it is a command they no
    /// longer meant to run: the server may take a while to come up (a slow
    /// signature check never leaves "starting"), but not minutes.
    pub unbound_ttl: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            ttl: Duration::from_secs(10),
            failed_ttl: Duration::from_secs(5),
            timeout: Duration::from_secs(3),
            unbound_ttl: Duration::from_secs(45),
        }
    }
}

/// The last listing the host gave, or the fact that it didn't.
struct Listing {
    at: Instant,
    boot: String,
    /// `None`: the host couldn't be asked, or was too slow.
    sessions: Option<Arc<Vec<SessionInfo>>>,
}

/// The remote panes of one host. Cheap to clone (one shared registry); one per
/// [`RemoteHost`].
#[derive(Clone)]
pub struct RemoteTerminals {
    inner: Arc<Inner>,
}

struct Inner {
    host: Arc<RemoteHost>,
    key: HostKey,
    ids: Arc<IdRegistry>,
    profile: Profile,
    panes: Mutex<HashMap<PaneId, Arc<Pane>>>,
    watching: OnceLock<()>,
    /// The host boot whose sessions adoption has taken over, once it has: what
    /// [`RemoteTerminals::adopt_ready`] waits on, and what keeps a reconnect to
    /// the same boot from adopting twice.
    adopted: watch::Sender<Option<String>>,
    /// The host boot whose listing kept failing, so adoption gave up on it for
    /// now: [`RemoteTerminals::adopt_ready`] stops waiting (nothing more is
    /// coming from this link) while `liveness` stays incomplete, because `adopted`
    /// never named it. The next connect tries again.
    adopt_failed: watch::Sender<Option<String>>,
    /// Held while a pane opens or finds its session and while adoption lists
    /// them, on a host that adopts: a session a pane has opened but not yet
    /// recorded would otherwise be adopted as a second pane. Not taken on a
    /// host that doesn't adopt (Daedalus), where opens stay concurrent.
    opening: tokio::sync::Mutex<()>,
    /// New panes with no link to open on are born [`PaneLink::Lost`] instead of
    /// waiting: the host has been given up on, and a tab that got here after
    /// the sweep of the waiting ones (`lose_unbound`) must not be the one that
    /// types its launch line when the host later returns.
    refusing_unbound: AtomicBool,
    timing: Timing,
    /// The listing reads share ([`Inner::listing`]).
    listed: Mutex<Option<Listing>>,
    /// Bumped by every change to the host's table, so a listing that was being
    /// fetched across one is not kept.
    listed_gen: AtomicU64,
    /// One listing in flight at a time: later readers wait for it and share it.
    listing_flight: tokio::sync::Mutex<()>,
}

/// What the pane's session is started with that must not outlive the start: the
/// project's env, secrets included. Held only until the session exists on the
/// host — a reconnect afterwards attaches and never opens again, so nothing
/// later needs it, and a pane can live for days.
#[derive(Clone)]
struct Launch {
    env: EnvVars,
}

struct Pane {
    id: PaneId,
    /// What the pane runs and where, without its environment (that is
    /// [`State::launch`]).
    spec: Spec,
    /// One network step (attach, detach, close) at a time, in call order.
    turn: tokio::sync::Mutex<()>,
    st: Mutex<State>,
    /// Keystrokes and the launch line, each tagged with the attach (`gen`) it
    /// was typed at. A [`PtyInput`], so nothing here (the output pump included)
    /// can queue bytes of its own.
    input: mpsc::UnboundedSender<(u64, PtyInput)>,
}

struct State {
    /// The webview page this pane belongs to (`terminal_adopt`).
    owner: String,
    /// The host's session, once opened or found.
    remote: Option<BoxSessionId>,
    /// The `bootId` of the host `remote` was bound on. A session id means
    /// nothing beside any other: a host numbers from 1 on every start.
    boot: Option<String>,
    /// Whether this pane opened `remote` itself — only then may a seed be
    /// typed into it; a session found again is already running its launch.
    opened_here: bool,
    /// Where the next attach resumes: the frontend's anchor after it attaches,
    /// then every byte forwarded since.
    anchor: Anchor,
    /// Where output goes; `None` while detached (no pane is showing it).
    sinks: Option<Sinks>,
    /// Bumped by every attach (the frontend's and each re-attach), detach and
    /// close: a pump or a network step that started under an older value has
    /// been superseded.
    gen: u64,
    /// The link the pane is attached over, output flowing; `None` while it
    /// isn't. A link that has died since counts as not attached, even before
    /// the pump has noticed.
    on: Option<Arc<RemoteClient>>,
    /// The link state last told to `sinks`.
    told: Option<PaneLink>,
    /// The last attach's answer, for an attach that finds the pane already
    /// re-attached by the time its turn comes.
    attached: Option<Attached>,
    size: (u16, u16),
    /// The grid changed while the pane couldn't reach its session.
    resize_due: bool,
    /// What the session is started with; `None` once the session is bound (or
    /// for a session found rather than started), and once the pane is over or
    /// lost: nothing starts a session for it after that, so its secrets go.
    launch: Option<Launch>,
    /// A launch line waiting for the session this pane is about to open (or
    /// the attach that follows a lost link), with when it was queued: a line
    /// typed long after the user asked for it is a command they no longer meant.
    seed: Option<(LaunchLine, Instant)>,
    /// The tab was closed: end the session as soon as the host can be told.
    closing: bool,
    /// Nothing more happens: the process exited, the host lost it, or it
    /// could not be started.
    ended: bool,
    /// The host the session lived on isn't the one answering any more. The
    /// pane stays, to say so; nothing is attached or closed on its behalf.
    lost: bool,
}

impl Pane {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The pane's address: what it was opened under and for which provider.
    fn address(&self) -> LiveTerminal {
        LiveTerminal {
            term_key: self.spec.label.clone(),
            agent_kind: self.spec.agent_kind,
        }
    }
}

impl State {
    fn new(owner: String, size: (u16, u16), sinks: Option<Sinks>) -> Self {
        Self {
            owner,
            remote: None,
            boot: None,
            opened_here: false,
            anchor: Anchor::Fresh,
            sinks,
            gen: 0,
            on: None,
            told: None,
            attached: None,
            size,
            resize_due: false,
            launch: None,
            seed: None,
            closing: false,
            ended: false,
            lost: false,
        }
    }

    /// Attached over a link that is still up.
    fn live(&self) -> bool {
        self.on.as_ref().is_some_and(|client| !client.is_closed())
    }

    /// Tell the pane's link state to whoever is showing it, once per change.
    fn tell(&mut self, link: PaneLink) {
        if self.told == Some(link) {
            return;
        }
        self.told = Some(link);
        if let Some(sinks) = &self.sinks {
            (sinks.link)(link);
        }
    }

    /// What a view is told when nothing better has happened: that the session
    /// is lost, or that the pane is waiting for a link.
    fn settle(&mut self) {
        if self.lost {
            self.tell(PaneLink::Lost);
        } else if !self.live() && !self.ended {
            self.tell(PaneLink::Reconnecting);
        }
    }

    /// Point output at a new pane (or at nothing) and supersede everything
    /// in flight for the old one.
    fn retarget(&mut self, sinks: Option<Sinks>) -> u64 {
        self.gen += 1;
        self.sinks = sinks;
        self.on = None;
        self.told = None;
        self.gen
    }

    /// Mark the pane over and tell its view the process is gone. The caller
    /// forgets it once this lock is released (the registry is locked first
    /// everywhere else).
    fn end(&mut self) {
        self.launch = None;
        self.ended = true;
        self.on = None;
        if let Some(sinks) = &self.sinks {
            (sinks.output)(Vec::new());
        }
    }

    /// Mark the session lost and say so — and supersede whatever a pump of the
    /// link it died with might still report.
    fn lose(&mut self) {
        // A launch line queued for a session that will now never start must not
        // be typed into anything, and its secrets have no session left to go to.
        self.seed = None;
        self.launch = None;
        self.lost = true;
        self.on = None;
        self.gen += 1;
        self.tell(PaneLink::Lost);
    }
}

impl RemoteTerminals {
    /// The panes of the host behind `host`, named `key`, with ids from `ids`,
    /// behaving as `profile` says.
    pub fn new(
        host: Arc<RemoteHost>,
        key: HostKey,
        ids: Arc<IdRegistry>,
        profile: Profile,
    ) -> Self {
        Self::with_timing(host, key, ids, profile, Timing::default())
    }

    /// [`RemoteTerminals::new`] with its own read pacing.
    pub fn with_timing(
        host: Arc<RemoteHost>,
        key: HostKey,
        ids: Arc<IdRegistry>,
        profile: Profile,
        timing: Timing,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                host,
                key,
                ids,
                profile,
                panes: Mutex::new(HashMap::new()),
                watching: OnceLock::new(),
                adopted: watch::channel(None).0,
                adopt_failed: watch::channel(None).0,
                opening: tokio::sync::Mutex::new(()),
                refusing_unbound: AtomicBool::new(false),
                timing,
                listed: Mutex::new(None),
                listed_gen: AtomicU64::new(0),
                listing_flight: tokio::sync::Mutex::new(()),
            }),
        }
    }

    /// Which host this is.
    pub fn key(&self) -> HostKey {
        self.inner.key
    }

    /// Whether pane `id` is one of this host's, until it is over.
    pub fn holds(&self, id: PaneId) -> bool {
        self.inner.lock().contains_key(&id)
    }

    /// The host is gone for good (a server that crashed, or was let go):
    /// every pane that is still here becomes [`PaneLink::Lost`] and stays that
    /// way. Without this a pane of a dropped host would simply stop answering.
    pub fn lose_all(&self) {
        self.lose_where(|_| true);
    }

    /// Panes that never reached a session — opened while the host was coming
    /// up, waiting for a link — become [`PaneLink::Lost`]. Called when the host
    /// is given up on: a launch line must not be typed by a later "Start" into a
    /// tab the user opened long before (nothing starts on its own).
    pub fn lose_unbound(&self) {
        self.lose_where(|st| st.remote.is_none());
    }

    /// Whether panes opened without a link are lost on arrival
    /// ([`RemoteTerminals::lose_unbound`] for the ones still to come). Set
    /// *before* sweeping the waiting panes: a pane inserted either sees the flag
    /// or is in the registry when the sweep takes its lock.
    pub fn refuse_unbound(&self, refuse: bool) {
        self.inner.refusing_unbound.store(refuse, Ordering::SeqCst);
    }

    fn lose_where(&self, pick: impl Fn(&State) -> bool) {
        for pane in self.inner.lock().values() {
            let mut st = pane.lock();
            if !st.ended && !st.closing && !st.lost && pick(&st) {
                st.lose();
            }
        }
    }

    /// The live client, waiting up to `wait` for a link that is still
    /// `Connecting` — so a pane opened right after launch or a network change
    /// doesn't fail on a link a moment from up.
    pub async fn client_within(&self, wait: Duration) -> Option<Arc<RemoteClient>> {
        if let Some(client) = self.inner.client() {
            return Some(client);
        }
        let mut status = self.inner.host.status();
        let _ = tokio::time::timeout(wait, status.wait_for(|s| *s != HostStatus::Connecting)).await;
        self.inner.client()
    }

    /// Re-attach every waiting pane on each (re)connect, and — on a host that
    /// adopts — take over what it holds on the first connect of each boot.
    /// Idempotent; call it from inside the runtime once the link starts.
    pub fn watch(&self) {
        if self.inner.watching.set(()).is_err() {
            return;
        }
        let inner = self.inner.clone();
        // Subscribed before looking at the link, so a connect is seen either
        // here (already up) or as an announcement, never neither: `watch` may
        // be called before or after the host starts, in either order.
        let mut reconnected = inner.host.reconnected();
        let mut already_up = inner.host.client().is_some();
        tokio::spawn(async move {
            loop {
                if !std::mem::take(&mut already_up) {
                    match reconnected.recv().await {
                        Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                        Err(broadcast::error::RecvError::Closed) => return,
                    }
                }
                inner.invalidate_listing();
                let Some(client) = inner.host.client() else {
                    continue;
                };
                let Some(boot) = link_boot(&inner.host, &client) else {
                    continue;
                };
                let binds: Vec<_> = inner
                    .waiting()
                    .into_iter()
                    .map(|pane| {
                        let (inner, client) = (inner.clone(), client.clone());
                        tokio::spawn(async move {
                            if let Err(e) = bind(&inner, &pane, &client).await {
                                fail(&inner, &pane, &e);
                            }
                        })
                    })
                    .collect();
                if inner.profile.adopt_all && *inner.adopted.borrow() != Some(boot.clone()) {
                    // After the panes that asked for a session by address have
                    // had theirs: a pane opened before this connect is more
                    // exact about what it wants than a sweep of everything.
                    for bind in binds {
                        let _ = bind.await;
                    }
                    adopt_all(&inner, &client, &boot).await;
                }
            }
        });
    }

    /// Resolves once this host's sessions have been adopted for the boot now
    /// answering — or at once when there is nothing to wait for: the host
    /// doesn't adopt, or it is known to be down. Unbounded while the link is
    /// still coming up; the caller bounds it.
    pub async fn adopt_ready(&self) {
        let inner = &self.inner;
        if !inner.profile.adopt_all {
            return;
        }
        let mut status = inner.host.status();
        let mut adopted = inner.adopted.subscribe();
        let mut failed = inner.adopt_failed.subscribe();
        loop {
            let settled = match inner.host.current_status() {
                HostStatus::Connected { .. } => inner.host.hello().is_some_and(|hello| {
                    *adopted.borrow() == Some(hello.boot_id.clone())
                        || *failed.borrow() == Some(hello.boot_id.clone())
                }),
                HostStatus::Connecting => false,
                HostStatus::Stopped | HostStatus::Down(_) | HostStatus::VersionMismatch { .. } => {
                    true
                }
            };
            if settled {
                return;
            }
            tokio::select! {
                _ = status.changed() => {}
                _ = adopted.changed() => {}
                _ = failed.changed() => {}
            }
        }
    }

    /// Open a pane running `spec` on the host. With a `client` the session is
    /// opened (or found) now and a refusal is this call's error; without one
    /// the pane waits, `Reconnecting`, and opens on the next connect.
    pub async fn open(
        &self,
        spec: Spec,
        owner: String,
        size: (u16, u16),
        client: Option<Arc<RemoteClient>>,
        sinks: Sinks,
    ) -> Result<PaneId> {
        if let Some(id) = self
            .claim(&spec, owner.clone(), size, client.clone(), sinks.clone())
            .await?
        {
            return Ok(id);
        }
        let id = self.inner.ids.mint();
        let (input, keys) = mpsc::unbounded_channel();
        let mut spec = spec;
        let launch = Launch {
            env: std::mem::take(&mut spec.env),
        };
        let mut state = State::new(owner, size, Some(sinks));
        state.launch = Some(launch);
        let pane = Arc::new(Pane {
            id,
            spec,
            turn: tokio::sync::Mutex::new(()),
            st: Mutex::new(state),
            input,
        });
        {
            let mut panes = self.inner.lock();
            panes.insert(id, pane.clone());
            // Under the registry lock, as the sweep is: see `refusing_unbound`.
            if client.is_none() && self.inner.refusing_unbound.load(Ordering::SeqCst) {
                pane.lock().lose();
            }
        }
        tokio::spawn(write_loop(
            self.inner.profile.name.clone(),
            Arc::downgrade(&pane),
            keys,
        ));
        if let Some(client) = client {
            if let Err(e) = bind(&self.inner, &pane, &client).await {
                self.inner.forget(id);
                return Err(e);
            }
        }
        pane.lock().settle();
        self.inner.expire_if_unbound(&pane);
        Ok(id)
    }

    /// Take over the session adoption already holds under `spec`'s address
    /// (label and provider), or `None` when there isn't one — and open nothing
    /// either way. [`RemoteTerminals::open`] begins with this: a tab asking for
    /// an address that adoption already took the session of claims that pane —
    /// never a second session for the same conversation, and never a launch
    /// line typed into a running agent.
    ///
    /// Only a host that adopts everything has such panes; any other answers
    /// `None`.
    async fn claim(
        &self,
        spec: &Spec,
        owner: String,
        size: (u16, u16),
        client: Option<Arc<RemoteClient>>,
        sinks: Sinks,
    ) -> Result<Option<PaneId>> {
        if !self.inner.profile.adopt_all {
            return Ok(None);
        }
        let claimed = {
            let _opening = self.inner.opening.lock().await;
            let address = LiveTerminal {
                term_key: spec.label.clone(),
                agent_kind: spec.agent_kind,
            };
            self.inner.unclaimed(&address).inspect(|pane| {
                let mut st = pane.lock();
                st.retarget(Some(sinks));
                st.owner = owner;
                st.attached = None;
                // The view's grid is not the one the session last had.
                st.size = size;
                st.resize_due = true;
            })
        };
        let Some(pane) = claimed else {
            return Ok(None);
        };
        let id = pane.id;
        if let Some(client) = client {
            if let Err(e) = bind(&self.inner, &pane, &client).await {
                self.inner.forget(id);
                return Err(e);
            }
        }
        pane.lock().settle();
        Ok(Some(id))
    }

    /// Point pane `id`'s output at `sinks`, resuming from `anchor` — what the
    /// frontend's anchor says it already has. Answers the host's attach, or,
    /// while the pane can't reach its session, a `Reanchor` with nothing sent.
    pub async fn attach(&self, id: PaneId, anchor: Anchor, sinks: Sinks) -> Result<Attached> {
        let pane = self.inner.pane(id)?;
        {
            let mut st = pane.lock();
            st.retarget(Some(sinks));
            st.anchor = anchor;
            st.attached = None;
        }
        if let Some(client) = self.inner.host.client() {
            if let Err(e) = bind(&self.inner, &pane, &client).await {
                self.inner.forget(id);
                return Err(e);
            }
        }
        let mut st = pane.lock();
        st.settle();
        Ok(st.attached.clone().unwrap_or(Attached {
            epoch: String::new(),
            seq: 0,
            mode: ReplayMode::Reanchor,
        }))
    }

    /// Stop showing pane `id`; its process keeps running on the host.
    pub fn detach(&self, id: PaneId) {
        let Ok(pane) = self.inner.pane(id) else {
            return;
        };
        let (gen, remote, boot) = {
            let mut st = pane.lock();
            (
                st.retarget(None),
                st.remote.filter(|_| !st.lost),
                st.boot.clone(),
            )
        };
        let Some(remote) = remote else {
            return;
        };
        let inner = self.inner.clone();
        tokio::spawn(async move {
            let _turn = pane.turn.lock().await;
            if pane.lock().gen != gen {
                return;
            }
            // The session id is the host's, and a host that restarted since
            // numbers its own: detaching `remote` there would detach a stranger.
            let Some(client) = inner.client() else {
                return;
            };
            if link_boot(&inner.host, &client) != boot {
                return;
            }
            if let Err(e) = client.pty_detach(remote).await {
                log::debug!("{}: detaching pane {}: {e}", inner.profile.name, pane.id);
            }
        });
    }

    /// End pane `id` and its process. While the link is down the pane waits
    /// for it and closes on the next connect.
    pub fn close(&self, id: PaneId) {
        let Ok(pane) = self.inner.pane(id) else {
            return;
        };
        {
            let mut st = pane.lock();
            st.retarget(None);
            st.closing = true;
            if st.lost {
                // Its session is gone with the host that held it: there is
                // nothing to tell anyone.
                st.ended = true;
                drop(st);
                self.inner.forget(id);
                return;
            }
        }
        if let Some(client) = self.inner.host.client() {
            let inner = self.inner.clone();
            tokio::spawn(async move {
                if let Err(e) = bind(&inner, &pane, &client).await {
                    log::warn!("{}: closing pane {}: {e:#}", inner.profile.name, pane.id);
                }
            });
        }
    }

    /// The user's keystrokes, in order, to the attach they were typed at.
    /// Dropped while the pane can't reach its session.
    pub fn write(&self, id: PaneId, keys: Keystrokes) -> Result<()> {
        let pane = self.inner.pane(id)?;
        let gen = {
            let st = pane.lock();
            if !st.live() {
                log::debug!(
                    "{}: pane {id} can't reach its session; input dropped",
                    self.inner.profile.name
                );
                return Ok(());
            }
            st.gen
        };
        pane.input
            .send((gen, keys.into()))
            .map_err(|_| anyhow!("no terminal session {id}"))
    }

    /// The one launch line, typed into a session this pane opens itself —
    /// now, or as soon as it is attached. A session found again is already
    /// running its launch, so the line is not typed twice.
    pub fn seed(&self, id: PaneId, line: LaunchLine) -> Result<()> {
        let pane = self.inner.pane(id)?;
        let mut st = pane.lock();
        if st.lost {
            return Ok(());
        }
        if st.remote.is_some() && !st.opened_here {
            log::info!(
                "{}: pane {id} found its session running; not typing its launch again",
                self.inner.profile.name
            );
            return Ok(());
        }
        if !st.live() {
            st.seed = Some((line, Instant::now()));
            return Ok(());
        }
        let gen = st.gen;
        drop(st);
        pane.input
            .send((gen, line.into()))
            .map_err(|_| anyhow!("no terminal session {id}"))
    }

    /// Whether a launch line for pane `id` would be typed: false for a session
    /// found running (it has its launch already) and for a pane that is over or
    /// lost. What a caller that prepares the line — spilling a long one to a
    /// file — asks first, so a refused seed leaves nothing behind.
    pub fn seed_wanted(&self, id: PaneId) -> bool {
        let Ok(pane) = self.inner.pane(id) else {
            return false;
        };
        let st = pane.lock();
        !st.ended && !st.lost && (st.remote.is_none() || st.opened_here)
    }

    /// The grid the pane shows. Sent now when it can be, else after the next
    /// re-attach.
    pub fn resize(&self, id: PaneId, cols: u16, rows: u16) -> Result<()> {
        let pane = self.inner.pane(id)?;
        let mut st = pane.lock();
        st.size = (cols, rows);
        let on = st.on.clone().filter(|_| st.live());
        match (st.remote, on) {
            (Some(remote), Some(client)) => {
                drop(st);
                let name = self.inner.profile.name.clone();
                tokio::spawn(async move {
                    if let Err(e) = client.pty_resize(remote, cols, rows).await {
                        log::debug!("{name}: resizing pane {}: {e}", pane.id);
                    }
                });
            }
            _ => st.resize_due = true,
        }
        Ok(())
    }

    /// The panes whose process is still running on the host, by the address a
    /// session row joins on — the remote half of `terminal::live_terminals`. A
    /// pane waiting out a dropped link counts: its process never stopped. One
    /// whose session was lost doesn't: its process is gone.
    pub fn live(&self) -> HashSet<LiveTerminal> {
        self.inner
            .lock()
            .values()
            .filter(|pane| {
                let st = pane.lock();
                !st.ended && !st.closing && !st.lost
            })
            .map(|pane| pane.address())
            .collect()
    }

    /// Which panes have a live process, asked of the host rather than of the
    /// panes — and whether that answer is the whole truth.
    ///
    /// A pane that is adopted has no pump watching it, so what it remembers
    /// can't say its process has exited since; `pty.sessions` can. For a host
    /// that adopts nothing (Daedalus) every pane was opened here and is
    /// watched, so the panes' own state is the answer: one waiting out a
    /// dropped link counts.
    ///
    /// For one that isn't, `complete` is false whenever the host can't be
    /// asked — down, not yet adopted, or failing to answer — because a server
    /// santree can't reach may be holding agents that are running fine, and
    /// "not seen" must not read as "exited".
    pub async fn liveness(&self) -> Liveness {
        let inner = &self.inner;
        if !inner.profile.adopt_all {
            return Liveness {
                live: self.live(),
                complete: true,
            };
        }
        let down = |live| Liveness {
            live,
            complete: false,
        };
        let Some(client) = inner.client() else {
            return down(self.live());
        };
        let Some(boot) = link_boot(&inner.host, &client) else {
            return down(self.live());
        };
        let alive: HashSet<BoxSessionId> = match inner.listing(&client, &boot).await {
            Some(sessions) => sessions.iter().filter(|s| s.alive).map(|s| s.id).collect(),
            None => return down(self.live()),
        };
        let live = inner
            .lock()
            .values()
            .filter_map(|pane| {
                let st = pane.lock();
                if st.ended || st.closing || st.lost {
                    return None;
                }
                // Not bound yet: a pane waiting for its session to open still
                // counts, as a Daedalus one does. Bound: the host says.
                let running = match st.remote {
                    None => true,
                    Some(remote) => {
                        st.boot.as_deref() == Some(boot.as_str()) && alive.contains(&remote)
                    }
                };
                running.then(|| pane.address())
            })
            .collect();
        Liveness {
            live,
            complete: *inner.adopted.borrow() == Some(boot),
        }
    }

    /// Each pane bound to a session on the host, with the host's own record of
    /// it. `None` when the host can't be asked right now. A session no pane
    /// holds has no id the app could close it by, so it isn't listed.
    pub async fn held_sessions(&self) -> Option<Vec<(PaneId, SessionInfo)>> {
        let client = self.inner.client()?;
        let boot = link_boot(&self.inner.host, &client)?;
        let sessions = self.inner.listing(&client, &boot).await?;
        let panes = self.inner.lock();
        Some(
            sessions
                .iter()
                .cloned()
                .filter_map(|info| {
                    let id = panes.values().find_map(|pane| {
                        let st = pane.lock();
                        (!st.lost
                            && st.remote == Some(info.id)
                            && st.boot.as_deref() == Some(boot.as_str()))
                        .then_some(pane.id)
                    })?;
                    Some((id, info))
                })
                .collect(),
        )
    }

    /// Each live pane bound to a session on the host now answering, with that
    /// session's id — what a scan of the host's process table walks down from.
    /// A pane bound under another boot holds an id from a numbering that is
    /// over (it would name a stranger's session here), and with no link there
    /// is no boot to compare: both read as nothing.
    pub fn bound(&self) -> Vec<(LiveTerminal, BoxSessionId)> {
        let Some(client) = self.inner.client() else {
            return Vec::new();
        };
        let Some(boot) = link_boot(&self.inner.host, &client) else {
            return Vec::new();
        };
        self.inner
            .lock()
            .values()
            .filter_map(|pane| {
                let st = pane.lock();
                let remote = st.remote.filter(|_| {
                    !st.ended
                        && !st.closing
                        && !st.lost
                        && st.boot.as_deref() == Some(boot.as_str())
                })?;
                Some((pane.address(), remote))
            })
            .collect()
    }

    /// Whether pane `id` still holds the env it is to be started with.
    #[cfg(test)]
    pub fn retains_launch_env(&self, id: PaneId) -> bool {
        self.inner
            .pane(id)
            .is_ok_and(|pane| pane.lock().launch.is_some())
    }

    /// Whether pane `id` still has a launch line queued.
    #[cfg(test)]
    pub fn retains_seed(&self, id: PaneId) -> bool {
        self.inner
            .pane(id)
            .is_ok_and(|pane| pane.lock().seed.is_some())
    }

    /// Drop the listing reads share, as an open or an exit does.
    #[cfg(test)]
    pub fn invalidate_listing_for_test(&self) {
        self.inner.invalidate_listing();
    }

    /// Pane `id`'s address and cwd on the host, as it was opened.
    pub fn address(&self, id: PaneId) -> Option<(LiveTerminal, Option<String>)> {
        let pane = self.inner.pane(id).ok()?;
        Some((pane.address(), pane.spec.cwd.clone()))
    }

    /// Hand every pane of another page to `owner`, and say which they are.
    pub fn adopt(&self, owner: &str) -> Vec<AdoptedSession> {
        self.inner
            .lock()
            .values()
            .filter_map(|pane| {
                let mut st = pane.lock();
                if st.ended || st.closing || st.owner == owner {
                    return None;
                }
                st.owner = owner.to_string();
                Some(AdoptedSession {
                    id: pane.id,
                    label: pane.spec.label.clone(),
                    agent_kind: pane.spec.agent_kind,
                    cwd: pane.spec.cwd.clone(),
                    command: pane.spec.command.clone(),
                })
            })
            .collect()
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, HashMap<PaneId, Arc<Pane>>> {
        self.panes.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn pane(&self, id: PaneId) -> Result<Arc<Pane>> {
        self.lock()
            .get(&id)
            .cloned()
            .ok_or_else(|| anyhow!("no terminal session {id}"))
    }

    /// On a host that loses a session it can't find, give a pane that has no
    /// session yet only [`Timing::unbound_ttl`] to get one: then it is lost, and
    /// its launch line is dropped with it ([`State::lose`]). A pane waiting for a
    /// link types that line the moment its session starts, and a host that
    /// stays in "starting" (a slow signature check) would let a connect minutes
    /// later type a command the user asked for long ago. Daedalus panes keep
    /// waiting, as documented.
    fn expire_if_unbound(&self, pane: &Arc<Pane>) {
        if self.profile.on_gone != Gone::Lost || pane.lock().remote.is_some() {
            return;
        }
        let (pane, ttl) = (Arc::downgrade(pane), self.timing.unbound_ttl);
        let name = self.profile.name.clone();
        tokio::spawn(async move {
            tokio::time::sleep(ttl).await;
            let Some(pane) = pane.upgrade() else {
                return;
            };
            let mut st = pane.lock();
            if st.remote.is_none() && !st.ended && !st.closing && !st.lost {
                log::info!(
                    "{name}: pane {} waited {ttl:?} for a server; it is lost",
                    pane.id
                );
                st.lose();
            }
        });
    }

    /// The host's sessions, from the last listing if it is recent enough, else
    /// asked of the host now — one asker at a time, and no longer than the
    /// timing allows. `None` when the host couldn't answer (and for as long as
    /// that failure is reused).
    async fn listing(&self, client: &RemoteClient, boot: &str) -> Option<Arc<Vec<SessionInfo>>> {
        let _flight = self.listing_flight.lock().await;
        let started = self.listed_gen.load(Ordering::SeqCst);
        if let Some(cached) = self
            .listed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            let ttl = if cached.sessions.is_some() {
                self.timing.ttl
            } else {
                self.timing.failed_ttl
            };
            if cached.boot == boot && cached.at.elapsed() < ttl {
                return cached.sessions.clone();
            }
        }
        let sessions = match tokio::time::timeout(self.timing.timeout, client.pty_sessions()).await
        {
            Ok(Ok(sessions)) => Some(Arc::new(sessions)),
            Ok(Err(e)) => {
                log::debug!("{}: listing sessions: {e}", self.profile.name);
                None
            }
            Err(_) => {
                log::warn!(
                    "{}: the host didn't list its sessions within {:?}",
                    self.profile.name,
                    self.timing.timeout
                );
                None
            }
        };
        if self.listed_gen.load(Ordering::SeqCst) == started {
            *self.listed.lock().unwrap_or_else(|e| e.into_inner()) = Some(Listing {
                at: Instant::now(),
                boot: boot.to_string(),
                sessions: sessions.clone(),
            });
        }
        sessions
    }

    /// The host's table changed (or may have): the next read asks it again.
    fn invalidate_listing(&self) {
        self.listed_gen.fetch_add(1, Ordering::SeqCst);
        *self.listed.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// The live client.
    fn client(&self) -> Option<Arc<RemoteClient>> {
        self.host.client()
    }

    /// An adopted pane no view has claimed at `address`: it holds a session it
    /// found (not one it opened), and nothing shows it yet.
    fn unclaimed(&self, address: &LiveTerminal) -> Option<Arc<Pane>> {
        self.lock()
            .values()
            .find(|pane| {
                let st = pane.lock();
                st.remote.is_some()
                    && !st.opened_here
                    && st.sinks.is_none()
                    && !st.ended
                    && !st.closing
                    && !st.lost
                    && pane.address() == *address
            })
            .cloned()
    }

    fn forget(&self, id: PaneId) {
        self.lock().remove(&id);
    }

    /// Panes a connect has work for: shown but not attached, or closed while
    /// the host couldn't be told. Never one whose session is lost.
    fn waiting(&self) -> Vec<Arc<Pane>> {
        self.lock()
            .values()
            .filter(|pane| {
                let st = pane.lock();
                !st.ended && !st.lost && !st.live() && (st.sinks.is_some() || st.closing)
            })
            .cloned()
            .collect()
    }

    /// The host's sessions, of boot `boot`, that panes other than `except`
    /// hold. A pane bound under another boot holds nothing here: its id
    /// belongs to a numbering that is over.
    fn held(&self, boot: &str, except: Option<PaneId>) -> HashSet<BoxSessionId> {
        self.lock()
            .values()
            .filter(|pane| Some(pane.id) != except)
            .filter_map(|pane| {
                let st = pane.lock();
                st.remote.filter(|_| st.boot.as_deref() == Some(boot))
            })
            .collect()
    }

    /// A pane for a session found on the host that none holds: no view is
    /// showing it, it belongs to no page yet, and it types nothing — its launch
    /// ran long ago.
    fn adopt_session(&self, info: SessionInfo, boot: &str) {
        let id = self.ids.mint();
        let (input, keys) = mpsc::unbounded_channel();
        let mut st = State::new(String::new(), (info.cols, info.rows), None);
        st.remote = Some(info.id);
        st.boot = Some(boot.to_string());
        st.anchor = Anchor::Unknown;
        let pane = Arc::new(Pane {
            id,
            spec: Spec {
                cwd: info.cwd,
                command: info.command,
                args: Vec::new(),
                env: Vec::new(),
                label: info.label,
                agent_kind: info.agent_kind,
            },
            turn: tokio::sync::Mutex::new(()),
            st: Mutex::new(st),
            input,
        });
        self.lock().insert(id, pane.clone());
        tokio::spawn(write_loop(
            self.profile.name.clone(),
            Arc::downgrade(&pane),
            keys,
        ));
    }
}

/// The `bootId` of the host `client` is a link to — `None` when `client` is no
/// longer the live link, so what is read is never a different link's.
fn link_boot(host: &RemoteHost, client: &Arc<RemoteClient>) -> Option<String> {
    link_hello(host, client).map(|hello| hello.boot_id.clone())
}

/// What the host answered `hello` on `client`'s link, as long as `client` is
/// still that link. `hello` is read before the client: a link that changes in
/// between is a different client, and fails the comparison; one that doesn't
/// can't have been paired with another's hello.
fn link_hello(host: &RemoteHost, client: &Arc<RemoteClient>) -> Option<Arc<HelloResult>> {
    let hello = host.hello()?;
    host.client()
        .is_some_and(|live| Arc::ptr_eq(&live, client))
        .then_some(hello)
}

/// How long adoption waits before listing again after the host failed to
/// answer (an error, not a dropped link — that one is retried by the connect).
const ADOPT_RETRY: Duration = Duration::from_millis(400);

/// Take over every session the host holds that no pane does: each live one
/// becomes a pane, each exited one is retired and closed. Records the boot as
/// adopted, so [`RemoteTerminals::adopt_ready`] resolves, only when the host
/// could be asked; a listing that fails for any reason but a dropped link is
/// tried once more, and then given up on (`adopt_failed`: nobody waits for it,
/// `liveness` stays incomplete) until the next connect.
async fn adopt_all(inner: &Arc<Inner>, client: &Arc<RemoteClient>, boot: &str) {
    let mut exited = Vec::new();
    let mut alive_addresses = HashSet::new();
    let mut attempt = 0;
    loop {
        attempt += 1;
        let opening = inner.opening.lock().await;
        let sessions = match within(
            inner,
            client,
            "listing sessions to adopt",
            client.pty_sessions(),
        )
        .await
        {
            Ok(sessions) => sessions,
            Err(e) if e.is_disconnected() => return,
            Err(e) if attempt == 1 => {
                log::warn!(
                    "{}: listing sessions to adopt: {e}; trying once more",
                    inner.profile.name
                );
                drop(opening);
                tokio::time::sleep(ADOPT_RETRY).await;
                if link_boot(&inner.host, client).as_deref() != Some(boot) {
                    return;
                }
                continue;
            }
            Err(e) => {
                log::warn!(
                    "{}: listing sessions to adopt failed twice ({e}); this host's sessions are \
                     not adopted, and what is running there is not known",
                    inner.profile.name
                );
                inner.adopt_failed.send_replace(Some(boot.to_string()));
                return;
            }
        };
        let taken = inner.held(boot, None);
        let mut adopted = 0usize;
        for info in sessions {
            if info.alive {
                alive_addresses.insert((info.label.clone(), info.agent_kind, info.cwd.clone()));
            }
            if taken.contains(&info.id) {
                continue;
            }
            if info.alive {
                inner.adopt_session(info, boot);
                adopted += 1;
            } else {
                exited.push(info);
            }
        }
        if adopted + exited.len() > 0 {
            log::info!(
                "{}: adopted {adopted} session(s), {} already exited",
                inner.profile.name,
                exited.len()
            );
        }
        break;
    }
    for info in exited {
        // A row is retired by (label, provider, cwd). A live session with the
        // same address is the row's agent now — a resumed run of the same
        // conversation — so the dead one's end must not stamp it exited.
        let shared =
            alive_addresses.contains(&(info.label.clone(), info.agent_kind, info.cwd.clone()));
        if let Some(on_exited) = &inner.profile.on_exited {
            if shared {
                log::info!(
                    "{}: {} exited, but a live session holds its address; its row stays",
                    inner.profile.name,
                    info.label
                );
            } else {
                on_exited(Exited {
                    label: info.label,
                    agent_kind: info.agent_kind,
                    cwd: info.cwd,
                })
                .await;
            }
        }
        match client.pty_close(info.id).await {
            Ok(()) => {}
            Err(e) if e.code() == Some(&ErrorCode::NotFound) || e.is_disconnected() => {}
            Err(e) => log::debug!(
                "{}: closing exited session {}: {e}",
                inner.profile.name,
                info.id
            ),
        }
    }
    inner.invalidate_listing();
    inner.adopted.send_replace(Some(boot.to_string()));
}

/// A call to the host, given [`Timing::timeout`]. These run while holding
/// `opening` (and a pane's `turn`), so a host that has stopped answering — a
/// stopped or wedged server — must not hold every other open behind it for as
/// long as the link takes to be declared dead. A call that runs out is treated
/// as a lost link: the shared client is shut down (the host reconnects, and
/// every waiting pane binds again), and the caller gets a disconnect — a pane
/// waits, nothing is shown. A session the host did start after the caller gave
/// up is found again by address on the next connect.
async fn within<T>(
    inner: &Inner,
    client: &RemoteClient,
    what: &str,
    call: impl std::future::Future<Output = Result<T, RemoteError>>,
) -> Result<T, RemoteError> {
    match tokio::time::timeout(inner.timing.timeout, call).await {
        Ok(answer) => answer,
        Err(_) => {
            log::warn!(
                "{}: the host didn't answer {what} within {:?}; dropping the link",
                inner.profile.name,
                inner.timing.timeout
            );
            client.shutdown();
            Err(RemoteError::Disconnected(format!(
                "no answer to {what} within {:?}",
                inner.timing.timeout
            )))
        }
    }
}

/// A pane's live session on the host with its own address — label and
/// provider — that no other pane holds; the newest when there are several.
async fn find(
    inner: &Inner,
    pane: &Pane,
    client: &RemoteClient,
    boot: &str,
) -> Result<Option<BoxSessionId>, RemoteError> {
    let taken = inner.held(boot, Some(pane.id));
    Ok(
        within(inner, client, "listing sessions", client.pty_sessions())
            .await?
            .into_iter()
            .filter(|s| {
                s.alive
                    && s.label == pane.spec.label
                    && s.agent_kind == pane.spec.agent_kind
                    && !taken.contains(&s.id)
            })
            .map(|s| s.id)
            .max(),
    )
}

/// What [`bind`] does after looking at the pane.
enum Step {
    /// Nothing to do, or done.
    Done,
    /// The pane is over: forget it.
    Forget,
    /// Go on, with the pane's generation, anchor, bound session, whether it is
    /// closing, and grid.
    Go(u64, Anchor, Option<BoxSessionId>, bool, (u16, u16)),
}

/// Bring pane `pane` up to date with the host over `client`: close it when
/// its tab was closed, else open or find its session and attach from its
/// anchor. A lost link is not an error — the pane stays `Reconnecting` for
/// the next connect; the host refusing to open the session is.
///
/// A pane whose session was bound under another boot of the host is never
/// attached, closed or detached here: `client` is a different host now, and its
/// session numbered like ours is somebody else's.
async fn bind(inner: &Arc<Inner>, pane: &Arc<Pane>, client: &Arc<RemoteClient>) -> Result<()> {
    let bound = bind_step(inner, pane, client).await;
    // An open, an attach and a close all change the host's table, and a read
    // that reused an older listing would miss a session just started.
    inner.invalidate_listing();
    bound
}

async fn bind_step(inner: &Arc<Inner>, pane: &Arc<Pane>, client: &Arc<RemoteClient>) -> Result<()> {
    let name = inner.profile.name.as_str();
    let _turn = pane.turn.lock().await;
    let Some(hello) = link_hello(&inner.host, client) else {
        // The link has changed since this was asked; its connect binds again.
        return Ok(());
    };
    let boot = hello.boot_id.as_str();
    let step = {
        let mut st = pane.lock();
        if st.ended {
            Step::Done
        } else if st.lost {
            if st.closing {
                st.ended = true;
                Step::Forget
            } else {
                st.tell(PaneLink::Lost);
                Step::Done
            }
        } else if st.live() || (st.sinks.is_none() && !st.closing) {
            Step::Done
        } else {
            if st.on.take().is_some() {
                // Its link died and the connect beat the pump to noticing: the
                // pane was cut off all the same, and says so before it resumes.
                st.tell(PaneLink::Reconnecting);
            }
            if st.remote.is_some() && st.boot.as_deref() != Some(boot) {
                if st.closing {
                    st.ended = true;
                    Step::Forget
                } else {
                    log::info!(
                        "{name}: pane {}'s session was on another boot of the host; it is gone",
                        pane.id
                    );
                    match inner.profile.on_gone {
                        Gone::Lost => {
                            st.lose();
                            Step::Done
                        }
                        // As a `not_found` on attach has always ended a Daedalus
                        // pane: the exit sentinel closes its tab. `Lost` has no
                        // view there to say why.
                        Gone::End => {
                            st.end();
                            Step::Forget
                        }
                    }
                }
            } else {
                Step::Go(st.gen, st.anchor.clone(), st.remote, st.closing, st.size)
            }
        }
    };
    let (gen, anchor, remote, closing, size) = match step {
        Step::Done => return Ok(()),
        Step::Forget => {
            inner.forget(pane.id);
            return Ok(());
        }
        Step::Go(gen, anchor, remote, closing, size) => (gen, anchor, remote, closing, size),
    };

    if closing {
        let target = match remote {
            Some(remote) => Some(remote),
            None => match find(inner, pane, client, boot).await {
                Ok(found) => found,
                Err(e) if e.is_disconnected() => return Ok(()),
                Err(e) => return Err(e.into()),
            },
        };
        if let Some(target) = target {
            match client.pty_close(target).await {
                Ok(()) => {}
                Err(e) if e.is_disconnected() => return Ok(()),
                Err(e) if e.code() == Some(&ErrorCode::NotFound) => {}
                Err(e) => return Err(e.into()),
            }
        }
        pane.lock().ended = true;
        inner.forget(pane.id);
        return Ok(());
    }

    let remote = match remote {
        Some(remote) => remote,
        None => {
            let _opening = if inner.profile.adopt_all {
                Some(inner.opening.lock().await)
            } else {
                None
            };
            // Waiting for `opening` can take as long as someone else's open: the
            // pane may have been lost meanwhile (its wait ran out), and a lost
            // pane starts nothing.
            if pane.lock().lost {
                return Ok(());
            }
            let found = match find(inner, pane, client, boot).await {
                Ok(found) => found,
                Err(e) if e.is_disconnected() => return Ok(()),
                Err(e) => return Err(e.into()),
            };
            let (remote, opened_here) = match found {
                Some(remote) => (remote, false),
                None => {
                    let spec = &pane.spec;
                    let owner = pane.lock().owner.clone();
                    let env = pane
                        .lock()
                        .launch
                        .clone()
                        .map(|l| l.env)
                        .unwrap_or_default();
                    let params = PtyOpenParams {
                        cwd: spec.cwd.clone(),
                        command: spec.command.clone(),
                        args: spec.args.clone(),
                        cols: size.0,
                        rows: size.1,
                        env,
                        base_env: base_env_for(inner, &hello),
                        owner,
                        label: spec.label.clone(),
                        agent_kind: spec.agent_kind,
                    };
                    let opened =
                        within(inner, client, "opening a session", client.pty_open(&params)).await;
                    match opened {
                        Ok(info) => {
                            // The table has this session now: a read that
                            // reused the listing from before it would see the
                            // pane bound to a session "not alive", with
                            // nothing to say the listing is old.
                            inner.invalidate_listing();
                            (info.id, true)
                        }
                        Err(e) if e.is_disconnected() => return Ok(()),
                        Err(e) => {
                            return Err(anyhow!("{name} couldn't start the terminal: {e}"));
                        }
                    }
                }
            };
            let committed = {
                let mut st = pane.lock();
                if st.lost {
                    false
                } else {
                    // The session exists (started, or found already running):
                    // nothing later opens it again, so its secrets are let go.
                    st.launch = None;
                    st.remote = Some(remote);
                    st.boot = Some(boot.to_string());
                    st.opened_here = opened_here;
                    if !opened_here {
                        st.seed = None;
                    }
                    true
                }
            };
            if !committed {
                // Lost while the host was opening it (its wait ran out): nobody
                // will ever attach to, type into or close this session, so it
                // is closed here. A session found already running is left to
                // the host.
                if opened_here {
                    if let Err(e) = client.pty_close(remote).await {
                        log::debug!("{name}: closing a session opened for a lost pane: {e}");
                    }
                }
                return Ok(());
            }
            remote
        }
    };

    let attached = within(
        inner,
        client,
        "attaching a session",
        client.pty_attach(remote, anchor),
    )
    .await;
    let (result, events) = match attached {
        Ok(attached) => attached,
        Err(e) if e.code() == Some(&ErrorCode::NotFound) => {
            log::info!("{name}: pane {}'s session is gone from the host", pane.id);
            match inner.profile.on_gone {
                // The host no longer has the session (it restarted): the
                // process is gone, which is the one thing besides `pty.exit`
                // that ends a pane.
                Gone::End => {
                    pane.lock().end();
                    inner.forget(pane.id);
                }
                Gone::Lost => pane.lock().lose(),
            }
            return Ok(());
        }
        Err(e) => {
            if !e.is_disconnected() {
                log::warn!("{name}: attaching pane {}: {e}", pane.id);
            }
            return Ok(());
        }
    };

    let (gen, seed, resize) = {
        let mut st = pane.lock();
        if st.gen != gen || st.ended || st.closing {
            // Superseded while the host answered; the newer step attaches again.
            return Ok(());
        }
        // This attach's own generation: the pump of the one it replaces (on a
        // link that died) must not report on this one when it finally ends.
        st.gen += 1;
        let gen = st.gen;
        if !result.data.is_empty() {
            if let Some(sinks) = &st.sinks {
                (sinks.output)(result.data);
            }
        }
        st.anchor = Anchor::At {
            epoch: result.epoch.clone(),
            seq: result.seq,
        };
        st.attached = Some(Attached {
            epoch: result.epoch,
            seq: result.seq,
            mode: result.mode,
        });
        st.on = Some(client.clone());
        st.tell(PaneLink::Live);
        // Only a line still fresh: one queued before a link that stayed down
        // for longer than a pane may wait is a command nobody asked for now.
        let ttl = inner.timing.unbound_ttl;
        let seed = if st.opened_here {
            st.seed
                .take()
                .filter(|(_, queued)| queued.elapsed() < ttl)
                .map(|(line, _)| line)
        } else {
            None
        };
        let resize = std::mem::take(&mut st.resize_due).then_some(st.size);
        (gen, seed, resize)
    };
    if let Some(seed) = seed {
        let _ = pane.input.send((gen, seed.into()));
    }
    if let Some((cols, rows)) = resize {
        if let Err(e) = client.pty_resize(remote, cols, rows).await {
            log::debug!("{name}: resizing pane {}: {e}", pane.id);
        }
    }
    tokio::spawn(pump(inner.clone(), pane.clone(), gen, events));
    Ok(())
}

/// The environment a session on this host inherits beneath its own `env`: the
/// profile's, and none at all on a host whose profile takes none (Daedalus) —
/// the one place this Mac's environment is kept off the box. Sent only to a
/// host that honours it: an older one would drop it silently, and the session
/// would run on the host's own minimal environment.
fn base_env_for(inner: &Inner, hello: &HelloResult) -> Vec<(String, String)> {
    let Some(profile_env) = inner.profile.base_env else {
        return Vec::new();
    };
    let env = profile_env();
    if !env.is_empty() && !hello.has(feature::PTY_BASE_ENV) {
        log::warn!(
            "{}: the host doesn't take a base environment; its sessions run on its own",
            inner.profile.name
        );
        return Vec::new();
    }
    env
}

/// A pane the host refused to start on a later connect: say so in the pane,
/// and stop trying. No exit is sent, so the tab stays with the reason on it.
fn fail(inner: &Inner, pane: &Pane, e: &anyhow::Error) {
    log::warn!("{}: pane {}: {e:#}", inner.profile.name, pane.id);
    {
        let mut st = pane.lock();
        st.ended = true;
        if let Some(sinks) = &st.sinks {
            (sinks.output)(format!("\r\n\x1b[31m[{e}]\x1b[0m\r\n").into_bytes());
        }
    }
    inner.forget(pane.id);
}

/// Forward one attach's output until it ends: the process exits (the pane
/// ends), or the view does — superseded by a newer attach, detached, or the
/// link lost (the pane waits, `Reconnecting`).
async fn pump(
    inner: Arc<Inner>,
    pane: Arc<Pane>,
    gen: u64,
    mut events: mpsc::UnboundedReceiver<PtyEvent>,
) {
    while let Some(event) = events.recv().await {
        let mut st = pane.lock();
        if st.gen != gen {
            return;
        }
        match event {
            PtyEvent::Data(bytes) => {
                if let Anchor::At { seq, .. } = &mut st.anchor {
                    *seq += bytes.len() as u64;
                }
                if let Some(sinks) = &st.sinks {
                    (sinks.output)(bytes);
                }
            }
            PtyEvent::Exit => {
                st.end();
                drop(st);
                inner.forget(pane.id);
                inner.invalidate_listing();
                return;
            }
        }
    }
    let mut st = pane.lock();
    if st.gen == gen && !st.ended && !st.lost {
        st.on = None;
        st.tell(PaneLink::Reconnecting);
    }
}

/// A pane's keystrokes, one `pty.write` at a time so they arrive in order;
/// whatever queued up behind a write goes in the next one. Keystrokes typed at
/// an attach that has since been replaced (a re-attach after a dropped link)
/// are dropped: they were typed at a pane that couldn't reach its session.
async fn write_loop(
    name: String,
    pane: Weak<Pane>,
    mut keys: mpsc::UnboundedReceiver<(u64, PtyInput)>,
) {
    while let Some((gen, first)) = keys.recv().await {
        let mut batch = vec![(gen, first.into_bytes())];
        while let Ok((gen, more)) = keys.try_recv() {
            match batch.last_mut() {
                Some((last, data)) if *last == gen => data.extend(more.into_bytes()),
                _ => batch.push((gen, more.into_bytes())),
            }
        }
        let Some(pane) = pane.upgrade() else {
            return;
        };
        for (gen, data) in batch {
            let target = {
                let st = pane.lock();
                (st.gen == gen && st.live())
                    .then(|| st.remote.zip(st.on.clone()))
                    .flatten()
            };
            let Some((remote, client)) = target else {
                log::debug!(
                    "{name}: pane {} can't reach its session; input dropped",
                    pane.id
                );
                continue;
            };
            // The one `pty.write` santree sends: clippy.toml's sanctioned site.
            #[allow(clippy::disallowed_methods)]
            let written = client.pty_write(remote, data).await;
            if let Err(e) = written {
                log::debug!("{name}: writing to pane {}: {e}", pane.id);
            }
        }
    }
}
