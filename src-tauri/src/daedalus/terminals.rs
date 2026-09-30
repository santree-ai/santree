//! Terminals whose shell runs on Daedalus: the panes of a Daedalus project,
//! each a PTY on the box reached through the link (docs/remote.md, "Terminals
//! on the box"; docs/terminals.md, "Remote sessions").
//!
//! The frontend sees the same terminal it always does — an id, a byte channel,
//! attach/detach — and one more signal, [`PaneLink`]: whether the pane is
//! reaching its session right now. Everything about the box is here:
//!
//! - **Ids.** A pane is named by an app-side id from [`FIRST_ID`] up, a range
//!   `PtyManager` never reaches, so `terminal.rs` tells the two apart without
//!   asking anyone. The box's own session id is bound to it once opened (or
//!   found).
//! - **Anchors.** Every byte forwarded advances the pane's anchor; a link that
//!   drops leaves the pane `Reconnecting` (never exited — only `pty.exit`, or a
//!   host that no longer has the session, ends one), and every [`Reconnected`]
//!   re-attaches it with that anchor, so the box replays exactly what was
//!   missed.
//! - **Finding a session again.** A pane with nothing bound — opened while the
//!   link was down, or after santree was relaunched — looks for a live session
//!   on the box with its own address (label and provider, `pty.sessions`)
//!   before opening a new one. That is what makes a remote pane survive
//!   santree quitting: the process never stopped, and the new app finds it by
//!   the same identity the old one opened it under.
//! - **Order.** The network half of attach, detach and close runs one at a time
//!   per pane (`turn`), so the host sees them in the order they were asked;
//!   keystrokes go through one writer per pane, coalesced, in order. Input
//!   typed while the pane can't reach its session is dropped, never replayed
//!   later into whatever the program is doing by then.
//!
//! [`Reconnected`]: santree_remote_client::Reconnected

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};

use anyhow::{anyhow, Result};
use tokio::sync::{broadcast, mpsc};

use santree_core::domain::AgentKind;
use santree_pty::SessionId;
use santree_remote_client::proto::{
    Anchor, ErrorCode, PtyOpenParams, ReplayMode, SessionId as BoxSessionId,
};
use santree_remote_client::{PtyEvent, RemoteClient, RemoteError, RemoteHost};

use crate::terminal::PaneLink;

/// The first app-side id of a remote pane. `PtyManager` counts its own from 1
/// and would need two billion sessions in one run to get here.
pub const FIRST_ID: SessionId = 1 << 31;

/// Whether `id` names a pane on Daedalus rather than a local PTY.
pub fn is_remote(id: SessionId) -> bool {
    id >= FIRST_ID
}

/// Where a pane's output goes: raw bytes (empty = the process exited, as for
/// a local session), and the pane's link state.
#[derive(Clone)]
pub struct Sinks {
    pub output: Arc<dyn Fn(Vec<u8>) + Send + Sync>,
    pub link: Arc<dyn Fn(PaneLink) + Send + Sync>,
}

/// What a remote pane runs, and where. `cwd` is a path on the box.
#[derive(Debug, Clone)]
pub struct Spec {
    pub cwd: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub label: String,
    pub agent_kind: Option<AgentKind>,
}

/// A pane handed over from a previous page load.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Adopted {
    pub id: SessionId,
    pub label: String,
    pub agent_kind: Option<AgentKind>,
    pub cwd: String,
    pub command: String,
}

/// What an attach answered: where the pane is in its session's stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attached {
    pub epoch: String,
    pub seq: u64,
    pub mode: ReplayMode,
}

/// The remote panes of this app. Cheap to clone (one shared registry); one per
/// [`RemoteHost`].
#[derive(Clone)]
pub struct RemoteTerminals {
    inner: Arc<Inner>,
}

struct Inner {
    host: Arc<RemoteHost>,
    panes: Mutex<HashMap<SessionId, Arc<Pane>>>,
    next: AtomicU32,
    watching: OnceLock<()>,
}

struct Pane {
    id: SessionId,
    spec: Spec,
    /// One network step (attach, detach, close) at a time, in call order.
    turn: tokio::sync::Mutex<()>,
    st: Mutex<State>,
    /// Keystrokes, each tagged with the attach (`gen`) it was typed at.
    input: mpsc::UnboundedSender<(u64, Vec<u8>)>,
}

struct State {
    /// The webview page this pane belongs to (`terminal_adopt`).
    owner: String,
    /// The box's session, once opened or found.
    remote: Option<BoxSessionId>,
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
    /// A launch line waiting for the session this pane is about to open.
    seed: Option<String>,
    /// The tab was closed: end the session as soon as the box can be told.
    closing: bool,
    /// Nothing more happens: the process exited, the box lost it, or it
    /// could not be started.
    ended: bool,
}

