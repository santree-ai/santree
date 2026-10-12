//! Protocol v1, served (docs/remote.md "Protocol v1").
//!
//! The one implementation of the host side of santree's protocol: PTY sessions
//! that outlive their client, `exec.run`, `fs.*` and a hook queue. Three
//! embedders bring their own transport and their own idea of who may connect:
//!
//! - the local **santree server** (`crates/server`): a unix socket, PTYs only;
//! - the **test daemon** (`santree-remote-client`'s `fake`): an in-memory link,
//!   everything on, plus test controls through an [`Extension`];
//! - Daedalus's **session host** (not yet on this crate): pinned TLS,
//!   confinement to a projects root, `workspaces.*` through an [`Extension`].
//!
//! Behaviour the doc leaves open is decided here once, so code that passes
//! against one embedder passes against all of them:
//!
//! - the `pty.attach` response is written before any `pty.data` of that
//!   attach (a gate buffers chunks until the response is queued);
//! - attaching to a session whose process already ended answers, then sends
//!   `pty.exit`;
//! - `pty.close` ends with `pty.exit` to the session's receiver, after what
//!   the process printed last;
//! - a dropped connection, and `pty.detach`, only detach the sessions *that
//!   connection* is the receiver of;
//! - `hooks.subscribe` has one subscriber at a time, the newest.
//!
//! What the host enforces on top ([`Caps`]): sessions, requests in flight,
//! connections and blocking work per node, bytes queued per connection, and a
//! session's input queue. A session whose receiver reads slower than it
//! prints is **paced** — its reader waits for the connection to drain, so the
//! process blocks on a full terminal like it would in any terminal — instead
//! of the whole connection being dropped; only a receiver that reads nothing
//! for [`Caps::stall`] loses its link (its sessions park, nothing is lost).

mod conn;
mod exec;
mod framing;
mod fsops;
mod hooks;
mod pty;
#[cfg(test)]
mod tests;
mod util;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use santree_pty::PtyManager;
use santree_remote_proto::*;
use serde::Serialize;
use serde_json::value::RawValue;
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

pub use conn::{serve_conn, Peer};
pub use fsops::Root;
pub use santree_pty;
pub use santree_remote_proto as proto;

use conn::Conn;
use fsops::Confine;
use hooks::HookQueue;
use pty::{pty_err, SessState};
use util::{busy, check_env, err, lock};

/// The longest request line accepted, the client's own cap.
pub const MAX_REQUEST_LINE: usize = 32 * 1024 * 1024;
/// What one queued line costs besides its text (its allocation and its
/// slot), so a flood of tiny lines still fills the queue.
pub const LINE_OVERHEAD: usize = 64;
/// Hook events cloned from the queue per lock while a backlog is sent.
const BACKLOG_CHUNK: usize = 256;
/// How long a closing connection's writer may take to write what is still
/// queued and shut its side down, so the peer gets its last answers and can
/// tell a close from a cut.
const WRITER_CLOSE: Duration = Duration::from_secs(1);
/// The longest `hello.client` logged.
pub const MAX_CLIENT_NAME: usize = 128;
/// The features this crate serves on its own, beyond every v1 method; an
/// embedder names them in [`HostOptions::features`] with its own.
pub const BUILTIN_FEATURES: &[&str] = &[feature::PTY_BASE_ENV, feature::PTY_MODES];

/// The host's limits. The defaults are the session host's, sized for a box
/// several machines share; an embedder with one trusted client may raise them.
#[derive(Debug, Clone)]
pub struct Caps {
    /// PTY sessions, live or exited (each holds a 2 MiB ring).
    pub max_ptys: usize,
    /// Requests one connection may have running at once; more get `busy`.
    pub max_in_flight: usize,
    /// Connections one node may hold at once; another is closed at once.
    pub max_conns_per_node: usize,
    /// Blocking work (the handlers that run on tokio's blocking pool) one node
    /// may have running at once; more get `busy`. Counted per node and held by
    /// the work itself until it returns: a reconnect does not reset it.
    pub max_blocking_per_node: usize,
    /// Bytes queued for one connection's writer, each line counted with
    /// [`LINE_OVERHEAD`]. The last resort: sessions are paced long before it
    /// (`pace_high`), so only an unbounded producer (a hook backlog to a peer
    /// that stopped reading) reaches it, and the link is then dropped.
    pub out_queue_bytes: usize,
    /// Bytes queued for a connection above which a session's output waits for
    /// it to drain.
    pub pace_high: usize,
    /// How long a paced session waits on a connection that drains nothing
    /// before the connection is dropped (its sessions park; the ring replays).
    pub stall: Duration,
    /// Bytes waiting to be written into one PTY (`pty.write`): a program that
    /// does not read its input fills it, and further writes get `busy`.
    pub pty_input_queue: usize,
    /// PTY input threads at once: one per session that was written to, plus
    /// any a closed session left parked in the kernel.
    pub max_input_threads: usize,
    /// How long a `pty.write` waits for its bytes to go in before it answers
    /// `timeout` (they stay queued, in order).
    pub pty_write_timeout: Duration,
    /// Hook events kept for a subscriber, by count and by bytes.
    pub hook_queue_cap: usize,
    pub hook_queue_bytes: usize,
}

