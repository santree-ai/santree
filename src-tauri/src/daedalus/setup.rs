//! Setup scripts of Daedalus projects, run in a PTY on the box and streamed to
//! the same read-only pane a local run uses (`crate::stream`; docs/remote.md,
//! "Setup scripts on the box").
//!
//! A run is one `pty.open` of `bash -lc` around the script — the login shell a
//! local run gets, the box's own — attached until `pty.exit`. A dropped link
//! doesn't end it: the process keeps running on the box, and the run
//! re-attaches from its anchor on the next connect, so the pane misses nothing.
//! `pty.exit` carries no status, so the wrapper leaves the script's exit code
//! in a file santree names (in the checkout's git dir, beside the split's
//! private index) and the run reads it back once the process is gone. Stop is
//! `pty.close`; a Stop while the link is down lands on the next connect.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use anyhow::{bail, Result};
use tokio::sync::broadcast;

use santree_remote_client::proto::{
    Anchor, ErrorCode, ExecParams, FsReadParams, PtyOpenParams, SessionId as BoxSessionId,
};
use santree_remote_client::{PtyEvent, RemoteClient, RemoteHost};

/// What the PTY runs: the script as `$0`, its status file as `$1`. The status
/// is written only when the script ends on its own; a killed run leaves none,
/// which reads as a failure.
const WRAPPER: &str = r#""$0"; s=$?; printf '%s' "$s" > "$1"; exit "$s""#;

/// Backstop for a run that never ends, as `stream::DEADLINE` is for a local
/// one; Stop is the normal way out.
#[cfg(not(test))]
const DEADLINE: Duration = Duration::from_secs(60 * 60);
#[cfg(test)]
const DEADLINE: Duration = Duration::from_secs(30);

/// One setup run on the box.
pub struct RunSpec {
    /// The worktree, on the box.
    pub cwd: String,
    /// The executable script, on the box.
    pub script: String,
    /// Where the wrapper writes the exit code: a path on the box nothing else
    /// uses (`git rev-parse --git-path`).
    pub status: String,
    pub env: Vec<(String, String)>,
    /// The PTY's label on the box — never a terminal's `term_key`.
    pub label: String,
    pub owner: String,
}

/// The setup runs on the box, keyed like `stream::RUNS`.
pub struct RemoteRuns {
    host: Arc<RemoteHost>,
    runs: Mutex<HashMap<String, Run>>,
    next: AtomicU64,
}

struct Run {
    id: u64,
    session: Option<BoxSessionId>,
    cancelled: bool,
}