impl Pane {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl State {
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
        self.ended = true;
        self.on = None;
        if let Some(sinks) = &self.sinks {
            (sinks.output)(Vec::new());
        }
    }
}

impl RemoteTerminals {
    pub fn new(host: Arc<RemoteHost>) -> Self {
        Self {
            inner: Arc::new(Inner {
                host,
                panes: Mutex::new(HashMap::new()),
                next: AtomicU32::new(FIRST_ID),
                watching: OnceLock::new(),
            }),
        }
    }

    /// Re-attach every waiting pane on each (re)connect. Idempotent; call it
    /// from inside the runtime once the link starts.
    pub fn watch(&self) {
        if self.inner.watching.set(()).is_err() {
            return;
        }
        let inner = self.inner.clone();
        let mut reconnected = inner.host.reconnected();
        tokio::spawn(async move {
            loop {
                match reconnected.recv().await {
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return,
                }
                let Some(client) = inner.host.client() else {
                    continue;
                };
                for pane in inner.waiting() {
                    let (inner, client) = (inner.clone(), client.clone());
                    tokio::spawn(async move {
                        if let Err(e) = bind(&inner, &pane, &client).await {
                            fail(&inner, &pane, &e);
                        }
                    });
                }
            }
        });
    }

    /// Open a pane running `spec` on the box. With a `client` the session is
    /// opened (or found) now and a refusal is this call's error; without one
    /// the pane waits, `Reconnecting`, and opens on the next connect.
    pub async fn open(
        &self,
        spec: Spec,
        owner: String,
        size: (u16, u16),
        client: Option<Arc<RemoteClient>>,
        sinks: Sinks,
    ) -> Result<SessionId> {
        let id = self.inner.next.fetch_add(1, Ordering::Relaxed);
        let (input, keys) = mpsc::unbounded_channel();
        let pane = Arc::new(Pane {
            id,
            spec,
            turn: tokio::sync::Mutex::new(()),
            st: Mutex::new(State {
                owner,
                remote: None,
                opened_here: false,
                anchor: Anchor::Fresh,
                sinks: Some(sinks),
                gen: 0,
                on: None,
                told: None,
                attached: None,
                size,
                resize_due: false,
                seed: None,
                closing: false,
                ended: false,
            }),
            input,
        });
        self.inner.lock().insert(id, pane.clone());
        tokio::spawn(write_loop(Arc::downgrade(&pane), keys));
        if let Some(client) = client {
            if let Err(e) = bind(&self.inner, &pane, &client).await {
                self.inner.forget(id);
                return Err(e);
            }
        }
        let mut st = pane.lock();
        if !st.live() && !st.ended {
            st.tell(PaneLink::Reconnecting);
        }
        Ok(id)
    }

    /// Point pane `id`'s output at `sinks`, resuming from `anchor` — what the
    /// frontend's anchor says it already has. Answers the host's attach, or,
    /// while the pane can't reach its session, a `Reanchor` with nothing sent.
    pub async fn attach(&self, id: SessionId, anchor: Anchor, sinks: Sinks) -> Result<Attached> {
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
        if !st.live() && !st.ended {
            st.tell(PaneLink::Reconnecting);
        }
        Ok(st.attached.clone().unwrap_or(Attached {
            epoch: String::new(),
            seq: 0,
            mode: ReplayMode::Reanchor,
        }))
    }

    /// Stop showing pane `id`; its process keeps running on the box.
    pub fn detach(&self, id: SessionId) {
        let Ok(pane) = self.inner.pane(id) else {
            return;
        };
        let (gen, remote) = {
            let mut st = pane.lock();
            (st.retarget(None), st.remote)
        };
        let Some(remote) = remote else {
            return;
        };
        let host = self.inner.host.clone();
        tokio::spawn(async move {
            let _turn = pane.turn.lock().await;
            if pane.lock().gen != gen {
                return;
            }
            if let Some(client) = host.client() {
                if let Err(e) = client.pty_detach(remote).await {
                    log::debug!("daedalus: detaching pane {}: {e}", pane.id);
                }
            }
        });
    }

    /// End pane `id` and its process. While the link is down the pane waits
    /// for it and closes on the next connect.
    pub fn close(&self, id: SessionId) {
        let Ok(pane) = self.inner.pane(id) else {
            return;
        };
        {
            let mut st = pane.lock();
            st.retarget(None);
            st.closing = true;
        }
        if let Some(client) = self.inner.host.client() {
            let inner = self.inner.clone();
            tokio::spawn(async move {
                if let Err(e) = bind(&inner, &pane, &client).await {
                    log::warn!("daedalus: closing pane {}: {e:#}", pane.id);
                }
            });
        }
    }

