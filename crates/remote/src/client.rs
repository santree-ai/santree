//! `RemoteClient`: protocol v1 over any byte stream.
//!
//! One reader task decodes frames in wire order and routes them: responses to
//! the call waiting on that id, `pty.data`/`pty.exit` to the session's
//! receiver, `hook`/`hooks.dropped` to the hooks receiver. One writer task owns
//! the write half. Calls are concurrent — each gets an id and a oneshot.
//!
//! The link is dead on EOF, on a read or write error, on an oversized line, or
//! after [`ClientOptions::idle_timeout`] with no traffic at all (the daemon
//! pings every 15s, so silence means the link is gone even when TCP hasn't
//! noticed). Death fails every in-flight call with [`RemoteError::Disconnected`]
//! and closes every session and hooks receiver; a new link is a new client.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::value::RawValue;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, watch};

use crate::framing::{read_line, ReadEnd};
use crate::proto::{self, *};

/// Silence after which the link is declared dead: three missed pings.
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(45);

/// The longest line accepted. Sized for the largest legitimate frame — an
/// `exec.run` result carrying two 8 MiB streams, base64-inflated by 4/3 —
/// with headroom, and small enough that a peer that never sends a newline
/// can't take the app's memory with it.
pub const DEFAULT_MAX_LINE: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct ClientOptions {
    pub idle_timeout: Duration,
    pub max_line: usize,
}

impl Default for ClientOptions {
    fn default() -> Self {
        Self {
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
            max_line: DEFAULT_MAX_LINE,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RemoteError {
    /// The link died (or was already dead) before an answer came.
    #[error("remote link lost: {0}")]
    Disconnected(String),
    /// The daemon answered with an error.
    #[error("{0}")]
    Remote(WireError),
    /// The daemon answered with something that isn't the method's result.
    #[error("malformed reply to {method}: {detail}")]
    Decode {
        method: &'static str,
        detail: String,
    },
}

impl RemoteError {
    pub fn code(&self) -> Option<&ErrorCode> {
        match self {
            RemoteError::Remote(e) => Some(&e.code),
            _ => None,
        }
    }

    pub fn is_disconnected(&self) -> bool {
        matches!(self, RemoteError::Disconnected(_))
    }
}

/// What a session's receiver yields. The channel closing without an `Exit`
/// means the *view* ended — a newer attach took the session, it was detached,
/// or the link died — never that the process did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyEvent {
    Data(Vec<u8>),
    Exit,
}

/// What the hooks receiver yields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HookMessage {
    Event(HookEvent),
    /// The daemon's queue overflowed and lost this many events.
    Dropped {
        count: u64,
    },
}

type Reply = Result<Box<RawValue>, RemoteError>;

struct PendingCall {
    tx: oneshot::Sender<Reply>,
    /// Set for `pty.attach`: the session whose route this response opens.
    attach: Option<SessionId>,
}

enum RouteState {
    /// An attach is in flight (request id). Data now belongs to the previous
    /// receiver and is covered by the replay this attach will return, so it
    /// is dropped.
    Pending(u64),
    Live,
}

struct Route {
    tx: mpsc::UnboundedSender<PtyEvent>,
    state: RouteState,
}

#[derive(Default)]
struct State {
    /// `Some(reason)` once the link is dead. Checked under the same lock as
    /// `pending` is filled, so no call can register after the drain and hang.
    closed: Option<String>,
    pending: HashMap<u64, PendingCall>,
    routes: HashMap<SessionId, Route>,
    hooks: Option<mpsc::UnboundedSender<HookMessage>>,
}

struct Shared {
    state: Mutex<State>,
    next_id: AtomicU64,
    out: mpsc::UnboundedSender<String>,
    last_seen: Mutex<Instant>,
    closed: watch::Sender<bool>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn fail(&self, reason: String) {
        let (pending, routes, hooks) = {
            let mut st = self.lock();
            if st.closed.is_some() {
                return;
            }
            log::info!("remote link closed: {reason}");
            st.closed = Some(reason.clone());
            (
                std::mem::take(&mut st.pending),
                std::mem::take(&mut st.routes),
                st.hooks.take(),
            )
        };
        for (_, call) in pending {
            let _ = call.tx.send(Err(RemoteError::Disconnected(reason.clone())));
        }
        drop((routes, hooks));
        self.closed.send_replace(true);
    }

