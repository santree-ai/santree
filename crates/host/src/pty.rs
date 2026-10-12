//! PTY sessions: who receives each one's output (the attach gate, pacing,
//! parking), its input thread, and open / attach / adopt / reap / revocation.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use santree_pty::{OpenOpts, PtyManager};
use santree_remote_proto::*;
use tokio::sync::{oneshot, Notify};

use super::conn::{Conn, Out};
use super::*;

/// One attach's delivery: chunks wait here until the attach response has been
/// queued, so the response always precedes them on the wire. Once open, each
/// chunk waits for its connection to have room (pacing), unless the gate is
/// retired — the session has a newer receiver, or none.
struct Gate {
    id: SessionId,
    out: Out,
    st: Mutex<GateState>,
    retired: AtomicBool,
}

#[derive(Default)]
struct GateState {
    open: bool,
    pending: Vec<Vec<u8>>,
    exit_sent: bool,
}

impl Gate {
    fn deliver(&self, bytes: Vec<u8>) {
        // Outside the state lock: the attach that opens this gate takes it,
        // and must not wait behind a paced chunk. The exit sentinel is never
        // held back.
        let retired = || self.retired.load(Ordering::Acquire);
        if !bytes.is_empty() && (retired() || !self.out.wait_room(retired)) {
            return;
        }
        let mut st = lock(&self.st);
        // Again under the lock `retire` takes: a chunk that passed the checks
        // just before the swap would otherwise follow the new attach's reply
        // on the same connection. A retired gate sends nothing, not even the
        // exit — the session's newer sink (a gate, or parked) has it.
        if retired() {
            return;
        }
        if st.open {
            self.emit(&mut st, bytes);
        } else {
            st.pending.push(bytes);
        }
    }

    /// Empty = the exit sentinel, sent once; nothing follows it.
    fn emit(&self, st: &mut GateState, bytes: Vec<u8>) {
        if st.exit_sent {
            return;
        }
        let event = if bytes.is_empty() {
            st.exit_sent = true;
            Event::PtyExit(PtyExit { id: self.id })
        } else {
            Event::PtyData(PtyData {
                id: self.id,
                data: bytes,
            })
        };
        self.out.send(event.encode());
    }

    /// No more output through this gate: whatever it is still pacing is
    /// dropped (the ring has it; the next receiver's replay carries it).
    /// Set under the state lock, so once this returns no `deliver` already
    /// past its checks can still emit.
    fn retire(&self) {
        {
            let _st = lock(&self.st);
            self.retired.store(true, Ordering::Release);
        }
        self.out.wake();
    }
}

pub(crate) struct SessState {
    /// Serialises attach/park for this session. Never held by a sink.
    attach: Mutex<()>,
    live: Mutex<Live>,
    /// The host's status-change signal, raised when the process ends.
    changed: Arc<Notify>,
    /// Its input (`pty.write`), started on the first write.
    input: Mutex<Option<Input>>,
    /// The gate output goes through now, retired before any other sink takes
    /// its place so a paced chunk never holds up the hand-over.
    gate: Mutex<Option<Arc<Gate>>>,
}

/// One PTY's input: a thread of its own that writes the queued bytes in
/// order. A program that does not read its input blocks that thread — and
/// only it: no pool thread waits, and a full queue answers `busy`. The
/// thread ends when the session's state is dropped (it was closed) and the
/// write in progress, if any, returns.
///
/// That write may not return: santree-pty's writer is a blocking master fd
/// this crate cannot reach, and on Linux (seen on 6.18) a write blocked on a
/// full PTY stays blocked after the session is closed and its process is
/// gone. Such a thread holds its queue until the host restarts, so input
/// threads are capped ([`Caps::max_input_threads`]); past it `pty.write`
/// answers `busy`.
struct Input {
    tx: std::sync::mpsc::Sender<InputJob>,
    queued: Arc<AtomicUsize>,
    limit: usize,
}

struct InputJob {
    data: Vec<u8>,
    done: oneshot::Sender<Result<(), String>>,
}

