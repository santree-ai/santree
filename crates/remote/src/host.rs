//! `RemoteHost`: the connection lifecycle for one server.
//!
//! Connects to its one target and completes `hello`. While connected it keeps
//! a hooks subscription open, forwarding
//! events into one receiver that survives reconnects. When the link dies it
//! reports `Connecting` (panes read "reconnecting", never "exited") and tries
//! again with backoff; every successful connect is broadcast as a
//! [`Reconnected`] so terminals re-attach through their ring anchors.
//!
//! Unreachable is a normal state, not an error: it is only ever *reported*,
//! through [`RemoteHost::status`].

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{broadcast, mpsc, watch};
use tokio::task::JoinHandle;

use crate::client::{ClientOptions, HookMessage, RemoteClient, RemoteError};
use crate::proto::{ErrorCode, PROTOCOL_VERSION};
use crate::transport::{Connector, Link, LinkTransport, SshTarget};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostStatus {
    NotConfigured,
    Connecting,
    Connected {
        version: String,
    },
    Unreachable {
        reason: String,
    },
    /// The daemon speaks another protocol; `theirs` when it said which.
    VersionMismatch {
        theirs: Option<u32>,
    },
}

/// What to connect to, and as whom.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostConfig {
    pub target: SshTarget,
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
    /// Bounds one attempt from spawning the transport to `hello`'s answer.
    pub hello_timeout: Duration,
    pub client: ClientOptions,
}

impl Default for HostOptions {
    fn default() -> Self {
        Self {
            backoff_min: Duration::from_secs(1),
            backoff_max: Duration::from_secs(30),
            hello_timeout: Duration::from_secs(10),
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
    client: Mutex<Option<Arc<RemoteClient>>>,
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

    fn set_client(&self, client: Option<Arc<RemoteClient>>) {
        *self.client.lock().unwrap_or_else(|e| e.into_inner()) = client;
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
    /// An idle host (`NotConfigured`) that will open links through
    /// `connector` — `SshConnector` in the app, the fake's in tests.
    pub fn new(connector: Arc<dyn Connector>, options: HostOptions) -> Self {
        let (status, _) = watch::channel(HostStatus::NotConfigured);
        let (reconnected, _) = broadcast::channel(16);
        let (hooks_tx, hooks_rx) = mpsc::unbounded_channel();
        Self {
            inner: Arc::new(Inner {
                connector,
                options,
                status,
                client: Mutex::new(None),
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
        self.inner.set_client(None);
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
            None => self.inner.set_status(HostStatus::NotConfigured),
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
        self.inner
            .client
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
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
    Failed(String),
    Version(Option<u32>),
}

struct Connection {
    client: Arc<RemoteClient>,
    /// Kept alive for as long as the client is in use (it owns the ssh child).
    _transport: Box<dyn LinkTransport>,
    version: String,
    boot_id: String,
}

async fn attempt(inner: &Inner, config: &HostConfig) -> Result<Connection, AttemptError> {
    let opened = tokio::time::timeout(inner.options.hello_timeout, async {
        let Link {
            reader,
            writer,
            transport,
        } = inner
            .connector
            .connect(&config.target)
            .await
            .map_err(AttemptError::Failed)?;
        let client = Arc::new(RemoteClient::with_options(
            reader,
            writer,
            inner.options.client.clone(),
        ));
        let hello = client.hello(&config.client, &config.owner).await;
        Ok::<_, AttemptError>((client, transport, hello))
    })
    .await
    .map_err(|_| AttemptError::Failed("the server did not answer in time".into()))??;

    let (client, mut transport, hello) = opened;
    match hello {
        Ok(hello) if hello.protocol == PROTOCOL_VERSION => Ok(Connection {
            client,
            _transport: transport,
            version: hello.version,
            boot_id: hello.boot_id,
        }),
        Ok(hello) => Err(AttemptError::Version(Some(hello.protocol))),
        Err(RemoteError::Remote(e)) if e.code == ErrorCode::Version => {
            Err(AttemptError::Version(e.protocol))
        }
        Err(e @ RemoteError::Disconnected(_)) => {
            // The link died under the handshake: the transport usually knows
            // why (ssh's "Permission denied", a missing santree-remote).
            let reason = transport.failure_reason().await;
            Err(AttemptError::Failed(
                reason.unwrap_or_else(|| e.to_string()),
            ))
        }
        Err(e) => Err(AttemptError::Failed(e.to_string())),
    }
}

async fn run(inner: Arc<Inner>, config: HostConfig) {
    let mut backoff = inner.options.backoff_min;
    loop {
        match attempt(&inner, &config).await {
            Ok(connection) => {
                backoff = inner.options.backoff_min;
                serve(&inner, connection).await;
                inner.set_client(None);
                inner.set_status(HostStatus::Connecting);
            }
            Err(AttemptError::Version(theirs)) => {
                inner.set_status(HostStatus::VersionMismatch { theirs })
            }
            Err(AttemptError::Failed(reason)) => {
                log::info!("remote: {} unreachable: {reason}", config.target.host);
                inner.set_status(HostStatus::Unreachable { reason });
            }
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(inner.options.backoff_max);
    }
}

/// Run one live link until it dies.
async fn serve(inner: &Inner, connection: Connection) {
    let client = connection.client.clone();
    let boot_id = connection.boot_id.clone();
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

    inner.set_client(Some(client.clone()));
    inner.set_status(HostStatus::Connected {
        version: connection.version.clone(),
    });
    let generation = inner.generation.fetch_add(1, Ordering::Relaxed) + 1;
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