impl Default for Caps {
    fn default() -> Self {
        Self {
            max_ptys: 64,
            max_in_flight: 32,
            max_conns_per_node: 4,
            max_blocking_per_node: 32,
            out_queue_bytes: 128 * 1024 * 1024,
            pace_high: 4 * 1024 * 1024,
            stall: Duration::from_secs(30),
            pty_input_queue: 1024 * 1024,
            max_input_threads: 128,
            pty_write_timeout: Duration::from_secs(10),
            hook_queue_cap: HOOK_QUEUE_CAP,
            hook_queue_bytes: 64 * 1024 * 1024,
        }
    }
}

/// Which of the protocol's method groups this host serves. PTYs always.
#[derive(Debug, Clone, Copy)]
pub struct Methods {
    /// `exec.run`.
    pub exec: bool,
    /// `fs.read`, `fs.write`, `fs.stat`.
    pub fs: bool,
    /// `hooks.subscribe`, `hooks.ack`.
    pub hooks: bool,
    /// `hooks.push` on the link itself. Only where whoever holds the link may
    /// also inject hook events — never on a host machines share.
    pub hooks_push: bool,
}

impl Methods {
    pub const ALL: Self = Self {
        exec: true,
        fs: true,
        hooks: true,
        hooks_push: true,
    };
    pub const PTY_ONLY: Self = Self {
        exec: false,
        fs: false,
        hooks: false,
        hooks_push: false,
    };
}

#[derive(Clone)]
pub struct HostOptions {
    /// The protocol `hello` accepts. [`PROTOCOL_VERSION`] outside tests.
    pub protocol: u32,
    /// `hello`'s `version`: the embedder's own.
    pub version: String,
    pub hostname: String,
    pub user: String,
    pub home: String,
    /// `hello`'s `projectsRoot`.
    pub projects_root: String,
    /// `hello`'s `hookBin`.
    pub hook_bin: String,
    /// `hello`'s `features`, exactly: [`BUILTIN_FEATURES`] and whatever the
    /// embedder's [`Extension`] serves.
    pub features: Vec<String>,
    /// Confine working directories and writes under this root.
    pub confine: Option<PathBuf>,
    /// The host's own environment for every `exec.run` and `pty.open` child,
    /// under a request's `env` and over a session's `baseEnv` — or, for a
    /// session opened without one, over this process's environment.
    pub env: Vec<(String, String)>,
    /// Refuse a `pty.open` that carries no `baseEnv`. Where the host's own
    /// process environment is not something a session should ever inherit —
    /// the local server's is whatever launched it — the client must say what
    /// the session inherits. Off for the test daemon and Daedalus, whose
    /// sessions stand in the host's environment.
    pub require_base_env: bool,
    pub methods: Methods,
    pub caps: Caps,
    pub ping_interval: Duration,
}

impl std::fmt::Debug for HostOptions {
    /// `env` by name only: it is the host's own environment.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostOptions")
            .field("protocol", &self.protocol)
            .field("version", &self.version)
            .field("hostname", &self.hostname)
            .field("user", &self.user)
            .field("home", &self.home)
            .field("projects_root", &self.projects_root)
            .field("hook_bin", &self.hook_bin)
            .field("features", &self.features)
            .field("confine", &self.confine)
            .field("env", &santree_remote_proto::EnvNames(&self.env))
            .field("require_base_env", &self.require_base_env)
            .field("methods", &self.methods)
            .field("caps", &self.caps)
            .field("ping_interval", &self.ping_interval)
            .finish()
    }
}