    fn dispatch(&self, line: &[u8]) {
        let frame = std::str::from_utf8(line)
            .map_err(|e| e.to_string())
            .and_then(|text| proto::decode_server_frame(text).map_err(|e| e.to_string()));
        match frame {
            Ok(ServerFrame::Response { id, result }) => self.respond(id, result),
            Ok(ServerFrame::Event(event)) => self.event(event),
            Ok(ServerFrame::UnknownEvent(name)) => log::debug!("remote: ignoring event {name}"),
            // One bad frame isn't worth the link: log it and carry on.
            Err(e) => log::warn!("remote: undecodable frame: {e}"),
        }
    }

    fn respond(&self, id: u64, result: Result<Box<RawValue>, WireError>) {
        let call = {
            let mut st = self.lock();
            let Some(call) = st.pending.remove(&id) else {
                log::debug!("remote: response to unknown request {id}");
                return;
            };
            // Flip the route in the same critical section the reader uses to
            // route data, and *before* the caller can see the result: every
            // `pty.data` the daemon wrote after this response is live, every
            // one before it was not. That is the whole ordering contract.
            if let Some(session) = call.attach {
                let ours = matches!(
                    st.routes.get(&session),
                    Some(Route { state: RouteState::Pending(req), .. }) if *req == id
                );
                if ours {
                    if result.is_ok() {
                        if let Some(route) = st.routes.get_mut(&session) {
                            route.state = RouteState::Live;
                        }
                    } else {
                        st.routes.remove(&session);
                    }
                }
            }
            call
        };
        let _ = call.tx.send(result.map_err(RemoteError::Remote));
    }

    fn event(&self, event: Event) {
        let mut st = self.lock();
        match event {
            Event::PtyData(PtyData { id, data }) => {
                let delivered = match st.routes.get(&id) {
                    Some(Route {
                        tx,
                        state: RouteState::Live,
                    }) => tx.send(PtyEvent::Data(data)).is_ok(),
                    _ => true,
                };
                if !delivered {
                    st.routes.remove(&id);
                }
            }
            Event::PtyExit(PtyExit { id }) => {
                // Only a live route: an exit racing an attach belongs to the
                // previous receiver, and the daemon reports it again after the
                // attach response when the process is gone.
                if matches!(
                    st.routes.get(&id),
                    Some(Route {
                        state: RouteState::Live,
                        ..
                    })
                ) {
                    if let Some(route) = st.routes.remove(&id) {
                        let _ = route.tx.send(PtyEvent::Exit);
                    }
                }
            }
            Event::Hook(hook) => {
                if let Some(tx) = &st.hooks {
                    if tx.send(HookMessage::Event(hook)).is_err() {
                        st.hooks = None;
                    }
                }
            }
            Event::HooksDropped(HooksDropped { count }) => {
                log::warn!("remote: daemon dropped {count} hook event(s)");
                if let Some(tx) = &st.hooks {
                    let _ = tx.send(HookMessage::Dropped { count });
                }
            }
            Event::Ping => {}
        }
    }
}

/// A protocol v1 connection to one daemon.
pub struct RemoteClient {
    shared: Arc<Shared>,
    reader: tokio::task::AbortHandle,
    writer: tokio::task::AbortHandle,
}

impl std::fmt::Debug for RemoteClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteClient")
            .field("closed", &self.close_reason())
            .finish()
    }
}

impl Drop for RemoteClient {
    fn drop(&mut self) {
        self.shared.fail("client dropped".into());
        self.reader.abort();
        self.writer.abort();
    }
}

