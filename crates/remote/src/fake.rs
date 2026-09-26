//! An in-process daemon speaking protocol v1, for tests.
//!
//! Faithful rather than minimal: PTYs are a real `santree_pty::PtyManager`,
//! `exec.run` spawns real processes, `fs.*` touches the real filesystem, and
//! the hook queue has the daemon's semantics (seq, backlog on subscribe, ack,
//! overflow). What wave-2 code passes against this should pass against
//! `santree-remote serve`.
//!
//! Choices the doc leaves open, made here and mirrored by the client:
//! - the `pty.attach` response is written before any `pty.data` of that
//!   attach (a gate buffers chunks until the response is queued);
//! - attaching to a session whose process already ended answers, then sends
//!   `pty.exit` — a receiver always learns the process is gone;
//! - a dropped connection, and `pty.detach`, only detach the sessions *that
//!   connection* is the receiver of, so a stale client can't cut off a newer
//!   one;
//! - `hooks.subscribe` has one subscriber at a time, the newest.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use santree_pty::{OpenOpts, PtyManager};
use serde::Serialize;
use serde_json::value::RawValue;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Notify};

use crate::framing::read_line;
use crate::proto::*;
use crate::transport::{memory_link, BoxFuture, Connector, Link, SshTarget};

/// Per-stream cap on `exec.run` output.
pub const EXEC_OUTPUT_CAP: usize = 8 * 1024 * 1024;
const MAX_REQUEST_LINE: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct FakeOptions {
    /// The one protocol this daemon speaks.
    pub protocol: u32,
    pub version: String,
    pub hostname: String,
    pub user: String,
    pub home: String,
    pub ping_interval: Duration,
    pub hook_queue_cap: usize,
}

impl Default for FakeOptions {
    fn default() -> Self {
        Self {
            protocol: PROTOCOL_VERSION,
            version: "fake-0.0.0".into(),
            hostname: "fake-daedalus".into(),
            user: std::env::var("USER").unwrap_or_default(),
            home: std::env::var("HOME").unwrap_or_default(),
            ping_interval: PING_INTERVAL,
            hook_queue_cap: HOOK_QUEUE_CAP,
        }
    }
}

/// A random id: `RandomState` is seeded from the OS once per process and
/// perturbed per instance, so two daemons (in one test, or across runs) never
/// share one. No `rand` dependency for a test fixture.
fn new_boot_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u128(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    format!("fake-{:016x}", hasher.finish())
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn err(code: ErrorCode, msg: impl Into<String>) -> WireError {
    WireError::new(code, msg)
}

fn io_err(e: std::io::Error, what: &str) -> WireError {
    let code = match e.kind() {
        std::io::ErrorKind::NotFound => ErrorCode::NotFound,
        _ => ErrorCode::Io,
    };
    err(code, format!("{what}: {e}"))
}

fn absolute(path: &str, what: &str) -> Result<PathBuf, WireError> {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        Ok(path)
    } else {
        Err(err(
            ErrorCode::BadRequest,
            format!("{what} must be absolute"),
        ))
    }
}

type Outcome = Result<Box<RawValue>, WireError>;

fn ok<T: Serialize>(value: &T) -> Outcome {
    serde_json::value::to_raw_value(value).map_err(|e| err(ErrorCode::Io, e.to_string()))
}

// ── connections ───────────────────────────────────────────────────────────

struct Conn {
    id: u64,
    out: mpsc::UnboundedSender<String>,
}

impl Conn {
    fn send(&self, line: String) {
        let _ = self.out.send(line);
    }
}

// ── pty routing ───────────────────────────────────────────────────────────

/// One attach's delivery: chunks wait here until the attach response has been
/// queued, so the response always precedes them on the wire.
struct Gate {
    id: SessionId,
    out: mpsc::UnboundedSender<String>,
    st: Mutex<GateState>,
}

