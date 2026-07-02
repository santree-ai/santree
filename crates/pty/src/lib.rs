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
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

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
    pub cols: u16,
    pub rows: u16,
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    /// Per-session writer lock so a blocking `write_all`/`flush` on one stuck
    /// child only serializes that session — not every session behind the manager's
    /// single `Inner` lock.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
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
        let mut child = pair.slave.spawn_command(cmd).context("spawning process")?;
        // Drop the slave handle in the parent so the master reader sees EOF once
        // the child exits.
        drop(pair.slave);

        let reader = match pair.master.try_clone_reader().context("cloning reader") {
            Ok(reader) => reader,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
        };
        let writer = match pair.master.take_writer().context("taking writer") {
            Ok(writer) => writer,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
        };

        let id = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let id = inner.next_id;
            inner.next_id += 1;
            id
        };

        // Spawn the reader *before* registering the session: if the spawn fails we
        // kill+reap the child here instead of leaving an unreaped, reader-less
        // session in the map. Blocking read loop on its own std thread (the PTY
        // master read is blocking), not an async task.
        if let Err(e) = std::thread::Builder::new()
            .name(format!("pty-reader-{id}"))
            .spawn(move || pump(reader, on_output))
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(anyhow::Error::new(e).context("spawning reader thread"));
        }

        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sessions
            .insert(
                id,
                Session {
                    master: pair.master,
                    writer: Arc::new(Mutex::new(writer)),
                    child,
                },
            );

        log::info!("opened pty session {id} (command: {})", opts.command);
        Ok(id)
    }

    /// Write raw bytes (keystrokes, or a seed) to the session's PTY master.
    pub fn write(&self, id: SessionId, data: &[u8]) -> Result<()> {
        // Clone out the per-session writer handle, then drop the manager lock so
        // the (potentially blocking) write never serializes other sessions.
        let writer = {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let session = inner
                .sessions
                .get(&id)
                .ok_or_else(|| anyhow!("no terminal session {id}"))?;
            session.writer.clone()
        };
        let mut writer = writer.lock().unwrap_or_else(|e| e.into_inner());
        writer.write_all(data).context("writing to pty")?;
        writer.flush().context("flushing pty")?;
        Ok(())
    }

    /// Resize the PTY so the hosted process reflows to the visible grid.
    pub fn resize(&self, id: SessionId, cols: u16, rows: u16) -> Result<()> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
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
        let session = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sessions
            .remove(&id);
        if let Some(mut session) = session {
            let _ = session.child.kill();
            // Reap on a detached thread: a process slow to die after the kill must
            // not block this command thread. Dropping master/writer at the end of
            // this block closes the pty, so the reader still sees EOF.
            let mut child = session.child;
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            log::info!("closed pty session {id}");
        }
        Ok(())
    }

    /// Kill every session — used on app exit so no child or thread is leaked.
    ///
    /// This runs synchronously on the Tauri run loop during `ExitRequested`, so
    /// it must never hang: `portable_pty::Child::kill()` sends `SIGHUP` on unix
    /// and internally escalates to `SIGKILL` after ~250ms if the child hasn't
    /// exited, but a child wedged in uninterruptible I/O (or otherwise slow to
    /// be reaped) could still stall a synchronous `wait()`. So, mirroring
    /// `close()`'s detached-thread reap (one stuck child must not block the
    /// others or this thread), each session is torn down on its own thread —
    /// pty master/writer dropped first so the child sees EOF/HUP even if it
    /// traps the kill signal, then `kill()` + `wait()` — and this function
    /// blocks on all of them finishing only up to a bounded overall deadline,
    /// after which it gives up so app exit can't hang no matter what a child
    /// does.
    pub fn close_all(&self) {
        let drained: Vec<Session> = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.sessions.drain().map(|(_, s)| s).collect()
        };
        let total = drained.len();
        if total == 0 {
            return;
        }

        let (done_tx, done_rx) = mpsc::channel::<()>();
        for session in drained {
            let done_tx = done_tx.clone();
            std::thread::spawn(move || {
                let Session {
                    master,
                    writer,
                    mut child,
                } = session;
                // Drop the pty master/writer before signalling: closing our end
                // of the pty delivers EOF/HUP to the child immediately, even if
                // it ignores or traps the kill signal below.
                drop(writer);
                drop(master);
                let _ = child.kill();
                let _ = child.wait();
                let _ = done_tx.send(());
            });
        }
        drop(done_tx);

        let deadline = Instant::now() + Duration::from_secs(2);
        let mut reaped = 0;
        while reaped < total {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() || done_rx.recv_timeout(remaining).is_err() {
                log::warn!(
                    "close_all: {} of {total} pty session(s) did not reap before the exit deadline",
                    total - reaped
                );
                return;
            }
            reaped += 1;
        }
        log::info!("closed all {total} pty session(s)");
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
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    on_output(Vec::new());
}

