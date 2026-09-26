//! The live link to `santree-remote` on Daedalus (docs/remote.md): one
//! [`RemoteHost`] over system ssh, configured from the `daedalus_connection`
//! row, plus the relay that applies the hooks agents fire on the server.
//!
//! [`DaedalusHost`] is Tauri-managed. Everything that runs on the server gets
//! its client through [`client`] / [`connected_client`] and turns
//! [`NotConnected`] into its own disabled state — a Daedalus project never
//! falls back to running locally.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;
use tokio::sync::{broadcast, mpsc};

use santree_core::domain::DaemonReach;
use santree_hook::{HookEnv, Invocation, Nudges};
use santree_remote_client::proto::HookEvent;
use santree_remote_client::{
    Connector, HookDelivery, HookMessage, HostConfig, HostOptions, HostStatus, Reconnected,
    RemoteClient, RemoteHost, SshConnector, SshTarget,
};

use super::Row;
use crate::db::Db;
use crate::session;
use crate::session_signal::{self, Signal};
use crate::tabs::validate_term_key;

/// ssh's port when Daedalus doesn't name one.
const DEFAULT_SSH_PORT: u16 = 22;

/// How long [`connected_client`] waits out a link that is still coming up.
pub const CONNECT_WAIT: Duration = Duration::from_secs(5);

/// Hook events applied between acks at most. Acks are per batch: one round
/// trip and one cursor write for a burst, not one per event.
const ACK_BATCH: usize = 256;

/// "The link to santree-remote changed state" — the frontend refetches
/// `daedalus_daemon_status`. Empty, like its siblings: the arrival is the news.
#[derive(Clone, Serialize, Type, Event)]
pub struct DaedalusDaemonChanged {}

/// Why there is no client to hand out: the link's state at the time of asking.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotConnected {
    pub reach: DaemonReach,
}

impl std::fmt::Display for NotConnected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.reach {
            DaemonReach::NotConfigured => {
                f.write_str("Daedalus hasn't reported how to reach it over ssh yet.")
            }
            DaemonReach::Connecting => f.write_str("Still connecting to Daedalus."),
            DaemonReach::Connected { .. } => f.write_str("The link to Daedalus just dropped."),
            DaemonReach::Unreachable { reason } => write!(f, "Can't reach Daedalus: {reason}"),
            DaemonReach::VersionMismatch { .. } => {
                f.write_str("santree-remote on Daedalus speaks another protocol version.")
            }
        }
    }
}

impl std::error::Error for NotConnected {}

/// The app's one link to Daedalus.
pub struct DaedalusHost {
    host: Arc<RemoteHost>,
    /// What [`DaedalusHost::sync`] last configured, so a refresh that changes
    /// nothing doesn't drop a working link.
    applied: Mutex<Option<HostConfig>>,
    /// `hello`'s `owner`: this app process. Minted per launch — the link
    /// outlives page reloads, so it can't be the webview's page owner (which
    /// is what a remote PTY session is tagged with, like a local one).
    owner: String,
    app_dir: PathBuf,
}

impl DaedalusHost {
    /// A host that reaches Daedalus with system ssh, keeping its pinned host
    /// key and control sockets under `<app_dir>/ssh`.
    pub fn new(app_dir: PathBuf) -> Self {
        let connector = Arc::new(SshConnector::new(app_dir.clone()));
        Self::with_connector(connector, HostOptions::default(), app_dir)
    }

    pub fn with_connector(
        connector: Arc<dyn Connector>,
        options: HostOptions,
        app_dir: PathBuf,
    ) -> Self {
        Self {
            host: Arc::new(RemoteHost::new(connector, options)),
            applied: Mutex::new(None),
            owner: uuid::Uuid::new_v4().to_string(),
            app_dir,
        }
    }

    pub fn app_dir(&self) -> &Path {
        &self.app_dir
    }

    /// Bring the link in line with the saved connection: (re)configure when
    /// its target changed, stop when there is none, and otherwise leave it
    /// alone. Cheap — call it after anything that may have changed the row.
    pub async fn sync(&self, db: &Db) {
        match super::load(db).await {
            Ok(row) => self.apply(row.as_ref().and_then(|row| self.config_for(row))),
            Err(e) => log::warn!("daedalus: reading the connection for the link failed: {e:#}"),
        }
    }

