//! Local PTY session manager.
//!
//! This is the real terminal backend: each session allocates a kernel PTY pair
//! (via `portable-pty`), spawns a real process attached to the slave, and streams
//! the master's **raw byte stream** to a caller-supplied sink. Input is raw bytes
//! written to the master; resize maps to a `TIOCSWINSZ` on the PTY. There is no
//! command interpretation here — full-screen TUIs (`vim`, `htop`, an interactive
//! `claude`) run exactly as they would in a standalone terminal.
//!
//! This crate is Tauri-agnostic: it hands bytes to a `Fn(Vec<u8>)` callback so it
//! can be unit-tested directly and wired to a Tauri Channel by `src-tauri`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Context, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

/// Opaque handle to a live terminal session.
pub type SessionId = u32;

/// How to spawn a session. An empty `command` means "the user's login shell".
#[derive(Debug, Clone, Default)]
pub struct OpenOpts {
    pub cwd: Option<String>,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
struct Inner {
    next_id: SessionId,
    sessions: HashMap<SessionId, Session>,
}

/// Owns all live PTY sessions. Cheap to clone (shared, internally synchronized).
#[derive(Clone, Default)]
pub struct PtyManager {
    inner: Arc<Mutex<Inner>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Allocate a PTY, spawn the process, and start streaming its output to
    /// `on_output` (called from a dedicated reader thread). Returns the session id.
    pub fn open(
        &self,
        opts: OpenOpts,
        on_output: impl Fn(Vec<u8>) + Send + 'static,
    ) -> Result<SessionId> {
        let size = PtySize {
            rows: opts.rows.max(1),
            cols: opts.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = native_pty_system()
            .openpty(size)
            .context("allocating pty")?;

        let cmd = build_command(&opts);
        let child = pair.slave.spawn_command(cmd).context("spawning process")?;
        // Drop the slave handle in the parent so the master reader sees EOF once
        // the child exits.
        drop(pair.slave);

        let reader = pair.master.try_clone_reader().context("cloning reader")?;
        let writer = pair.master.take_writer().context("taking writer")?;

        let id = {
            let mut inner = self.inner.lock().unwrap();
            let id = inner.next_id;
            inner.next_id += 1;
            inner.sessions.insert(
                id,
                Session {
                    master: pair.master,
                    writer,
                    child,
                },
            );
            id
        };

        // Blocking read loop on its own thread — the PTY master read is blocking,
        // so this is a std thread rather than an async task.
        std::thread::Builder::new()
            .name(format!("pty-reader-{id}"))
            .spawn(move || pump(reader, on_output))
            .context("spawning reader thread")?;

        tracing::info!(id, command = %opts.command, "opened pty session");
        Ok(id)
    }

    /// Write raw bytes (keystrokes, or a seed) to the session's PTY master.
    pub fn write(&self, id: SessionId, data: &[u8]) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        let session = inner
            .sessions
            .get_mut(&id)
            .ok_or_else(|| anyhow!("no terminal session {id}"))?;
        session.writer.write_all(data).context("writing to pty")?;
        session.writer.flush().context("flushing pty")?;
        Ok(())
    }

    /// Resize the PTY so the hosted process reflows to the visible grid.
    pub fn resize(&self, id: SessionId, cols: u16, rows: u16) -> Result<()> {
        let inner = self.inner.lock().unwrap();
        let session = inner
            .sessions
            .get(&id)
            .ok_or_else(|| anyhow!("no terminal session {id}"))?;
        session
            .master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("resizing pty")?;
        Ok(())
    }

    /// Kill the child and free the session. The reader thread then sees EOF and
    /// exits on its own.
    pub fn close(&self, id: SessionId) -> Result<()> {
        let session = self.inner.lock().unwrap().sessions.remove(&id);
        if let Some(mut session) = session {
            let _ = session.child.kill();
            let _ = session.child.wait();
            tracing::info!(id, "closed pty session");
        }
        Ok(())
    }

