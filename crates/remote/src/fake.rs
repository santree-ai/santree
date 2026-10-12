//! An in-process daemon speaking protocol v1, and a stand-in for the
//! Daedalus agent's santree socket in front of it ([`FakeAgent`]), for tests.
//!
//! The daemon *is* the production host (`santree-host`), with every method
//! group on and no caps that a test could trip, served over an in-memory link
//! — real `PtyManager` PTYs, real processes, the real filesystem, the hook
//! queue's real semantics. What it adds is test control: the `hello` a test
//! wants (protocol, version, features), a host environment, `workspaces.*`
//! answered from memory, and logs of what was asked ([`FakeDaemon::exec_log`],
//! [`FakeDaemon::icon_log`]). What code passes against this passes against
//! the local santree server and the session host, because it is their code.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use santree_host::santree_pty::PtyManager;
use santree_host::{Caps, Extension, Host, Methods, Peer};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

use crate::agent::AgentConnector;
use crate::proto::*;
use crate::transport::{memory_link, BoxFuture, ConnectError, Connector, Link, PeerTrust};

#[derive(Debug, Clone)]
pub struct FakeOptions {
    /// The one protocol this daemon speaks.
    pub protocol: u32,
    pub version: String,
    pub hostname: String,
    pub user: String,
    pub home: String,
    /// `hello`'s `projectsRoot`, and `workspaces.list`'s `root`.
    pub projects_root: String,
    pub hook_bin: String,
    pub features: Vec<String>,
    /// What `workspaces.list` answers: the snapshot's time and rows.
    pub workspaces_generated_at: Option<String>,
    pub workspaces: Vec<Workspace>,
    /// What `workspaces.icon` answers, by workspace name; a name with none
    /// is `not_found`. Served only while `features` names the method, as a
    /// host from before it answers it as unknown. [`FakeDaemon::set_icon`]
    /// changes it on a running daemon.
    pub icons: HashMap<String, WorkspaceIcon>,
    pub ping_interval: Duration,
    pub hook_queue_cap: usize,
    /// The host's own environment, over this process's, for every `exec.run`
    /// and `pty.open` child (a request's `env` still goes on top) — as the real
    /// host's children get its unit's `PATH` and `HOME`.
    pub env: Vec<(String, String)>,
    /// The trust a link from [`FakeDaemon::connect`] / [`FakeDaemon::connector`]
    /// carries — what a real connector would have established. `UidOnly` by
    /// default, so a test of the session layer is not refused by a profile that
    /// demands more than nothing; the Daedalus-shaped link through
    /// [`FakeAgent`] is `Agent` whatever this says.
    pub peer: PeerTrust,
}