/// Build the `CommandBuilder`. `CommandBuilder::new` already inherits the full
/// parent environment (so PATH/HOME are present and login CLIs resolve) via
/// `vars_os()`, which is `OsString`-based and so tolerates non-UTF-8 values —
/// unlike `std::env::vars()`, which panics on one. Only a sane TERM is added on
/// top of that — the PTY only ever inherits the ambient process environment
/// (see COMPLIANCE.md); there is deliberately no override channel a caller
/// could misuse to forward secrets into a hosted CLI.
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

    cmd.env("TERM", "xterm-256color");

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

    /// Open a silent `sh` session, returning its id and the receiver end of its
    /// output channel. Shared by the sentinel tests below.
    fn open_silent_shell(mgr: &PtyManager) -> (SessionId, mpsc::Receiver<Vec<u8>>) {
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
        (id, rx)
    }

    /// Poll `rx` until either the exit sentinel (an empty chunk — see `pump`'s
    /// doc comment) arrives or `deadline` passes. Returns whether it arrived.
    fn recv_sentinel(rx: &mpsc::Receiver<Vec<u8>>, deadline: Instant) -> bool {
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(bytes) if bytes.is_empty() => return true,
                Ok(_) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => break,
            }
        }
        false
    }

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

    /// `pump()`'s exit sentinel (a final empty chunk — see its doc comment) is
    /// the frontend's only signal to tear down a terminal pane. Prove it's
    /// actually delivered when the hosted process exits on its own, not just
    /// when we kill it.
    #[test]
    fn process_exit_sends_sentinel() {
        let mgr = PtyManager::new();
        let (id, rx) = open_silent_shell(&mgr);

        mgr.write(id, b"exit\n").expect("write");

        let deadline = Instant::now() + Duration::from_secs(5);
        assert!(
            recv_sentinel(&rx, deadline),
            "expected exit sentinel after the shell process exited on its own"
        );
    }

    /// `close()` kills the session out from under a still-running process; the
    /// sentinel must still arrive so the frontend tears the pane down.
    #[test]
    fn close_sends_sentinel() {
        let mgr = PtyManager::new();
        let (id, rx) = open_silent_shell(&mgr);

        mgr.close(id).expect("close");

        let deadline = Instant::now() + Duration::from_secs(5);
        assert!(
            recv_sentinel(&rx, deadline),
            "expected exit sentinel after close()"
        );
    }

    /// `close_all()` (used on app quit) must reap every open session and
    /// deliver each one's sentinel, not just the first — the whole point of
    /// its per-session detached-thread fix is that one session can't block
    /// another.
    #[test]
    fn close_all_sends_sentinel_to_every_session() {
        let mgr = PtyManager::new();
        let sessions: Vec<(SessionId, mpsc::Receiver<Vec<u8>>)> =
            (0..3).map(|_| open_silent_shell(&mgr)).collect();

        mgr.close_all();

        for (id, rx) in sessions {
            let deadline = Instant::now() + Duration::from_secs(5);
            assert!(
                recv_sentinel(&rx, deadline),
                "expected exit sentinel for session {id} after close_all()"
            );
        }
    }
}
