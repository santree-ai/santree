//! `RemoteHost`: the connection lifecycle for one session host.
//!
//! Opens a link through its [`Connector`] and completes `hello`. While
//! connected it keeps a hooks subscription open, forwarding events into one
//! receiver that survives reconnects. When the link dies it reports
//! `Connecting` (panes read "reconnecting", never "exited") and tries again
//! with backoff — at the slowest pace at once when the connect failed in a way
//! only a person can change ([`ConnectError::permanent`]); every successful
//! connect is broadcast as a [`Reconnected`] so terminals re-attach through
//! their ring anchors.
//!
//! Unreachable is a normal state, not an error: it is only ever *reported*,
//! through [`RemoteHost::status`].

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{broadcast, mpsc, watch};
use tokio::task::JoinHandle;

use crate::client::{ClientOptions, HookMessage, RemoteClient, RemoteError};
use crate::proto::{ErrorCode, HelloResult, PROTOCOL_VERSION};
use crate::transport::{ConnectError, Connector, Link};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostStatus {
    /// Not started, or stopped.
    Stopped,
    Connecting,
    Connected {
        /// The session host's own version.
        version: String,
        hostname: String,
        /// Where the host's checkouts live.
        projects_root: String,
        /// The agent's version, when the link came through it.
        agent: Option<String>,
    },
    /// No link: why, as the connect (or the handshake after it) said.
    Down(ConnectError),
    /// The host speaks another protocol; `theirs` when it said which.
    VersionMismatch {
        theirs: Option<u32>,
    },
}

/// Who this client is, and where it was in the hook queue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostConfig {
    /// `hello`'s `client`: `santree/<ver>`.
    pub client: String,
    /// `hello`'s `owner`: a stable id for this app instance.
    pub owner: String,
    /// The last hook seq the app has durably applied, so a restart resumes
    /// after it rather than replaying the daemon's whole queue.
    pub hook_cursor: Option<u64>,
    /// The daemon boot `hook_cursor` was taken under. Seqs restart with every
    /// boot, so a connect that reports another one drops the cursor.
    pub boot_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct HostOptions {
    pub backoff_min: Duration,
    pub backoff_max: Duration,
    /// Bounds one attempt from opening the link to `hello`'s answer.
    pub hello_timeout: Duration,
    pub client: ClientOptions,
}

impl Default for HostOptions {
    fn default() -> Self {
        Self {
            backoff_min: Duration::from_secs(1),
            backoff_max: Duration::from_secs(30),
            // Past the agent's own first-line wait (its dial to the host
            // included), plus the handshake.
            hello_timeout: Duration::from_secs(25),
            client: ClientOptions::default(),
        }
    }
}

/// One message off [`RemoteHost::take_hook_events`], tagged with the daemon
/// boot it came from. Ack with that same `boot_id`: an ack for a boot the
/// daemon has since restarted out of would land on the new boot's seqs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookDelivery {
    pub boot_id: String,
    pub message: HookMessage,
}

/// A link came (back) up. Sent for every successful connect, the first
/// included — `generation` counts them — so a terminal waiting for the server
/// and one that lost it re-attach the same way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reconnected {
    pub generation: u64,
}

#[derive(Default)]
struct HookCursor {
    /// The daemon boot `acked` and `forwarded` count in.
    boot_id: Option<String>,
    /// Highest seq the consumer acked.
    acked: Option<u64>,
    /// Highest seq forwarded to the consumer. The daemon redelivers what was
    /// forwarded but not yet acked when a link comes back; this is what keeps
    /// the consumer from seeing it twice.
    forwarded: Option<u64>,
}

struct Inner {
    connector: Arc<dyn Connector>,
    options: HostOptions,
    status: watch::Sender<HostStatus>,
    /// The live client and the `hello` it was answered, set together.
    live: Mutex<Option<(Arc<RemoteClient>, Arc<HelloResult>)>>,
    reconnected: broadcast::Sender<Reconnected>,
    hooks_tx: mpsc::UnboundedSender<HookDelivery>,
    hooks_rx: Mutex<Option<mpsc::UnboundedReceiver<HookDelivery>>>,
    cursor: Mutex<HookCursor>,
    generation: AtomicU64,
}

impl Inner {
    fn set_status(&self, status: HostStatus) {
        self.status.send_if_modified(|current| {
            let changed = *current != status;
            *current = status;
            changed
        });
    }

    fn set_live(&self, live: Option<(Arc<RemoteClient>, Arc<HelloResult>)>) {
        *self.live() = live;
    }