    fn config_for(&self, row: &Row) -> Option<HostConfig> {
        let target = target(row)?;
        // The pair is only meaningful together (seqs restart per boot).
        let (hook_cursor, boot_id) = match (&row.boot_id, row.hook_cursor) {
            (Some(boot), Some(seq)) => (u64::try_from(seq).ok(), Some(boot.clone())),
            _ => (None, None),
        };
        Some(HostConfig {
            target,
            client: format!("santree/{}", env!("CARGO_PKG_VERSION")),
            owner: self.owner.clone(),
            hook_cursor,
            boot_id,
        })
    }

    fn apply(&self, config: Option<HostConfig>) {
        let mut applied = self.applied.lock().unwrap_or_else(|e| e.into_inner());
        // Only the target decides: the cursor fields just seed a host that
        // hasn't met a daemon yet, and change with every ack.
        let unchanged = match (applied.as_ref(), config.as_ref()) {
            (Some(a), Some(b)) => a.target == b.target,
            (None, None) => true,
            _ => false,
        };
        if unchanged {
            return;
        }
        log::info!(
            "daedalus: link {}",
            if config.is_some() {
                "configured"
            } else {
                "stopped"
            }
        );
        self.host.configure(config.clone());
        *applied = config;
    }

    /// Skip the backoff: a link that isn't up tries again now. What a health
    /// check does before it asks how the link is.
    pub fn retry_now(&self) {
        if matches!(self.host.current_status(), HostStatus::Connected { .. }) {
            return;
        }
        let applied = self.applied.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(config) = applied.clone() {
            self.host.configure(Some(config));
        }
    }

    pub fn reach(&self) -> DaemonReach {
        reach_of(self.host.current_status())
    }

    /// The reach once the link stops `Connecting`, or as it is after `wait`.
    pub async fn settled_reach(&self, wait: Duration) -> DaemonReach {
        let mut status = self.host.status();
        let _ = tokio::time::timeout(wait, status.wait_for(|s| *s != HostStatus::Connecting)).await;
        self.reach()
    }

    /// The live client, or why there isn't one. Don't hold it across a
    /// reconnect: ask again after [`DaedalusHost::reconnected`].
    pub fn client(&self) -> Result<Arc<RemoteClient>, NotConnected> {
        self.host.client().ok_or_else(|| NotConnected {
            reach: self.reach(),
        })
    }

    /// [`DaedalusHost::client`], waiting up to `wait` for a link that is
    /// still `Connecting` — so an action right after launch or a network
    /// change doesn't fail on a link a moment from up.
    pub async fn client_within(&self, wait: Duration) -> Result<Arc<RemoteClient>, NotConnected> {
        if let Some(client) = self.host.client() {
            return Ok(client);
        }
        let mut status = self.host.status();
        let _ = tokio::time::timeout(wait, status.wait_for(|s| *s != HostStatus::Connecting)).await;
        self.client()
    }

    /// Every (re)connect, the first included — terminals re-attach on it.
    pub fn reconnected(&self) -> broadcast::Receiver<Reconnected> {
        self.host.reconnected()
    }

    /// Start the link's background work: announce every status change to the
    /// frontend, relay hooks into `db`, and configure from the saved row.
    /// Call once, from setup.
    pub fn start(&self, app: &AppHandle, db: Db, db_path: String) {
        let mut status = self.host.status();
        let emitter = app.clone();
        tauri::async_runtime::spawn(async move {
            while status.changed().await.is_ok() {
                let reach = reach_of(status.borrow_and_update().clone());
                log::info!("daedalus: link {reach:?}");
                let _ = DaedalusDaemonChanged {}.emit(&emitter);
            }
        });

        if let Some(events) = self.host.take_hook_events() {
            let relay = Relay {
                host: self.host.clone(),
                db: db.clone(),
                db_path,
            };
            let app = app.clone();
            tauri::async_runtime::spawn(relay.run(events, move |nudges| emit_nudges(&app, nudges)));
        }
    }
}

/// The client for running something on Daedalus now, or why not.
#[expect(
    dead_code,
    reason = "the remote git/fs/terminal dispatch is its first caller"
)]
pub fn client(app: &AppHandle) -> Result<Arc<RemoteClient>, NotConnected> {
    app.state::<DaedalusHost>().client()
}

