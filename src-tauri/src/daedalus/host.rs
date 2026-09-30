//! The live link to Daedalus (docs/remote.md): one [`RemoteHost`] through the
//! Daedalus agent on this machine, plus the relay that applies the hooks
//! agents fire on the server.
//!
//! [`DaedalusHost`] is Tauri-managed. Everything that runs on the server gets
//! its client through [`DaedalusHost::client_within`] — by way of
//! `repo::checkout`, the one place a repo is resolved to where it lives — and
//! turns [`NotConnected`] into its own disabled state: a Daedalus project never
//! falls back to running locally.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event;
use tokio::sync::mpsc;

use santree_core::domain::DaedalusLink;
use santree_hook::{HookEnv, Invocation, Nudges};
use santree_remote_client::proto::{HelloResult, HookEvent};
use santree_remote_client::{
    AgentConnector, ConnectError, Connector, HookDelivery, HookMessage, HostConfig, HostOptions,
    HostStatus, Refusal, RemoteClient, RemoteHost,
};

use crate::db::Db;
use crate::session;
use crate::session_signal::{self, Signal};
use crate::tabs::validate_term_key;

/// How long a read waits out a link that is still coming up.
pub const CONNECT_WAIT: Duration = Duration::from_secs(5);

/// Hook events applied between acks at most. Acks are per batch: one round
/// trip and one cursor write for a burst, not one per event.
const ACK_BATCH: usize = 256;

/// "The link to Daedalus changed state" — the frontend refetches
/// `daedalus_status`. Empty, like its siblings: the arrival is the news.
#[derive(Clone, Serialize, Type, Event)]
pub struct DaedalusLinkChanged {}

/// Why there is no client to hand out: the link's state at the time of asking.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotConnected {
    pub link: DaedalusLink,
}

impl std::fmt::Display for NotConnected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&describe(&self.link))
    }
}

impl std::error::Error for NotConnected {}

/// A link state as one sentence, for an action that needed the link.
pub fn describe(link: &DaedalusLink) -> String {
    match link {
        DaedalusLink::AgentMissing => {
            "Install the Daedalus agent on this machine to reach Daedalus.".into()
        }
        DaedalusLink::AgentOutdated => {
            "Update the Daedalus agent on this machine: this one is too old for santree.".into()
        }
        DaedalusLink::Connecting => "Still connecting to Daedalus.".into(),
        DaedalusLink::SantreeOff => {
            "santree is off for this machine. Turn it on in Daedalus › Settings › Machines.".into()
        }
        DaedalusLink::HostKeyChanged { reason } => {
            format!("Daedalus's session host key changed: {reason}")
        }
        DaedalusLink::Unavailable { reason } => format!("Can't reach Daedalus: {reason}"),
        DaedalusLink::VersionMismatch { .. } => {
            "Daedalus's session host speaks another protocol version.".into()
        }
        DaedalusLink::Connected { .. } => "The link to Daedalus just dropped.".into(),
    }
}

/// The app's one link to Daedalus.
pub struct DaedalusHost {
    host: Arc<RemoteHost>,
    /// What [`DaedalusHost::resume`] configured, for [`DaedalusHost::retry_now`].
    applied: Mutex<Option<HostConfig>>,
    /// `hello`'s `owner`: this app process. Minted per launch — the link
    /// outlives page reloads, so it can't be the webview's page owner (which
    /// is what a remote PTY session is tagged with, like a local one).
    owner: String,
}

impl Default for DaedalusHost {
    /// A host that reaches Daedalus through the installed agent's socket.
    fn default() -> Self {
        Self::with_connector(Arc::new(AgentConnector::new()), HostOptions::default())
    }
}

impl DaedalusHost {
    pub fn with_connector(connector: Arc<dyn Connector>, options: HostOptions) -> Self {
        Self {
            host: Arc::new(RemoteHost::new(connector, options)),
            applied: Mutex::new(None),
            owner: uuid::Uuid::new_v4().to_string(),
        }
    }