#[derive(Default)]
struct GateState {
    open: bool,
    pending: Vec<Vec<u8>>,
    exit_sent: bool,
}

impl Gate {
    fn deliver(&self, bytes: Vec<u8>) {
        let mut st = lock(&self.st);
        if st.open {
            self.emit(&mut st, bytes);
        } else {
            st.pending.push(bytes);
        }
    }

    /// Empty = the exit sentinel, sent once; nothing follows it.
    fn emit(&self, st: &mut GateState, bytes: Vec<u8>) {
        if st.exit_sent {
            return;
        }
        let event = if bytes.is_empty() {
            st.exit_sent = true;
            Event::PtyExit(PtyExit { id: self.id })
        } else {
            Event::PtyData(PtyData {
                id: self.id,
                data: bytes,
            })
        };
        let _ = self.out.send(event.encode());
    }
}

#[derive(Default)]
struct SessState {
    /// Serialises attach/park for this session. Never held by a sink.
    attach: Mutex<()>,
    live: Mutex<Live>,
}

#[derive(Default)]
struct Live {
    /// The pump emitted its exit sentinel: no more output will ever come.
    ended: bool,
    /// The connection receiving this session's output.
    route: Option<u64>,
    /// `adopt_others` dropped the sink for a moment, so an exit sentinel may
    /// have gone nowhere; attach falls back to asking whether it's alive.
    sentinel_maybe_lost: bool,
}

/// A sink that delivers nothing but still notices the process ending — the
/// daemon's "detached" state. `PtyManager::detach` would drop the sink and,
/// with it, the only way to learn of an exit that happens while detached.
fn parked_sink(sess: Arc<SessState>) -> impl Fn(Vec<u8>) + Send + 'static {
    move |bytes: Vec<u8>| {
        if bytes.is_empty() {
            lock(&sess.live).ended = true;
        }
    }
}

// ── hooks ─────────────────────────────────────────────────────────────────

struct HookQueue {
    cap: usize,
    last_seq: u64,
    items: VecDeque<HookEvent>,
    /// Overflow not yet reported to a subscriber.
    dropped: u64,
    subscriber: Option<(u64, mpsc::UnboundedSender<String>)>,
}

impl HookQueue {
    fn notify(&mut self, line: String) {
        if let Some((_, out)) = &self.subscriber {
            if out.send(line).is_err() {
                self.subscriber = None;
            }
        }
    }

    fn report_dropped(&mut self) {
        if self.dropped > 0 && self.subscriber.is_some() {
            let count = std::mem::take(&mut self.dropped);
            self.notify(Event::HooksDropped(HooksDropped { count }).encode());
        }
    }

    fn push(&mut self, event: String, env: Vec<(String, String)>, stdin: Vec<u8>) -> u64 {
        self.last_seq += 1;
        let hook = HookEvent {
            seq: self.last_seq,
            at: now_ms(),
            event,
            env,
            stdin,
        };
        while self.items.len() >= self.cap.max(1) {
            self.items.pop_front();
            self.dropped += 1;
        }
        self.report_dropped();
        self.items.push_back(hook.clone());
        self.notify(Event::Hook(hook).encode());
        self.last_seq
    }
}

// ── the daemon ────────────────────────────────────────────────────────────

struct Daemon {
    opts: FakeOptions,
    /// `hello`'s `bootId`: fresh per instance, as a real daemon's is per start.
    boot_id: String,
    mgr: PtyManager,
    sessions: Mutex<HashMap<SessionId, Arc<SessState>>>,
    hooks: Mutex<HookQueue>,
    next_conn: AtomicU64,
    conns: Mutex<HashMap<u64, Arc<Notify>>>,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        self.mgr.close_all();
    }
}

/// The fake daemon. Clones share one daemon (one PTY table, one hook queue).
#[derive(Clone)]
pub struct FakeDaemon {
    inner: Arc<Daemon>,
}

impl Default for FakeDaemon {
    fn default() -> Self {
        Self::new()
    }
}