    /// Kill every session — used on app exit so no child or thread is leaked.
    pub fn close_all(&self) {
        let drained: Vec<Session> = {
            let mut inner = self.inner.lock().unwrap();
            inner.sessions.drain().map(|(_, s)| s).collect()
        };
        for mut session in drained {
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
    }
}

/// Read the master until EOF, handing each chunk to the sink. On EOF (the hosted
/// process exited — `exit`, Ctrl-D, or a kill) emit a final empty chunk as an
/// exit sentinel so the frontend can tear the pane down instead of leaving a dead
/// terminal on screen. Output chunks are always non-empty, so empty is unambiguous.
fn pump(mut reader: Box<dyn Read + Send>, on_output: impl Fn(Vec<u8>)) {
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => on_output(buf[..n].to_vec()),
            Err(_) => break,
        }
    }
    on_output(Vec::new());
}

/// Build the `CommandBuilder`: inherit the parent environment (so PATH/HOME are
/// present and login CLIs resolve), then apply caller overrides, a sane TERM, and
/// a working directory that exists.
fn build_command(opts: &OpenOpts) -> CommandBuilder {
    let (program, default_args) = if opts.command.trim().is_empty() {
        (default_shell(), vec!["-l".to_string()])
    } else {
        (opts.command.clone(), Vec::new())
    };

    let mut cmd = CommandBuilder::new(program);
    let args = if opts.args.is_empty() {
        &default_args
    } else {
        &opts.args
    };
    cmd.args(args);

    for (key, value) in std::env::vars() {
        cmd.env(key, value);
    }
    for (key, value) in &opts.env {
        cmd.env(key, value);
    }
    if !opts.env.iter().any(|(k, _)| k == "TERM") {
        cmd.env("TERM", "xterm-256color");
    }

    if let Some(cwd) = effective_cwd(opts.cwd.as_deref()) {
        cmd.cwd(cwd);
    }
    cmd
}

/// Use the requested cwd when it exists, otherwise fall back to $HOME so a stale
/// or missing path never fails the spawn.
fn effective_cwd(cwd: Option<&str>) -> Option<String> {
    if let Some(cwd) = cwd {
        if !cwd.is_empty() && Path::new(cwd).is_dir() {
            return Some(cwd.to_string());
        }
    }
    std::env::var("HOME").ok()
}

fn default_shell() -> String {
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.is_empty() {
            return shell;
        }
    }
    if cfg!(target_os = "macos") {
        "/bin/zsh".to_string()
    } else {
        "/bin/bash".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    /// Full lifecycle: spawn a shell, write a command, read its echoed output,
    /// then close — proving real PTY round-tripping.
    #[test]
    fn spawn_write_read_close() {
        let mgr = PtyManager::new();
        let (tx, rx) = mpsc::channel();
        let id = mgr
            .open(
                OpenOpts {
                    command: "sh".into(),
                    cols: 80,
                    rows: 24,
                    ..Default::default()
                },
                move |bytes| {
                    let _ = tx.send(bytes);
                },
            )
            .expect("open session");

        mgr.write(id, b"echo santree_marker_42\n").expect("write");

        let mut out = String::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(bytes) => {
                    out.push_str(&String::from_utf8_lossy(&bytes));
                    if out.contains("santree_marker_42") {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => break,
            }
        }

        assert!(
            out.contains("santree_marker_42"),
            "expected echoed output, got: {out:?}"
        );
        mgr.close(id).expect("close");
    }

    #[test]
    fn concurrent_sessions_are_isolated() {
        let mgr = PtyManager::new();
        let open_silent = || {
            mgr.open(
                OpenOpts {
                    command: "sh".into(),
                    cols: 80,
                    rows: 24,
                    ..Default::default()
                },
                |_| {},
            )
            .unwrap()
        };
        let a = open_silent();
        let b = open_silent();
        assert_ne!(a, b);
        mgr.write(a, b"true\n").unwrap();
        mgr.write(b, b"true\n").unwrap();
        mgr.close(a).unwrap();
        // b is still alive and writable after a is closed.
        mgr.write(b, b"true\n").unwrap();
        mgr.close(b).unwrap();
    }

    #[test]
    fn write_to_missing_session_errors() {
        let mgr = PtyManager::new();
        assert!(mgr.write(999, b"x").is_err());
    }
}
