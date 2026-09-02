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
use santree_core::domain::AgentKind;

mod ring;
use ring::Ring;
pub use ring::{Anchor, Replay, ReplayMode, RING_CAP_BYTES};

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
    /// Who asked for this session — an opaque tag the caller compares against
    /// itself later (see [`PtyManager::adopt_others`]). This crate never
    /// interprets it; it only stores and matches it.
    pub owner: String,
    /// What the caller calls this session (santree's `term_key`). Opaque here —
    /// stored and handed back on adoption so a reloaded page can match a live
    /// session to the surface that owns it. Never a path or a lookup key.
    ///
    /// **Half of an identity, not all of it.** A surface hosts one session per
    /// provider, so this is only unique when paired with [`OpenOpts::agent_kind`]
    /// — see that field.
    pub label: String,
    /// Which agent santree launched in this session, or `None` for a plain shell.
    ///
    /// The second half of the session's identity, kept as its own field rather
    /// than folded into `label`: the label is santree's `term_key`, and
    /// `terminal_sessions` keys the same surface by a separate provider column,
    /// so a label carrying `::<provider>` matched nothing on the way back and a
    /// live agent read as exited. Two providers on one surface are therefore two
    /// sessions here, distinguishable by this field alone.
    pub agent_kind: Option<AgentKind>,
}

/// Where a session's output goes right now. `None` while detached — the pump
/// keeps reading and the ring keeps filling, because the process does not care
/// that nobody is watching.
type OutputSink = Box<dyn Fn(Vec<u8>) + Send>;

struct Session {
    master: Box<dyn MasterPty + Send>,
    /// Per-session writer lock so a blocking `write_all`/`flush` on one stuck
    /// child only serializes that session — not every session behind the manager's
    /// single `Inner` lock.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn Child + Send + Sync>,
    /// The grid the pty was last resized to. Stored because the kernel owns it
    /// and there is no portable way to read it back — a caller that wants to
    /// show the user what size a session is running at has nowhere else to ask.
    size: (u16, u16),
    /// Recent output, so a client that lost its view can be caught up rather
    /// than losing the session. Shared with the reader thread.
    ring: Arc<Mutex<Ring>>,
    /// Swapped by `attach`/`detach`. Shared with the reader thread, which holds
    /// it only long enough to forward one chunk.
    sink: Arc<Mutex<Option<OutputSink>>>,
    /// Where the session runs and what it spawned — see [`SessionInfo`].
    info: SessionInfo,
}