impl RemoteRuns {
    pub fn new(host: Arc<RemoteHost>) -> Self {
        Self {
            host,
            runs: Mutex::new(HashMap::new()),
            next: AtomicU64::new(0),
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, Run>> {
        self.runs.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Run `spec` under `key`, streaming its output to `on_text` (whole UTF-8,
    /// as `stream::run` sends it), and answer whether the script exited 0.
    /// Errors only when a run is already registered under `key`, or the box
    /// refuses to start it.
    pub async fn run(
        &self,
        key: &str,
        client: &Arc<RemoteClient>,
        spec: RunSpec,
        on_text: impl Fn(String),
    ) -> Result<bool> {
        let id = {
            let mut runs = self.lock();
            if runs.contains_key(key) {
                bail!("setup is already running here");
            }
            let id = self.next.fetch_add(1, Ordering::Relaxed);
            runs.insert(
                key.to_string(),
                Run {
                    id,
                    session: None,
                    cancelled: false,
                },
            );
            id
        };
        let result = self.drive(key, id, client, &spec, &on_text).await;
        {
            let mut runs = self.lock();
            if runs.get(key).is_some_and(|run| run.id == id) {
                runs.remove(key);
            }
        }
        result
    }

    async fn drive(
        &self,
        key: &str,
        id: u64,
        client: &Arc<RemoteClient>,
        spec: &RunSpec,
        on_text: &impl Fn(String),
    ) -> Result<bool> {
        let session = client
            .pty_open(&PtyOpenParams {
                cwd: Some(spec.cwd.clone()),
                command: "bash".into(),
                args: vec![
                    "-lc".into(),
                    WRAPPER.into(),
                    spec.script.clone(),
                    spec.status.clone(),
                ],
                cols: crate::stream::COLS,
                rows: crate::stream::ROWS,
                env: spec.env.clone(),
                owner: spec.owner.clone(),
                label: spec.label.clone(),
                agent_kind: None,
            })
            .await
            .map_err(|e| anyhow::anyhow!("Daedalus couldn't start the setup script: {e}"))?
            .id;
        let cancelled = {
            let mut runs = self.lock();
            match runs.get_mut(key) {
                Some(run) if run.id == id => {
                    run.session = Some(session);
                    run.cancelled
                }
                _ => true,
            }
        };
        if cancelled {
            let _ = client.pty_close(session).await;
            return Ok(false);
        }

        let exited = tokio::time::timeout(DEADLINE, self.follow(key, id, session, on_text))
            .await
            .unwrap_or_else(|_| {
                log::warn!(
                    "setup run {key} exceeded {}s — stopping it",
                    DEADLINE.as_secs()
                );
                false
            });
        let Some(client) = self.host.client() else {
            return Ok(false);
        };
        if !exited {
            let _ = client.pty_close(session).await;
        }
        Ok(exited && self.exit_code(&client, spec).await == Some(0))
    }

    /// Stream the session until its process exits, re-attaching from the
    /// anchor across dropped links. `true` once `pty.exit` (or a box that no
    /// longer has the session) says the process is gone.
    async fn follow(
        &self,
        key: &str,
        id: u64,
        session: BoxSessionId,
        on_text: &impl Fn(String),
    ) -> bool {
        let mut anchor = Anchor::Fresh;
        let mut carry = Vec::new();
        let mut reconnected = self.host.reconnected();
        loop {
            let client = match self.host.client().filter(|c| !c.is_closed()) {
                Some(client) => client,
                None => match reconnected.recv().await {
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return false,
                },
            };
            // A Stop that landed while the link was down.
            let cancelled = self
                .lock()
                .get(key)
                .is_none_or(|run| run.id != id || run.cancelled);
            if cancelled {
                let _ = client.pty_close(session).await;
            }
            let (attached, mut events) = match client.pty_attach(session, anchor.clone()).await {
                Ok(attached) => attached,
                Err(e) if e.code() == Some(&ErrorCode::NotFound) => return true,
                Err(e) => {
                    if !e.is_disconnected() {
                        log::warn!("setup run {key}: attaching: {e}");
                        return false;
                    }
                    continue;
                }
            };
            let mut seq = attached.seq;
            forward(&mut carry, attached.data, on_text);
            while let Some(event) = events.recv().await {
                match event {
                    PtyEvent::Data(bytes) => {
                        seq += bytes.len() as u64;
                        forward(&mut carry, bytes, on_text);
                    }
                    PtyEvent::Exit => {
                        if !carry.is_empty() {
                            on_text(String::from_utf8_lossy(&carry).into_owned());
                        }
                        return true;
                    }
                }
            }
            // The link dropped under the run: pick it up where it was.
            anchor = Anchor::At {
                epoch: attached.epoch,
                seq,
            };
        }
    }

    /// The script's exit code from its status file, which is then removed.
    /// `None` when there is none — the run was stopped or killed.
    async fn exit_code(&self, client: &RemoteClient, spec: &RunSpec) -> Option<i32> {
        let read = client
            .fs_read(&FsReadParams {
                path: spec.status.clone(),
                len: Some(16),
                ..FsReadParams::default()
            })
            .await;
        if let Err(e) = client
            .exec_run(&ExecParams {
                cwd: spec.cwd.clone(),
                argv: vec!["rm".into(), "-f".into(), "--".into(), spec.status.clone()],
                ..ExecParams::default()
            })
            .await
        {
            log::debug!("setup: removing {}: {e}", spec.status);
        }
        String::from_utf8(read.ok()?.data).ok()?.trim().parse().ok()
    }

    /// Stop the run under `key`. Whether one was registered; a Stop while the
    /// link is down is sent on the next connect.
    pub async fn cancel(&self, key: &str) -> bool {
        let session = {
            let mut runs = self.lock();
            let Some(run) = runs.get_mut(key) else {
                return false;
            };
            run.cancelled = true;
            run.session
        };
        if let (Some(session), Some(client)) = (session, self.host.client()) {
            if let Err(e) = client.pty_close(session).await {
                log::debug!("setup run {key}: stopping: {e}");
            }
        }
        true
    }

    /// Re-grid the run under `key` to the pane showing it. Whether one is
    /// running there.
    pub async fn resize(&self, key: &str, cols: u16, rows: u16) -> bool {
        let Some(session) = self.lock().get(key).and_then(|run| run.session) else {
            return false;
        };
        let Some(client) = self.host.client() else {
            return true;
        };
        if let Err(e) = client.pty_resize(session, cols.max(1), rows.max(1)).await {
            log::debug!("setup run {key}: resizing: {e}");
        }
        true
    }
}

/// Send what of `carry` + `bytes` is whole UTF-8, keeping a split character
/// for the next chunk.
fn forward(carry: &mut Vec<u8>, bytes: Vec<u8>, on_text: &impl Fn(String)) {
    carry.extend(bytes);
    let text = crate::stream::take_utf8(carry);
    if !text.is_empty() {
        on_text(text);
    }
}