impl FakeDaemon {
    pub fn new() -> Self {
        Self::with_options(FakeOptions::default())
    }

    pub fn with_options(opts: FakeOptions) -> Self {
        let cap = opts.hook_queue_cap;
        Self {
            inner: Arc::new(Daemon {
                opts,
                boot_id: new_boot_id(),
                mgr: PtyManager::new(),
                sessions: Mutex::new(HashMap::new()),
                hooks: Mutex::new(HookQueue {
                    cap,
                    last_seq: 0,
                    items: VecDeque::new(),
                    dropped: 0,
                    subscriber: None,
                }),
                next_conn: AtomicU64::new(1),
                conns: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Serve one connection (what `santree-remote connect` would relay).
    /// Must be called inside a tokio runtime.
    pub fn serve<R, W>(&self, reader: R, writer: W) -> tokio::task::JoinHandle<()>
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        tokio::spawn(serve_conn(self.inner.clone(), reader, writer))
    }

    /// A fresh in-memory link to this daemon.
    pub fn connect(&self) -> Link {
        let (link, server) = memory_link();
        let (reader, writer) = tokio::io::split(server);
        self.serve(reader, writer);
        link
    }

    /// A [`Connector`] whose every connect is [`FakeDaemon::connect`],
    /// whatever the target.
    pub fn connector(&self) -> Arc<dyn Connector> {
        let daemon = self.clone();
        Arc::new(
            move |_: &SshTarget| -> BoxFuture<'static, Result<Link, String>> {
                let link = daemon.connect();
                Box::pin(async move { Ok(link) })
            },
        )
    }

    /// What `santree-remote hook <Event>` does on the server.
    pub fn push_hook(&self, event: &str, env: Vec<(String, String)>, stdin: Vec<u8>) -> u64 {
        lock(&self.inner.hooks).push(event.to_string(), env, stdin)
    }

    /// This instance's `bootId`.
    pub fn boot_id(&self) -> &str {
        &self.inner.boot_id
    }

    /// Unacked hook events still queued.
    pub fn queued_hooks(&self) -> Vec<u64> {
        lock(&self.inner.hooks)
            .items
            .iter()
            .map(|h| h.seq)
            .collect()
    }

    /// The daemon's PTY table, for asserting on what it's running.
    pub fn pty(&self) -> &PtyManager {
        &self.inner.mgr
    }

    /// Sever every live connection from the server side (a network drop).
    pub fn disconnect_all(&self) {
        for kill in lock(&self.inner.conns).values() {
            kill.notify_one();
        }
    }

    pub fn connection_count(&self) -> usize {
        lock(&self.inner.conns).len()
    }

    /// Sever every connection and kill every session.
    pub fn shutdown(&self) {
        self.disconnect_all();
        self.inner.mgr.close_all();
    }
}

async fn serve_conn<R, W>(daemon: Arc<Daemon>, reader: R, writer: W)
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin + 'static,
{
    let id = daemon.next_conn.fetch_add(1, Ordering::Relaxed);
    let kill = Arc::new(Notify::new());
    lock(&daemon.conns).insert(id, kill.clone());
    let (out, mut out_rx) = mpsc::unbounded_channel::<String>();
    let conn = Arc::new(Conn { id, out });

    let writer_task = tokio::spawn(async move {
        let mut writer = writer;
        while let Some(mut line) = out_rx.recv().await {
            line.push('\n');
            if writer.write_all(line.as_bytes()).await.is_err() || writer.flush().await.is_err() {
                break;
            }
        }
        let _ = writer.shutdown().await;
    });
    let ping_task = {
        let conn = conn.clone();
        let every = daemon.opts.ping_interval;
        tokio::spawn(async move {
            let mut ticks = tokio::time::interval(every);
            ticks.tick().await;
            loop {
                ticks.tick().await;
                conn.send(Event::Ping.encode());
            }
        })
    };

    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    let mut greeted = false;
    loop {
        let read = tokio::select! {
            _ = kill.notified() => break,
            read = read_line(&mut reader, &mut line, MAX_REQUEST_LINE, None) => read,
        };
        if read.is_err() {
            break;
        }
        if line.is_empty() {
            continue;
        }
        let request = match std::str::from_utf8(&line)
            .map_err(|e| e.to_string())
            .and_then(|text| decode_request(text).map_err(|e| e.to_string()))
        {
            Ok(request) => request,
            Err(e) => {
                // No id to answer to; a daemon can only log it.
                log::warn!("fake daemon: undecodable request: {e}");
                continue;
            }
        };
        // `hello` is handled in line so nothing overtakes it.
        if request.m == m::Hello::NAME {
            let outcome = daemon.hello(&request);
            greeted |= outcome.is_ok();
            reply(&conn, request.id, outcome);
            continue;
        }
        if !greeted {
            reply(
                &conn,
                request.id,
                Err(err(ErrorCode::BadRequest, "send hello first")),
            );
            continue;
        }
        let daemon = daemon.clone();
        let conn = conn.clone();
        tokio::spawn(async move {
            if let Some(outcome) = daemon.handle(&conn, &request).await {
                reply(&conn, request.id, outcome);
            }
        });
    }

    // A dropped connection detaches, never closes.
    let routed: Vec<(SessionId, Arc<SessState>)> = lock(&daemon.sessions)
        .iter()
        .map(|(id, sess)| (*id, sess.clone()))
        .collect();
    for (sid, sess) in routed {
        daemon.park(sid, &sess, Some(id));
    }
    {
        let mut hooks = lock(&daemon.hooks);
        if hooks.subscriber.as_ref().is_some_and(|(c, _)| *c == id) {
            hooks.subscriber = None;
        }
    }
    lock(&daemon.conns).remove(&id);
    ping_task.abort();
    writer_task.abort();
}

fn reply(conn: &Conn, id: u64, outcome: Outcome) {
    conn.send(match outcome {
        Ok(result) => encode_ok(id, &result).expect("raw results serialize"),
        Err(e) => encode_err(id, &e),
    });
}

/// Run a blocking handler off the async workers.
async fn blocking<F>(f: F) -> Option<Outcome>
where
    F: FnOnce() -> Option<Outcome> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .unwrap_or_else(|e| Some(Err(err(ErrorCode::Io, format!("handler panicked: {e}")))))
}

impl Daemon {
    fn hello(&self, request: &RawRequest) -> Outcome {
        let p: HelloParams = request.params()?;
        if p.protocol != self.opts.protocol {
            return Err(WireError {
                code: ErrorCode::Version,
                msg: format!(
                    "protocol {} is not supported; this daemon speaks {}",
                    p.protocol, self.opts.protocol
                ),
                protocol: Some(self.opts.protocol),
            });
        }
        ok(&HelloResult {
            protocol: self.opts.protocol,
            version: self.opts.version.clone(),
            hostname: self.opts.hostname.clone(),
            user: self.opts.user.clone(),
            home: self.opts.home.clone(),
            boot_id: self.boot_id.clone(),
        })
    }