impl Default for FakeOptions {
    fn default() -> Self {
        Self {
            protocol: PROTOCOL_VERSION,
            version: "fake-0.0.0".into(),
            hostname: "fake-daedalus".into(),
            user: std::env::var("USER").unwrap_or_default(),
            home: std::env::var("HOME").unwrap_or_default(),
            projects_root: std::env::var("HOME").unwrap_or_default(),
            hook_bin: "/fake/bin/daedalus-session-host".into(),
            features: vec![
                m::WorkspacesList::NAME.into(),
                m::WorkspacesIcon::NAME.into(),
                feature::PTY_BASE_ENV.into(),
            ],
            workspaces_generated_at: None,
            workspaces: vec![],
            icons: HashMap::new(),
            ping_interval: PING_INTERVAL,
            hook_queue_cap: HOOK_QUEUE_CAP,
            env: Vec::new(),
            peer: PeerTrust::UidOnly,
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// `workspaces.*` from memory, and the logs a test reads.
struct FakeExt {
    root: String,
    generated_at: Option<String>,
    workspaces: Vec<Workspace>,
    serves_icons: bool,
    icons: Mutex<HashMap<String, WorkspaceIcon>>,
    /// The argv of every `exec.run` served, in order — what a test reads to
    /// know a command ran here, on the "box", and not somewhere else.
    execs: Mutex<Vec<Vec<String>>>,
    /// The `name` of every `workspaces.icon` asked, in order.
    icon_asks: Mutex<Vec<String>>,
    /// The method of every request served, in order.
    requests: Mutex<Vec<String>>,
}

impl FakeExt {
    /// `workspaces.icon`: the host's answers — `bad_request` for a name that
    /// is not one plain path component, `not_found` for one with no icon.
    fn workspace_icon(&self, name: &str) -> santree_host::Outcome {
        let plain =
            !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', '\0']);
        if !plain {
            return Err(WireError::new(
                ErrorCode::BadRequest,
                format!("{name:?} is not a workspace name"),
            ));
        }
        match lock(&self.icons).get(name) {
            Some(icon) => santree_host::ok(icon),
            None => Err(WireError::new(
                ErrorCode::NotFound,
                format!("no icon for {name}"),
            )),
        }
    }
}

impl Extension for FakeExt {
    fn observe(&self, request: &RawRequest) {
        lock(&self.requests).push(request.m.clone());
        if request.m == m::ExecRun::NAME {
            if let Ok(p) = request.params::<ExecParams>() {
                lock(&self.execs).push(p.argv);
            }
        }
    }

    fn handle(
        &self,
        _host: &Arc<Host>,
        request: &RawRequest,
    ) -> Option<santree_host::BoxFuture<santree_host::Outcome>> {
        let answer = match request.m.as_str() {
            m::WorkspacesList::NAME => santree_host::ok(&WorkspacesResult {
                root: self.root.clone(),
                generated_at: self.generated_at.clone(),
                workspaces: self.workspaces.clone(),
            }),
            m::WorkspacesIcon::NAME if self.serves_icons => {
                match request.params::<WorkspacesIconParams>() {
                    Ok(p) => {
                        lock(&self.icon_asks).push(p.name.clone());
                        self.workspace_icon(&p.name)
                    }
                    Err(e) => Err(e),
                }
            }
            _ => return None,
        };
        Some(Box::pin(async move { answer }))
    }
}

/// The fake daemon. Clones share one host (one PTY table, one hook queue).
#[derive(Clone)]
pub struct FakeDaemon {
    host: Arc<Host>,
    ext: Arc<FakeExt>,
    peer: Arc<Mutex<PeerTrust>>,
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
        let peer = Arc::new(Mutex::new(opts.peer.clone()));
        let ext = Arc::new(FakeExt {
            root: opts.projects_root.clone(),
            generated_at: opts.workspaces_generated_at.clone(),
            workspaces: opts.workspaces.clone(),
            serves_icons: opts.features.iter().any(|f| f == m::WorkspacesIcon::NAME),
            icons: Mutex::new(opts.icons.clone()),
            execs: Mutex::new(Vec::new()),
            icon_asks: Mutex::new(Vec::new()),
            requests: Mutex::new(Vec::new()),
        });
        let host = Host::new(
            santree_host::HostOptions {
                protocol: opts.protocol,
                version: opts.version,
                hostname: opts.hostname,
                user: opts.user,
                home: opts.home,
                projects_root: opts.projects_root,
                hook_bin: opts.hook_bin,
                features: opts.features,
                confine: None,
                env: opts.env,
                require_base_env: false,
                methods: Methods::ALL,
                // One test client, which may hold as many links as it likes.
                caps: Caps {
                    max_conns_per_node: usize::MAX,
                    hook_queue_cap: opts.hook_queue_cap,
                    ..Caps::default()
                },
                ping_interval: opts.ping_interval,
            },
            Some(ext.clone() as Arc<dyn Extension>),
        );
        Self { host, ext, peer }
    }

    /// Serve one connection (what the agent would pipe to the session host).
    /// Must be called inside a tokio runtime.
    pub fn serve<R, W>(&self, reader: R, writer: W) -> tokio::task::JoinHandle<()>
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let peer = Peer {
            node: "fake".into(),
            addr: "memory".into(),
        };
        tokio::spawn(santree_host::serve_conn(
            self.host.clone(),
            reader,
            writer,
            peer,
        ))
    }

    /// A fresh in-memory link to this daemon.
    pub fn connect(&self) -> Link {
        let (mut link, server) = memory_link();
        link.peer = lock(&self.peer).clone();
        let (reader, writer) = tokio::io::split(server);
        self.serve(reader, writer);
        link
    }

    /// The trust the NEXT link this daemon hands out carries (a socket that
    /// was swapped for a stranger's, say).
    pub fn set_peer(&self, peer: PeerTrust) {
        *lock(&self.peer) = peer;
    }

    /// A [`Connector`] whose every connect is [`FakeDaemon::connect`].
    pub fn connector(&self) -> Arc<dyn Connector> {
        let daemon = self.clone();
        Arc::new(move || -> BoxFuture<'static, Result<Link, ConnectError>> {
            let link = daemon.connect();
            Box::pin(async move { Ok(link) })
        })
    }

