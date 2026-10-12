//! The `server.*` methods: what the app asks of the server itself, besides
//! its sessions.

use std::process::Child;
use std::sync::{Arc, Mutex};

use santree_host::proto::*;
use santree_host::{ok, Extension, Host, Outcome};
use tokio::sync::Notify;

use crate::REVISION;

pub struct ServerExt {
    started_at_ms: i64,
    exe: String,
    /// The `caffeinate` holding the machine awake, while one does.
    awake: Arc<Mutex<Option<Child>>>,
    /// Raised once `server.stop` is answered; the serve loop shuts down on it.
    pub(crate) stop: Arc<Notify>,
}

impl ServerExt {
    pub fn new(started_at_ms: i64) -> Arc<Self> {
        Arc::new(Self {
            started_at_ms,
            exe: std::env::current_exe()
                .map(|p| p.display().to_string())
                .unwrap_or_default(),
            awake: Arc::new(Mutex::new(None)),
            stop: Arc::new(Notify::new()),
        })
    }

    fn info(&self, host: &Host) -> ServerInfo {
        ServerInfo {
            version: host.options().version.clone(),
            revision: REVISION,
            pid: std::process::id(),
            started_at_ms: self.started_at_ms,
            exe: self.exe.clone(),
            live_sessions: host.live_sessions(),
            clients: host.connection_count(),
        }
    }

    /// Let the machine sleep again, at shutdown.
    pub fn release(&self) {
        if let Some(mut child) = self.awake.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Extension for ServerExt {
    fn handle(
        &self,
        host: &Arc<Host>,
        request: &RawRequest,
    ) -> Option<santree_host::BoxFuture<Outcome>> {
        let answer = match request.m.as_str() {
            m::ServerInfo::NAME => ok(&self.info(host)),
            m::ServerKeepAwake::NAME => {
                let on = match request.params::<KeepAwakeParams>() {
                    Ok(p) => p.on,
                    Err(e) => return Some(Box::pin(async move { Err(e) })),
                };
                let awake = self.awake.clone();
                // Spawning and reaping a process: off the async workers.
                return Some(Box::pin(async move {
                    tokio::task::spawn_blocking(move || keep_awake(&awake, on))
                        .await
                        .map_err(|e| santree_host::wire_err(ErrorCode::Io, e.to_string()))
                        .and_then(|r| ok(&r))
                }));
            }
            m::ServerStop::NAME => {
                // Stopped once this answer is queued (`answered`): the
                // connection's writer then drains it before the close.
                log::info!("server.stop: closing every session and exiting");
                ok(&Empty)
            }
            _ => return None,
        };
        Some(Box::pin(async move { answer }))
    }

    fn answered(&self, request: &RawRequest) {
        if request.m == m::ServerStop::NAME {
            self.stop.notify_one();
        }
    }
}

/// `caffeinate -w <this pid>` while `on`. Tied to the server rather than the
/// app: an app that quits with agents still running must not let the machine
/// sleep under them, and `-w` ends the assertion with the server however the
/// server ends. Idempotent both ways.
#[cfg(target_os = "macos")]
fn keep_awake(awake: &Mutex<Option<Child>>, on: bool) -> KeepAwakeResult {
    use std::process::{Command, Stdio};

    let mut held = awake.lock().unwrap_or_else(|e| e.into_inner());
    // One that died on its own (killed by hand) no longer holds anything.
    if let Some(child) = held.as_mut() {
        if !matches!(child.try_wait(), Ok(None)) {
            *held = None;
        }
    }
    match (on, held.is_some()) {
        (true, false) => {
            let spawned = Command::new("/usr/bin/caffeinate")
                .args(["-d", "-i", "-w", &std::process::id().to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
            match spawned {
                Ok(child) => {
                    log::info!("keeping the machine awake (caffeinate {})", child.id());
                    *held = Some(child);
                }
                Err(e) => log::warn!("can't start caffeinate: {e}"),
            }
        }
        (false, true) => {
            if let Some(mut child) = held.take() {
                let _ = child.kill();
                let _ = child.wait();
                log::info!("no longer keeping the machine awake");
            }
        }
        _ => {}
    }
    KeepAwakeResult {
        active: held.is_some(),
        supported: true,
    }
}

#[cfg(not(target_os = "macos"))]
fn keep_awake(_awake: &Mutex<Option<Child>>, _on: bool) -> KeepAwakeResult {
    KeepAwakeResult {
        active: false,
        supported: false,
    }
}

/// The `server.*` methods' wire names, for `hello.features`.
pub const SERVER_FEATURES: &[&str] = &[
    m::ServerInfo::NAME,
    m::ServerKeepAwake::NAME,
    m::ServerStop::NAME,
];