    /// `None` = the handler already wrote its response (attach, subscribe:
    /// both must order it ahead of the events they start).
    async fn handle(self: &Arc<Self>, conn: &Arc<Conn>, request: &RawRequest) -> Option<Outcome> {
        macro_rules! params {
            ($ty:ty) => {
                match request.params::<$ty>() {
                    Ok(p) => p,
                    Err(e) => return Some(Err(e)),
                }
            };
        }
        let this = self.clone();
        match request.m.as_str() {
            m::PtyOpen::NAME => {
                let p = params!(PtyOpenParams);
                blocking(move || Some(this.pty_open(p))).await
            }
            m::PtyAttach::NAME => {
                let p = params!(PtyAttachParams);
                let (conn, id) = (conn.clone(), request.id);
                blocking(move || this.pty_attach(&conn, id, p)).await
            }
            m::PtyDetach::NAME => {
                let p = params!(SessionRef);
                let conn = conn.id;
                blocking(move || {
                    if let Some(sess) = this.session(p.id) {
                        this.park(p.id, &sess, Some(conn));
                    }
                    Some(ok(&Empty))
                })
                .await
            }
            m::PtyWrite::NAME => {
                let p = params!(PtyWriteParams);
                blocking(move || {
                    Some(
                        this.mgr
                            .write(p.id, &p.data)
                            .map_err(|e| pty_err(&this, p.id, e))
                            .and_then(|()| ok(&Empty)),
                    )
                })
                .await
            }
            m::PtyResize::NAME => {
                let p = params!(PtyResizeParams);
                blocking(move || {
                    Some(
                        this.mgr
                            .resize(p.id, p.cols, p.rows)
                            .map_err(|e| pty_err(&this, p.id, e))
                            .and_then(|()| ok(&Empty)),
                    )
                })
                .await
            }
            m::PtyClose::NAME => {
                let p = params!(SessionRef);
                blocking(move || {
                    let _ = this.mgr.close(p.id);
                    lock(&this.sessions).remove(&p.id);
                    Some(ok(&Empty))
                })
                .await
            }
            m::PtySessions::NAME => {
                blocking(move || Some(ok(&this.infos(this.mgr.sessions())))).await
            }
            m::PtyAdopt::NAME => {
                let p = params!(PtyAdoptParams);
                blocking(move || Some(this.pty_adopt(&p.owner))).await
            }
            m::ExecRun::NAME => Some(exec_run(params!(ExecParams)).await),
            m::FsRead::NAME => {
                let p = params!(FsReadParams);
                blocking(move || Some(fs_read(&p).and_then(|r| ok(&r)))).await
            }
            m::FsWrite::NAME => {
                let p = params!(FsWriteParams);
                blocking(move || Some(fs_write(&p).and_then(|()| ok(&Empty)))).await
            }
            m::FsStat::NAME => {
                let p = params!(FsStatParams);
                blocking(move || Some(fs_stat(&p.path).and_then(|r| ok(&r)))).await
            }
            m::HooksPush::NAME => {
                let p = params!(HookPushParams);
                let seq = lock(&self.hooks).push(p.event, p.env, p.stdin);
                Some(ok(&HookPushResult { seq }))
            }
            m::HooksSubscribe::NAME => {
                let p = params!(HooksSubscribeParams);
                let mut hooks = lock(&self.hooks);
                conn.send(encode_ok(request.id, &Empty).expect("empty serializes"));
                hooks.subscriber = Some((conn.id, conn.out.clone()));
                hooks.report_dropped();
                let backlog: Vec<HookEvent> = hooks
                    .items
                    .iter()
                    .filter(|h| p.after.is_none_or(|after| h.seq > after))
                    .cloned()
                    .collect();
                for hook in backlog {
                    hooks.notify(Event::Hook(hook).encode());
                }
                None
            }
            m::HooksAck::NAME => {
                let p = params!(HooksAckParams);
                lock(&self.hooks).items.retain(|h| h.seq > p.up_to);
                Some(ok(&Empty))
            }
            other => Some(Err(err(
                ErrorCode::BadRequest,
                format!("unknown method {other}"),
            ))),
        }
    }