    /// The user's keystrokes, in order, to the attach they were typed at.
    /// Dropped while the pane can't reach its session.
    pub fn write(&self, id: SessionId, bytes: Vec<u8>) -> Result<()> {
        let pane = self.inner.pane(id)?;
        let gen = {
            let st = pane.lock();
            if !st.live() {
                log::debug!("daedalus: pane {id} can't reach its session; input dropped");
                return Ok(());
            }
            st.gen
        };
        pane.input
            .send((gen, bytes))
            .map_err(|_| anyhow!("no terminal session {id}"))
    }

    /// The one launch line, typed into a session this pane opens itself —
    /// now, or as soon as it is attached. A session found again is already
    /// running its launch, so the line is not typed twice.
    pub fn seed(&self, id: SessionId, line: String) -> Result<()> {
        let pane = self.inner.pane(id)?;
        let mut st = pane.lock();
        if st.remote.is_some() && !st.opened_here {
            log::info!(
                "daedalus: pane {id} found its session running; not typing its launch again"
            );
            return Ok(());
        }
        if !st.live() {
            st.seed = Some(line);
            return Ok(());
        }
        let gen = st.gen;
        drop(st);
        pane.input
            .send((gen, line.into_bytes()))
            .map_err(|_| anyhow!("no terminal session {id}"))
    }

    /// The grid the pane shows. Sent now when it can be, else after the next
    /// re-attach.
    pub fn resize(&self, id: SessionId, cols: u16, rows: u16) -> Result<()> {
        let pane = self.inner.pane(id)?;
        let mut st = pane.lock();
        st.size = (cols, rows);
        let on = st.on.clone().filter(|_| st.live());
        match (st.remote, on) {
            (Some(remote), Some(client)) => {
                drop(st);
                tokio::spawn(async move {
                    if let Err(e) = client.pty_resize(remote, cols, rows).await {
                        log::debug!("daedalus: resizing pane {}: {e}", pane.id);
                    }
                });
            }
            _ => st.resize_due = true,
        }
        Ok(())
    }