impl HostOptions {
    /// This machine and its user as `hello` reports them; everything else at
    /// its default, PTYs only.
    pub fn local(version: impl Into<String>) -> Self {
        let (user, home) = sys::user_and_home();
        Self {
            protocol: PROTOCOL_VERSION,
            version: version.into(),
            hostname: sys::hostname(),
            projects_root: home.clone(),
            user,
            home,
            hook_bin: String::new(),
            features: BUILTIN_FEATURES.iter().map(|f| f.to_string()).collect(),
            confine: None,
            env: Vec::new(),
            require_base_env: false,
            methods: Methods::PTY_ONLY,
            caps: Caps::default(),
            ping_interval: PING_INTERVAL,
        }
    }
}

/// Methods an embedder serves besides the protocol's own, and what it wants
/// to see of each request.
pub trait Extension: Send + Sync + 'static {
    /// Every request, after `hello` and before it is dispatched.
    fn observe(&self, _request: &RawRequest) {}

    /// Answer `request` when it is this extension's, on the async side (an
    /// extension with blocking work moves it to the blocking pool itself).
    /// Asked only for methods the host does not serve itself.
    fn handle(&self, _host: &Arc<Host>, _request: &RawRequest) -> Option<BoxFuture<Outcome>> {
        None
    }

    /// Every request, once its answer is queued on its connection: nothing
    /// queued later overtakes it, and a connection closed from here on still
    /// writes it (within [`WRITER_CLOSE`]). Where an effect must follow the
    /// answer — `server.stop` closing the very connection it answers on.
    fn answered(&self, _request: &RawRequest) {}
}

pub type BoxFuture<T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'static>>;
pub type Outcome = Result<Box<RawValue>, WireError>;

/// A result as a response's `ok`.
pub fn ok<T: Serialize>(value: &T) -> Outcome {
    serde_json::value::to_raw_value(value).map_err(|e| err(ErrorCode::Io, e.to_string()))
}

pub use util::{err as wire_err, io_err};

// ── the host ──────────────────────────────────────────────────────────────

pub struct Host {
    opts: HostOptions,
    confine: Confine,
    /// `hello`'s `bootId`: fresh per host.
    boot_id: String,
    mgr: PtyManager,
    sessions: Mutex<HashMap<SessionId, Arc<SessState>>>,
    extension: Option<Arc<dyn Extension>>,
    /// Held across a `pty.open`'s count and open, so `max_ptys` is exact.
    opening: Mutex<()>,
    hooks: Mutex<HookQueue>,
    /// Each node's blocking work ([`Caps::max_blocking_per_node`]).
    blocking: Mutex<HashMap<String, Arc<Semaphore>>>,
    /// PTY input threads alive ([`Caps::max_input_threads`]).
    inputs: Arc<AtomicUsize>,
    next_conn: AtomicU64,
    /// Each connection's node and its close signal.
    conns: Mutex<HashMap<u64, (String, Arc<Notify>)>>,
    /// Raised on every change a status reader reports.
    changed: Arc<Notify>,
}

impl Drop for Host {
    fn drop(&mut self) {
        self.mgr.close_all();
    }
}

impl Host {
    pub fn new(opts: HostOptions, extension: Option<Arc<dyn Extension>>) -> Arc<Self> {
        let confine = match &opts.confine {
            Some(root) => Confine::Root(Root::new(root.clone())),
            None => Confine::None,
        };
        Arc::new(Self {
            hooks: Mutex::new(HookQueue::new(
                opts.caps.hook_queue_cap,
                opts.caps.hook_queue_bytes,
            )),
            confine,
            opts,
            boot_id: sys::new_boot_id(),
            mgr: PtyManager::new(),
            sessions: Mutex::new(HashMap::new()),
            extension,
            opening: Mutex::new(()),
            blocking: Mutex::new(HashMap::new()),
            inputs: Arc::new(AtomicUsize::new(0)),
            next_conn: AtomicU64::new(1),
            conns: Mutex::new(HashMap::new()),
            changed: Arc::new(Notify::new()),
        })
    }

    pub fn options(&self) -> &HostOptions {
        &self.opts
    }

    pub fn boot_id(&self) -> &str {
        &self.boot_id
    }

    /// The PTY table, for a test asserting on what runs. Not compiled for
    /// shipping (the `test-support` feature): a write through it would reach
    /// a session without passing the `pty.write` handler.
    #[cfg(any(test, feature = "test-support"))]
    pub fn pty(&self) -> &PtyManager {
        &self.mgr
    }

    /// Resolves after the next status-relevant change — a connection, a
    /// session opened, attached or ended, a hook queued (or at once, if one
    /// happened since the last wait).
    pub async fn changed(&self) {
        self.changed.notified().await;
    }

    fn touch(&self) {
        self.changed.notify_one();
    }