    /// Start linking, resuming the hook queue after `cursor` (`(boot_id,
    /// seq)`, as [`saved_cursor`] reads it). Call once the runtime is up.
    pub fn resume(&self, cursor: Option<(String, u64)>) {
        let (boot_id, hook_cursor) = cursor.map_or((None, None), |(b, s)| (Some(b), Some(s)));
        let config = HostConfig {
            client: format!("santree/{}", env!("CARGO_PKG_VERSION")),
            owner: self.owner.clone(),
            hook_cursor,
            boot_id,
        };
        *self.applied.lock().unwrap_or_else(|e| e.into_inner()) = Some(config.clone());
        self.host.configure(Some(config));
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

    /// The link's state now.
    pub fn state(&self) -> DaedalusLink {
        link_of(self.host.current_status())
    }

    /// The state once the link stops `Connecting`, or as it is after `wait`.
    pub async fn settled(&self, wait: Duration) -> DaedalusLink {
        let mut status = self.host.status();
        let _ = tokio::time::timeout(wait, status.wait_for(|s| *s != HostStatus::Connecting)).await;
        self.state()
    }

    /// The live client, or why there isn't one. Don't hold it across a
    /// reconnect: ask again.
    pub fn client(&self) -> Result<Arc<RemoteClient>, NotConnected> {
        self.host
            .client()
            .ok_or_else(|| NotConnected { link: self.state() })
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

    /// What the session host answered `hello` on the live link.
    pub fn hello(&self) -> Option<Arc<HelloResult>> {
        self.host.hello()
    }

    /// Start the link's background work: announce every status change to the
    /// frontend and relay hooks into `db`. Call once, from setup; the link
    /// itself starts with [`DaedalusHost::resume`].
    pub fn start(&self, app: &AppHandle, db: Db, db_path: String) {
        let mut status = self.host.status();
        let emitter = app.clone();
        tauri::async_runtime::spawn(async move {
            while status.changed().await.is_ok() {
                let link = link_of(status.borrow_and_update().clone());
                log::info!("daedalus: link {link:?}");
                let _ = DaedalusLinkChanged {}.emit(&emitter);
            }
        });

        if let Some(events) = self.host.take_hook_events() {
            let relay = Relay {
                host: self.host.clone(),
                db,
                db_path,
            };
            let app = app.clone();
            tauri::async_runtime::spawn(relay.run(events, move |nudges| emit_nudges(&app, nudges)));
        }
    }
}

/// The link's status as the state santree shows.
fn link_of(status: HostStatus) -> DaedalusLink {
    match status {
        HostStatus::Stopped | HostStatus::Connecting => DaedalusLink::Connecting,
        HostStatus::Connected {
            version,
            hostname,
            projects_root,
            agent,
        } => DaedalusLink::Connected {
            hostname,
            version,
            projects_root,
            agent,
        },
        HostStatus::VersionMismatch { theirs } => DaedalusLink::VersionMismatch { theirs },
        HostStatus::Down(e) => match e {
            ConnectError::NoAgent => DaedalusLink::AgentMissing,
            ConnectError::AgentOutdated => DaedalusLink::AgentOutdated,
            ConnectError::Refused {
                refusal: Refusal::SantreeOff,
                ..
            } => DaedalusLink::SantreeOff,
            ConnectError::Refused {
                refusal: Refusal::HostKeyChanged,
                msg,
            } => DaedalusLink::HostKeyChanged { reason: msg },
            ConnectError::Refused { msg: reason, .. }
            | ConnectError::Untrusted(reason)
            | ConnectError::Failed(reason) => DaedalusLink::Unavailable { reason },
        },
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
                        "daedalus: the session host's hook queue overflowed and lost {count} \
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

/// Where the app is in the session host's hook queue: `(boot_id, seq)`, the
/// last seq applied and acked and the host boot it belongs to. `None` before
/// the first ack.
pub async fn saved_cursor(db: &Db) -> anyhow::Result<Option<(String, u64)>> {
    let row: Option<(Option<String>, Option<i64>)> =
        sqlx::query_as("SELECT boot_id, hook_cursor FROM daedalus_connection WHERE id = 1")
            .fetch_optional(db)
            .await?;
    // The pair is only meaningful together (seqs restart per boot).
    Ok(match row {
        Some((Some(boot), Some(seq))) => u64::try_from(seq).ok().map(|seq| (boot, seq)),
        _ => None,
    })
}

async fn save_cursor(db: &Db, boot_id: &str, seq: u64) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO daedalus_connection (id, hook_cursor, boot_id) VALUES (1, ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET hook_cursor = ?1, boot_id = ?2",
    )
    .bind(i64::try_from(seq)?)
    .bind(boot_id)
    .execute(db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::path::Path;

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

    /// An app database with one registered Daedalus project (`acme/web`).
    async fn app_db(base: &Path) -> (Db, String) {
        let _ = std::fs::remove_dir_all(base);
        let path = base.join("santree.db");
        let db = crate::db::init(path.clone()).await.unwrap();
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
        Arc::new(move || -> BoxFuture<'static, Result<Link, ConnectError>> {
            let link = current.lock().unwrap().connect();
            Box::pin(async move { Ok(link) })
        })
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

    /// The saved cursor row, or `None` before the first ack writes it — the queue
    /// empties on the host at the ack, a moment before the row is saved here.
    async fn cursor(db: &Db) -> Option<(Option<i64>, Option<String>)> {
        sqlx::query_as("SELECT hook_cursor, boot_id FROM daedalus_connection WHERE id = 1")
            .fetch_optional(db)
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
        let link = DaedalusHost::with_connector(swappable(current.clone()), fast());
        assert!(matches!(
            link.client(),
            Err(NotConnected {
                link: DaedalusLink::Connecting
            })
        ));
        link.resume(saved_cursor(&db).await.unwrap());
        let client = link.client_within(WAIT).await.expect("the link comes up");
        drop(client);
        assert!(matches!(link.state(), DaedalusLink::Connected { .. }));

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
            first.queued_hooks().is_empty()
                && cursor(&db).await == Some((Some(5), Some(boot.clone())))
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
        assert_eq!(saved_cursor(&db).await.unwrap(), Some((boot.clone(), 5)));

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
            cursor(&db).await == Some((Some(1), Some(new_boot.clone())))
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
}