/// [`client`], waiting up to [`CONNECT_WAIT`] while the link is `Connecting`.
#[expect(
    dead_code,
    reason = "the remote git/fs/terminal dispatch is its first caller"
)]
pub async fn connected_client(app: &AppHandle) -> Result<Arc<RemoteClient>, NotConnected> {
    app.state::<DaedalusHost>()
        .client_within(CONNECT_WAIT)
        .await
}

/// Every (re)connect of the link.
#[expect(
    dead_code,
    reason = "the remote git/fs/terminal dispatch is its first caller"
)]
pub fn reconnected(app: &AppHandle) -> broadcast::Receiver<Reconnected> {
    app.state::<DaedalusHost>().reconnected()
}

/// Where a saved connection says sshd is: `None` until Daedalus has reported
/// both a user and a host. Values reach ssh only through `ssh_args`, which
/// validates them (a bad one fails its attempt with a reason rather than
/// vanishing here).
pub(super) fn target(row: &Row) -> Option<SshTarget> {
    let non_empty = |v: &Option<String>| v.as_deref().filter(|v| !v.is_empty()).map(String::from);
    Some(SshTarget {
        user: non_empty(&row.ssh_user)?,
        host: non_empty(&row.ssh_host)?,
        port: row
            .ssh_port
            .and_then(|p| u16::try_from(p).ok())
            .filter(|p| *p != 0)
            .unwrap_or(DEFAULT_SSH_PORT),
        identity_file: row.identity_file.as_ref().map(PathBuf::from),
    })
}

fn reach_of(status: HostStatus) -> DaemonReach {
    match status {
        HostStatus::NotConfigured => DaemonReach::NotConfigured,
        HostStatus::Connecting => DaemonReach::Connecting,
        HostStatus::Connected { version } => DaemonReach::Connected { version },
        HostStatus::Unreachable { reason } => DaemonReach::Unreachable { reason },
        HostStatus::VersionMismatch { theirs } => DaemonReach::VersionMismatch { theirs },
    }
}

/// The same events the signal socket raises for a local hook's nudge.
fn emit_nudges(app: &AppHandle, nudges: Nudges) {
    for (changed, signal) in [
        (nudges.state, Signal::State),
        (nudges.usage, Signal::Usage),
        (nudges.rate_limits, Signal::RateLimits),
    ] {
        if changed {
            session_signal::emit(app, signal);
        }
    }
}

// ── The hook relay ───────────────────────────────────────────────────────────

/// Applies the hooks agents fire on Daedalus to the app's own database, the way
/// `santree-hook` applies a local one, then acks them. Like the local hook it
/// never blocks on a bad event: a failure is logged (and left in
/// `santree-hook-errors.log`), and the event is acked anyway, so one poison
/// event can't wedge the queue behind it.
pub(crate) struct Relay {
    pub host: Arc<RemoteHost>,
    pub db: Db,
    /// The app's db file, for `santree_hook::note`'s log beside it.
    pub db_path: String,
}

impl Relay {
    pub async fn run(
        self,
        mut events: mpsc::UnboundedReceiver<HookDelivery>,
        on_nudges: impl Fn(Nudges),
    ) {
        while let Some(first) = events.recv().await {
            let mut batch = vec![first];
            while batch.len() < ACK_BATCH {
                match events.try_recv() {
                    Ok(delivery) => batch.push(delivery),
                    Err(_) => break,
                }
            }
            let mut nudges = Nudges::default();
            for delivery in &batch {
                match &delivery.message {
                    HookMessage::Event(event) => {
                        let applied = self.apply(event).await;
                        nudges.state |= applied.state;
                        nudges.usage |= applied.usage;
                        nudges.rate_limits |= applied.rate_limits;
                    }
                    HookMessage::Dropped { count } => log::warn!(
                        "daedalus: santree-remote's hook queue overflowed and lost {count} \
                         event(s); agent state may be stale until the next hook"
                    ),
                }
            }
            if nudges != Nudges::default() {
                on_nudges(nudges);
            }
            self.ack(&batch).await;
        }
    }

