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
    /// Extra environment variables (name → value) to set on top of the inherited
    /// ambient env — the user's own configured project env (see COMPLIANCE.md's
    /// "user-configured project environment" carve-out). Resolved by the caller
    /// (`src-tauri`); this crate just applies them. Empty for an unconfigured
    /// environment. This is NOT a channel for an agent CLI's own auth tokens —
    /// those are never read, stored, or forwarded here.
    pub env: Vec<(String, String)>,
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
    /// Set by `close_all()`, which runs once at app exit and is the last thing that
    /// reaps children. An `open()` already past its spawn when that happens must not
    /// register afterwards: nothing would be left to kill its child.
    closed: bool,
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

        // Mint the id and register the session in a *single* critical section, and
        // refuse outright once `close_all()` has run. Registering across two locks
        // let a `close_all()` land in between and never see this child; registering
        // at all after the drain is the same leak, since nothing reaps the map again.
        let id = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if inner.closed {
                drop(inner);
                let _ = child.kill();
                let _ = child.wait();
                return Err(anyhow!("pty manager is shutting down"));
            }
            let id = inner.next_id;
            inner.next_id += 1;
            inner.sessions.insert(
                id,
                Session {
                    master: pair.master,
                    writer: Arc::new(Mutex::new(writer)),
                    child,
                },
            );
            id
        };

        // Blocking read loop on its own std thread (the PTY master read is blocking),
        // not an async task. If the thread won't spawn, unregister the session again
        // rather than leave a reader-less one in the map — `close` kills and reaps it.
        if let Err(e) = std::thread::Builder::new()
            .name(format!("pty-reader-{id}"))
            .spawn(move || pump(reader, on_output))
        {
            let _ = self.close(id);
            return Err(anyhow::Error::new(e).context("spawning reader thread"));
        }

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
            // Latch shutdown under the same lock as the drain, so an `open()` racing
            // this either registers before it (and is drained here) or is refused.
            inner.closed = true;
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
            Err(e) => {
                // A pty master read normally ends at EOF (`Ok(0)`); anything else
                // (EIO, EBADF) is a real fault, and treating it as a silent EOF
                // leaves a torn-down pane with nothing to explain it. Recording
                // *that* a read failed is not output parsing — no byte of the
                // stream is inspected, and nothing here feeds back into the pty.
                log::warn!("pty read failed, ending session stream: {e}");
                break;
            }
        }
    }
    on_output(Vec::new());
}

/// Build the `CommandBuilder`. `CommandBuilder::new` already inherits the full
/// parent environment (so PATH/HOME are present and login CLIs resolve) via
/// `vars_os()`, which is `OsString`-based and so tolerates non-UTF-8 values —
/// unlike `std::env::vars()`, which panics on one.
///
/// On top of the inherited env we set: the user's own configured project env
/// (`opts.env`, resolved by `src-tauri` from the Environment settings — see
/// COMPLIANCE.md's "user-configured project environment" carve-out), then a sane
/// `TERM` last so it can't be clobbered. This is the *only* env override channel,
/// and it carries the user's own variables — it is never used to read, store, or
/// forward an agent CLI's auth tokens.
fn build_command(opts: &OpenOpts) -> CommandBuilder {
    // Spawn the *trimmed* command: emptiness is judged on it, so a padded exec path
    // would otherwise pass the "not empty" check and then fail exec on the padding.
    let command = opts.command.trim();
    let (program, default_args) = if command.is_empty() {
        (default_shell(), vec!["-l".to_string()])
    } else {
        (command.to_string(), Vec::new())
    };

    let mut cmd = CommandBuilder::new(program);
    let args = if opts.args.is_empty() {
        &default_args
    } else {
        &opts.args
    };
    cmd.args(args);

    for (name, value) in &opts.env {
        cmd.env(name, value);
    }
    // TERM last so a stray user-set TERM can't break xterm rendering.
    cmd.env("TERM", "xterm-256color");

    if let Some(cwd) = effective_cwd(opts.cwd.as_deref()) {
        cmd.cwd(cwd);
    }
    cmd
}