    fn session(&self, id: SessionId) -> Option<Arc<SessState>> {
        lock(&self.sessions).get(&id).cloned()
    }

    fn infos(&self, infos: Vec<santree_pty::SessionInfo>) -> Vec<SessionInfo> {
        let sessions = lock(&self.sessions);
        infos
            .into_iter()
            .map(|info| SessionInfo {
                attached: sessions
                    .get(&info.id)
                    .is_some_and(|s| lock(&s.live).route.is_some()),
                id: info.id,
                pid: info.pid,
                cwd: info.cwd,
                command: info.command,
                owner: info.owner,
                label: info.label,
                agent_kind: info.agent_kind,
                cols: info.cols,
                rows: info.rows,
                alive: info.alive,
                epoch: info.epoch,
            })
            .collect()
    }

    fn info(&self, id: SessionId) -> Option<SessionInfo> {
        let all = self.mgr.sessions();
        self.infos(all).into_iter().find(|info| info.id == id)
    }

    fn pty_open(&self, p: PtyOpenParams) -> Outcome {
        let sess = Arc::new(SessState::default());
        let id = self
            .mgr
            .open(
                OpenOpts {
                    cwd: p.cwd,
                    command: p.command,
                    args: p.args,
                    cols: p.cols,
                    rows: p.rows,
                    env: p.env,
                    owner: p.owner,
                    label: p.label,
                    agent_kind: p.agent_kind,
                },
                parked_sink(sess.clone()),
            )
            .map_err(|e| err(ErrorCode::Io, format!("{e:#}")))?;
        lock(&self.sessions).insert(id, sess);
        match self.info(id) {
            Some(info) => ok(&info),
            None => Err(err(ErrorCode::NotFound, format!("session {id} vanished"))),
        }
    }