    /// What `<hookBin> hook <Event>` does on the server.
    pub fn push_hook(&self, event: &str, env: Vec<(String, String)>, stdin: Vec<u8>) -> u64 {
        self.host.push_hook(event.to_string(), env, stdin)
    }

    /// This instance's `bootId`.
    pub fn boot_id(&self) -> &str {
        self.host.boot_id()
    }

    /// Unacked hook events still queued.
    pub fn queued_hooks(&self) -> Vec<u64> {
        self.host.queued_hooks()
    }

    /// The daemon's PTY table, for asserting on what it's running.
    pub fn pty(&self) -> &PtyManager {
        self.host.pty()
    }

    /// Sever every live connection from the server side (a network drop).
    pub fn disconnect_all(&self) {
        self.host.disconnect_all();
    }

    /// The argv of every `exec.run` this daemon has served, oldest first.
    pub fn exec_log(&self) -> Vec<Vec<String>> {
        lock(&self.ext.execs).clone()
    }

    /// Give workspace `name` an icon, or take it away.
    pub fn set_icon(&self, name: &str, icon: Option<WorkspaceIcon>) {
        let mut icons = lock(&self.ext.icons);
        match icon {
            Some(icon) => icons.insert(name.to_string(), icon),
            None => icons.remove(name),
        };
    }

    /// The `name` of every `workspaces.icon` this daemon was asked, oldest
    /// first — whether or not it had one.
    pub fn icon_log(&self) -> Vec<String> {
        lock(&self.ext.icon_asks).clone()
    }

    /// The method of every request this daemon has served, oldest first.
    pub fn request_log(&self) -> Vec<String> {
        lock(&self.ext.requests).clone()
    }

    pub fn connection_count(&self) -> usize {
        self.host.connection_count()
    }

    /// Sever every connection and kill every session.
    pub fn shutdown(&self) {
        self.disconnect_all();
        self.host.close_all();
    }
}

/// A stand-in for the Daedalus agent's santree socket: it listens where the
/// test says and writes each connection the agent's first line — `ok`, then
/// the connection is served by a [`FakeDaemon`] as the agent would pipe it
/// to the session host; or a refusal, then the connection is closed.
pub struct FakeAgent {
    socket: PathBuf,
    /// The refusal line new connections get; `None` admits them.
    refusal: Arc<Mutex<Option<String>>>,
    accepted: Arc<AtomicU64>,
    task: tokio::task::JoinHandle<()>,
}

impl FakeAgent {
    /// The version its `ok` line names.
    pub const VERSION: &'static str = "0.22.0-fake";

    /// Listen at `socket`, admitting every connection to `daemon`. Must be
    /// called inside a tokio runtime.
    pub fn serve(socket: impl Into<PathBuf>, daemon: FakeDaemon) -> std::io::Result<Self> {
        let socket = socket.into();
        let listener = tokio::net::UnixListener::bind(&socket)?;
        let refusal: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let accepted = Arc::new(AtomicU64::new(0));
        let task = {
            let (refusal, accepted) = (refusal.clone(), accepted.clone());
            tokio::spawn(async move {
                while let Ok((mut stream, _)) = listener.accept().await {
                    accepted.fetch_add(1, Ordering::SeqCst);
                    let refused = lock(&refusal).clone();
                    let daemon = daemon.clone();
                    tokio::spawn(async move {
                        let line = refused.clone().unwrap_or_else(|| {
                            serde_json::json!({ "id": null, "ok": {
                                "host": "box.test:7789",
                                "node": "00112233445566ff",
                                "agent": FakeAgent::VERSION,
                            } })
                            .to_string()
                        });
                        if stream
                            .write_all(format!("{line}\n").as_bytes())
                            .await
                            .is_err()
                            || refused.is_some()
                        {
                            return;
                        }
                        let (reader, writer) = stream.into_split();
                        daemon.serve(reader, writer);
                    });
                }
            })
        };
        Ok(Self {
            socket,
            refusal,
            accepted,
            task,
        })
    }

    /// Refuse new connections with `code` and `msg`, as the agent does.
    pub fn refuse(&self, code: &str, msg: &str) {
        let line = serde_json::json!({ "id": null, "err": { "code": code, "msg": msg } });
        *lock(&self.refusal) = Some(line.to_string());
    }

