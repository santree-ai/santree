//! Santree-owned Codex App Server and its newline-delimited JSON-RPC control
//! channel. The experimental remote-TUI socket is isolated in this module; no
//! caller depends on it beyond receiving an opaque `unix://…` address.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use santree_core::domain::{
    CodexAccount, CodexHealth, CodexLogin, CodexModel, CodexRateLimitWindow, CodexRateLimits,
    CodexReasoningEffort,
};
use serde_json::{json, Value};

const MIN_VERSION: (u64, u64, u64) = (0, 149, 0);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(8);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexProfile {
    Work,
    ReadOnly,
    FixCi,
}

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>;

struct Connection {
    executable: String,
    server: Child,
    proxy: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Pending,
    next_id: AtomicU64,
    alive: Arc<AtomicBool>,
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
        let _ = self.proxy.kill();
        let _ = self.server.kill();
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
        let line = serde_json::to_string(&json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params
        }))?;
        if let Err(e) = writeln!(
            self.stdin.lock().unwrap_or_else(|p| p.into_inner()),
            "{line}"
        ) {
            self.pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&id);
            return Err(e).context("writing to Codex control proxy");
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
        let line = serde_json::to_string(&json!({
            "jsonrpc": "2.0", "method": method, "params": params
        }))?;
        writeln!(
            self.stdin.lock().unwrap_or_else(|p| p.into_inner()),
            "{line}"
        )?;
        Ok(())
    }
}

/// Process owner and protocol facade. Calls lazily start the server so Claude
/// and plain terminals remain usable even when Codex is missing or incompatible.
pub struct CodexRuntime {
    runtime_dir: PathBuf,
    socket: PathBuf,
    connection: Mutex<Option<Connection>>,
    last_error: Mutex<Option<String>>,
}

impl CodexRuntime {
    pub fn new(data_dir: &Path) -> Self {
        let runtime_dir = data_dir.join("codex-runtime");
        let socket = runtime_dir.join("codex.sock");
        Self {
            runtime_dir,
            socket,
            connection: Mutex::new(None),
            last_error: Mutex::new(None),
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
    ) -> Result<String> {
        let read_only = matches!(profile, CodexProfile::ReadOnly);
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
        if let Some(effort) = effort.filter(|e| !e.is_empty()) {
            params["config"] = json!({"model_reasoning_effort": effort});
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
        let mut server = Command::new(executable)
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
            .context("starting Codex App Server")?;
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
                let _ = server.kill();
                bail!("Codex App Server did not create its socket within 8 seconds");
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let mut proxy = match Command::new(executable)
            .args(["app-server", "proxy", "--sock"])
            .arg(&self.socket)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(proxy) => proxy,
            Err(error) => {
                let _ = server.kill();
                return Err(error).context("starting Codex control proxy");
            }
        };
        let Some(proxy_stdin) = proxy.stdin.take() else {
            let _ = proxy.kill();
            let _ = server.kill();
            bail!("opening Codex control proxy stdin");
        };
        let Some(stdout) = proxy.stdout.take() else {
            let _ = proxy.kill();
            let _ = server.kill();
            bail!("opening Codex control proxy stdout");
        };
        let stdin = Arc::new(Mutex::new(proxy_stdin));
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        spawn_reader(stdout, pending.clone(), alive.clone(), stdin.clone());
        let connection = Connection {
            executable: executable.to_string(),
            server,
            proxy,
            stdin,
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

fn spawn_reader(
    stdout: impl std::io::Read + Send + 'static,
    pending: Pending,
    alive: Arc<AtomicBool>,
    stdin: Arc<Mutex<ChildStdin>>,
) {
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                log::warn!("Codex control proxy emitted malformed JSON");
                continue;
            };
            if let Some(method) = message.get("method").and_then(Value::as_str) {
                // A method plus an id is a server request, not a response to one
                // of ours. Always answer so the server cannot wait forever.
                if let Some(id) = message.get("id") {
                    log::warn!("rejecting unhandled Codex server request {method}");
                    let reply = json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": {"code": -32601, "message": "Unsupported server request"}
                    });
                    let _ = writeln!(stdin.lock().unwrap_or_else(|e| e.into_inner()), "{reply}");
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
                        log::warn!("Codex protocol request rejected, code={code:?}");
                        Err(match code {
                            Some(code) => format!("request rejected (code {code})"),
                            None => "request rejected".into(),
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
            let _ = tx.send(Err("Codex control proxy exited".into()));
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
}
