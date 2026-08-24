//! Santree-owned Codex App Server and its WebSocket-over-Unix-socket control
//! channel. The experimental remote-TUI transport is isolated in this module;
//! no caller depends on it beyond receiving an opaque `unix://…` address.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::ops::{Deref, DerefMut};
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use santree_core::domain::{
    CodexAccount, CodexHealth, CodexLogin, CodexModel, CodexRateLimitWindow, CodexRateLimits,
    CodexReasoningEffort,
};
use serde_json::{json, Value};
use socket2::{Domain, SockAddr, Socket, Type};
use tungstenite::{Message, WebSocket};

const MIN_VERSION: (u64, u64, u64) = (0, 149, 0);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(8);
const CONTROL_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexProfile {
    Work,
    ReadOnly,
    Review,
    FixCi,
}

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>;

struct Connection {
    executable: String,
    server: ManagedChild,
    outbound: mpsc::Sender<String>,
    pending: Pending,
    next_id: AtomicU64,
    alive: Arc<AtomicBool>,
}

struct ManagedChild(Child);

impl ManagedChild {
    fn terminate(&mut self) {
        if self.0.try_wait().ok().flatten().is_some() {
            return;
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl Deref for ManagedChild {
    type Target = Child;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl DerefMut for ManagedChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        self.terminate();
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
        self.server.terminate();
        for (_, tx) in self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
        {
            let _ = tx.send(Err("Codex control connection closed".into()));
        }
    }
}

impl Connection {
    fn request(&self, method: &str, params: Value) -> Result<Value> {
        if !self.alive.load(Ordering::Acquire) {
            bail!("Codex control connection is not running");
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, tx);
        let line = serde_json::to_string(&request_payload(id, method, params))?;
        if self.outbound.send(line).is_err() {
            self.pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&id);
            bail!("Codex control connection closed");
        }
        match rx.recv_timeout(REQUEST_TIMEOUT) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => bail!("Codex {method} failed: {error}"),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.pending
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&id);
                bail!("Codex {method} timed out")
            }
            Err(_) => bail!("Codex {method} connection closed"),
        }
    }

    fn notify(&self, method: &str, params: Value) -> Result<()> {
        let line = serde_json::to_string(&notification_payload(method, params))?;
        self.outbound
            .send(line)
            .map_err(|_| anyhow!("Codex control connection closed"))?;
        Ok(())
    }
}

/// Process owner and protocol facade. Calls lazily start the server so Claude
/// and plain terminals remain usable even when Codex is missing or incompatible.
#[derive(Clone)]
pub struct CodexRuntime {
    runtime_dir: PathBuf,
    socket: PathBuf,
    connection: Arc<Mutex<Option<Connection>>>,
    last_error: Arc<Mutex<Option<String>>>,
}

impl CodexRuntime {
    pub fn new(data_dir: &Path) -> Self {
        let runtime_dir = short_runtime_dir(data_dir);
        let socket = runtime_dir.join("codex.sock");
        Self {
            runtime_dir,
            socket,
            connection: Arc::new(Mutex::new(None)),
            last_error: Arc::new(Mutex::new(None)),
        }
    }

    pub fn health(&self, executable: Option<String>) -> CodexHealth {
        let Some(executable) = executable else {
            return CodexHealth {
                error: Some(
                    "Codex CLI was not found. Install it or set its executable path.".into(),
                ),
                ..Default::default()
            };
        };
        match detected_version(&executable) {
            Ok((version, compatible)) => {
                let guard = self.connection.lock().unwrap_or_else(|e| e.into_inner());
                let running = guard
                    .as_ref()
                    .is_some_and(|c| c.alive.load(Ordering::Acquire));
                CodexHealth {
                    available: compatible,
                    running,
                    version,
                    executable,
                    error: if compatible {
                        self.last_error
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .clone()
                    } else {
                        Some("Codex 0.149.0 or newer is required.".into())
                    },
                }
            }
            Err(e) => CodexHealth {
                executable,
                error: Some(e.to_string()),
                ..Default::default()
            },
        }
    }

    pub fn remote(&self, executable: &str) -> Result<String> {
        self.with_connection(executable, |_| Ok(()))?;
        Ok(format!("unix://{}", self.socket.display()))
    }