    /// One event, through the local hook's own code. Never fails.
    pub async fn apply(&self, event: &HookEvent) -> Nudges {
        let Some(invocation) = Invocation::parse_relayed(&event.event) else {
            log::debug!("daedalus: ignoring relayed hook {}", quoted(&event.event));
            return Nudges::default();
        };
        let env = HookEnv::from_pairs(event.env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        let stdin = match self.vetted(&env, &event.stdin).await {
            Ok(stdin) => stdin,
            Err(why) => {
                self.failed(event, &format!("refused: {why}"));
                return Nudges::default();
            }
        };
        let env = self.scoped_env(env).await;
        let mut conn = match self.db.acquire().await {
            Ok(conn) => conn,
            Err(e) => {
                self.failed(event, &format!("no database connection: {e}"));
                return Nudges::default();
            }
        };
        let applied = santree_hook::apply(&mut conn, &invocation, &stdin, &env).await;
        for failure in &applied.failures {
            self.failed(event, failure);
        }
        applied.nudges
    }

    /// The payload to apply, or why the event is refused. The server is not
    /// trusted with what the local hook is: its terminal key and session id
    /// must have the shapes santree's own have, it may not write to a session
    /// a local project owns (`session_state` is keyed by session id alone), and
    /// its `transcript_path` is dropped — a path on the server names nothing on
    /// this Mac, and the app reads a stored one locally (`hooks.rs`
    /// `reconcile_live_state`).
    async fn vetted(&self, env: &HookEnv, stdin: &[u8]) -> Result<Vec<u8>, String> {
        if !env.term_key.is_empty() && validate_term_key(&env.term_key).is_err() {
            return Err(format!("terminal key {}", capped(&env.term_key)));
        }
        // Anything but an object the hook reads as no payload, and writes nothing for.
        let Ok(Value::Object(mut payload)) = serde_json::from_slice::<Value>(stdin) else {
            return Ok(stdin.to_vec());
        };
        let session_id = payload
            .get("session_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !session_id.is_empty() {
            if !session::is_session_id(session_id) {
                return Err(format!("session id {}", capped(session_id)));
            }
            match bound_locally(&self.db, session_id).await {
                Ok(false) => {}
                Ok(true) => return Err(format!("session {session_id} belongs to a local project")),
                Err(e) => return Err(format!("checking session {session_id}'s project: {e:#}")),
            }
        }
        if payload.remove("transcript_path").is_none() {
            return Ok(stdin.to_vec());
        }
        serde_json::to_vec(&payload).map_err(|e| e.to_string())
    }

    /// A relayed event may only bind a terminal of a Daedalus project: the
    /// server has no business naming a local one.
    async fn scoped_env(&self, env: HookEnv) -> HookEnv {
        if env.repo.is_empty() {
            return env;
        }
        match crate::repo::is_daedalus(&self.db, &env.repo).await {
            Ok(true) => env,
            Ok(false) => {
                log::warn!(
                    "daedalus: a relayed hook named {}, which isn't a Daedalus project; \
                     not binding it",
                    quoted(&env.repo)
                );
                HookEnv::default()
            }
            Err(e) => {
                log::warn!("daedalus: checking a relayed hook's project failed: {e:#}");
                HookEnv::default()
            }
        }
    }

    fn failed(&self, event: &HookEvent, detail: &str) {
        let (name, detail) = (quoted(&event.event), quoted(detail));
        log::warn!(
            "daedalus: relayed hook {} ({name}) failed: {detail}",
            event.seq
        );
        santree_hook::note(
            &self.db_path,
            &name,
            &format!("relayed from Daedalus (seq {}): {detail}", event.seq),
        );
    }

    /// Ack the batch's highest seq per boot, and persist each ack the host
    /// took, so an app restart resumes after it.
    async fn ack(&self, batch: &[HookDelivery]) {
        let mut acks: Vec<(&str, u64)> = Vec::new();
        for delivery in batch {
            let HookMessage::Event(event) = &delivery.message else {
                continue;
            };
            match acks.last_mut() {
                Some((boot, seq)) if *boot == delivery.boot_id => *seq = (*seq).max(event.seq),
                _ => acks.push((&delivery.boot_id, event.seq)),
            }
        }
        for (boot, seq) in acks {
            if !self.host.ack_hooks(boot, seq).await {
                continue;
            }
            if let Err(e) = save_cursor(&self.db, boot, seq).await {
                log::warn!("daedalus: saving the hook cursor failed: {e:#}");
            }
        }
    }
}

/// Whether `session_id` is bound to a terminal of a project that isn't on
/// Daedalus — a local one, or one no longer registered (which could only have
/// been local: a Daedalus session's row names its Daedalus project).
async fn bound_locally(db: &Db, session_id: &str) -> anyhow::Result<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS (
             SELECT 1 FROM terminal_sessions t
             WHERE t.session_id = ?
               AND NOT EXISTS (SELECT 1 FROM repos r
                               WHERE r.name = t.repo AND r.location = 'daedalus'))",
    )
    .bind(session_id)
    .fetch_one(db)
    .await?)
}