    /// Admit new connections again.
    pub fn admit(&self) {
        *lock(&self.refusal) = None;
    }

    /// Connections accepted so far.
    pub fn connections(&self) -> u64 {
        self.accepted.load(Ordering::SeqCst)
    }

    /// An [`AgentConnector`] for this socket, trusting its owner — the test.
    pub fn connector(&self) -> AgentConnector {
        use std::os::unix::fs::MetadataExt;
        let owner = std::fs::symlink_metadata(&self.socket)
            .expect("the fake agent's socket")
            .uid();
        AgentConnector::at(&self.socket, owner)
    }
}

impl Drop for FakeAgent {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_file(&self.socket);
    }
}

/// A stand-in for the Daedalus agent's own socket (`agent.sock`): it answers
/// `settings.get` and `settings.set` the way agent 0.25 does, over settings
/// the test holds and moves — the box applying a request ([`Self::apply`]),
/// or failing it ([`Self::fail`]) — and logs every request it is sent.
pub struct FakeAgentControl {
    socket: PathBuf,
    state: Arc<Mutex<ControlState>>,
    task: tokio::task::JoinHandle<()>,
}

/// What the fake agent keeps and how it answers.
struct ControlState {
    settings: crate::control::MachineSettings,
    /// The app a log-in named: santree ON's page is under it; `None` answers
    /// `unsupported`, as an agent that never logged in does.
    app_url: Option<String>,
    /// Whether the caller is the operator (`settings.set` allowed).
    may_change: bool,
    /// An agent from before 0.25: every method is unknown.
    outdated: bool,
    requests: Vec<serde_json::Value>,
}

impl FakeAgentControl {
    /// The app the fake agent logged in to.
    pub const APP_URL: &'static str = "https://daedalus-app.example.test";

    /// Listen at `socket` with `settings` as the box keeps them. Must be called
    /// inside a tokio runtime.
    pub fn serve(
        socket: impl Into<PathBuf>,
        settings: crate::control::MachineSettings,
    ) -> std::io::Result<Self> {
        let socket = socket.into();
        let listener = tokio::net::UnixListener::bind(&socket)?;
        let state = Arc::new(Mutex::new(ControlState {
            settings,
            app_url: Some(Self::APP_URL.into()),
            may_change: true,
            outdated: false,
            requests: Vec::new(),
        }));
        let task = {
            let state = state.clone();
            tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let state = state.clone();
                    tokio::spawn(async move {
                        let (reader, mut writer) = stream.into_split();
                        let mut reader = BufReader::new(reader);
                        let mut line = String::new();
                        if tokio::io::AsyncBufReadExt::read_line(&mut reader, &mut line)
                            .await
                            .is_err()
                        {
                            return;
                        }
                        let answer = control_answer(&state, &line);
                        let _ = writer.write_all(format!("{answer}\n").as_bytes()).await;
                    });
                }
            })
        };
        Ok(Self {
            socket,
            state,
            task,
        })
    }

    /// An [`AgentControl`](crate::control::AgentControl) for this socket,
    /// trusting its owner — the test.
    pub fn control(&self) -> crate::control::AgentControl {
        use std::os::unix::fs::MetadataExt;
        let owner = std::fs::symlink_metadata(&self.socket)
            .expect("the fake agent's socket")
            .uid();
        crate::control::AgentControl::at(&self.socket, owner)
    }

    /// The box applied `key` = `value`: the kept value moves and its request
    /// is done.
    pub fn apply(&self, key: crate::control::SettingKey, value: bool) {
        let mut s = lock(&self.state);
        *kept(&mut s.settings, key) = value;
        s.settings.pending.retain(|p| p.key != key);
    }

    /// The request for `key` did not take, for `why`.
    pub fn fail(&self, key: crate::control::SettingKey, why: &str) {
        let mut s = lock(&self.state);
        let want = s
            .settings
            .pending
            .iter()
            .find(|p| p.key == key)
            .is_none_or(|p| p.want);
        s.settings.pending.retain(|p| p.key != key);
        s.settings.failed.retain(|f| f.key != key);
        s.settings.failed.push(crate::control::FailedSetting {
            key,
            want,
            why: why.into(),
        });
    }

    /// Whether the agent's link to the box is up.
    pub fn set_linked(&self, linked: bool) {
        lock(&self.state).settings.linked = linked;
    }

    /// Whether the caller may change the settings (is the operator).
    pub fn set_may_change(&self, may: bool) {
        lock(&self.state).may_change = may;
    }

    /// Answer as an agent from before `settings.get` existed.
    pub fn set_outdated(&self, outdated: bool) {
        lock(&self.state).outdated = outdated;
    }

    /// The app santree ON's page is under; `None`: the agent knows none.
    pub fn set_app_url(&self, url: Option<&str>) {
        lock(&self.state).app_url = url.map(str::to_string);
    }

    /// Every request received, parsed, oldest first.
    pub fn requests(&self) -> Vec<serde_json::Value> {
        lock(&self.state).requests.clone()
    }
}