impl Input {
    /// Start one, counted in `inputs` until its thread ends.
    fn start(
        mgr: PtyManager,
        id: SessionId,
        inputs: Arc<AtomicUsize>,
        caps: &Caps,
    ) -> Result<Self, WireError> {
        let max = caps.max_input_threads;
        inputs
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < max).then_some(n + 1)
            })
            .map_err(|_| {
                busy(format!(
                    "{max} terminals' input writers are running; \
                     restart the host to clear the stuck ones"
                ))
            })?;
        let (tx, rx) = std::sync::mpsc::channel::<InputJob>();
        let queued = Arc::new(AtomicUsize::new(0));
        let left = queued.clone();
        let count = inputs.clone();
        let started = std::thread::Builder::new()
            .name(format!("pty-input-{id}"))
            .spawn(move || {
                for job in rx {
                    // The host's one PTY write: a `pty.write` request's bytes,
                    // relayed (the sanctioned site of clippy.toml's rule).
                    #[allow(clippy::disallowed_methods)]
                    let written = mgr.write(id, &job.data).map_err(|e| format!("{e:#}"));
                    left.fetch_sub(job.data.len(), Ordering::AcqRel);
                    let _ = job.done.send(written);
                }
                count.fetch_sub(1, Ordering::AcqRel);
            });
        if let Err(e) = started {
            inputs.fetch_sub(1, Ordering::AcqRel);
            return Err(err(ErrorCode::Io, format!("starting its input: {e}")));
        }
        Ok(Self {
            tx,
            queued,
            limit: caps.pty_input_queue,
        })
    }

    /// Queue `data`; the receiver says when it went in. `busy` when the
    /// queue is full already (a write into an empty queue is always taken,
    /// however large).
    fn queue(&self, data: Vec<u8>) -> Result<oneshot::Receiver<Result<(), String>>, WireError> {
        let len = data.len();
        self.queued
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |q| {
                (q == 0 || q + len <= self.limit).then_some(q + len)
            })
            .map_err(|q| {
                busy(format!(
                    "{q} bytes are waiting for this terminal to read its input"
                ))
            })?;
        let (done, rx) = oneshot::channel();
        if self.tx.send(InputJob { data, done }).is_err() {
            self.queued.fetch_sub(len, Ordering::AcqRel);
            return Err(err(ErrorCode::Io, "the terminal's input is closed"));
        }
        Ok(rx)
    }
}

impl SessState {
    fn new(changed: Arc<Notify>) -> Self {
        Self {
            attach: Mutex::new(()),
            live: Mutex::new(Live::default()),
            changed,
            input: Mutex::new(None),
            gate: Mutex::new(None),
        }
    }

    fn mark_ended(&self) {
        lock(&self.live).ended = true;
        self.changed.notify_one();
    }

    /// Retire the current gate, if any, and make `next` the current one.
    fn swap_gate(&self, next: Option<Arc<Gate>>) {
        if let Some(old) = std::mem::replace(&mut *lock(&self.gate), next) {
            old.retire();
        }
    }
}

#[derive(Default)]
struct Live {
    /// The pump emitted its exit sentinel: no more output will ever come.
    ended: bool,
    /// The connection receiving this session's output.
    route: Option<u64>,
    /// `adopt_others` dropped the sink for a moment, so an exit sentinel may
    /// have gone nowhere; attach falls back to asking whether it's alive.
    sentinel_maybe_lost: bool,
    /// Since when the reaper has seen it exited and unattached.
    idle_dead_since: Option<Instant>,
}

/// A sink that delivers nothing but still notices the process ending — the
/// "detached" state. `PtyManager::detach` would drop the sink and, with it,
/// the only way to learn of an exit that happens while detached.
fn parked_sink(sess: Arc<SessState>) -> impl Fn(Vec<u8>) + Send + Sync + 'static {
    move |bytes: Vec<u8>| {
        if bytes.is_empty() {
            sess.mark_ended();
        }
    }
}

/// A session's `base_env`: the host's own environment over what the client
/// forwarded (the client's explicit `env` goes on top of both, in
/// santree-pty). A forwarded inheritance replaces this process's environment
/// (santree-pty clears it for a non-empty `base_env`); a client that forwarded
/// none inherits this process's, as an `exec.run` child does — so this
/// process's stands in for it whenever the host has its own to add.
pub(crate) fn session_base_env(
    forwarded: Vec<(String, String)>,
    host_env: &[(String, String)],
) -> Vec<(String, String)> {
    let inherited: Vec<(String, String)> = if forwarded.is_empty() && !host_env.is_empty() {
        std::env::vars_os()
            .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
            .collect()
    } else {
        forwarded
    };
    inherited
        .into_iter()
        .chain(host_env.iter().cloned())
        .collect()
}