/// Longest stretch of server-sent text a log line carries, in chars.
const LOGGED_TEXT_MAX: usize = 300;

/// `text` cut to [`LOGGED_TEXT_MAX`] chars.
fn capped(text: &str) -> String {
    match text.char_indices().nth(LOGGED_TEXT_MAX) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text.to_string(),
    }
}

/// Server-sent text as it goes into a log line: capped, and `Debug`-quoted so a
/// newline or control character in it can't forge a line of its own.
fn quoted(text: &str) -> String {
    format!("{:?}", capped(text))
}

async fn save_cursor(db: &Db, boot_id: &str, seq: u64) -> anyhow::Result<()> {
    sqlx::query("UPDATE daedalus_connection SET hook_cursor = ?, boot_id = ? WHERE id = 1")
        .bind(i64::try_from(seq)?)
        .bind(boot_id)
        .execute(db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::future::Future;

    use santree_remote_client::fake::FakeDaemon;
    use santree_remote_client::transport::BoxFuture;
    use santree_remote_client::{ClientOptions, Link};

    use super::*;

    const WAIT: Duration = Duration::from_secs(10);

    async fn eventually<F, Fut>(what: &str, mut check: F)
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = bool>,
    {
        let ok = tokio::time::timeout(WAIT, async {
            while !check().await {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        assert!(ok.is_ok(), "timed out waiting for {what}");
    }

    /// An app database with a Daedalus connection that has ssh info, and one
    /// registered Daedalus project (`acme/web`).
    async fn app_db(base: &Path) -> (Db, String) {
        let _ = std::fs::remove_dir_all(base);
        let path = base.join("santree.db");
        let db = crate::db::init(path.clone()).await.unwrap();
        sqlx::query(
            "INSERT INTO daedalus_connection (id, url, ssh_user, ssh_host, ssh_port)
             VALUES (1, 'https://daedalus.test', 'santiago', 's2.example.org', 22)",
        )
        .execute(&db)
        .await
        .unwrap();
        crate::repo::add_daedalus(
            &db,
            "/srv/projects/web",
            Some("git@github.com:acme/web.git"),
        )
        .await
        .unwrap();
        (db, path.to_string_lossy().into_owned())
    }

    fn fast() -> HostOptions {
        HostOptions {
            backoff_min: Duration::from_millis(20),
            backoff_max: Duration::from_millis(100),
            hello_timeout: Duration::from_secs(5),
            client: ClientOptions::default(),
        }
    }

    /// Reaches whichever daemon is current: swapping it is a server restart.
    fn swappable(current: Arc<Mutex<FakeDaemon>>) -> Arc<dyn Connector> {
        Arc::new(
            move |_: &SshTarget| -> BoxFuture<'static, Result<Link, String>> {
                let link = current.lock().unwrap().connect();
                Box::pin(async move { Ok(link) })
            },
        )
    }

    fn env(term_key: &str) -> Vec<(String, String)> {
        vec![
            ("SANTREE_REPO".into(), "acme/web".into()),
            ("SANTREE_TERM_KEY".into(), term_key.into()),
            ("PATH".into(), "/usr/bin".into()),
        ]
    }

    /// Codex thread ids, as a real server's hooks would send them.
    const T1: &str = "01998f6c-1d3f-7c11-9a2b-4e6f8a0b1c2d";
    const T2: &str = "01998f6c-1d3f-7c11-9a2b-4e6f8a0b1c2e";

    /// Carries a `transcript_path`: a path on the server, which the relay drops.
    const SESSION_START: &[u8] = br#"{"session_id":"01998f6c-1d3f-7c11-9a2b-4e6f8a0b1c2d","cwd":"/srv/projects/web","source":"startup","transcript_path":"/dev/zero"}"#;
    const STATUSLINE: &[u8] = br#"{"session_id":"01998f6c-1d3f-7c11-9a2b-4e6f8a0b1c2d","model":{"id":"gpt-5"},"context_window":{"used_percentage":12.5,"total_input_tokens":3000,"context_window_size":200000},"cost":{"total_cost_usd":0.25}}"#;
    const FOREIGN_START: &[u8] =
        br#"{"session_id":"01998f6c-1d3f-7c11-9a2b-4e6f8a0b1c2e","cwd":"/srv/x"}"#;

    /// `payload` without its `transcript_path` — what the relay hands the hook.
    fn without_transcript(payload: &[u8]) -> Vec<u8> {
        let mut v: Value = serde_json::from_slice(payload).unwrap();
        v.as_object_mut().unwrap().remove("transcript_path");
        serde_json::to_vec(&v).unwrap()
    }

    /// Every row the relay (or the local hook) writes, minus the clocks.
    async fn rows(
        db: &Db,
    ) -> (
        Vec<(String, String, String, String)>,
        Vec<(String, String, String, Option<String>)>,
        Vec<(String, f64, i64)>,
    ) {
        let sessions = sqlx::query_as(
            "SELECT term_key, agent_kind, session_id, cwd FROM terminal_sessions ORDER BY term_key",
        )
        .fetch_all(db)
        .await
        .unwrap();
        let states = sqlx::query_as(
            "SELECT session_id, state, event, transcript_path FROM session_state ORDER BY session_id",
        )
        .fetch_all(db)
        .await
        .unwrap();
        let usage = sqlx::query_as(
            "SELECT session_id, used_pct, input_tokens FROM session_usage_live ORDER BY session_id",
        )
        .fetch_all(db)
        .await
        .unwrap();
        (sessions, states, usage)
    }

    async fn cursor(db: &Db) -> (Option<i64>, Option<String>) {
        sqlx::query_as("SELECT hook_cursor, boot_id FROM daedalus_connection WHERE id = 1")
            .fetch_one(db)
            .await
            .unwrap()
    }

    /// A hook fired on the server lands as exactly the rows the local
    /// `santree-hook` writes for it, the queue is acked and the cursor saved;
    /// a daemon restart starts the cursor over.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn relayed_hooks_write_what_the_local_hook_writes() {
        let base =
            std::env::temp_dir().join(format!("santree-daedalus-relay-{}", std::process::id()));
        let (db, db_path) = app_db(&base.join("app")).await;

        let first = FakeDaemon::new();
        let current = Arc::new(Mutex::new(first.clone()));
        let link = DaedalusHost::with_connector(swappable(current.clone()), fast(), base.clone());
        let mut reconnected = link.reconnected();
        assert!(matches!(
            link.client(),
            Err(NotConnected {
                reach: DaemonReach::NotConfigured
            })
        ));
        link.sync(&db).await;
        let client = link.client_within(WAIT).await.expect("the link comes up");
        drop(client);
        assert!(matches!(link.reach(), DaemonReach::Connected { .. }));
        // A refresh that changes nothing keeps the link.
        link.sync(&db).await;
        assert_eq!(reconnected.recv().await.unwrap().generation, 1);

        let (nudged_tx, mut nudged) = mpsc::unbounded_channel();
        let relay = Relay {
            host: link.host.clone(),
            db: db.clone(),
            db_path: db_path.clone(),
        };
        let events = link.host.take_hook_events().unwrap();
        tokio::spawn(relay.run(events, move |n| {
            let _ = nudged_tx.send(n);
        }));

        // A poison payload, a mode that isn't an event, then real work.
        first.push_hook(
            "--agent-kind Codex SessionStart",
            env("tree:AK-1"),
            b"not json".to_vec(),
        );
        first.push_hook("mcp", vec![], b"{}".to_vec());
        first.push_hook(
            "--agent-kind Codex SessionStart",
            env("tree:AK-1"),
            SESSION_START.to_vec(),
        );
        first.push_hook("statusline", vec![], STATUSLINE.to_vec());
        // Naming a project that isn't a Daedalus one records state but binds nothing.
        let mut foreign = env("tree:AK-2");
        foreign[0].1 = "acme/local".into();
        first.push_hook(
            "--agent-kind Codex SessionStart",
            foreign,
            FOREIGN_START.to_vec(),
        );

        let mut seen = Nudges::default();
        while !(seen.state && seen.usage) {
            let n = tokio::time::timeout(WAIT, nudged.recv())
                .await
                .unwrap()
                .unwrap();
            seen.state |= n.state;
            seen.usage |= n.usage;
        }
        let boot = first.boot_id().to_string();
        eventually("the whole batch acked and saved", || async {
            first.queued_hooks().is_empty() && cursor(&db).await == (Some(5), Some(boot.clone()))
        })
        .await;

        // The same invocations applied straight through the hook library —
        // minus the server's transcript path, which the relay drops on purpose.
        let (direct, _) = app_db(&base.join("direct")).await;
        let mut conn = direct.acquire().await.unwrap();
        let start = Invocation::parse_relayed("--agent-kind Codex SessionStart").unwrap();
        let env_of = |pairs: &[(String, String)]| {
            HookEnv::from_pairs(pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        };
        santree_hook::apply(
            &mut conn,
            &start,
            &without_transcript(SESSION_START),
            &env_of(&env("tree:AK-1")),
        )
        .await;
        santree_hook::apply(
            &mut conn,
            &Invocation::Statusline,
            STATUSLINE,
            &HookEnv::default(),
        )
        .await;
        santree_hook::apply(&mut conn, &start, FOREIGN_START, &HookEnv::default()).await;
        drop(conn);
        let relayed = rows(&db).await;
        assert_eq!(relayed, rows(&direct).await);
        assert_eq!(
            relayed.0,
            vec![(
                "tree:AK-1".into(),
                "Codex".into(),
                T1.into(),
                "/srv/projects/web".into()
            )]
        );
        assert_eq!(relayed.2, vec![(T1.into(), 12.5, 3000)]);
        // No server path is stored for the app to read locally.
        assert_eq!(
            relayed.1,
            vec![
                (T1.into(), "idle".into(), "SessionStart".into(), None),
                (T2.into(), "idle".into(), "SessionStart".into(), None),
            ]
        );
        // The failure the binary would have logged is beside the db too.
        let log =
            std::fs::read_to_string(base.join("app").join("santree-hook-errors.log")).unwrap();
        assert!(log.contains("relayed from Daedalus"), "{log}");

        // An app restart resumes from the saved cursor.
        let row = super::super::load(&db).await.unwrap().unwrap();
        let config = link.config_for(&row).unwrap();
        assert_eq!(
            (config.hook_cursor, config.boot_id.as_deref()),
            (Some(5), Some(boot.as_str()))
        );

        // The server restarts: a new boot, whose seqs start over — and are
        // applied, not skipped as already seen.
        let second = FakeDaemon::new();
        second.push_hook(
            "UserPromptSubmit",
            vec![],
            format!(r#"{{"session_id":"{T1}","cwd":"/srv/projects/web"}}"#).into_bytes(),
        );
        *current.lock().unwrap() = second.clone();
        first.shutdown();
        let new_boot = second.boot_id().to_string();
        eventually("the new boot's first event applied and saved", || async {
            cursor(&db).await == (Some(1), Some(new_boot.clone()))
        })
        .await;
        let (_, states, _) = rows(&db).await;
        assert!(
            states.contains(&(T1.into(), "active".into(), "UserPromptSubmit".into(), None)),
            "{states:?}"
        );

        link.host.stop();
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The server can't write through a terminal key or session id santree
    /// would never mint, nor onto a session a local project owns — the one
    /// `session_state` row a local agent's liveness is read from.
    #[tokio::test]
    async fn relayed_hooks_cannot_reach_local_sessions_or_carry_bad_ids() {
        let base =
            std::env::temp_dir().join(format!("santree-daedalus-vet-{}", std::process::id()));
        let (db, db_path) = app_db(&base).await;
        const LOCAL: &str = "9f1c0e2a-4b7d-4c81-9d2e-0a1b2c3d4e5f";
        const ORPHAN: &str = "9f1c0e2a-4b7d-4c81-9d2e-0a1b2c3d4e60";
        sqlx::query("INSERT INTO repos (name, path) VALUES ('acme/local', '/Users/me/dev/local')")
            .execute(&db)
            .await
            .unwrap();
        // One session of a registered local project, one of a project since removed.
        for (repo, id) in [("acme/local", LOCAL), ("acme/gone", ORPHAN)] {
            sqlx::query(
                "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id, agent_kind)
                 VALUES (?, 'tree:AK-9', '/Users/me/dev/local', ?, 'Claude')",
            )
            .bind(repo)
            .bind(id)
            .execute(&db)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO session_state (session_id, state, event, cwd, updated_at_ms)
                 VALUES (?, 'permission', 'PermissionRequest', '/Users/me/dev/local', 1)",
            )
            .bind(id)
            .execute(&db)
            .await
            .unwrap();
        }
        let before = rows(&db).await;

        let relay = Relay {
            host: Arc::new(RemoteHost::new(
                FakeDaemon::new().connector(),
                HostOptions::default(),
            )),
            db: db.clone(),
            db_path,
        };
        let event = |event: &str, env: Vec<(String, String)>, stdin: String| HookEvent {
            seq: 1,
            at: 0,
            event: event.into(),
            env,
            stdin: stdin.into_bytes(),
        };
        let prompt = |id: &str| format!(r#"{{"session_id":"{id}","cwd":"/srv/projects/web"}}"#);
        for refused in [
            event("UserPromptSubmit", vec![], prompt(LOCAL)),
            event("UserPromptSubmit", vec![], prompt(ORPHAN)),
            event(
                "statusline",
                vec![],
                format!(r#"{{"session_id":"{LOCAL}","context_window":{{"used_percentage":1}}}}"#),
            ),
            event("UserPromptSubmit", vec![], prompt("../../../etc/passwd")),
            event("UserPromptSubmit", vec![], prompt("t-1")),
            event(
                "--agent-kind Codex SessionStart",
                env("tree:AK-1;touch /tmp/x"),
                prompt(T1),
            ),
            event(
                "--agent-kind Codex SessionStart",
                env("tree:$(id)\nforged line"),
                prompt(T1),
            ),
        ] {
            assert_eq!(relay.apply(&refused).await, Nudges::default());
        }
        assert_eq!(rows(&db).await, before, "a refused event wrote nothing");

        let log = std::fs::read_to_string(base.join("santree-hook-errors.log")).unwrap();
        assert!(log.contains("belongs to a local project"), "{log}");
        // Relayed text reaches the log escaped: one line per refusal, never two.
        assert_eq!(log.lines().count(), 7, "{log}");
        assert!(log.contains(r"tree:$(id)\nforged line"), "{log}");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn logged_server_text_is_quoted_and_capped() {
        assert_eq!(quoted("a\nb"), r#""a\nb""#);
        let long = "x".repeat(LOGGED_TEXT_MAX + 50);
        let logged = quoted(&long);
        assert_eq!(
            logged.chars().filter(|c| *c == 'x').count(),
            LOGGED_TEXT_MAX
        );
        assert!(logged.ends_with("…\""), "{logged}");
    }

    #[test]
    fn the_target_follows_the_saved_connection() {
        let row = |user: Option<&str>, host: Option<&str>, port: Option<i64>| Row {
            url: "https://d.test".into(),
            ssh_user: user.map(Into::into),
            ssh_host: host.map(Into::into),
            ssh_port: port,
            projects_root: None,
            identity_file: Some("/Users/me/.ssh/daedalus".into()),
            fetched_at: None,
            hook_cursor: None,
            boot_id: None,
        };
        assert_eq!(
            target(&row(Some("me"), Some("s2.example.org"), None)),
            Some(SshTarget {
                user: "me".into(),
                host: "s2.example.org".into(),
                port: 22,
                identity_file: Some(PathBuf::from("/Users/me/.ssh/daedalus")),
            })
        );
        let port = |p| target(&row(Some("me"), Some("s2.example.org"), p)).map(|t| t.port);
        assert_eq!(port(Some(2222)), Some(2222));
        assert_eq!(port(Some(0)), Some(22));
        assert_eq!(port(Some(70_000)), Some(22));
        assert_eq!(target(&row(None, Some("s2.example.org"), None)), None);
        assert_eq!(target(&row(Some("me"), None, None)), None);
        assert_eq!(target(&row(Some("me"), Some(""), None)), None);
    }
}