/// Use the requested cwd when it exists, otherwise fall back to $HOME so a stale
/// or missing path never fails the spawn.
///
/// The fallback is deliberate but consequential: a "worktree terminal" whose
/// directory has been deleted underneath it then runs git/claude against $HOME
/// instead. That's still better than failing the spawn, but it must not be silent —
/// the mismatch between the pane's label and its actual cwd is otherwise invisible.
fn effective_cwd(cwd: Option<&str>) -> Option<String> {
    if let Some(cwd) = cwd.filter(|c| !c.is_empty()) {
        if Path::new(cwd).is_dir() {
            return Some(cwd.to_string());
        }
        log::warn!("pty cwd {cwd:?} is not a directory; falling back to $HOME");
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

    #[test]
    fn resize_missing_session_errors() {
        let mgr = PtyManager::new();
        assert!(mgr.resize(999, 80, 24).is_err());
    }

    /// Resizing a live session must reach the hosted process: the shell reports the
    /// new column count back through `$COLUMNS`, which only changes if the
    /// `TIOCSWINSZ` actually landed on the pty.
    #[test]
    fn resize_reflows_the_hosted_process() {
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

        mgr.resize(id, 132, 40).expect("resize");
        // `checkwinsize` is not universal in `sh`, so ask the tty directly.
        mgr.write(id, b"stty size\n").expect("write");

        let mut out = String::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && !out.contains("40 132") {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(bytes) => out.push_str(&String::from_utf8_lossy(&bytes)),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => break,
            }
        }
        assert!(
            out.contains("40 132"),
            "pty should report the resized grid (rows cols), got: {out:?}"
        );
        mgr.close(id).expect("close");
    }

    /// `close()` on an id that was never opened (or is already closed) is a no-op,
    /// not an error — the frontend can tear a pane down twice on a race.
    #[test]
    fn closing_an_unknown_session_is_a_noop() {
        let mgr = PtyManager::new();
        assert!(mgr.close(999).is_ok());
    }

    /// `close_all()` runs once, at app exit, and is the last thing that reaps
    /// children. An `open()` that lands after it must refuse rather than register a
    /// session nothing will ever tear down — otherwise its child outlives the app.
    #[test]
    fn open_after_close_all_is_refused_and_leaves_no_child() {
        let mgr = PtyManager::new();
        mgr.close_all();

        let err = mgr
            .open(
                OpenOpts {
                    command: "sh".into(),
                    cols: 80,
                    rows: 24,
                    ..Default::default()
                },
                |_| {},
            )
            .expect_err("open must fail once the manager is shut down");
        assert!(err.to_string().contains("shutting down"), "{err}");

        let inner = mgr.inner.lock().unwrap();
        assert!(
            inner.sessions.is_empty(),
            "a refused open must not register a session"
        );
    }

    /// The same race the other way round: sessions opened *before* `close_all()` are
    /// all drained by it, whichever order the interleaving takes.
    #[test]
    fn close_all_drains_every_registered_session() {
        let mgr = PtyManager::new();
        let sessions: Vec<_> = (0..4).map(|_| open_silent_shell(&mgr)).collect();
        mgr.close_all();
        assert!(mgr.inner.lock().unwrap().sessions.is_empty());
        for (id, rx) in sessions {
            assert!(
                recv_sentinel(&rx, Instant::now() + Duration::from_secs(5)),
                "session {id} was never reaped"
            );
        }
    }

    // ── build_command ───────────────────────────────────────────────────────

    /// A padded exec path (e.g. a stray space in the settings field) must not be
    /// spawned verbatim: emptiness is judged on the trimmed string, so the spawned
    /// program has to be the trimmed one too, or the exec fails confusingly.
    #[test]
    fn command_is_trimmed_before_spawning() {
        let cmd = build_command(&OpenOpts {
            command: "  /bin/sh  ".into(),
            ..Default::default()
        });
        assert_eq!(cmd.get_argv()[0], "/bin/sh");
    }

    /// A blank command means "the user's login shell", including a command that is
    /// only whitespace.
    #[test]
    fn blank_command_falls_back_to_a_login_shell() {
        for command in ["", "   "] {
            let cmd = build_command(&OpenOpts {
                command: command.into(),
                ..Default::default()
            });
            let argv = cmd.get_argv();
            assert_eq!(argv[0], std::ffi::OsString::from(default_shell()));
            assert_eq!(argv[1], "-l", "login shell");
        }
    }

    /// Explicit args replace the login-shell default, and are passed through as-is.
    #[test]
    fn explicit_args_are_passed_through() {
        let cmd = build_command(&OpenOpts {
            command: "claude".into(),
            args: vec!["--model".into(), "opus".into()],
            ..Default::default()
        });
        let argv: Vec<_> = cmd.get_argv().iter().collect();
        assert_eq!(argv, ["claude", "--model", "opus"]);
    }

    /// The user's own configured project env reaches the child, and `TERM` is set
    /// last so a stray user-set `TERM` can't break xterm rendering.
    #[test]
    fn user_env_is_applied_and_term_wins() {
        let cmd = build_command(&OpenOpts {
            command: "sh".into(),
            env: vec![
                ("DATABASE_URL".into(), "postgres://local".into()),
                ("TERM".into(), "dumb".into()),
            ],
            ..Default::default()
        });
        let env: HashMap<&str, &str> = cmd.iter_extra_env_as_str().collect();
        assert_eq!(env.get("DATABASE_URL"), Some(&"postgres://local"));
        assert_eq!(
            env.get("TERM"),
            Some(&"xterm-256color"),
            "TERM is set last and must override a user-supplied one"
        );
    }

    // ── effective_cwd ───────────────────────────────────────────────────────

    /// A cwd that exists is used as-is.
    #[test]
    fn existing_cwd_is_used() {
        let tmp = std::env::temp_dir();
        let tmp = tmp.to_str().unwrap();
        assert_eq!(effective_cwd(Some(tmp)), Some(tmp.to_string()));
    }

    /// A stale worktree path must not silently run the session in `$HOME` — that
    /// would point git/claude at the wrong repo. It still falls back (a spawn
    /// failure would be worse), but the caller can see it happened.
    #[test]
    fn missing_cwd_falls_back_to_home() {
        let home = std::env::var("HOME").ok();
        assert_eq!(
            effective_cwd(Some("/nonexistent/santree/worktree")),
            home,
            "a vanished worktree falls back to $HOME"
        );
        // No cwd requested at all is the ordinary case, not a stale path.
        assert_eq!(effective_cwd(None), home);
        assert_eq!(effective_cwd(Some("")), home);
    }

    /// A cwd that exists but is a *file* is not a usable working directory.
    #[test]
    fn file_cwd_falls_back_to_home() {
        let file = std::env::temp_dir().join("santree-pty-cwd-probe");
        std::fs::write(&file, b"x").unwrap();
        assert_eq!(
            effective_cwd(Some(file.to_str().unwrap())),
            std::env::var("HOME").ok()
        );
        let _ = std::fs::remove_file(&file);
    }

    /// The cwd actually reaches the spawned child, not just `effective_cwd`.
    #[test]
    fn cwd_reaches_the_command() {
        let tmp = std::env::temp_dir();
        let cmd = build_command(&OpenOpts {
            command: "sh".into(),
            cwd: Some(tmp.to_string_lossy().into_owned()),
            ..Default::default()
        });
        assert_eq!(cmd.get_cwd(), Some(&tmp.into_os_string()));
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