impl Host {
    /// Queue `data` for session `id`'s input (`Input`).
    pub(crate) fn pty_input(
        &self,
        id: SessionId,
        data: Vec<u8>,
    ) -> Result<oneshot::Receiver<Result<(), String>>, WireError> {
        let Some(sess) = self.session(id) else {
            return Err(err(
                ErrorCode::NotFound,
                format!("no terminal session {id}"),
            ));
        };
        let mut input = lock(&sess.input);
        if input.is_none() {
            *input = Some(Input::start(
                self.mgr.clone(),
                id,
                self.inputs.clone(),
                &self.opts.caps,
            )?);
        }
        input.as_ref().expect("just made").queue(data)
    }

    /// `pty.write`: the bytes go through the session's own input thread
    /// (`Input`); the answer waits at most [`Caps::pty_write_timeout`] for
    /// them to go in.
    pub(crate) async fn pty_write(&self, p: PtyWriteParams) -> Outcome {
        // The one caller of `pty_input` (clippy.toml).
        #[allow(clippy::disallowed_methods)]
        let done = self.pty_input(p.id, p.data)?;
        let limit = self.opts.caps.pty_write_timeout;
        match tokio::time::timeout(limit, done).await {
            Ok(Ok(Ok(()))) => ok(&Empty),
            Ok(Ok(Err(e))) => Err(pty_err(self, p.id, e)),
            Ok(Err(_)) => Err(err(ErrorCode::Io, "the terminal's input is closed")),
            Err(_) => Err(err(
                ErrorCode::Timeout,
                format!(
                    "terminal session {} has not read its input for {}s; the bytes stay queued",
                    p.id,
                    limit.as_secs()
                ),
            )),
        }
    }

    /// Kill every session. Bounded (santree-pty gives up after ~2s).
    pub fn close_all(&self) {
        // Gates first: nothing more goes out for a host closing down, and a
        // session paced on a slow receiver stops waiting at once.
        for (_, sess) in lock(&self.sessions).drain() {
            sess.swap_gate(None);
        }
        self.mgr.close_all();
        self.touch();
    }

    /// Kill one session. Its gate is not retired: it delivers what the
    /// process printed last and then `pty.exit`, the receiver's word that the
    /// close took effect (a setup run's Stop waits for it). A gate paced on a
    /// slow receiver holds up only that delivery, never the kill.
    pub fn close_session(&self, id: SessionId) {
        let _ = self.mgr.close(id);
        lock(&self.sessions).remove(&id);
        self.touch();
    }

    /// PTY sessions whose process is still running.
    pub fn live_sessions(&self) -> usize {
        self.mgr.sessions().iter().filter(|s| s.alive).count()
    }

    /// PTY sessions held: live, or exited and not yet closed or reaped —
    /// each of those still holds how it ended, for a client to read.
    pub fn held_sessions(&self) -> usize {
        self.mgr.sessions().len()
    }

    /// Close the sessions that have been exited and unattached for `after`.
    pub fn reap(&self, after: Duration) {
        let now = Instant::now();
        let dead: Vec<SessionId> = self
            .mgr
            .sessions()
            .into_iter()
            .filter(|s| !s.alive)
            .map(|s| s.id)
            .collect();
        let mut expired = Vec::new();
        for (id, sess) in lock(&self.sessions).iter() {
            let mut live = lock(&sess.live);
            if !dead.contains(id) || live.route.is_some() {
                live.idle_dead_since = None;
                continue;
            }
            let since = *live.idle_dead_since.get_or_insert(now);
            if now.duration_since(since) >= after {
                expired.push(*id);
            }
        }
        for id in expired {
            self.close_session(id);
            log::info!(
                "closed pty session {id}: exited and unattached for {}s",
                after.as_secs()
            );
        }
    }

    pub(crate) fn session(&self, id: SessionId) -> Option<Arc<SessState>> {
        lock(&self.sessions).get(&id).cloned()
    }