    /// Hand every pane of another page to `owner`, and say which they are.
    pub fn adopt(&self, owner: &str) -> Vec<Adopted> {
        self.inner
            .lock()
            .values()
            .filter_map(|pane| {
                let mut st = pane.lock();
                if st.ended || st.closing || st.owner == owner {
                    return None;
                }
                st.owner = owner.to_string();
                Some(Adopted {
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
    fn lock(&self) -> MutexGuard<'_, HashMap<SessionId, Arc<Pane>>> {
        self.panes.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn pane(&self, id: SessionId) -> Result<Arc<Pane>> {
        self.lock()
            .get(&id)
            .cloned()
            .ok_or_else(|| anyhow!("no terminal session {id}"))
    }

    fn forget(&self, id: SessionId) {
        self.lock().remove(&id);
    }

    /// Panes a connect has work for: shown but not attached, or closed while
    /// the box couldn't be told.
    fn waiting(&self) -> Vec<Arc<Pane>> {
        self.lock()
            .values()
            .filter(|pane| {
                let st = pane.lock();
                !st.ended && !st.live() && (st.sinks.is_some() || st.closing)
            })
            .cloned()
            .collect()
    }

    /// Box sessions other panes already hold.
    fn bound_elsewhere(&self, id: SessionId) -> HashSet<BoxSessionId> {
        self.lock()
            .values()
            .filter(|pane| pane.id != id)
            .filter_map(|pane| pane.lock().remote)
            .collect()
    }
}

/// A pane's live session on the box with its own address — label and
/// provider — that no other pane holds; the newest when there are several.
async fn find(
    inner: &Inner,
    pane: &Pane,
    client: &RemoteClient,
) -> Result<Option<BoxSessionId>, RemoteError> {
    let taken = inner.bound_elsewhere(pane.id);
    Ok(client
        .pty_sessions()
        .await?
        .into_iter()
        .filter(|s| {
            s.alive
                && s.label == pane.spec.label
                && s.agent_kind == pane.spec.agent_kind
                && !taken.contains(&s.id)
        })
        .map(|s| s.id)
        .max())
}

/// Bring pane `pane` up to date with the box over `client`: close it when
/// its tab was closed, else open or find its session and attach from its
/// anchor. A lost link is not an error — the pane stays `Reconnecting` for
/// the next connect; the box refusing to open the session is.
async fn bind(inner: &Arc<Inner>, pane: &Arc<Pane>, client: &Arc<RemoteClient>) -> Result<()> {
    let _turn = pane.turn.lock().await;
    let (gen, anchor, remote, closing, size) = {
        let mut st = pane.lock();
        if st.ended || st.live() || (st.sinks.is_none() && !st.closing) {
            return Ok(());
        }
        if st.on.take().is_some() {
            // Its link died and the connect beat the pump to noticing: the
            // pane was cut off all the same, and says so before it resumes.
            st.tell(PaneLink::Reconnecting);
        }
        (st.gen, st.anchor.clone(), st.remote, st.closing, st.size)
    };

    if closing {
        let target = match remote {
            Some(remote) => Some(remote),
            None => match find(inner, pane, client).await {
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
            let found = match find(inner, pane, client).await {
                Ok(found) => found,
                Err(e) if e.is_disconnected() => return Ok(()),
                Err(e) => return Err(e.into()),
            };
            let (remote, opened_here) = match found {
                Some(remote) => (remote, false),
                None => {
                    let spec = &pane.spec;
                    let owner = pane.lock().owner.clone();
                    let opened = client
                        .pty_open(&PtyOpenParams {
                            cwd: Some(spec.cwd.clone()),
                            command: spec.command.clone(),
                            args: spec.args.clone(),
                            cols: size.0,
                            rows: size.1,
                            env: spec.env.clone(),
                            owner,
                            label: spec.label.clone(),
                            agent_kind: spec.agent_kind,
                        })
                        .await;
                    match opened {
                        Ok(info) => (info.id, true),
                        Err(e) if e.is_disconnected() => return Ok(()),
                        Err(e) => return Err(anyhow!("Daedalus couldn't start the terminal: {e}")),
                    }
                }
            };
            let mut st = pane.lock();
            st.remote = Some(remote);
            st.opened_here = opened_here;
            if !opened_here {
                st.seed = None;
            }
            remote
        }
    };

    let (result, events) = match client.pty_attach(remote, anchor).await {
        Ok(attached) => attached,
        Err(e) if e.code() == Some(&ErrorCode::NotFound) => {
            // The box no longer has the session (it restarted): the process is
            // gone, which is the one thing besides `pty.exit` that ends a pane.
            log::info!("daedalus: pane {}'s session is gone from the box", pane.id);
            pane.lock().end();
            inner.forget(pane.id);
            return Ok(());
        }
        Err(e) => {
            if !e.is_disconnected() {
                log::warn!("daedalus: attaching pane {}: {e}", pane.id);
            }
            return Ok(());
        }
    };

    let (gen, seed, resize) = {
        let mut st = pane.lock();
        if st.gen != gen || st.ended || st.closing {
            // Superseded while the box answered; the newer step attaches again.
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
        let seed = if st.opened_here { st.seed.take() } else { None };
        let resize = std::mem::take(&mut st.resize_due).then_some(st.size);
        (gen, seed, resize)
    };
    if let Some(seed) = seed {
        let _ = pane.input.send((gen, seed.into_bytes()));
    }
    if let Some((cols, rows)) = resize {
        if let Err(e) = client.pty_resize(remote, cols, rows).await {
            log::debug!("daedalus: resizing pane {}: {e}", pane.id);
        }
    }
    tokio::spawn(pump(inner.clone(), pane.clone(), gen, events));
    Ok(())
}

/// A pane the box refused to start on a later connect: say so in the pane,
/// and stop trying. No exit is sent, so the tab stays with the reason on it.
fn fail(inner: &Inner, pane: &Pane, e: &anyhow::Error) {
    log::warn!("daedalus: pane {}: {e:#}", pane.id);
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
                return;
            }
        }
    }
    let mut st = pane.lock();
    if st.gen == gen && !st.ended {
        st.on = None;
        st.tell(PaneLink::Reconnecting);
    }
}

/// A pane's keystrokes, one `pty.write` at a time so they arrive in order;
/// whatever queued up behind a write goes in the next one. Keystrokes typed at
/// an attach that has since been replaced (a re-attach after a dropped link)
/// are dropped: they were typed at a pane that couldn't reach its session.
async fn write_loop(pane: Weak<Pane>, mut keys: mpsc::UnboundedReceiver<(u64, Vec<u8>)>) {
    while let Some(first) = keys.recv().await {
        let mut batch = vec![first];
        while let Ok(more) = keys.try_recv() {
            match batch.last_mut() {
                Some((gen, data)) if *gen == more.0 => data.extend(more.1),
                _ => batch.push(more),
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
                    "daedalus: pane {} can't reach its session; input dropped",
                    pane.id
                );
                continue;
            };
            if let Err(e) = client.pty_write(remote, data).await {
                log::debug!("daedalus: writing to pane {}: {e}", pane.id);
            }
        }
    }
}