impl Drop for FakeAgentControl {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_file(&self.socket);
    }
}

fn kept(s: &mut crate::control::MachineSettings, key: crate::control::SettingKey) -> &mut bool {
    use crate::control::SettingKey;
    match key {
        SettingKey::AwakeHold => &mut s.awake_hold,
        SettingKey::ClaudeRemoteControl => &mut s.claude_remote_control,
        SettingKey::Santree => &mut s.santree,
    }
}

/// One request line, answered as agent 0.25's `settings.get` / `settings.set`
/// do (its `local.rs` and `settings.rs`).
fn control_answer(state: &Mutex<ControlState>, line: &str) -> String {
    use crate::control::{PendingSetting, SettingKey, SettingVia};
    let err = |code: &str, msg: &str| {
        serde_json::json!({ "id": 1, "err": { "code": code, "msg": msg } }).to_string()
    };
    let ok = |v: serde_json::Value| serde_json::json!({ "id": 1, "ok": v }).to_string();
    let Ok(req) = serde_json::from_str::<serde_json::Value>(line) else {
        return err("bad_request", "not a request");
    };
    let mut s = lock(state);
    s.requests.push(req.clone());
    let method = req["m"].as_str().unwrap_or_default().to_string();
    if s.outdated {
        return err("unknown_method", &format!("no method `{method}`"));
    }
    match method.as_str() {
        "settings.get" => {
            let mut view = serde_json::to_value(&s.settings).expect("settings serialize");
            view["may_change"] = s.may_change.into();
            ok(view)
        }
        "settings.set" => {
            let (Ok(key), Some(value)) = (
                serde_json::from_value::<SettingKey>(req["p"]["key"].clone()),
                req["p"]["value"].as_bool(),
            ) else {
                return err("bad_request", "settings.set: {key, value}");
            };
            if !s.may_change {
                return err(
                    "forbidden",
                    "uid 502 may not change this machine's settings (root and the user who \
                     installed the agent may)",
                );
            }
            s.settings.failed.retain(|f| f.key != key);
            if key == SettingKey::Santree && value {
                if s.settings.santree {
                    return ok(serde_json::json!({ "unchanged": true }));
                }
                let Some(app) = s.app_url.clone() else {
                    return err("unsupported", "turn santree on in Settings › Machines");
                };
                let node = s.settings.node.clone().unwrap_or_default();
                s.settings.pending.retain(|p| p.key != key);
                s.settings.pending.push(PendingSetting {
                    key,
                    want: true,
                    via: SettingVia::Browser,
                });
                return ok(serde_json::json!({
                    "confirm_url": format!("{app}/settings?tab=machines&node={node}&santree=on")
                }));
            }
            let in_flight = s
                .settings
                .pending
                .iter()
                .any(|p| p.key == key && p.via == SettingVia::Box && p.want != value);
            if *kept(&mut s.settings, key) == value && !in_flight {
                s.settings.pending.retain(|p| p.key != key);
                return ok(serde_json::json!({ "unchanged": true }));
            }
            if !s.settings.linked {
                s.settings.pending.retain(|p| p.key != key);
                s.settings.failed.push(crate::control::FailedSetting {
                    key,
                    want: value,
                    why: "not connected to the box".into(),
                });
                return err("unavailable", "not connected to the box");
            }
            s.settings.pending.retain(|p| p.key != key);
            s.settings.pending.push(PendingSetting {
                key,
                want: value,
                via: SettingVia::Box,
            });
            ok(serde_json::json!({ "sent": true }))
        }
        other => err("unknown_method", &format!("no method `{other}`")),
    }
}