    pub(crate) fn infos(&self, infos: Vec<santree_pty::SessionInfo>) -> Vec<SessionInfo> {
        let sessions = lock(&self.sessions);
        infos
            .into_iter()
            .map(|info| SessionInfo {
                attached: sessions
                    .get(&info.id)
                    .is_some_and(|s| lock(&s.live).route.is_some()),
                id: info.id,
                pid: info.pid,
                cwd: info.cwd,
                command: info.command,
                owner: info.owner,
                label: info.label,
                agent_kind: info.agent_kind,
                cols: info.cols,
                rows: info.rows,
                alive: info.alive,
                epoch: info.epoch,
            })
            .collect()
    }

    pub(crate) fn info(&self, id: SessionId) -> Option<SessionInfo> {
        let all = self.mgr.sessions();
        self.infos(all).into_iter().find(|info| info.id == id)
    }

    pub(crate) fn pty_open(&self, p: PtyOpenParams) -> Outcome {
        check_env(&p.env, "env")?;
        check_env(&p.base_env, "baseEnv")?;
        if self.opts.require_base_env && p.base_env.is_empty() {
            return Err(err(ErrorCode::BadRequest, "baseEnv is required"));
        }
        let cwd = self.confine.pty_cwd(p.cwd.as_deref())?;
        let _one = lock(&self.opening);
        let max = self.opts.caps.max_ptys;
        if self.mgr.sessions().len() >= max {
            return Err(busy(format!(
                "{max} terminal sessions are open; close one first"
            )));
        }
        let base_env = session_base_env(p.base_env, &self.opts.env);
        let sess = Arc::new(SessState::new(self.changed.clone()));
        // The host's one PTY spawn: a `pty.open` request (clippy.toml).
        #[allow(clippy::disallowed_methods)]
        let id = self
            .mgr
            .open(
                OpenOpts {
                    cwd,
                    command: p.command,
                    args: p.args,
                    cols: p.cols,
                    rows: p.rows,
                    base_env,
                    env: p.env,
                    owner: p.owner,
                    label: p.label,
                    agent_kind: p.agent_kind,
                },
                parked_sink(sess.clone()),
            )
            .map_err(|e| err(ErrorCode::Io, format!("{e:#}")))?;
        lock(&self.sessions).insert(id, sess);
        self.touch();
        match self.info(id) {
            Some(info) => ok(&info),
            None => Err(err(ErrorCode::NotFound, format!("session {id} vanished"))),
        }
    }

    pub(crate) fn pty_attach(&self, conn: &Conn, req_id: u64, p: PtyAttachParams) -> Reply {
        let Some(sess) = self.session(p.id) else {
            return Reply::Answer(Err(err(
                ErrorCode::NotFound,
                format!("no terminal session {}", p.id),
            )));
        };
        let _serial = lock(&sess.attach);
        let gate = Arc::new(Gate {
            id: p.id,
            out: conn.out.clone(),
            st: Mutex::new(GateState::default()),
            retired: AtomicBool::new(false),
        });
        // Before the sink is swapped: a chunk the old receiver is pacing gives
        // way now instead of after its connection drains.
        sess.swap_gate(Some(gate.clone()));
        let sink = {
            let gate = gate.clone();
            let sess = sess.clone();
            move |bytes: Vec<u8>| {
                if bytes.is_empty() {
                    sess.mark_ended();
                }
                gate.deliver(bytes);
            }
        };
        let anchor = match p.anchor {
            Anchor::At { epoch, seq } => santree_pty::Anchor::At { epoch, seq },
            Anchor::Fresh => santree_pty::Anchor::Fresh,
            Anchor::Unknown => santree_pty::Anchor::Unknown,
        };
        let replay = match self.mgr.attach(p.id, &anchor, sink) {
            Ok(replay) => replay,
            Err(e) => return Reply::Answer(Err(pty_err(self, p.id, format!("{e:#}")))),
        };
        let maybe_lost = {
            let mut live = lock(&sess.live);
            live.route = Some(conn.id);
            live.sentinel_maybe_lost
        };
        // Asked before the gate is locked: `sessions()` takes the manager's
        // sink locks.
        let dead = maybe_lost
            && self
                .mgr
                .sessions()
                .iter()
                .any(|info| info.id == p.id && !info.alive);

        let result = AttachResult {
            mode: match replay.mode {
                santree_pty::ReplayMode::Exact => ReplayMode::Exact,
                santree_pty::ReplayMode::Tail => ReplayMode::Tail,
                santree_pty::ReplayMode::Reanchor => ReplayMode::Reanchor,
            },
            epoch: replay.epoch,
            seq: replay.seq,
            data: replay.bytes,
        };
        {
            let mut st = lock(&gate.st);
            conn.out
                .send(encode_ok(req_id, &result).expect("attach results serialize"));
            for bytes in std::mem::take(&mut st.pending) {
                gate.emit(&mut st, bytes);
            }
            st.open = true;
            if lock(&sess.live).ended || dead {
                gate.emit(&mut st, Vec::new());
            }
        }
        log::debug!("connection {}: pty.attach #{req_id} ok", conn.id);
        self.touch();
        Reply::Done
    }