impl RemoteClient {
    /// Start a client over `reader`/`writer`. Spawns its two tasks on the
    /// current tokio runtime, so it must be called from inside one. Nothing is
    /// sent until the first call — send [`RemoteClient::hello`] first.
    pub fn new<R, W>(reader: R, writer: W) -> Self
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        Self::with_options(reader, writer, ClientOptions::default())
    }

    pub fn with_options<R, W>(reader: R, writer: W, options: ClientOptions) -> Self
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let (out, out_rx) = mpsc::unbounded_channel();
        let (closed, _) = watch::channel(false);
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            next_id: AtomicU64::new(1),
            out,
            last_seen: Mutex::new(Instant::now()),
            closed,
        });
        let reader = tokio::spawn(read_loop(shared.clone(), reader, options)).abort_handle();
        let writer = tokio::spawn(write_loop(shared.clone(), writer, out_rx)).abort_handle();
        Self {
            shared,
            reader,
            writer,
        }
    }

    pub fn is_closed(&self) -> bool {
        self.shared.lock().closed.is_some()
    }

    /// Why the link died, once it has.
    pub fn close_reason(&self) -> Option<String> {
        self.shared.lock().closed.clone()
    }

    /// Resolves when the link dies (immediately if it already has).
    pub async fn closed(&self) {
        let mut rx = self.shared.closed.subscribe();
        let _ = rx.wait_for(|closed| *closed).await;
    }

    /// When a frame (of any kind, pings included) last arrived.
    pub fn last_seen(&self) -> Instant {
        *self
            .shared
            .last_seen
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// End the link now. In-flight calls fail with `Disconnected`.
    pub fn shutdown(&self) {
        self.shared.fail("closed by client".into());
    }

    fn start<M: Method>(
        &self,
        params: &M::Params,
        attach: Option<(SessionId, mpsc::UnboundedSender<PtyEvent>)>,
    ) -> Result<oneshot::Receiver<Reply>, RemoteError> {
        let id = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        let line = proto::encode_request(id, M::NAME, params).map_err(|e| RemoteError::Decode {
            method: M::NAME,
            detail: format!("params: {e}"),
        })?;
        let (tx, rx) = oneshot::channel();
        {
            let mut st = self.shared.lock();
            if let Some(reason) = &st.closed {
                return Err(RemoteError::Disconnected(reason.clone()));
            }
            let session = attach.map(|(session, route)| {
                // Replacing an older route drops its sender: that receiver
                // ends, which is what "a newer attach replaces the older" means
                // to whoever held it.
                st.routes.insert(
                    session,
                    Route {
                        tx: route,
                        state: RouteState::Pending(id),
                    },
                );
                session
            });
            st.pending.insert(
                id,
                PendingCall {
                    tx,
                    attach: session,
                },
            );
            // Queued under the lock so request lines leave in id order.
            if self.shared.out.send(line).is_err() {
                st.pending.remove(&id);
                return Err(RemoteError::Disconnected("writer stopped".into()));
            }
        }
        Ok(rx)
    }

    fn finish<M: Method>(
        reply: Result<Reply, oneshot::error::RecvError>,
    ) -> Result<M::Result, RemoteError> {
        let raw = reply.map_err(|_| RemoteError::Disconnected("client dropped".into()))??;
        serde_json::from_str(raw.get()).map_err(|e| RemoteError::Decode {
            method: M::NAME,
            detail: e.to_string(),
        })
    }

    /// Call any method.
    pub async fn call<M: Method>(&self, params: &M::Params) -> Result<M::Result, RemoteError> {
        let rx = self.start::<M>(params, None)?;
        Self::finish::<M>(rx.await)
    }

    /// [`RemoteClient::call`] for synchronous code (the git layer, from a
    /// `spawn_blocking` thread). Blocks the calling thread; panics if called
    /// from inside an async context, like any tokio blocking receive.
    pub fn call_blocking<M: Method>(&self, params: &M::Params) -> Result<M::Result, RemoteError> {
        let rx = self.start::<M>(params, None)?;
        Self::finish::<M>(rx.blocking_recv())
    }

    // ── typed helpers ─────────────────────────────────────────────────────

    /// The handshake, at [`PROTOCOL_VERSION`]. A daemon speaking another
    /// version answers `version` and keeps the connection open.
    pub async fn hello(&self, client: &str, owner: &str) -> Result<HelloResult, RemoteError> {
        self.call::<m::Hello>(&HelloParams {
            protocol: PROTOCOL_VERSION,
            client: client.to_string(),
            owner: owner.to_string(),
        })
        .await
    }

    pub async fn pty_open(&self, params: &PtyOpenParams) -> Result<SessionInfo, RemoteError> {
        self.call::<m::PtyOpen>(params).await
    }

    /// Attach to a session: the replay to write first, and the receiver of
    /// everything after it.
    ///
    /// The receiver is registered before the request leaves and only starts
    /// accepting data when the reader processes this response, so nothing the
    /// replay already covers is delivered twice and nothing after it is lost.
    /// Write `AttachResult::data` before draining the receiver.
    pub async fn pty_attach(
        &self,
        id: SessionId,
        anchor: Anchor,
    ) -> Result<(AttachResult, mpsc::UnboundedReceiver<PtyEvent>), RemoteError> {
        let (tx, rx) = mpsc::unbounded_channel();
        let reply = self.start::<m::PtyAttach>(&PtyAttachParams { id, anchor }, Some((id, tx)))?;
        let result = Self::finish::<m::PtyAttach>(reply.await)?;
        Ok((result, rx))
    }

    /// Stop receiving a session's output; the process keeps running.
    pub async fn pty_detach(&self, id: SessionId) -> Result<(), RemoteError> {
        self.shared.lock().routes.remove(&id);
        self.call::<m::PtyDetach>(&SessionRef { id })
            .await
            .map(drop)
    }

    pub async fn pty_write(&self, id: SessionId, data: Vec<u8>) -> Result<(), RemoteError> {
        self.call::<m::PtyWrite>(&PtyWriteParams { id, data })
            .await
            .map(drop)
    }

    pub async fn pty_resize(&self, id: SessionId, cols: u16, rows: u16) -> Result<(), RemoteError> {
        self.call::<m::PtyResize>(&PtyResizeParams { id, cols, rows })
            .await
            .map(drop)
    }

    /// Kill a session. Its receiver, if attached, gets `Exit`.
    pub async fn pty_close(&self, id: SessionId) -> Result<(), RemoteError> {
        self.call::<m::PtyClose>(&SessionRef { id }).await.map(drop)
    }

    pub async fn pty_sessions(&self) -> Result<Vec<SessionInfo>, RemoteError> {
        self.call::<m::PtySessions>(&Empty).await
    }

    pub async fn pty_adopt(&self, owner: &str) -> Result<Vec<SessionInfo>, RemoteError> {
        self.call::<m::PtyAdopt>(&PtyAdoptParams {
            owner: owner.to_string(),
        })
        .await
    }

    pub async fn exec_run(&self, params: &ExecParams) -> Result<ExecResult, RemoteError> {
        self.call::<m::ExecRun>(params).await
    }

    pub async fn fs_read(&self, params: &FsReadParams) -> Result<FsReadResult, RemoteError> {
        self.call::<m::FsRead>(params).await
    }

    pub async fn fs_write(
        &self,
        path: &str,
        data: Vec<u8>,
        mode: Option<u32>,
    ) -> Result<(), RemoteError> {
        self.call::<m::FsWrite>(&FsWriteParams {
            path: path.to_string(),
            data,
            mode,
        })
        .await
        .map(drop)
    }

    pub async fn fs_stat(&self, path: &str) -> Result<FsStat, RemoteError> {
        self.call::<m::FsStat>(&FsStatParams {
            path: path.to_string(),
        })
        .await
    }

    pub async fn hooks_push(&self, params: &HookPushParams) -> Result<u64, RemoteError> {
        Ok(self.call::<m::HooksPush>(params).await?.seq)
    }

    /// Subscribe to hook events after `after`. The receiver replaces any
    /// earlier one on this client; the daemon redelivers everything not yet
    /// acked, so a consumer must be idempotent by `seq` or dedupe on it.
    pub async fn hooks_subscribe(
        &self,
        after: Option<u64>,
    ) -> Result<mpsc::UnboundedReceiver<HookMessage>, RemoteError> {
        let (tx, rx) = mpsc::unbounded_channel();
        // Installed before the request so the backlog, which follows the
        // response on the wire, has somewhere to go.
        self.shared.lock().hooks = Some(tx.clone());
        match self
            .call::<m::HooksSubscribe>(&HooksSubscribeParams { after })
            .await
        {
            Ok(_) => Ok(rx),
            Err(e) => {
                let mut st = self.shared.lock();
                if st.hooks.as_ref().is_some_and(|h| h.same_channel(&tx)) {
                    st.hooks = None;
                }
                Err(e)
            }
        }
    }

    /// Let the daemon forget every event up to and including `up_to`.
    pub async fn hooks_ack(&self, up_to: u64) -> Result<(), RemoteError> {
        self.call::<m::HooksAck>(&HooksAckParams { up_to })
            .await
            .map(drop)
    }
}