/// What the manager knows about a live session, for a caller that wants to
/// account for it (which processes it owns, where it runs) without touching the
/// pty itself. Read-only: nothing here writes to or reads from the stream.
///
/// `Default` is derived so callers constructing one — test fixtures, mostly —
/// can name only the fields they care about. Adding a field here has broken
/// those three times now; spreading a default is what stops the fourth.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SessionInfo {
    pub id: SessionId,
    /// The root process's pid — the shell or command spawned on the pty slave;
    /// everything the session runs descends from it. `None` if the platform
    /// couldn't report one (portable-pty's `Child::process_id`), never a guess.
    pub pid: Option<u32>,
    /// The directory the root process actually started in: the requested cwd,
    /// or `$HOME` when that was missing (see [`effective_cwd`]).
    pub cwd: Option<String>,
    /// The program actually spawned (argv[0]): the requested command, or the
    /// user's login shell when the request left it blank.
    pub command: String,
    /// The [`OpenOpts::owner`] tag this session was opened under.
    pub owner: String,
    /// The [`OpenOpts::label`] this session was opened under.
    pub label: String,
    /// The [`OpenOpts::agent_kind`] this session was opened under — the other
    /// half of its identity, since one label can host one session per provider.
    pub agent_kind: Option<AgentKind>,
    /// The grid the pty was last resized to.
    pub cols: u16,
    pub rows: u16,
    /// Whether anything is currently receiving this session's output.
    ///
    /// A session with no receiver is not broken — it is the normal state of a
    /// pane that is closed, or of work inherited from a page that reloaded and
    /// not yet reopened. It is worth reporting because it is invisible
    /// everywhere else: the process is running and nothing is watching it.
    pub attached: bool,
    /// Whether the root process still exists. `false` for a session whose child
    /// exited but which nobody has closed yet — it holds a pty and a ring, and
    /// it is the state a user would want to clean up.
    pub alive: bool,
    /// Identity of this session's byte stream. A client holding an anchor minted
    /// against a different epoch cannot be caught up — its position refers to a
    /// stream that no longer exists — so this is what makes that detectable
    /// instead of silently mis-anchoring it.
    pub epoch: String,
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

        let owner = opts.owner.clone();
        let label = opts.label.clone();
        let agent_kind = opts.agent_kind;
        let cmd = build_command(&opts);
        let cwd = cmd.get_cwd().map(|cwd| cwd.to_string_lossy().into_owned());
        let program = cmd
            .get_argv()
            .first()
            .map(|arg| arg.to_string_lossy().into_owned())
            .unwrap_or_default();
        let mut child = pair.slave.spawn_command(cmd).context("spawning process")?;
        let pid = child.process_id();
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

        let ring = Arc::new(Mutex::new(Ring::default()));
        let sink: Arc<Mutex<Option<OutputSink>>> = Arc::new(Mutex::new(Some(Box::new(on_output))));

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
                    size: (size.cols, size.rows),
                    ring: ring.clone(),
                    sink: sink.clone(),
                    info: SessionInfo {
                        id,
                        pid,
                        cwd,
                        command: program,
                        owner,
                        label,
                        agent_kind,
                        cols: size.cols,
                        rows: size.rows,
                        // Set live by `sessions()`; the stored value is only a
                        // seed, and the session does start out attached.
                        attached: true,
                        alive: true,
                        epoch: mint_epoch(id),
                    },
                },
            );
            id
        };

        // Blocking read loop on its own std thread (the PTY master read is blocking),
        // not an async task. If the thread won't spawn, unregister the session again
        // rather than leave a reader-less one in the map — `close` kills and reaps it.
        if let Err(e) = std::thread::Builder::new()
            .name(format!("pty-reader-{id}"))
            .spawn(move || pump(reader, ring, sink))
        {
            let _ = self.close(id);
            return Err(anyhow::Error::new(e).context("spawning reader thread"));
        }

        log::info!(
            "opened pty session {id} (command: {}, label: {}, agent: {})",
            opts.command,
            opts.label,
            opts.agent_kind.map(AgentKind::as_str).unwrap_or("-")
        );
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
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let session = inner
            .sessions
            .get_mut(&id)
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
        // Only after the pty accepted it: reporting a size the kernel refused
        // would make the panel confidently wrong about what the child sees.
        session.size = (cols.max(1), rows.max(1));
        session.info.cols = session.size.0;
        session.info.rows = session.size.1;
        Ok(())
    }

    /// Every registered session's identity — id, root pid, cwd, command — in id
    /// order. A snapshot under the manager lock (cheap: a clone of a few strings
    /// per session), so a caller can go and look those pids up without holding
    /// anything. A session whose child has exited but which nobody has `close`d
    /// yet is still listed: its pid is then a reaped-or-zombie process the caller
    /// won't find alive.
    pub fn sessions(&self) -> Vec<SessionInfo> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut infos: Vec<SessionInfo> = inner
            .sessions
            .values_mut()
            .map(|s| {
                // Both are live facts, so they are read here rather than trusted
                // from the stored copy: `attached` changes on every pane mount,
                // and `alive` can only be answered by asking the child.
                s.info.attached = s.sink.lock().unwrap_or_else(|e| e.into_inner()).is_some();
                // `try_wait` reaps without blocking: `Ok(Some(_))` means it has
                // exited, `Ok(None)` that it is still running. An error means we
                // cannot tell, and claiming "dead" on an unprovable answer is how
                // a caller ends up offering to clean up live work.
                s.info.alive = !matches!(s.child.try_wait(), Ok(Some(_)));
                s.info.clone()
            })
            .collect();
        infos.sort_by_key(|info| info.id);
        infos
    }

    /// Point a session's output at `on_output`, and report what the client needs
    /// to write before the live stream makes sense.
    ///
    /// This replaces any previous sink, which is what makes a reload survivable:
    /// the old page's channel is dead, the new page's is not, and the session
    /// never noticed. `anchor` says what the client already has — see
    /// [`Anchor`] — and the returned [`Replay`] is the catch-up for it.
    pub fn attach(
        &self,
        id: SessionId,
        anchor: &Anchor,
        on_output: impl Fn(Vec<u8>) + Send + 'static,
    ) -> Result<Replay> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let session = inner
            .sessions
            .get(&id)
            .ok_or_else(|| anyhow!("no terminal session {id}"))?;
        // Read the ring and install the sink under the manager lock, so a chunk
        // arriving mid-attach either lands in the replay or goes to the new sink
        // — never both (a duplicated repaint) and never neither (a lost one).
        let replay = session
            .ring
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .replay_for(&session.info.epoch, anchor);
        *session.sink.lock().unwrap_or_else(|e| e.into_inner()) = Some(Box::new(on_output));
        log::info!(
            "attached pty session {id} ({:?}, {} byte(s) replayed, label: {})",
            replay.mode,
            replay.bytes.len(),
            session.info.label
        );
        Ok(replay)
    }

    /// Stop forwarding a session's output. The process keeps running and the
    /// ring keeps filling; only the delivery stops.
    ///
    /// Infallible and idempotent by design: this runs from a React cleanup, and
    /// a pane unmounting after its session already ended is ordinary, not an
    /// error worth surfacing.
    pub fn detach(&self, id: SessionId) {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(session) = inner.sessions.get(&id) {
            *session.sink.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
    }

    /// Hand every session owned by a *different* page over to `owner`, and
    /// report them so the caller can match each one back to the surface that
    /// owns it.
    ///
    /// This is the inverse of what the owner tag used to mean. A session
    /// deliberately outlives the view that opened it; it used to also have to
    /// die with the *page*, because every handle to it — the tab list, the byte
    /// channel, the xterm — was thrown away by a reload and nothing on the new
    /// page could reach it again. The ring removes that constraint: a reloaded
    /// page can re-derive all three from `(label, agent_kind)` and catch up from
    /// the stream.
    /// So the tag stops being a kill list and becomes a hand-over.
    ///
    /// Sessions are re-tagged here, not by the caller, so that a second reload
    /// arriving mid-adoption sees them as already claimed rather than adopting
    /// them twice. The caller is responsible for closing what it cannot host —
    /// a worktree deleted while the page was down — and this returns everything
    /// rather than filtering, because only the caller knows which is which.
    pub fn adopt_others(&self, owner: &str) -> Vec<SessionInfo> {
        let mut adopted = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let mut adopted = Vec::new();
            for session in inner.sessions.values_mut() {
                if session.info.owner == owner {
                    continue;
                }
                // The old page is gone, so its sink is a channel nothing reads.
                // Drop it now rather than at the caller's attach: an unclaimed
                // session should not keep forwarding into the void.
                *session.sink.lock().unwrap_or_else(|e| e.into_inner()) = None;
                session.info.owner = owner.to_string();
                adopted.push(session.info.clone());
            }
            adopted
        };
        adopted.sort_by_key(|info| info.id);

        // A label names one surface, and a surface hosts one session *per
        // provider*, so two live sessions under the same (label, agent_kind)
        // means an earlier page opened a duplicate. Only one of them can ever be
        // reached again — the caller looks sessions up by that pair — so keep
        // the newest (highest id, the one whose output is current) and end the
        // rest here rather than hand back a list with unreachable entries in it.
        //
        // The pair, never the label alone: a Claude and a Codex session on one
        // surface (an AI review of the same PR under both) are two panes the
        // caller can host at once, and deduping by label would kill one of them.
        let mut newest: HashMap<(&str, Option<AgentKind>), SessionId> = HashMap::new();
        for info in &adopted {
            if info.label.is_empty() {
                continue;
            }
            newest
                .entry((&info.label, info.agent_kind))
                .and_modify(|id| *id = (*id).max(info.id))
                .or_insert(info.id);
        }
        let superseded: Vec<SessionId> = adopted
            .iter()
            .filter(|info| {
                !info.label.is_empty()
                    && newest.get(&(info.label.as_str(), info.agent_kind)) != Some(&info.id)
            })
            .map(|info| info.id)
            .collect();
        if !superseded.is_empty() {
            log::info!(
                "closing {} superseded pty session(s) sharing a label and provider with a newer one",
                superseded.len()
            );
            for id in &superseded {
                let _ = self.close(*id);
            }
            adopted.retain(|info| !superseded.contains(&info.id));
        }
        adopted
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
                    size: _,
                    ring: _,
                    sink: _,
                    info: _,
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

/// A stream identity for one session, unique for the life of this process.
///
/// The session id alone would nearly do — ids are monotonic and never reused —
/// but an anchor is a value a client can hold across an app restart if we ever
/// persist one, and ids restart at zero. Mixing in the process start time makes
/// a stale anchor from a previous run fail to match instead of matching the
/// wrong session, which is the whole point of having an epoch at all.
fn mint_epoch(id: SessionId) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    static START_NANOS: std::sync::OnceLock<u128> = std::sync::OnceLock::new();
    let start = START_NANOS.get_or_init(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    });
    format!("{start:x}-{id}")
}