    fn live(&self) -> std::sync::MutexGuard<'_, Option<(Arc<RemoteClient>, Arc<HelloResult>)>> {
        self.live.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn cursor(&self) -> std::sync::MutexGuard<'_, HookCursor> {
        self.cursor.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Owns the link to one server. Cheap to share behind an `Arc`.
pub struct RemoteHost {
    inner: Arc<Inner>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl Drop for RemoteHost {
    fn drop(&mut self) {
        if let Some(task) = self.task.lock().unwrap_or_else(|e| e.into_inner()).take() {
            task.abort();
        }
    }
}

impl RemoteHost {
    /// An idle host (`Stopped`) that will open links through `connector` —
    /// `AgentConnector` in the app, the fake's in tests.
    pub fn new(connector: Arc<dyn Connector>, options: HostOptions) -> Self {
        let (status, _) = watch::channel(HostStatus::Stopped);
        let (reconnected, _) = broadcast::channel(16);
        let (hooks_tx, hooks_rx) = mpsc::unbounded_channel();
        Self {
            inner: Arc::new(Inner {
                connector,
                options,
                status,
                live: Mutex::new(None),
                reconnected,
                hooks_tx,
                hooks_rx: Mutex::new(Some(hooks_rx)),
                cursor: Mutex::new(HookCursor::default()),
                generation: AtomicU64::new(0),
            }),
            task: Mutex::new(None),
        }
    }

    /// (Re)start with `config`, or stop with `None`. Drops any current link.
    /// Spawns on the current tokio runtime, so call it from inside one.
    pub fn configure(&self, config: Option<HostConfig>) {
        let mut task = self.task.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(old) = task.take() {
            old.abort();
        }
        self.inner.set_live(None);
        match config {
            Some(config) => {
                {
                    // What this host saw itself is at least as fresh as what the
                    // caller persisted from it; the config only seeds a host
                    // that hasn't met a daemon yet.
                    let mut cursor = self.inner.cursor();
                    if cursor.boot_id.is_none() {
                        cursor.boot_id = config.boot_id.clone();
                        if let Some(seq) = config.hook_cursor {
                            cursor.acked = Some(cursor.acked.map_or(seq, |a| a.max(seq)));
                            cursor.forwarded = Some(cursor.forwarded.map_or(seq, |f| f.max(seq)));
                        }
                    }
                }
                self.inner.set_status(HostStatus::Connecting);
                *task = Some(tokio::spawn(run(self.inner.clone(), config)));
            }
            None => self.inner.set_status(HostStatus::Stopped),
        }
    }

    /// Drop the link and stop reconnecting.
    pub fn stop(&self) {
        self.configure(None);
    }

    pub fn status(&self) -> watch::Receiver<HostStatus> {
        self.inner.status.subscribe()
    }

    pub fn current_status(&self) -> HostStatus {
        self.inner.status.borrow().clone()
    }

    /// The live client, when connected. Don't hold it across a reconnect:
    /// ask again after a [`Reconnected`].
    pub fn client(&self) -> Option<Arc<RemoteClient>> {
        self.inner.live().as_ref().map(|(client, _)| client.clone())
    }

    /// What the host answered `hello` on the live link — its `features`,
    /// say — when connected.
    pub fn hello(&self) -> Option<Arc<HelloResult>> {
        self.inner.live().as_ref().map(|(_, hello)| hello.clone())
    }

    /// How many links this host has brought up, the one now live included —
    /// the [`Reconnected::generation`] of the latest. What a cache keyed on
    /// "this link" compares to know a reconnect happened since.
    pub fn generation(&self) -> u64 {
        self.inner.generation.load(Ordering::Relaxed)
    }

    pub fn reconnected(&self) -> broadcast::Receiver<Reconnected> {
        self.inner.reconnected.subscribe()
    }

    /// The hook event stream, across every link this host ever has. There is
    /// one consumer: the first call takes it, later calls get `None`.
    pub fn take_hook_events(&self) -> Option<mpsc::UnboundedReceiver<HookDelivery>> {
        self.inner
            .hooks_rx
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
    }