    fn pty_attach(&self, conn: &Conn, req_id: u64, p: PtyAttachParams) -> Option<Outcome> {
        let Some(sess) = self.session(p.id) else {
            return Some(Err(err(
                ErrorCode::NotFound,
                format!("no terminal session {}", p.id),
            )));
        };
        let _serial = lock(&sess.attach);
        let gate = Arc::new(Gate {
            id: p.id,
            out: conn.out.clone(),
            st: Mutex::new(GateState::default()),
        });
        let sink = {
            let gate = gate.clone();
            let sess = sess.clone();
            move |bytes: Vec<u8>| {
                if bytes.is_empty() {
                    lock(&sess.live).ended = true;
                }
                gate.deliver(bytes);
            }
        };
        let anchor = match p.anchor {
            Anchor::At { epoch, seq } => santree_pty::Anchor::At { epoch, seq },
            Anchor::Fresh => santree_pty::Anchor::Fresh,
            Anchor::Unknown => santree_pty::Anchor::Unknown,
        };
        let replay = match self.mgr.attach(p.id, &anchor, sink) {
            Ok(replay) => replay,
            Err(e) => return Some(Err(err(ErrorCode::NotFound, format!("{e:#}")))),
        };
        let maybe_lost = {
            let mut live = lock(&sess.live);
            live.route = Some(conn.id);
            live.sentinel_maybe_lost
        };
        // Asked before the gate is locked: `sessions()` takes the manager's
        // sink locks, which a pump holds while it calls into the gate.
        let dead = maybe_lost
            && self
                .mgr
                .sessions()
                .iter()
                .any(|info| info.id == p.id && !info.alive);

        let result = AttachResult {
            mode: match replay.mode {
                santree_pty::ReplayMode::Exact => ReplayMode::Exact,
                santree_pty::ReplayMode::Tail => ReplayMode::Tail,
                santree_pty::ReplayMode::Reanchor => ReplayMode::Reanchor,
            },
            epoch: replay.epoch,
            seq: replay.seq,
            data: replay.bytes,
        };
        let mut st = lock(&gate.st);
        conn.send(encode_ok(req_id, &result).expect("attach results serialize"));
        for bytes in std::mem::take(&mut st.pending) {
            gate.emit(&mut st, bytes);
        }
        st.open = true;
        if lock(&sess.live).ended || dead {
            gate.emit(&mut st, Vec::new());
        }
        None
    }