/// Read the master until EOF, recording each chunk and handing it to whatever
/// sink is attached. On EOF (the hosted process exited — `exit`, Ctrl-D, or a
/// kill) emit a final empty chunk as an exit sentinel so the frontend can tear
/// the pane down instead of leaving a dead terminal on screen. Output chunks are
/// always non-empty, so empty is unambiguous.
///
/// The ring is written **before** the sink, and a `None` sink is not an error:
/// a detached pane, or a page that reloaded out from under this session, must
/// not stop the process or lose what it prints in the meantime. That is the
/// property the whole reattach design rests on.
fn pump(
    mut reader: Box<dyn Read + Send>,
    ring: Arc<Mutex<Ring>>,
    sink: Arc<Mutex<Option<OutputSink>>>,
) {
    let emit = |bytes: Vec<u8>| {
        if !bytes.is_empty() {
            ring.lock().unwrap_or_else(|e| e.into_inner()).push(&bytes);
        }
        // Held only for the forward itself. The sink writes to a Tauri channel,
        // which does not block on the webview, so this cannot stall the read
        // loop behind a slow renderer.
        if let Some(sink) = sink.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            sink(bytes);
        }
    };
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => emit(buf[..n].to_vec()),
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
    emit(Vec::new());
}

/// Environment markers an agent CLI stamps onto the processes it spawns to say
/// "you are a nested session of mine". They are removed from the inherited env
/// before a santree session is built, because a santree-launched agent is a
/// *top-level* session — the user opened a tab — and not a child of whatever
/// happened to launch santree.
///
/// This is not cosmetic. santree is routinely run from inside a Claude Code
/// session during development, so its own process env carries these; without
/// this strip they reach every agent PTY it spawns. Claude Code reads
/// `CLAUDE_CODE_CHILD_SESSION` as proof it is a nested session and turns
/// **transcript saving off** — and a session with no transcript is one
/// `session::resolve` can never offer to resume and Session History can never
/// show. The whole resume story silently stops working.
///
/// Removing the false marker is the fix; Claude's own
/// `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE` escape hatch is deliberately *not*
/// used, because forcing persistence over a marker that lies about the process
/// tree leaves every other consumer of that marker still lied to.
///
/// The list is deliberately narrow — only what a *parent agent process* writes
/// into a child's env, never a knob a user sets for themselves (notably
/// `CLAUDE_CODE_SKIP_PROMPT_HISTORY`, which also suppresses transcripts but is
/// the user's own deliberate choice and so is left alone). The first group is
/// exactly what the `claude` binary writes into the env of everything it
/// spawns; the second is what its own "clean relaunch" path deletes to turn a
/// nested env back into a top-level one.
///
/// It lives here rather than in `src-tauri` because this is where inheritance
/// actually happens — `CommandBuilder::new` copies the ambient env. Sessions get
/// the strip for free from [`build_command`]; the other spawn site in the app
/// (`stream.rs`, which runs setup scripts and builds behind their own PTY) calls
/// [`strip_inherited_session_markers`] with this same list, so the two can never
/// drift apart.
pub const INHERITED_SESSION_MARKERS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "AI_AGENT",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
];