    /// The consumer has applied every event of boot `boot_id` through
    /// `up_to`. Remembered for the next subscribe, and sent to the daemon now
    /// when connected (a disconnected ack is sent on the next connect instead,
    /// so a failed send is only logged).
    ///
    /// `false` when `boot_id` is no longer the daemon's boot: the daemon
    /// restarted since, its seqs start over, and this ack means nothing there.
    /// Nothing is recorded, and the caller must not persist it.
    pub async fn ack_hooks(&self, boot_id: &str, up_to: u64) -> bool {
        {
            let mut cursor = self.inner.cursor();
            if cursor.boot_id.as_deref() != Some(boot_id) {
                return false;
            }
            cursor.acked = Some(cursor.acked.map_or(up_to, |a| a.max(up_to)));
        }
        if let Some(client) = self.client() {
            if let Err(e) = client.hooks_ack(up_to).await {
                log::debug!("remote: hook ack not sent now ({e}); it goes with the next connect");
            }
        }
        true
    }
}

enum AttemptError {
    Down(ConnectError),
    Version(Option<u32>),
}

struct Connection {
    client: Arc<RemoteClient>,
    hello: Arc<HelloResult>,
    /// The agent's version, when the link came through it.
    agent: Option<String>,
}

async fn attempt(inner: &Inner, config: &HostConfig) -> Result<Connection, AttemptError> {
    let failed = |reason: &str| AttemptError::Down(ConnectError::Failed(reason.into()));
    let opened = tokio::time::timeout(inner.options.hello_timeout, async {
        let Link {
            reader,
            writer,
            agent,
        } = inner
            .connector
            .connect()
            .await
            .map_err(AttemptError::Down)?;
        let client = Arc::new(RemoteClient::with_options(
            reader,
            writer,
            inner.options.client.clone(),
        ));
        let hello = client.hello(&config.client, &config.owner).await;
        Ok::<_, AttemptError>((client, agent, hello))
    })
    .await
    .map_err(|_| failed("the session host didn't answer in time"))??;

    let (client, agent, hello) = opened;
    match hello {
        Ok(hello) if hello.protocol == PROTOCOL_VERSION => Ok(Connection {
            client,
            hello: Arc::new(hello),
            agent: agent.map(|a| a.agent),
        }),
        Ok(hello) => Err(AttemptError::Version(Some(hello.protocol))),
        Err(RemoteError::Remote(e)) if e.code == ErrorCode::Version => {
            Err(AttemptError::Version(e.protocol))
        }
        // The agent answered `ok`, then the stream ended before the host said
        // a word: in TLS 1.3 that is how the host turns a key away after the
        // handshake, so the likeliest reason is its allow-list.
        Err(RemoteError::Disconnected(_)) => Err(failed(
            "the session host closed the link before answering; it may not admit this machine \
             yet",
        )),
        Err(e) => Err(AttemptError::Down(ConnectError::Failed(e.to_string()))),
    }
}

async fn run(inner: Arc<Inner>, config: HostConfig) {
    let mut backoff = inner.options.backoff_min;
    loop {
        let mut wait = backoff;
        match attempt(&inner, &config).await {
            Ok(connection) => {
                wait = inner.options.backoff_min;
                serve(&inner, connection).await;
                inner.set_live(None);
                inner.set_status(HostStatus::Connecting);
            }
            // Retrying soon cannot change these: wait at the slow end, where a
            // fix made elsewhere (the agent installed, santree turned on, the
            // host updated) is still picked up without a restart.
            Err(AttemptError::Version(theirs)) => {
                wait = inner.options.backoff_max;
                inner.set_status(HostStatus::VersionMismatch { theirs });
            }
            Err(AttemptError::Down(e)) => {
                if e.permanent() {
                    wait = inner.options.backoff_max;
                }
                inner.set_status(HostStatus::Down(e));
            }
        }
        tokio::time::sleep(wait).await;
        backoff = (wait * 2).min(inner.options.backoff_max);
    }
}

/// Run one live link until it dies.
async fn serve(inner: &Inner, connection: Connection) {
    let client = connection.client.clone();
    let boot_id = connection.hello.boot_id.clone();
    let acked = {
        let mut cursor = inner.cursor();
        if cursor.boot_id.as_deref() != Some(boot_id.as_str()) {
            // The daemon restarted (or this is the first boot we've seen): its
            // seqs start over at 1, so a cursor from another boot would skip
            // events. Replay the whole queue instead: re-applying an event only
            // lands its rows where they already were.
            if cursor.acked.is_some() {
                log::info!("remote: daemon rebooted; hook cursor reset");
            }
            *cursor = HookCursor {
                boot_id: Some(boot_id.clone()),
                acked: None,
                forwarded: None,
            };
        }
        cursor.acked
    };
    if let Some(seq) = acked {
        // An ack made while the link was down (or by a previous run).
        if let Err(e) = client.hooks_ack(seq).await {
            log::warn!("remote: re-sending hook ack failed: {e}");
        }
    }
    let mut hooks = match client.hooks_subscribe(acked).await {
        Ok(hooks) => Some(hooks),
        Err(e) if e.is_disconnected() => return,
        Err(e) => {
            log::warn!("remote: hooks subscribe failed: {e}");
            None
        }
    };

    // Counted before the link is handed out, so whoever sees this link's
    // client or hello also sees its generation.
    let generation = inner.generation.fetch_add(1, Ordering::Relaxed) + 1;
    let hello = &connection.hello;
    inner.set_live(Some((client.clone(), hello.clone())));
    inner.set_status(HostStatus::Connected {
        version: hello.version.clone(),
        hostname: hello.hostname.clone(),
        projects_root: hello.projects_root.clone(),
        agent: connection.agent.clone(),
    });
    log::info!("remote: connected (generation {generation})");
    let _ = inner.reconnected.send(Reconnected { generation });

    loop {
        let message = tokio::select! {
            _ = client.closed() => break,
            message = async {
                match hooks.as_mut() {
                    Some(rx) => rx.recv().await,
                    None => std::future::pending().await,
                }
            } => message,
        };
        let Some(message) = message else {
            // The subscription ended without the link: keep serving the link.
            hooks = None;
            continue;
        };
        if let HookMessage::Event(event) = &message {
            let mut cursor = inner.cursor();
            if cursor.forwarded.is_some_and(|seq| event.seq <= seq) {
                continue;
            }
            cursor.forwarded = Some(event.seq);
        }
        let _ = inner.hooks_tx.send(HookDelivery {
            boot_id: boot_id.clone(),
            message,
        });
    }
    log::info!(
        "remote: link lost: {}",
        client.close_reason().unwrap_or_default()
    );
}