    /// Detach a session into the parked state — only when `only_conn` (if
    /// given) is still its receiver.
    fn park(&self, id: SessionId, sess: &Arc<SessState>, only_conn: Option<u64>) {
        let _serial = lock(&sess.attach);
        {
            let mut live = lock(&sess.live);
            if live.route.is_none() || only_conn.is_some_and(|c| live.route != Some(c)) {
                return;
            }
            live.route = None;
        }
        let _ = self
            .mgr
            .attach(id, &santree_pty::Anchor::Unknown, parked_sink(sess.clone()));
    }

    fn pty_adopt(&self, owner: &str) -> Outcome {
        let adopted = self.mgr.adopt_others(owner);
        let live: Vec<SessionId> = self.mgr.sessions().iter().map(|s| s.id).collect();
        {
            let mut sessions = lock(&self.sessions);
            // Superseded duplicates were closed by the manager.
            sessions.retain(|id, _| live.contains(id));
        }
        for info in &adopted {
            if let Some(sess) = self.session(info.id) {
                let _serial = lock(&sess.attach);
                {
                    let mut live = lock(&sess.live);
                    live.route = None;
                    live.sentinel_maybe_lost = true;
                }
                let _ = self.mgr.attach(
                    info.id,
                    &santree_pty::Anchor::Unknown,
                    parked_sink(sess.clone()),
                );
            }
        }
        ok(&self.infos(adopted))
    }
}

fn pty_err(daemon: &Daemon, id: SessionId, e: impl std::fmt::Display) -> WireError {
    let known = lock(&daemon.sessions).contains_key(&id);
    err(
        if known {
            ErrorCode::Io
        } else {
            ErrorCode::NotFound
        },
        e.to_string(),
    )
}

// ── exec ──────────────────────────────────────────────────────────────────

async fn read_capped<R: AsyncRead + Unpin>(mut reader: R) -> (Vec<u8>, bool) {
    let mut kept = Vec::new();
    let mut truncated = false;
    let mut buf = [0u8; 16 * 1024];
    while let Ok(n) = reader.read(&mut buf).await {
        if n == 0 {
            break;
        }
        let room = EXEC_OUTPUT_CAP.saturating_sub(kept.len());
        kept.extend_from_slice(&buf[..n.min(room)]);
        // Keep draining past the cap so the child never blocks on a full pipe.
        truncated |= n > room;
    }
    (kept, truncated)
}

async fn exec_run(p: ExecParams) -> Outcome {
    let Some(program) = p.argv.first() else {
        return Err(err(ErrorCode::BadRequest, "argv is empty"));
    };
    let cwd = absolute(&p.cwd, "cwd")?;
    let limit = Duration::from_millis(
        p.timeout_ms
            .unwrap_or(EXEC_DEFAULT_TIMEOUT_MS)
            .clamp(1, EXEC_MAX_TIMEOUT_MS),
    );
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(&p.argv[1..])
        .current_dir(&cwd)
        .envs(p.env.unwrap_or_default())
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(if p.stdin.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| io_err(e, program))?;
    if let (Some(mut pipe), Some(data)) = (child.stdin.take(), p.stdin) {
        tokio::spawn(async move {
            let _ = pipe.write_all(&data).await;
        });
    }
    let stdout = tokio::spawn(read_capped(child.stdout.take().expect("piped")));
    let stderr = tokio::spawn(read_capped(child.stderr.take().expect("piped")));
    let started = tokio::time::Instant::now();
    let status = match tokio::time::timeout(limit, child.wait()).await {
        Ok(status) => status.map_err(|e| io_err(e, program))?,
        Err(_) => {
            let _ = child.kill().await;
            return Err(err(
                ErrorCode::Timeout,
                format!("{program} ran past {}ms", limit.as_millis()),
            ));
        }
    };
    // A grandchild can hold the pipes open past the child's exit; don't wait
    // for it beyond the request's own deadline.
    let remaining = limit
        .saturating_sub(started.elapsed())
        .max(Duration::from_millis(100));
    let collect = async { (stdout.await, stderr.await) };
    let (stdout, stderr) = match tokio::time::timeout(remaining, collect).await {
        Ok((Ok(out), Ok(errs))) => (out, errs),
        _ => {
            return Err(err(
                ErrorCode::Timeout,
                format!("{program}'s output never closed"),
            ))
        }
    };
    #[cfg(unix)]
    let signal = std::os::unix::process::ExitStatusExt::signal(&status);
    #[cfg(not(unix))]
    let signal = None;
    ok(&ExecResult {
        code: status.code(),
        signal,
        stdout: stdout.0,
        stderr: stderr.0,
        truncated: stdout.1 || stderr.1,
    })
}

// ── fs ────────────────────────────────────────────────────────────────────

fn fs_read(p: &FsReadParams) -> Result<FsReadResult, WireError> {
    let path = absolute(&p.path, "path")?;
    let path = match &p.within {
        Some(within) => {
            let root = absolute(within, "within")?
                .canonicalize()
                .map_err(|e| io_err(e, within))?;
            let real = path.canonicalize().map_err(|e| io_err(e, &p.path))?;
            if !real.starts_with(&root) {
                return Err(err(
                    ErrorCode::Outside,
                    format!("{} resolves outside {within}", p.path),
                ));
            }
            // Read the resolved path, so a swap after the check can't escape.
            real
        }
        None => path,
    };
    let mut file = std::fs::File::open(&path).map_err(|e| io_err(e, &p.path))?;
    let meta = file.metadata().map_err(|e| io_err(e, &p.path))?;
    if meta.is_dir() {
        return Err(err(ErrorCode::Io, format!("{} is a directory", p.path)));
    }
    let size = meta.len();
    let start = match p.offset.unwrap_or(0) {
        offset if offset < 0 => size.saturating_sub(offset.unsigned_abs()),
        offset => (offset as u64).min(size),
    };
    let len = p.len.unwrap_or(FS_READ_MAX).min(FS_READ_MAX);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| io_err(e, &p.path))?;
    let mut data = Vec::new();
    file.take(len)
        .read_to_end(&mut data)
        .map_err(|e| io_err(e, &p.path))?;
    let eof = start + data.len() as u64 >= size;
    Ok(FsReadResult { data, size, eof })
}