    pub fn connection_count(&self) -> usize {
        lock(&self.conns).len()
    }

    /// Sever every connection from this side (its sessions park).
    pub fn disconnect_all(&self) {
        for (_, close) in lock(&self.conns).values() {
            close.notify_one();
        }
    }

    /// A slot for one piece of `node`'s blocking work, or `busy`. The work
    /// holds it until it returns (`blocking`), not until its connection ends.
    fn permit(&self, node: &str) -> Result<OwnedSemaphorePermit, WireError> {
        let cap = self.opts.caps.max_blocking_per_node;
        let sem = lock(&self.blocking)
            .entry(node.to_string())
            .or_insert_with(|| Arc::new(Semaphore::new(cap)))
            .clone();
        sem.try_acquire_owned()
            .map_err(|_| busy(format!("{cap} requests of this client are still running")))
    }

    fn hello(&self, request: &RawRequest) -> Result<(HelloParams, Box<RawValue>), WireError> {
        let p: HelloParams = request.params()?;
        if p.protocol != self.opts.protocol {
            return Err(WireError {
                code: ErrorCode::Version,
                msg: format!(
                    "protocol {} is not supported; this host speaks {}",
                    p.protocol, self.opts.protocol
                ),
                protocol: Some(self.opts.protocol),
            });
        }
        let result = ok(&HelloResult {
            protocol: self.opts.protocol,
            version: self.opts.version.clone(),
            hostname: self.opts.hostname.clone(),
            user: self.opts.user.clone(),
            home: self.opts.home.clone(),
            boot_id: self.boot_id.clone(),
            projects_root: self.opts.projects_root.clone(),
            hook_bin: self.opts.hook_bin.clone(),
            features: self.opts.features.clone(),
        })?;
        Ok((p, result))
    }