    /// Prove the installed CLI honored Santree's fail-closed permission layer.
    /// Headless helpers call this before processing attacker-influenceable text;
    /// an unsupported config shape must use their deterministic fallback instead.
    pub fn ensure_restricted_config(&self, executable: &str) -> Result<()> {
        self.with_connection(executable, |_| Ok(()))
    }

    pub fn account(&self, executable: &str) -> Result<CodexAccount> {
        let value = self.request(executable, "account/read", json!({"refreshToken": false}))?;
        let account = value.get("account");
        Ok(CodexAccount {
            connected: account.is_some_and(|a| !a.is_null()),
            auth_type: account
                .and_then(|a| a.get("type"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .into(),
            email: account
                .and_then(|a| a.get("email"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            plan: account
                .and_then(|a| a.get("planType"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            requires_openai_auth: value
                .get("requiresOpenaiAuth")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }

    pub fn models(&self, executable: &str) -> Result<Vec<CodexModel>> {
        let mut cursor: Option<String> = None;
        let mut models = Vec::new();
        loop {
            let value = self.request(
                executable,
                "model/list",
                json!({"cursor": cursor, "limit": 100}),
            )?;
            for item in value
                .get("data")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if item.get("hidden").and_then(Value::as_bool) == Some(true) {
                    continue;
                }
                models.push(parse_model(item));
            }
            cursor = value
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        Ok(models)
    }

    pub fn rate_limits(&self, executable: &str) -> Result<CodexRateLimits> {
        let value = self.request(executable, "account/rateLimits/read", json!({}))?;
        let snapshot = value.get("rateLimits").unwrap_or(&Value::Null);
        Ok(CodexRateLimits {
            plan: snapshot
                .get("planType")
                .and_then(Value::as_str)
                .map(str::to_owned),
            primary: snapshot.get("primary").and_then(parse_window),
            secondary: snapshot.get("secondary").and_then(parse_window),
        })
    }

    pub fn login(&self, executable: &str, device_code: bool) -> Result<CodexLogin> {
        let params = if device_code {
            json!({"type": "chatgptDeviceCode"})
        } else {
            json!({"type": "chatgpt", "codexStreamlinedLogin": false, "useHostedLoginSuccessPage": true})
        };
        let value = self.request(executable, "account/login/start", params)?;
        Ok(CodexLogin {
            login_id: string_field(&value, "loginId"),
            auth_url: value
                .get("authUrl")
                .or_else(|| value.get("verificationUrl"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .into(),
            user_code: value
                .get("userCode")
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
    }

    pub fn cancel_login(&self, executable: &str, login_id: &str) -> Result<()> {
        self.request(
            executable,
            "account/login/cancel",
            json!({"loginId": login_id}),
        )?;
        Ok(())
    }

    pub fn logout(&self, executable: &str) -> Result<()> {
        self.request(executable, "account/logout", json!({}))?;
        Ok(())
    }

    pub fn start_thread(
        &self,
        executable: &str,
        cwd: &Path,
        model: Option<&str>,
        effort: Option<&str>,
        profile: CodexProfile,
        review_mcp_config: Option<&Path>,
    ) -> Result<String> {
        let read_only = matches!(profile, CodexProfile::ReadOnly | CodexProfile::Review);
        let approval_policy = if matches!(profile, CodexProfile::Work) {
            "on-request"
        } else {
            "never"
        };
        let mut params = json!({
            "cwd": cwd,
            "approvalPolicy": approval_policy,
            "sandbox": if read_only { "read-only" } else { "workspace-write" },
            "serviceName": "santree"
        });
        if let Some(model) = model.filter(|m| !m.is_empty()) {
            params["model"] = json!(model);
        }
        let mut config = serde_json::Map::new();
        if let Some(effort) = effort.filter(|e| !e.is_empty()) {
            config.insert("model_reasoning_effort".into(), json!(effort));
        }
        if matches!(profile, CodexProfile::Review) {
            let path = review_mcp_config
                .ok_or_else(|| anyhow!("Codex review requires Santree's review MCP config"))?;
            config.insert("mcp_servers".into(), review_mcp_servers(path)?);
        } else if review_mcp_config.is_some() {
            bail!("review MCP config is only valid for review threads");
        }
        if !config.is_empty() {
            params["config"] = Value::Object(config);
        }
        let value = self.request(executable, "thread/start", params)?;
        value
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("Codex thread/start returned no thread id"))
    }

    pub fn resume_thread(&self, executable: &str, thread_id: &str) -> Result<()> {
        self.request(executable, "thread/resume", json!({"threadId": thread_id}))?;
        Ok(())
    }

    /// Give a newly-created thread a durable rollout before another App Server
    /// connection (the remote TUI) attempts to resume it. `thread/start` alone
    /// only creates an in-memory thread in Codex 0.149.0.
    pub fn set_thread_name(&self, executable: &str, thread_id: &str, name: &str) -> Result<()> {
        self.request(
            executable,
            "thread/name/set",
            json!({"threadId": thread_id, "name": name}),
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub fn delete_thread(&self, executable: &str, thread_id: &str) -> Result<()> {
        self.request(executable, "thread/delete", json!({"threadId": thread_id}))?;
        Ok(())
    }

    fn request(&self, executable: &str, method: &str, params: Value) -> Result<Value> {
        self.with_connection(executable, |connection| connection.request(method, params))
    }

    fn with_connection<T>(
        &self,
        executable: &str,
        f: impl FnOnce(&Connection) -> Result<T>,
    ) -> Result<T> {
        let mut guard = self.connection.lock().unwrap_or_else(|e| e.into_inner());
        let dead = guard
            .as_ref()
            .is_some_and(|c| !c.alive.load(Ordering::Acquire) || c.executable != executable);
        if dead {
            *guard = None;
        }
        if guard.is_none() {
            match self.start(executable) {
                Ok(connection) => {
                    *self.last_error.lock().unwrap_or_else(|e| e.into_inner()) = None;
                    *guard = Some(connection);
                }
                Err(e) => {
                    *self.last_error.lock().unwrap_or_else(|p| p.into_inner()) =
                        Some(e.to_string());
                    return Err(e);
                }
            }
        }
        f(guard.as_ref().expect("connection was inserted"))
    }

    fn start(&self, executable: &str) -> Result<Connection> {
        let (_, compatible) = detected_version(executable)?;
        if !compatible {
            bail!("Codex 0.149.0 or newer is required");
        }
        prepare_runtime_dir(&self.runtime_dir)?;
        remove_stale_socket(&self.socket)?;
        let listen = format!("unix://{}", self.socket.display());
        let mut server = ManagedChild(
            Command::new(executable)
                .args([
                    "app-server",
                    // This field is consumed by Codex's permission-layer loader but
                    // is not in 0.149's strict Config schema. Verify the sessionFlags
                    // layer after initialization so an incompatible CLI fails closed.
                    "-c",
                    "sandbox_permissions=[]",
                    "-c",
                    "mcp_servers={}",
                    "-c",
                    "apps={}",
                    "-c",
                    "plugins={}",
                    "-c",
                    "hooks={}",
                    "-c",
                    "web_search=\"disabled\"",
                    "-c",
                    "sandbox_workspace_write.network_access=false",
                    "-c",
                    "sandbox_workspace_write.writable_roots=[]",
                    "--listen",
                    &listen,
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .context("starting Codex App Server")?,
        );
        let started = Instant::now();
        loop {
            if fs::symlink_metadata(&self.socket)
                .is_ok_and(|metadata| metadata.file_type().is_socket())
            {
                break;
            }
            if let Some(status) = server.try_wait()? {
                bail!("Codex App Server exited during startup ({status})");
            }
            if started.elapsed() >= STARTUP_TIMEOUT {
                bail!("Codex App Server did not create its socket within 8 seconds");
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let outbound = connect_control(&self.socket, pending.clone(), alive.clone())?;
        let connection = Connection {
            executable: executable.to_string(),
            server,
            outbound,
            pending,
            next_id: AtomicU64::new(1),
            alive,
        };
        connection.request(
            "initialize",
            json!({"clientInfo": {"name": "santree", "version": env!("CARGO_PKG_VERSION")}}),
        )?;
        connection.notify("initialized", json!({}))?;
        let config = connection.request(
            "config/read",
            json!({"cwd": Value::Null, "includeLayers": true}),
        )?;
        verify_sandbox_permission_override(&config)?;
        Ok(connection)
    }
}

/// Convert Santree's app-owned Claude MCP file into Codex's thread-scoped config
/// shape. Only the single review server is copied; ambient user servers remain
/// disabled by the App Server's fail-closed base config.
fn review_mcp_servers(path: &Path) -> Result<Value> {
    let value: Value = serde_json::from_slice(&fs::read(path)?)?;
    let server = value
        .pointer("/mcpServers/santree-review")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("Santree review MCP config has no review server"))?;
    let command = server
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("Santree review MCP config has no command"))?;
    let args = server
        .get("args")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("Santree review MCP config has no arguments"))?;
    if !args.iter().all(|arg| arg.as_str().is_some()) {
        bail!("Santree review MCP config has a non-string argument");
    }
    let mut args = args.clone();
    args.push(json!("--agent-kind"));
    args.push(json!("Codex"));
    Ok(json!({
        "santree-review": {
            "command": command,
            "args": args,
            "enabled": true
        }
    }))
}

fn short_runtime_dir(data_dir: &Path) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    data_dir.hash(&mut hasher);
    PathBuf::from("/tmp").join(format!("santree-codex-{:016x}", hasher.finish()))
}

fn prepare_runtime_dir(runtime_dir: &Path) -> Result<()> {
    let parent = runtime_dir
        .parent()
        .ok_or_else(|| anyhow!("Codex runtime directory has no parent"))?;
    let parent = fs::canonicalize(parent).context("resolving Codex runtime parent")?;
    match fs::symlink_metadata(runtime_dir) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                bail!("Codex runtime path is not a private directory");
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(runtime_dir).context("creating Codex runtime directory")?;
        }
        Err(error) => return Err(error).context("checking Codex runtime directory"),
    }
    let resolved = fs::canonicalize(runtime_dir).context("resolving Codex runtime directory")?;
    if resolved.parent() != Some(parent.as_path()) {
        bail!("Codex runtime directory escapes its app-owned parent");
    }
    fs::set_permissions(&resolved, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn remove_stale_socket(socket: &Path) -> Result<()> {
    match fs::symlink_metadata(socket) {
        Ok(metadata) if metadata.file_type().is_socket() => {
            fs::remove_file(socket).context("removing stale Codex socket")?;
        }
        Ok(_) => bail!("Codex socket path exists but is not a Unix socket"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("checking stale Codex socket"),
    }
    Ok(())
}

fn verify_sandbox_permission_override(config: &Value) -> Result<()> {
    let applied = config
        .get("layers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|layer| layer.pointer("/name/type").and_then(Value::as_str) == Some("sessionFlags"))
        .and_then(|layer| layer.pointer("/config/sandbox_permissions"))
        .and_then(Value::as_array)
        .is_some_and(Vec::is_empty);
    if !applied {
        bail!("installed Codex cannot prove Santree's restricted read permissions were applied");
    }
    Ok(())
}

fn request_payload(id: u64, method: &str, params: Value) -> Value {
    // Codex uses JSON-RPC semantics but deliberately omits the JSON-RPC version
    // member on the wire.
    json!({"id": id, "method": method, "params": params})
}

fn notification_payload(method: &str, params: Value) -> Value {
    json!({"method": method, "params": params})
}

fn connect_control(
    socket_path: &Path,
    pending: Pending,
    alive: Arc<AtomicBool>,
) -> Result<mpsc::Sender<String>> {
    connect_control_with_timeout(socket_path, pending, alive, CONTROL_CONNECT_TIMEOUT)
}

fn connect_control_with_timeout(
    socket_path: &Path,
    pending: Pending,
    alive: Arc<AtomicBool>,
    timeout: Duration,
) -> Result<mpsc::Sender<String>> {
    let socket =
        Socket::new(Domain::UNIX, Type::STREAM, None).context("opening Codex control socket")?;
    let address = SockAddr::unix(socket_path).context("addressing Codex control socket")?;
    socket
        .connect_timeout(&address, timeout)
        .context("connecting to Codex control socket")?;
    let stream: UnixStream = socket.into();
    stream
        .set_read_timeout(Some(timeout))
        .context("setting Codex control handshake read timeout")?;
    stream
        .set_write_timeout(Some(timeout))
        .context("setting Codex control handshake write timeout")?;
    let (mut socket, _) = tungstenite::client("ws://localhost/", stream)
        .map_err(|error| anyhow!("opening Codex control WebSocket: {error}"))?;
    socket
        .get_mut()
        .set_read_timeout(None)
        .context("clearing Codex control read timeout")?;
    socket
        .get_mut()
        .set_write_timeout(None)
        .context("clearing Codex control write timeout")?;
    socket
        .get_mut()
        .set_nonblocking(true)
        .context("configuring Codex control socket")?;
    let (outbound, receiver) = mpsc::channel();
    spawn_router(socket, receiver, pending, alive);
    Ok(outbound)
}

fn spawn_router(
    mut socket: WebSocket<UnixStream>,
    outbound: mpsc::Receiver<String>,
    pending: Pending,
    alive: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        while alive.load(Ordering::Acquire) {
            while let Ok(line) = outbound.try_recv() {
                if let Err(error) = socket.send(Message::Text(line.into())) {
                    log::warn!("Codex control WebSocket write failed: {error}");
                    alive.store(false, Ordering::Release);
                    break;
                }
            }
            if !alive.load(Ordering::Acquire) {
                break;
            }
            let message = match socket.read() {
                Ok(Message::Text(line)) => match serde_json::from_str::<Value>(line.as_str()) {
                    Ok(message) => message,
                    Err(_) => {
                        log::warn!("Codex control WebSocket emitted malformed JSON");
                        continue;
                    }
                },
                Ok(Message::Ping(payload)) => {
                    if socket.send(Message::Pong(payload)).is_err() {
                        break;
                    }
                    continue;
                }
                Ok(Message::Close(_)) => break,
                Ok(_) => continue,
                Err(tungstenite::Error::Io(error))
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                    break;
                }
                Err(error) => {
                    log::warn!("Codex control WebSocket read failed: {error}");
                    break;
                }
            };
            if let Some(method) = message.get("method").and_then(Value::as_str) {
                // A method plus an id is a server request, not a response to one
                // of ours. Always answer so the server cannot wait forever.
                if let Some(id) = message.get("id") {
                    log::warn!("rejecting unhandled Codex server request {method}");
                    let reply = json!({
                        "id": id,
                        "error": {"code": -32601, "message": "Unsupported server request"}
                    });
                    let _ = socket.send(Message::Text(reply.to_string().into()));
                } else {
                    log::debug!("Codex notification {method}");
                }
                continue;
            }
            if let Some(id) = message.get("id").and_then(Value::as_u64) {
                let tx = pending
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&id);
                if let Some(tx) = tx {
                    let result = if let Some(error) = message.get("error") {
                        let code = error.get("code").and_then(Value::as_i64);
                        let detail = error
                            .get("message")
                            .and_then(Value::as_str)
                            .filter(|message| !message.is_empty());
                        log::warn!(
                            "Codex protocol request rejected, code={code:?}, message={detail:?}"
                        );
                        Err(match (code, detail) {
                            (Some(code), Some(detail)) => {
                                format!("request rejected (code {code}): {detail}")
                            }
                            (Some(code), None) => format!("request rejected (code {code})"),
                            (None, Some(detail)) => format!("request rejected: {detail}"),
                            (None, None) => "request rejected".into(),
                        })
                    } else {
                        Ok(message.get("result").cloned().unwrap_or(Value::Null))
                    };
                    let _ = tx.send(result);
                }
            }
        }
        alive.store(false, Ordering::Release);
        for (_, tx) in pending.lock().unwrap_or_else(|e| e.into_inner()).drain() {
            let _ = tx.send(Err("Codex control connection closed".into()));
        }
    });
}

fn detected_version(executable: &str) -> Result<(String, bool)> {
    let output = Command::new(executable)
        .arg("--version")
        .output()
        .context("running codex --version")?;
    if !output.status.success() {
        bail!("codex --version exited {}", output.status);
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let version = text
        .split_whitespace()
        .find(|part| part.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .unwrap_or_default()
        .trim_start_matches('v');
    let mut numbers = version.split('.').map(|part| {
        part.split(|c: char| !c.is_ascii_digit())
            .next()
            .unwrap_or("0")
            .parse::<u64>()
            .unwrap_or(0)
    });
    let parsed = (
        numbers.next().unwrap_or(0),
        numbers.next().unwrap_or(0),
        numbers.next().unwrap_or(0),
    );
    Ok((version.into(), parsed >= MIN_VERSION))
}

fn parse_model(item: &Value) -> CodexModel {
    let efforts = item
        .get("supportedReasoningEfforts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|effort| CodexReasoningEffort {
            effort: string_field(effort, "reasoningEffort"),
            description: string_field(effort, "description"),
        })
        .collect();
    CodexModel {
        id: string_field(item, "id"),
        display_name: string_field(item, "displayName"),
        description: string_field(item, "description"),
        is_default: item
            .get("isDefault")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        default_reasoning_effort: string_field(item, "defaultReasoningEffort"),
        supported_reasoning_efforts: efforts,
        input_modalities: item
            .get("inputModalities")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        supports_personality: item
            .get("supportsPersonality")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

fn parse_window(value: &Value) -> Option<CodexRateLimitWindow> {
    if value.is_null() {
        return None;
    }
    Some(CodexRateLimitWindow {
        used_percent: value
            .get("usedPercent")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        window_minutes: value.get("windowDurationMins").and_then(Value::as_f64),
        resets_at: value.get("resetsAt").and_then(Value::as_f64),
    })
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn short_socket_test_dir(prefix: &str) -> PathBuf {
        #[cfg(target_os = "macos")]
        let root = PathBuf::from("/private/tmp");
        #[cfg(not(target_os = "macos"))]
        let root = std::env::temp_dir();
        root.join(format!("{prefix}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn codex_wire_envelopes_omit_jsonrpc_version() {
        let request = request_payload(7, "account/read", json!({}));
        assert_eq!(request.get("id").and_then(Value::as_u64), Some(7));
        assert!(request.get("jsonrpc").is_none());

        let notification = notification_payload("initialized", json!({}));
        assert!(notification.get("id").is_none());
        assert!(notification.get("jsonrpc").is_none());
    }

    #[test]
    fn websocket_router_round_trips_over_unix_socket() {
        // macOS Unix socket paths are capped at 104 bytes; its per-user temp
        // directory is long enough to make an otherwise ordinary fixture fail.
        let base = short_socket_test_dir("santree-codex-ws");
        fs::create_dir(&base).unwrap();
        let socket_path = base.join("codex.sock");
        let listener = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut socket = tungstenite::accept(stream).unwrap();
            let Message::Text(line) = socket.read().unwrap() else {
                panic!("expected a text request");
            };
            let request: Value = serde_json::from_str(line.as_str()).unwrap();
            assert_eq!(
                request.get("method").and_then(Value::as_str),
                Some("initialize")
            );
            assert!(request.get("jsonrpc").is_none());
            socket
                .send(Message::Text(
                    json!({"id": 1, "result": {"platformFamily": "unix"}})
                        .to_string()
                        .into(),
                ))
                .unwrap();
        });

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let outbound = connect_control(&socket_path, pending.clone(), alive.clone()).unwrap();
        let (tx, rx) = mpsc::channel();
        pending.lock().unwrap().insert(1, tx);
        outbound
            .send(
                request_payload(
                    1,
                    "initialize",
                    json!({"clientInfo": {"name": "santree", "version": "test"}}),
                )
                .to_string(),
            )
            .unwrap();
        let response = rx.recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        assert_eq!(
            response.get("platformFamily").and_then(Value::as_str),
            Some("unix")
        );
        alive.store(false, Ordering::Release);
        server.join().unwrap();
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn websocket_handshake_has_a_deadline() {
        let base = short_socket_test_dir("santree-codex-stall");
        fs::create_dir(&base).unwrap();
        let socket_path = base.join("codex.sock");
        let listener = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();
        let server = std::thread::spawn(move || {
            let (_stream, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_millis(100));
        });

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let started = Instant::now();
        assert!(connect_control_with_timeout(
            &socket_path,
            pending,
            alive,
            Duration::from_millis(25),
        )
        .is_err());
        assert!(started.elapsed() < Duration::from_millis(500));
        server.join().unwrap();
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn runtime_socket_path_stays_below_unix_platform_limits() {
        let deep_data_dir = PathBuf::from("/Users").join("x".repeat(256));
        let runtime = CodexRuntime::new(&deep_data_dir);
        assert!(runtime.socket.as_os_str().len() < 104);
    }

    #[test]
    fn managed_children_are_reaped_on_termination() {
        let child = Command::new("/bin/sh")
            .args(["-c", "sleep 10"])
            .spawn()
            .unwrap();
        let mut child = ManagedChild(child);
        child.terminate();
        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    #[ignore = "requires SANTREE_CODEX_BIN pointing to an installed Codex CLI"]
    fn installed_codex_control_handshake() {
        let executable = std::env::var("SANTREE_CODEX_BIN").expect("set SANTREE_CODEX_BIN");
        let base = short_socket_test_dir("santree-codex-installed");
        fs::create_dir(&base).unwrap();
        let runtime = CodexRuntime::new(&base);
        let account = runtime.account(&executable).unwrap();
        assert!(runtime.health(Some(executable.clone())).running);
        assert!(!runtime.models(&executable).unwrap().is_empty());
        if account.connected {
            runtime.rate_limits(&executable).unwrap();
        }
        drop(runtime);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    #[ignore = "requires SANTREE_CODEX_BIN pointing to an installed Codex CLI"]
    fn installed_codex_fresh_thread_is_attachable() {
        let executable = std::env::var("SANTREE_CODEX_BIN").expect("set SANTREE_CODEX_BIN");
        let base = short_socket_test_dir("santree-codex-fresh-thread");
        fs::create_dir(&base).unwrap();
        let runtime = CodexRuntime::new(&base);
        let thread_id = runtime
            .start_thread(
                &executable,
                Path::new(env!("CARGO_MANIFEST_DIR")),
                None,
                None,
                CodexProfile::ReadOnly,
                None,
            )
            .unwrap();
        runtime
            .set_thread_name(&executable, &thread_id, "Santree attachability test")
            .unwrap();
        runtime.resume_thread(&executable, &thread_id).unwrap();
        runtime.delete_thread(&executable, &thread_id).unwrap();
        drop(runtime);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn parses_additive_model_payload() {
        let model = parse_model(&json!({
            "id": "gpt-5.6-codex", "displayName": "GPT-5.6 Codex",
            "description": "Coding", "isDefault": true,
            "defaultReasoningEffort": "high", "hidden": false,
            "supportedReasoningEfforts": [{"reasoningEffort": "high", "description": "Deep"}],
            "inputModalities": ["text", "image"], "supportsPersonality": true,
            "futureField": {"isSafeToIgnore": true}
        }));
        assert_eq!(model.id, "gpt-5.6-codex");
        assert!(model.is_default);
        assert_eq!(model.input_modalities, ["text", "image"]);
    }

    #[test]
    fn version_floor_is_ordered_numerically() {
        assert!((0, 149, 0) >= MIN_VERSION);
        assert!((0, 150, 0) >= MIN_VERSION);
        assert!((0, 99, 99) < MIN_VERSION);
    }

    #[test]
    fn sandbox_permission_override_must_be_proven_in_session_flags() {
        assert!(verify_sandbox_permission_override(&json!({
            "layers": [{
                "name": {"type": "sessionFlags"},
                "config": {"sandbox_permissions": []}
            }]
        }))
        .is_ok());
        assert!(verify_sandbox_permission_override(&json!({
            "layers": [{
                "name": {"type": "sessionFlags"},
                "config": {"sandbox_permissions": ["disk-full-read-access"]}
            }]
        }))
        .is_err());
        assert!(verify_sandbox_permission_override(&json!({"layers": []})).is_err());
    }

    #[test]
    fn runtime_directory_rejects_symlinks() {
        let base = std::env::temp_dir().join(format!("santree-codex-dir-{}", uuid::Uuid::new_v4()));
        let target = base.join("target");
        let runtime = base.join("codex-runtime");
        fs::create_dir_all(&target).unwrap();
        std::os::unix::fs::symlink(&target, &runtime).unwrap();
        assert!(prepare_runtime_dir(&runtime).is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn stale_socket_cleanup_rejects_non_sockets() {
        let base =
            std::env::temp_dir().join(format!("santree-codex-socket-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&base).unwrap();
        let socket = base.join("codex.sock");
        fs::write(&socket, b"not a socket").unwrap();
        assert!(remove_stale_socket(&socket).is_err());
        assert!(socket.exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn review_config_copies_only_santrees_server() {
        let base =
            std::env::temp_dir().join(format!("santree-codex-review-mcp-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&base).unwrap();
        let path = base.join("review.json");
        fs::write(
            &path,
            serde_json::to_vec(&json!({
                "mcpServers": {
                    "santree-review": { "command": "/app/santree-hook", "args": ["mcp", "--number", "7"] },
                    "ambient-user-server": { "command": "/tmp/nope", "args": [] }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let config = review_mcp_servers(&path).unwrap();
        assert_eq!(
            config
                .pointer("/santree-review/command")
                .and_then(Value::as_str),
            Some("/app/santree-hook")
        );
        assert!(config.get("ambient-user-server").is_none());
        fs::remove_dir_all(base).unwrap();
    }
}