fn fs_write(p: &FsWriteParams) -> Result<(), WireError> {
    static TEMP: AtomicU64 = AtomicU64::new(0);
    let path = absolute(&p.path, "path")?;
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return Err(err(ErrorCode::BadRequest, "path has no file name"));
    };
    std::fs::create_dir_all(parent).map_err(|e| io_err(e, &parent.to_string_lossy()))?;
    let temp = parent.join(format!(
        ".{}.santree-{}-{}.tmp",
        name.to_string_lossy(),
        std::process::id(),
        TEMP.fetch_add(1, Ordering::Relaxed)
    ));
    let written = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(&p.data)?;
        file.sync_all()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = match p.mode {
                Some(mode) => Some(mode),
                None => std::fs::metadata(&path)
                    .ok()
                    .map(|m| m.permissions().mode()),
            };
            if let Some(mode) = mode {
                std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(mode & 0o7777))?;
            }
        }
        std::fs::rename(&temp, &path)
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(io_err(e, &p.path));
    }
    Ok(())
}

fn fs_stat(path: &str) -> Result<FsStat, WireError> {
    let full = absolute(path, "path")?;
    let meta = match std::fs::symlink_metadata(&full) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(FsStat::default()),
        Err(e) => return Err(io_err(e, path)),
    };
    let kind = if meta.file_type().is_symlink() {
        FsKind::Symlink
    } else if meta.is_dir() {
        FsKind::Dir
    } else if meta.is_file() {
        FsKind::File
    } else {
        FsKind::Other
    };
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Ok(FsStat {
        exists: true,
        kind: Some(kind),
        size: meta.len(),
        mtime_ms,
    })
}