    /// One request after `hello`. `hello` itself is answered in line by
    /// [`serve_conn`], so nothing overtakes it.
    async fn handle(self: &Arc<Self>, conn: &Arc<Conn>, request: &RawRequest) -> Reply {
        macro_rules! params {
            ($ty:ty) => {
                match request.params::<$ty>() {
                    Ok(p) => p,
                    Err(e) => return Reply::Answer(Err(e)),
                }
            };
        }
        // A slot of this node's blocking work, or the `busy` answer.
        macro_rules! permit {
            () => {
                match self.permit(&conn.node) {
                    Ok(permit) => permit,
                    Err(e) => return Reply::Answer(Err(e)),
                }
            };
        }
        if let Some(ext) = &self.extension {
            ext.observe(request);
        }
        let this = self.clone();
        let audit = |what: String| {
            log::info!(
                "node {} connection {}: {} #{} {what}",
                conn.node,
                conn.id,
                request.m,
                request.id
            )
        };
        let methods = self.opts.methods;
        match request.m.as_str() {
            m::PtyOpen::NAME => {
                let p = params!(PtyOpenParams);
                audit(format!(
                    "{:?} in {:?}",
                    if p.command.is_empty() {
                        "login shell"
                    } else {
                        &p.command
                    },
                    p.cwd.as_deref().unwrap_or("-")
                ));
                blocking(permit!(), move || this.pty_open(p)).await
            }
            m::PtyAttach::NAME => {
                let p = params!(PtyAttachParams);
                let (conn, id, sid) = (conn.clone(), request.id, p.id);
                blocking(permit!(), move || {
                    let reply = this.pty_attach(&conn, id, p);
                    // Its connection ended while this ran: the teardown's
                    // sweep may have missed the route just set (`Conn`).
                    if conn.closed.load(Ordering::SeqCst) {
                        if let Some(sess) = this.session(sid) {
                            this.park(sid, &sess, Some(conn.id));
                        }
                    }
                    reply
                })
                .await
            }
            m::PtyDetach::NAME => {
                let p = params!(SessionRef);
                let conn = conn.id;
                blocking(permit!(), move || {
                    if let Some(sess) = this.session(p.id) {
                        this.park(p.id, &sess, Some(conn));
                    }
                    ok(&Empty)
                })
                .await
            }
            // Through the session's own input thread, never the blocking pool.
            m::PtyWrite::NAME => Reply::Answer(self.pty_write(params!(PtyWriteParams)).await),
            m::PtyResize::NAME => {
                let p = params!(PtyResizeParams);
                blocking(permit!(), move || {
                    this.mgr
                        .resize(p.id, p.cols, p.rows)
                        .map_err(|e| pty_err(&this, p.id, e))
                        .and_then(|()| ok(&Empty))
                })
                .await
            }
            m::PtyClose::NAME => {
                let p = params!(SessionRef);
                audit(format!("session {}", p.id));
                blocking(permit!(), move || {
                    this.close_session(p.id);
                    ok(&Empty)
                })
                .await
            }
            m::PtySessions::NAME => {
                blocking(permit!(), move || ok(&this.infos(this.mgr.sessions()))).await
            }
            m::PtyAdopt::NAME => {
                let p = params!(PtyAdoptParams);
                audit(String::new());
                blocking(permit!(), move || this.pty_adopt(&p.owner)).await
            }
            m::ExecRun::NAME if methods.exec => {
                let p = params!(ExecParams);
                audit(format!(
                    "{:?} in {:?}",
                    p.argv.first().map(String::as_str).unwrap_or(""),
                    p.cwd
                ));
                Reply::Answer(self.exec_run(permit!(), p).await)
            }
            m::FsRead::NAME if methods.fs => {
                let p = params!(FsReadParams);
                blocking(permit!(), move || fsops::read(&p).and_then(|r| ok(&r))).await
            }
            m::FsWrite::NAME if methods.fs => {
                let p = params!(FsWriteParams);
                audit(format!("{:?}", p.path));
                blocking(permit!(), move || {
                    this.confine
                        .write_target(&p.path)
                        .and_then(|target| fsops::write(&p, &target))
                        .and_then(|()| ok(&Empty))
                })
                .await
            }
            m::FsStat::NAME if methods.fs => {
                let p = params!(FsStatParams);
                blocking(permit!(), move || fsops::stat(&p.path).and_then(|r| ok(&r))).await
            }
            m::HooksSubscribe::NAME if methods.hooks => {
                let p = params!(HooksSubscribeParams);
                self.subscribe_hooks(conn, request.id, p.after);
                log::info!("connection {}: subscribed to hooks", conn.id);
                self.touch();
                Reply::Done
            }
            m::HooksAck::NAME if methods.hooks => {
                let p = params!(HooksAckParams);
                lock(&self.hooks).ack(p.up_to);
                self.touch();
                Reply::Answer(ok(&Empty))
            }
            m::HooksPush::NAME if methods.hooks_push => {
                let p = params!(HookPushParams);
                Reply::Answer(ok(&HookPushResult {
                    seq: self.push_hook(p.event, p.env, p.stdin),
                }))
            }
            other => {
                let handled = self
                    .extension
                    .as_ref()
                    .and_then(|ext| ext.handle(self, request));
                match handled {
                    // On its own task, so a handler that panics answers `io`
                    // instead of leaving its request unanswered.
                    Some(answer) => Reply::Answer(tokio::spawn(answer).await.unwrap_or_else(|e| {
                        Err(err(ErrorCode::Io, format!("handler panicked: {e}")))
                    })),
                    None => Reply::Answer(Err(err(
                        ErrorCode::BadRequest,
                        format!("unknown method {other}"),
                    ))),
                }
            }
        }
    }

    /// `exec.run`: its `cwd` is resolved on the blocking pool under the
    /// node's `permit`; the process itself runs on the async side.
    async fn exec_run(&self, permit: OwnedSemaphorePermit, p: ExecParams) -> Outcome {
        let confine = self.confine.clone();
        let cwd = p.cwd.clone();
        let cwd = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            confine.exec_cwd(&cwd)
        })
        .await
        .map_err(|e| err(ErrorCode::Io, e.to_string()))??;
        exec::run(p, cwd, &self.opts.env).await.and_then(|r| ok(&r))
    }
}

/// What a request's handler leaves to the connection.
enum Reply {
    /// The handler queued its response itself: `pty.attach` and
    /// `hooks.subscribe` must order it ahead of the events they start.
    Done,
    /// The response for the connection to send.
    Answer(Outcome),
}

impl From<Outcome> for Reply {
    fn from(outcome: Outcome) -> Self {
        Reply::Answer(outcome)
    }
}

/// Run a blocking handler off the async workers, holding its node's
/// `permit` until it returns — even when its request is aborted (the
/// connection ended), which cannot stop a blocking task. A handler that
/// panics answers `io`; the host and every other session go on.
async fn blocking<F, R>(permit: OwnedSemaphorePermit, f: F) -> Reply
where
    F: FnOnce() -> R + Send + 'static,
    R: Into<Reply> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        f().into()
    })
    .await
    .unwrap_or_else(|e| Reply::Answer(Err(err(ErrorCode::Io, format!("handler panicked: {e}")))))
}

mod sys;