async fn read_loop<R: AsyncRead + Unpin>(shared: Arc<Shared>, reader: R, options: ClientOptions) {
    let mut reader = BufReader::with_capacity(64 * 1024, reader);
    let mut line = Vec::new();
    let reason = loop {
        match read_line(
            &mut reader,
            &mut line,
            options.max_line,
            Some(options.idle_timeout),
        )
        .await
        {
            Ok(()) => {
                *shared.last_seen.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
                if !line.is_empty() {
                    shared.dispatch(&line);
                }
            }
            Err(ReadEnd::Closed) => break "connection closed".to_string(),
            Err(ReadEnd::Failed(reason)) => break reason,
        }
    };
    shared.fail(reason);
}

async fn write_loop<W: AsyncWrite + Unpin>(
    shared: Arc<Shared>,
    mut writer: W,
    mut lines: mpsc::UnboundedReceiver<String>,
) {
    let mut closed = shared.closed.subscribe();
    loop {
        let line = tokio::select! {
            line = lines.recv() => line,
            _ = closed.wait_for(|closed| *closed) => None,
        };
        let Some(mut line) = line else { break };
        line.push('\n');
        let written = async {
            writer.write_all(line.as_bytes()).await?;
            writer.flush().await
        };
        if let Err(e) = written.await {
            shared.fail(format!("write failed: {e}"));
            break;
        }
    }
    let _ = writer.shutdown().await;
}