    /// Detach a session into the parked state — only when `only_conn` (if
    /// given) is still its receiver.
    pub(crate) fn park(&self, id: SessionId, sess: &Arc<SessState>, only_conn: Option<u64>) {
        let _serial = lock(&sess.attach);
        {
            let mut live = lock(&sess.live);
            if live.route.is_none() || only_conn.is_some_and(|c| live.route != Some(c)) {
                return;
            }
            live.route = None;
        }
        sess.swap_gate(None);
        let _ = self
            .mgr
            .attach(id, &santree_pty::Anchor::Unknown, parked_sink(sess.clone()));
        self.touch();
    }

    pub(crate) fn pty_adopt(&self, owner: &str) -> Outcome {
        let adopted = self.mgr.adopt_others(owner);
        let live: Vec<SessionId> = self.mgr.sessions().iter().map(|s| s.id).collect();
        {
            let mut sessions = lock(&self.sessions);
            // Superseded duplicates were closed by the manager.
            sessions.retain(|id, sess| {
                let keep = live.contains(id);
                if !keep {
                    sess.swap_gate(None);
                }
                keep
            });
        }
        for info in &adopted {
            if let Some(sess) = self.session(info.id) {
                let _serial = lock(&sess.attach);
                {
                    let mut live = lock(&sess.live);
                    live.route = None;
                    live.sentinel_maybe_lost = true;
                }
                sess.swap_gate(None);
                let _ = self.mgr.attach(
                    info.id,
                    &santree_pty::Anchor::Unknown,
                    parked_sink(sess.clone()),
                );
            }
        }
        self.touch();
        ok(&self.infos(adopted))
    }
}

pub(crate) fn pty_err(host: &Host, id: SessionId, e: impl std::fmt::Display) -> WireError {
    let known = lock(&host.sessions).contains_key(&id);
    err(
        if known {
            ErrorCode::Io
        } else {
            ErrorCode::NotFound
        },
        e.to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// After `retire` returns, the gate sends nothing: not a chunk that had
    /// passed its checks and was waiting on the gate's state when the swap
    /// came, which would land after the new attach's reply on the same
    /// connection and repeat what that reply's replay already holds.
    #[test]
    fn a_retired_gate_emits_nothing_after_retire_returns() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let out = Out::new(1, tx, &Caps::default());
        let gate = Arc::new(Gate {
            id: 7,
            out: out.clone(),
            st: Mutex::new(GateState {
                open: true,
                ..Default::default()
            }),
            retired: AtomicBool::new(false),
        });

        // Held while a chunk gets past the checks and waits for the state.
        let st = lock(&gate.st);
        let delivering = {
            let gate = gate.clone();
            std::thread::spawn(move || gate.deliver(b"late".to_vec()))
        };
        std::thread::sleep(Duration::from_millis(200));
        let retiring = {
            let (gate, out) = (gate.clone(), out.clone());
            std::thread::spawn(move || {
                gate.retire();
                out.send("retired".into());
            })
        };
        std::thread::sleep(Duration::from_millis(200));
        drop(st);
        delivering.join().unwrap();
        retiring.join().unwrap();
        gate.deliver(Vec::new());

        let mut lines = Vec::new();
        while let Ok(line) = rx.try_recv() {
            lines.push(line);
        }
        let retired_at = lines.iter().position(|l| l == "retired").unwrap();
        assert_eq!(
            lines.len(),
            retired_at + 1,
            "the retired gate sent {:?} after retiring",
            &lines[retired_at + 1..]
        );
    }
}