/// Drop every [`INHERITED_SESSION_MARKERS`] name from `cmd`'s inherited
/// environment.
///
/// Public because santree spawns processes behind a PTY in two places, and the
/// marker leak is a property of *spawning*, not of this crate's session
/// manager: a build or setup script launched by `stream.rs` inherits the same
/// poisoned env. Call this on any `CommandBuilder` before the caller's own
/// variables are applied — an explicitly configured value of the same name is
/// the user's call and must survive.
pub fn strip_inherited_session_markers(cmd: &mut CommandBuilder) {
    for marker in INHERITED_SESSION_MARKERS {
        cmd.env_remove(marker);
    }
}

/// Build the `CommandBuilder`. `CommandBuilder::new` already inherits the full
/// parent environment (so PATH/HOME are present and login CLIs resolve) via
/// `vars_os()`, which is `OsString`-based and so tolerates non-UTF-8 values —
/// unlike `std::env::vars()`, which panics on one.
///
/// That inherited env is then cleaned and layered, in this order:
/// 1. [`INHERITED_SESSION_MARKERS`] are dropped, so the session starts as its
///    own top-level session rather than a leaked child of santree's launcher;
/// 2. the user's own configured project env (`opts.env`, resolved by
///    `src-tauri` from the Environment settings — see COMPLIANCE.md's
///    "user-configured project environment" carve-out). It is applied *after*
///    the strip on purpose: a name the user set explicitly is their call, and
///    their value must win over our removal;
/// 3. a sane `TERM` last so it can't be clobbered.
///
/// Steps 2 and 3 are the *only* env override channel, and step 2 carries the
/// user's own variables — it is never used to read, store, or forward an agent
/// CLI's auth tokens.
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

    // Before anything is layered on: drop the nested-session markers santree
    // inherited from whatever launched it, so this session is nobody's child.
    strip_inherited_session_markers(&mut cmd);

    // The user's own variables come after the strip, so an explicit setting of
    // one of those names wins over our removal.
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

    /// Serialises the tests that allocate real PTYs.
    ///
    /// Every test in this module forks a real shell behind a real pty, and cargo
    /// runs them on parallel threads. Together with whatever else is on the
    /// machine — the app itself during development, the other crates' suites
    /// under `--workspace` — that was enough to exhaust the pty table and fail
    /// `openpty` outright (`Os { code: -6 }`), on a different test each run. The
    /// failures were real resource contention, not flaky assertions, and a
    /// suite that fails for reasons unrelated to the code under test teaches
    /// people to re-run instead of to look.
    ///
    /// Poisoning is ignored: one panicking test must not cascade into every
    /// later one reporting the same unrelated failure.
    fn pty_guard() -> std::sync::MutexGuard<'static, ()> {
        static SERIAL: Mutex<()> = Mutex::new(());
        SERIAL.lock().unwrap_or_else(|e| e.into_inner())
    }

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
        let _serial = pty_guard();
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
        let _serial = pty_guard();
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
        let _serial = pty_guard();
        let mgr = PtyManager::new();
        assert!(mgr.write(999, b"x").is_err());
    }

    #[test]
    fn resize_missing_session_errors() {
        let _serial = pty_guard();
        let mgr = PtyManager::new();
        assert!(mgr.resize(999, 80, 24).is_err());
    }

    /// Resizing a live session must reach the hosted process: the shell reports the
    /// new column count back through `$COLUMNS`, which only changes if the
    /// `TIOCSWINSZ` actually landed on the pty.
    #[test]
    fn resize_reflows_the_hosted_process() {
        let _serial = pty_guard();
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
        let _serial = pty_guard();
        let mgr = PtyManager::new();
        assert!(mgr.close(999).is_ok());
    }

    /// Two live sessions under one label means an earlier page opened a
    /// duplicate. Only one can ever be reached again — the caller looks sessions
    /// up by label — so the older one is ended here instead of being handed back
    /// as an entry nothing can use.
    #[test]
    fn adopt_others_ends_sessions_superseded_by_a_newer_one_with_the_same_label() {
        let _serial = pty_guard();
        let mgr = PtyManager::new();
        let open = |owner: &str, label: &str| {
            mgr.open(
                OpenOpts {
                    command: "sh".into(),
                    cols: 80,
                    rows: 24,
                    owner: owner.into(),
                    label: label.into(),
                    ..Default::default()
                },
                |_| {},
            )
            .expect("open session")
        };
        let stale = open("page-1", "tree:a");
        let newest = open("page-2", "tree:a");
        let other = open("page-2", "tree:b");

        let adopted = mgr.adopt_others("page-3");

        assert_eq!(
            adopted.iter().map(|s| s.id).collect::<Vec<_>>(),
            vec![newest, other],
            "the superseded session is not reported"
        );
        assert_eq!(
            mgr.sessions().iter().map(|s| s.id).collect::<Vec<_>>(),
            vec![newest, other],
            "and it is actually ended, not just hidden"
        );
        assert!(!mgr.sessions().iter().any(|s| s.id == stale));

        for id in [newest, other] {
            mgr.close(id).expect("close");
        }
    }

    /// A surface hosts one session *per provider* — the real database holds a
    /// Claude and a Codex review of the same PR — so two sessions sharing a label
    /// are a duplicate only when they share the provider too. Deduping by label
    /// alone would end one of two panes the caller can host at once, and the user
    /// would watch half their review disappear on a reload.
    #[test]
    fn adopt_others_supersedes_within_a_provider_and_never_across_two() {
        let _serial = pty_guard();
        let mgr = PtyManager::new();
        let open = |owner: &str, label: &str, agent_kind: Option<AgentKind>| {
            mgr.open(
                OpenOpts {
                    command: "sh".into(),
                    cols: 80,
                    rows: 24,
                    owner: owner.into(),
                    label: label.into(),
                    agent_kind,
                    ..Default::default()
                },
                |_| {},
            )
            .expect("open session")
        };
        let surface = "ai-review:acme/web#7";
        let stale_codex = open("page-1", surface, Some(AgentKind::Codex));
        let codex = open("page-2", surface, Some(AgentKind::Codex));
        let claude = open("page-2", surface, Some(AgentKind::Claude));

        let adopted = mgr.adopt_others("page-3");

        assert_eq!(
            adopted.iter().map(|s| s.id).collect::<Vec<_>>(),
            vec![codex, claude],
            "only the older session of the SAME provider is superseded"
        );
        assert!(!mgr.sessions().iter().any(|s| s.id == stale_codex));
        // Both survivors are reachable, and each carries the other half of its
        // identity — which is what `live_terminals` joins the durable rows on.
        assert_eq!(
            mgr.sessions()
                .iter()
                .map(|s| (s.label.as_str(), s.agent_kind))
                .collect::<Vec<_>>(),
            vec![
                (surface, Some(AgentKind::Codex)),
                (surface, Some(AgentKind::Claude)),
            ]
        );

        for id in [codex, claude] {
            mgr.close(id).expect("close");
        }
    }

    /// An unlabelled session can't collide with anything, so it must survive
    /// adoption alongside others that are also unlabelled.
    #[test]
    fn adopt_others_keeps_every_unlabelled_session() {
        let _serial = pty_guard();
        let mgr = PtyManager::new();
        let open = || {
            mgr.open(
                OpenOpts {
                    command: "sh".into(),
                    cols: 80,
                    rows: 24,
                    owner: "page-1".into(),
                    ..Default::default()
                },
                |_| {},
            )
            .expect("open session")
        };
        let a = open();
        let b = open();

        assert_eq!(mgr.adopt_others("page-2").len(), 2);

        for id in [a, b] {
            mgr.close(id).expect("close");
        }
    }

    /// The property the whole design exists for: the process does not care that
    /// nobody is watching. A detached session keeps running and keeps recording,
    /// and the bytes it printed while unwatched are still there to catch up on.
    #[test]
    fn a_detached_session_keeps_running_and_its_output_is_recoverable() {
        let _serial = pty_guard();
        let mgr = PtyManager::new();
        let (tx, rx) = mpsc::channel();
        let id = mgr
            .open(
                OpenOpts {
                    command: "sh".into(),
                    cols: 80,
                    rows: 24,
                    label: "tree:a".into(),
                    ..Default::default()
                },
                move |bytes| {
                    let _ = tx.send(bytes);
                },
            )
            .expect("open session");

        // Detach, then print something no sink is listening for.
        mgr.detach(id);
        drop(rx);
        mgr.write(id, b"echo detached-marker\n").expect("write");

        // Reattach as a brand-new terminal would: nothing on screen, no position.
        let replay = wait_for_replay(&mgr, id, &Anchor::Fresh, b"detached-marker");
        assert_eq!(replay.mode, ReplayMode::Tail);

        mgr.close(id).expect("close");
    }

    /// A pane that comes back after a detach knows where it was, so it must be
    /// handed exactly what it missed — not the whole ring again, which would
    /// reprint output already on its screen.
    #[test]
    fn a_reattach_with_a_known_position_replays_only_the_gap() {
        let _serial = pty_guard();
        let mgr = PtyManager::new();
        let id = mgr
            .open(
                OpenOpts {
                    command: "sh".into(),
                    cols: 80,
                    rows: 24,
                    label: "tree:a".into(),
                    ..Default::default()
                },
                |_| {},
            )
            .expect("open session");

        // The needle must not appear in the line the shell echoes back, or the
        // wait below can return on that echo while the command's own output is
        // still in flight — anchoring the reattach *before* the thing it is
        // supposed to have already seen, and failing the assertion at the end
        // for a reason that has nothing to do with the ring. `bef''ore-gap`
        // prints `before-gap` while the echoed command line does not contain it.
        // (Load-sensitive: it passed alone and failed under a parallel
        // `--workspace` run.)
        mgr.write(id, b"echo bef''ore-gap\n").expect("write");
        let first = wait_for_replay(&mgr, id, &Anchor::Fresh, b"before-gap");
        let epoch = mgr
            .sessions()
            .into_iter()
            .find(|s| s.id == id)
            .expect("session")
            .epoch;

        mgr.detach(id);
        mgr.write(id, b"echo aft''er-gap\n").expect("write");

        let anchor = Anchor::At {
            epoch,
            seq: first.seq,
        };
        let second = wait_for_replay(&mgr, id, &anchor, b"after-gap");
        assert_eq!(second.mode, ReplayMode::Exact);
        assert!(
            !String::from_utf8_lossy(&second.bytes).contains("before-gap"),
            "catch-up must not reprint what the pane already has"
        );

        mgr.close(id).expect("close");
    }

    /// Poll `attach` until the shell has actually printed `needle`. A PTY write
    /// is asynchronous — the shell has to be scheduled, run the command and
    /// flush — so the alternative is a sleep long enough to be flaky on a loaded
    /// CI box. Reattaching repeatedly is harmless: it only swaps the sink.
    fn wait_for_replay(mgr: &PtyManager, id: SessionId, anchor: &Anchor, needle: &[u8]) -> Replay {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut last = mgr.attach(id, anchor, |_| {}).expect("attach");
        while Instant::now() < deadline {
            if last.bytes.windows(needle.len()).any(|w| w == needle) {
                return last;
            }
            std::thread::sleep(Duration::from_millis(25));
            last = mgr.attach(id, anchor, |_| {}).expect("attach");
        }
        panic!(
            "timed out waiting for {:?} in session output",
            String::from_utf8_lossy(needle)
        );
    }

    /// What a reload leans on. A session opened under a previous owner has
    /// nothing left that can reach it, so coming back under a new one must hand
    /// it over — re-tagged so a second reload doesn't adopt it again, and with
    /// enough identity for the caller to match it to a surface. The current
    /// owner's own sessions must be left alone, or adoption would disturb the
    /// terminal that just triggered it.
    #[test]
    fn adopt_others_claims_previous_owners_and_skips_the_current_one() {
        let _serial = pty_guard();
        let mgr = PtyManager::new();
        let open = |owner: &str, label: &str| {
            mgr.open(
                OpenOpts {
                    command: "sh".into(),
                    cols: 80,
                    rows: 24,
                    owner: owner.into(),
                    label: label.into(),
                    ..Default::default()
                },
                |_| {},
            )
            .expect("open session")
        };
        let stale_a = open("page-1", "tree:a");
        let stale_b = open("page-2", "tree:b");
        let mine = open("page-3", "tree:c");

        let adopted = mgr.adopt_others("page-3");
        assert_eq!(
            adopted.iter().map(|s| s.id).collect::<Vec<_>>(),
            vec![stale_a, stale_b]
        );
        // The label is what lets the caller find the surface that owns it again.
        assert_eq!(
            adopted.iter().map(|s| s.label.as_str()).collect::<Vec<_>>(),
            vec!["tree:a", "tree:b"]
        );
        assert!(
            adopted.iter().all(|s| s.owner == "page-3"),
            "adoption re-tags, so a second reload sees them as claimed"
        );

        // Nothing was killed: adoption hands sessions over, it does not reap.
        assert_eq!(mgr.sessions().len(), 3);

        // Idempotent: everything is already this owner's.
        assert!(mgr.adopt_others("page-3").is_empty());

        for id in [stale_a, stale_b, mine] {
            mgr.close(id).expect("close");
        }
    }

    /// `sessions()` is what the app's resource accounting joins the process table
    /// on: each live session must report the real root pid (one that exists and
    /// is our child), the directory it started in, and the program it ran —
    /// and drop out of the list once closed.
    #[test]
    fn sessions_report_root_pid_cwd_and_command() {
        let _serial = pty_guard();
        let mgr = PtyManager::new();
        assert!(mgr.sessions().is_empty());

        let tmp = std::env::temp_dir();
        let id = mgr
            .open(
                OpenOpts {
                    command: "sh".into(),
                    cwd: Some(tmp.to_string_lossy().into_owned()),
                    cols: 80,
                    rows: 24,
                    ..Default::default()
                },
                |_| {},
            )
            .expect("open session");

        let infos = mgr.sessions();
        assert_eq!(infos.len(), 1);
        let info = &infos[0];
        assert_eq!(info.id, id);
        assert_eq!(info.command, "sh");
        assert_eq!(info.cwd.as_deref(), Some(tmp.to_str().unwrap()));
        let pid = info.pid.expect("a spawned child has a pid");
        assert_ne!(pid, 0);
        assert_ne!(pid, std::process::id(), "the root pid is the child, not us");
        // The child is alive: signal 0 probes existence without sending anything.
        let alive = std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(alive, "pid {pid} should be a live child");

        mgr.close(id).expect("close");
        assert!(mgr.sessions().is_empty(), "closed sessions are unlisted");
    }

    /// `close_all()` runs once, at app exit, and is the last thing that reaps
    /// children. An `open()` that lands after it must refuse rather than register a
    /// session nothing will ever tear down — otherwise its child outlives the app.
    #[test]
    fn open_after_close_all_is_refused_and_leaves_no_child() {
        let _serial = pty_guard();
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
        let _serial = pty_guard();
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

    /// Serialises the tests that mutate this process's own environment.
    /// `build_command` snapshots the ambient env, so two tests setting the same
    /// variable on parallel threads would read each other's writes.
    fn env_guard() -> std::sync::MutexGuard<'static, ()> {
        static SERIAL: Mutex<()> = Mutex::new(());
        SERIAL.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The bug this strip exists for: santree run from inside a Claude Code
    /// session inherits `CLAUDE_CODE_CHILD_SESSION`, and passing it on makes
    /// every agent it launches believe it is a nested session — which turns
    /// transcript saving off, so the session can never be resumed or shown in
    /// Session History. A santree-launched agent is a top-level session, so
    /// every marker a parent agent stamps on its children is dropped.
    ///
    /// And the other half of the contract: the strip is of *inherited* values
    /// only. A name the user typed into Settings → Environment is their
    /// explicit call, and their value must survive it.
    #[test]
    fn inherited_session_markers_are_stripped_but_a_user_set_value_wins() {
        let _serial = env_guard();

        // Stand in for a santree launched from inside an agent session.
        let restore: Vec<(&str, Option<String>)> = INHERITED_SESSION_MARKERS
            .iter()
            .map(|name| (*name, std::env::var(name).ok()))
            .collect();
        for name in INHERITED_SESSION_MARKERS {
            std::env::set_var(name, "inherited-from-our-launcher");
        }

        let cmd = build_command(&OpenOpts {
            command: "claude".into(),
            // The user's own Settings → Environment, one of which deliberately
            // reuses a stripped name.
            env: vec![
                ("DATABASE_URL".into(), "postgres://local".into()),
                ("CLAUDECODE".into(), "user-said-so".into()),
            ],
            ..Default::default()
        });

        for name in INHERITED_SESSION_MARKERS {
            if *name == "CLAUDECODE" {
                continue;
            }
            assert_eq!(
                cmd.get_env(name),
                None,
                "{name} was inherited from santree's launcher and must not reach the session"
            );
        }
        assert_eq!(
            cmd.get_env("CLAUDECODE"),
            Some(std::ffi::OsStr::new("user-said-so")),
            "a variable the user set explicitly outranks our removal of it"
        );
        assert_eq!(
            cmd.get_env("DATABASE_URL"),
            Some(std::ffi::OsStr::new("postgres://local")),
            "the rest of the user's project env is untouched"
        );
        // The strip is surgical: unrelated inherited variables still reach the
        // child, or login CLIs would stop resolving.
        assert!(cmd.get_env("PATH").is_some(), "PATH is still inherited");

        for (name, value) in restore {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }

    /// The same property one level down, where it actually bites: not "the
    /// builder's map is right" but "the process on the pty cannot see the
    /// marker". A real shell is asked what it inherited, because that is the
    /// question `claude` asks when it decides whether to save a transcript.
    #[test]
    fn a_spawned_process_does_not_inherit_the_nested_session_marker() {
        let _serial = pty_guard();
        let _env = env_guard();
        let restore = std::env::var("CLAUDE_CODE_CHILD_SESSION").ok();
        std::env::set_var("CLAUDE_CODE_CHILD_SESSION", "1");

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

        // Bracket the value so the answer is unambiguous even though the shell
        // echoes the command line back at us.
        mgr.write(id, b"echo \"marker=[${CLAUDE_CODE_CHILD_SESSION}]\"\n")
            .expect("write");

        let mut out = String::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline && !out.contains("marker=[]") {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(bytes) => out.push_str(&String::from_utf8_lossy(&bytes)),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => break,
            }
        }
        assert!(
            out.contains("marker=[]"),
            "the spawned process must see no CLAUDE_CODE_CHILD_SESSION, got: {out:?}"
        );
        assert!(
            !out.contains("marker=[1]"),
            "the inherited marker reached the child: {out:?}"
        );

        mgr.close(id).expect("close");
        match restore {
            Some(value) => std::env::set_var("CLAUDE_CODE_CHILD_SESSION", value),
            None => std::env::remove_var("CLAUDE_CODE_CHILD_SESSION"),
        }
    }

    /// `CLAUDE_CODE_SKIP_PROMPT_HISTORY` also turns transcript saving off, but
    /// it is a knob the *user* sets for themselves, not a marker a parent agent
    /// stamps on its children. Stripping it would override a deliberate choice,
    /// so the list must stay narrow.
    #[test]
    fn a_users_own_persistence_setting_is_not_stripped() {
        let _serial = env_guard();
        let restore = std::env::var("CLAUDE_CODE_SKIP_PROMPT_HISTORY").ok();
        std::env::set_var("CLAUDE_CODE_SKIP_PROMPT_HISTORY", "1");

        let cmd = build_command(&OpenOpts {
            command: "claude".into(),
            ..Default::default()
        });
        assert_eq!(
            cmd.get_env("CLAUDE_CODE_SKIP_PROMPT_HISTORY"),
            Some(std::ffi::OsStr::new("1"))
        );

        match restore {
            Some(value) => std::env::set_var("CLAUDE_CODE_SKIP_PROMPT_HISTORY", value),
            None => std::env::remove_var("CLAUDE_CODE_SKIP_PROMPT_HISTORY"),
        }
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
        let _serial = pty_guard();
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
        let _serial = pty_guard();
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
        let _serial = pty_guard();
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
