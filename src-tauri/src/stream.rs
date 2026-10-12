//! Run a long command in the background and stream its output to a read-only view.
//!
//! The shape every caller wants: kick off a setup script, watch it live, stop it,
//! and keep the output afterwards — *without* handing the user an interactive
//! shell. That's deliberately not a tab: a tab is a PTY the user types into,
//! whose lifetime is the tab's. Here the process is a pane nobody types into, the
//! view is read-only, and the frontend keeps the transcript after it exits.
//!
//! **The process is a terminal pane.** A run is opened through [`RunHost`] — the
//! terminal adapter's handle on the same facade every terminal uses — so on a
//! build with the local santree server its PTY lives *in the server* and outlives
//! a quit, a crash or an update, exactly as an agent's does; without one it is an
//! in-app PTY and ends with the app. This module never knows which (docs/server.md,
//! "Setup runs"): no branch on the backend lives here, and a run writes nothing
//! into its PTY.
//!
//! **A run outlives the app the way a pane does, and no further.** A run is a
//! pane labelled `run:<key>#<id>` (unique per run, so a leftover process of an
//! older run can never be mistaken for a new one) whose script ends by leaving
//! its exit code in a status file — the host has no exit status to read
//! (`pty.exitStatus` is not built), and the same wrapper does the job on the box
//! for a Daedalus project. While this process follows it, a run has its Stop,
//! its [`DEADLINE`] and its result. A run that is still going when the app quits
//! keeps running on the local server and is not followed again: it is listed in
//! Settings → Terminal, where it can be ended, and a new run of its key is
//! refused while it lives (the caller asks [`RunHost::any_live`]).
//!
//! Output is streamed as raw PTY **chunks**, escape codes and all, so the view can
//! render exactly what the tool printed (colours, progress redraws). Why a PTY
//! rather than pipes: nearly every build tool block-buffers its output and turns
//! colour off when stdout isn't a TTY.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use anyhow::Result;
use futures::future::BoxFuture;
use serde::Serialize;
use specta::Type;
use tokio::sync::{mpsc, watch};

use crate::sessions::{PaneId, PaneLink, Sinks};

/// A backstop against a command that will *never* finish (waiting on stdin nobody
/// can answer, a wedged network mount) — not a performance budget. Stop is the
/// normal way out. Generous: a cold `cargo build --release` is genuinely slow.
///
/// It is the app that enforces it, from when this process started the run: a
/// run still going when the app quits has none after that (it is ended from
/// Settings → Terminal). A timer in the server would need a protocol feature and
/// a server revision for a backstop. Shared with the Daedalus runs
/// (`daedalus::setup`).
///
/// It is also, unavoidably, how long a *wedged* run looks like a hang: an hour
/// reads as "forever" to anyone watching. See [`pty_guard`] for the test-side
/// consequence.
#[cfg(not(test))]
pub(crate) const DEADLINE: Duration = Duration::from_secs(60 * 60);

/// Under test the backstop is seconds, not an hour.
///
/// A test run has no `cargo build --release` to wait for, and inheriting the
/// production hour is what turned one contended PTY into a **3604-second suite**:
/// the wedged run sat until the deadline holding [`pty_guard`], and every later
/// PTY test queued behind it — then failed on its own 20s timeout, an hour after
/// anyone could have connected the two. Serializing these tests is what makes the
/// backstop load-bearing, so the two constants belong together: a wedge now costs
/// half a minute and names itself.
#[cfg(test)]
pub(crate) const DEADLINE: Duration = Duration::from_secs(30);

/// Serializes every test in this crate that allocates a real PTY.
///
/// The pty table is a small, machine-wide resource (`kern.tty.ptmx_max` is 511 on
/// macOS) and cargo runs tests on one thread per core, so a suite that forks a
/// shell per test contends with itself *and* with everything else on the box — a
/// dev app with terminals open, other agents' builds, a stray pool of CLI
/// processes. `crates/pty` hit exactly this and took the same fix; these tests are
/// the second population of PTY allocators in the workspace and had no guard.
///
/// The symptom is load-dependent and does not reproduce on an idle machine, which
/// is what makes it expensive to diagnose twice. So this bounds how many of these
/// can be in flight at once. The hang it prevents
/// is contention, not a deadlock — but the guard could introduce a real one, which
/// is why it is async:
///
/// A `tokio::sync::Mutex`, not a `std` one: every holder awaits the PTY run it is
/// serializing, and a `std` guard held across an `await` can park the runtime
/// thread with the lock still held — the deadlock this guard exists to avoid,
/// reintroduced by the guard itself. It also drops `std`'s poisoning, which is
/// what we want here anyway: one panicking test must not cascade into every later
/// test reporting the same unrelated failure.
#[cfg(test)]
pub(crate) async fn pty_guard() -> tokio::sync::MutexGuard<'static, ()> {
    SERIAL.lock().await
}

#[cfg(test)]
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The grid a run *starts* on, before any pane has reported its width — a run can be
/// kicked off with its pane hidden or not yet mounted, so there's nothing to measure
/// at spawn time. Once a pane is showing the run it re-grids it (see [`Runs::resize`])
/// and this stops mattering. 120 is wide enough that a build watched entirely from a
/// closed tab still reads correctly.
pub const COLS: u16 = 120;
pub const ROWS: u16 = 40;

/// What a run's PTY is labelled with: the prefix that keeps a run apart from
/// every terminal tab, investigation and review (`tree:`, `triage:`, `ai-review:`,
/// `login:`). Nothing else may open a pane under it, and a page adopting what an
/// earlier page left running is never handed one (see [`is_run_label`]).
pub const LABEL_PREFIX: &str = "run:";

/// The label of the run `run_id` of `key`: unique per run on purpose. A stable
/// label per key would let a new run's open *claim* a leftover live process of a
/// stopped one (the facade hands an address's session to whoever asks for it) and
/// follow a script that is not its own.
pub fn run_label(key: &str, run_id: &str) -> String {
    format!("{LABEL_PREFIX}{key}#{run_id}")
}

/// Whether a pane's label names a run rather than a terminal.
pub fn is_run_label(label: &str) -> bool {
    label.starts_with(LABEL_PREFIX)
}

/// A streamed run event. `Chunk` is raw PTY output — arbitrary bytes as they
/// arrive, *not* line-aligned and with escape sequences intact; the view feeds it
/// to a terminal emulator verbatim. `Done` reports the exit status.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum StreamEvent {
    Chunk { text: String },
    Done { ok: bool },
}

/// Where a run's output goes: whole UTF-8, as it arrives.
pub type Text = Arc<dyn Fn(String) + Send + Sync>;

/// What a run is started with.
#[derive(Clone)]
pub struct Launch {
    /// The pane's label ([`run_label`]).
    pub label: String,
    /// The directory it runs in, on this Mac.
    pub cwd: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Where the script's exit code is left ([`WRAPPER`]).
    pub status: String,
}

/// The env by name only: its values are the project's environment, which can
/// hold secrets, and a launch ends up in the log.
impl std::fmt::Debug for Launch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Launch")
            .field("label", &self.label)
            .field("cwd", &self.cwd)
            .field("command", &self.command)
            .field("args", &self.args)
            .field("env", &self.env.iter().map(|(k, _)| k).collect::<Vec<_>>())
            .field("status", &self.status)
            .finish()
    }
}

/// What the PTY runs: the script as `$0`, its status file as `$1`. The status
/// is written only when the script ends on its own; a killed run leaves none,
/// which reads as a failure. The Daedalus runs use the same one.
pub(crate) const WRAPPER: &str = r#""$0"; s=$?; printf '%s' "$s" > "$1"; exit "$s""#;

impl Launch {
    /// `script` run to completion under a login shell, its exit code left in
    /// `status`. A command *line* under `bash -lc` rather than the script
    /// alone: these are developer scripts that want the login shell's PATH —
    /// `pnpm` from a version manager, `cargo` from rustup, whatever direnv/nix
    /// put there. Nothing here is IPC-supplied; every caller builds its own
    /// literal.
    ///
    /// `env` is the project's environment and santree's own variables; the
    /// colour-capable `TERM` goes last — this is why we bothered with a PTY.
    /// Deliberately *not* `COLUMNS`: it's a snapshot taken at spawn, and a
    /// `SIGWINCH` can't update it. A tool that prefers the env var over the tty's
    /// own size would stay pinned to the starting grid for the whole run, which
    /// is exactly the behaviour [`Runs::resize`] exists to remove.
    pub fn script(
        label: String,
        cwd: &Path,
        script: &Path,
        status: &str,
        mut env: Vec<(String, String)>,
    ) -> Self {
        env.push(("TERM".into(), "xterm-256color".into()));
        Self {
            label,
            cwd: cwd.to_string_lossy().into_owned(),
            command: "/bin/bash".into(),
            args: vec![
                "-lc".into(),
                WRAPPER.into(),
                script.to_string_lossy().into_owned(),
                status.to_string(),
            ],
            env,
            status: status.to_string(),
        }
    }
}

/// The terminals a run is a pane of. Implemented by the terminal adapter over the
/// facade (`terminal::TerminalRuns`); defined here so this module — which must
/// not name the facade — and its tests need no real one.
pub trait RunHost: Send + Sync {
    /// Start `launch` as a pane on this Mac. Its output, and an empty chunk when
    /// it exits, go to `sinks`.
    fn open(&self, launch: Launch, size: (u16, u16), sinks: Sinks)
        -> BoxFuture<'_, Result<PaneId>>;

    /// Whether a pane whose label starts with `prefix` has a live process:
    /// `None` when the host can't say in full (`Liveness::knows`).
    fn any_live(&self, prefix: &str) -> BoxFuture<'_, Option<bool>>;

    /// End the pane's process, as soon as its host can be told.
    fn close(&self, pane: PaneId);

    /// Re-grid the pane's PTY; whether there was a pane to re-grid.
    fn resize(&self, pane: PaneId, cols: u16, rows: u16) -> bool;
}

/// The commands running right now, keyed by an opaque caller-chosen string (setup
/// keys by repo+issue). A process-wide singleton rather than Tauri state, because
/// a run's task outlives any borrow.
///
/// This is the exclusivity within this process: one run per key, claimed before
/// anything is started.
pub static RUNS: LazyLock<Runs> = LazyLock::new(Runs::default);

/// One registered run. The pane exists a moment *after* the slot is claimed, but
/// the `id` names the run for its whole life, which is what keeps a finished run
/// from evicting the entry of a newer one started under the same key.
struct Run {
    id: u64,
    /// The pane and the host that can end or re-grid it, once it exists.
    pane: Option<(Arc<dyn RunHost>, PaneId)>,
    /// Flipped to `true` when the run is stopped, so a task parked on something
    /// else (an open that hasn't returned) learns of it.
    stop: watch::Sender<bool>,
}

/// A claimed "something is running under this key" slot, held for one run's lifetime.
///
/// Claiming is the check *and* the insert under a single lock: a `contains`-then-
/// `insert` split let two calls both get past the guard and stack two processes over
/// the same directory. Dropping the guard frees the slot on every path out of a run —
/// a failed open, an early return, a panic — so a slot can't leak and wedge the view
/// at "already running" forever.
pub struct Slot {
    /// The registry to release back into. Held rather than assumed to be the
    /// [`RUNS`] singleton so the registry's exclusion and identity rules can be
    /// tested against a private instance instead of process-wide shared state.
    runs: Arc<Registry>,
    key: String,
    id: u64,
    stop: watch::Receiver<bool>,
}

impl Slot {
    /// Hand the run's pane to its slot. `false` when the slot is already gone —
    /// a Stop (or a removal) landed between the reserve and the open — and the
    /// caller must then end the pane it just started, since nothing else holds a
    /// handle on it.
    fn attach(&self, host: &Arc<dyn RunHost>, pane: PaneId) -> bool {
        let mut runs = self.runs.lock();
        match runs.get_mut(&self.key) {
            Some(run) if run.id == self.id => {
                run.pane = Some((host.clone(), pane));
                true
            }
            _ => false,
        }
    }

    #[cfg(test)]
    pub(crate) fn attach_for_test(&self, host: &Arc<dyn RunHost>, pane: PaneId) -> bool {
        self.attach(host, pane)
    }

    /// Resolves when the run is stopped; never when it simply ends.
    async fn stopped(&self) {
        let mut stop = self.stop.clone();
        if stop.wait_for(|stopped| *stopped).await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.runs.release(self);
    }
}

#[derive(Default)]
pub struct Runs {
    registry: Arc<Registry>,
}

#[derive(Default)]
struct Registry {
    runs: Mutex<HashMap<String, Run>>,
    next_id: AtomicU64,
}

impl Registry {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Run>> {
        self.runs.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Free a finished run's slot — but only when it's still *that* run's. A cancel
    /// followed by a re-run puts a newer run under the same key, and an identity-less
    /// remove would evict it: its process would then be unkillable.
    fn release(&self, slot: &Slot) {
        let mut runs = self.lock();
        if runs.get(&slot.key).is_some_and(|run| run.id == slot.id) {
            runs.remove(&slot.key);
        }
    }
}

impl Runs {
    /// Claim the slot for `key`, or `None` when something is already running under
    /// it — re-running would stack a second process over the same directory.
    pub fn reserve(&self, key: &str) -> Option<Slot> {
        let mut runs = self.registry.lock();
        if runs.contains_key(key) {
            return None;
        }
        let id = self.registry.next_id.fetch_add(1, Ordering::Relaxed);
        let (stop, stopped) = watch::channel(false);
        runs.insert(
            key.to_string(),
            Run {
                id,
                pane: None,
                stop,
            },
        );
        Some(Slot {
            runs: self.registry.clone(),
            key: key.to_string(),
            id,
            stop: stopped,
        })
    }

    /// Whether `pane` is some run's. A run's pane is the app's own: no page may
    /// attach, detach, write to or re-grid it, which would take its output from
    /// the task following it.
    pub fn owns(&self, pane: PaneId) -> bool {
        self.registry
            .lock()
            .values()
            .any(|run| run.pane.as_ref().is_some_and(|(_, id)| *id == pane))
    }

    /// Whether a run is currently registered under `key`.
    #[cfg(test)]
    pub fn is_running(&self, key: &str) -> bool {
        self.registry.lock().contains_key(key)
    }

    /// Re-grid a running command's PTY to match the pane showing it.
    ///
    /// This is the half xterm can't do for us. The view reflows its *existing* lines
    /// on its own (nothing hard-wrapped them — the tool emits long lines whole and
    /// the terminal wraps at render time), but a tool still drawing progress bars
    /// sizes them to the width the kernel reports, so without this the live output
    /// keeps arriving laid out for the old grid.
    ///
    /// `false` when no run is registered under `key` — the pane outlives the run, so
    /// a resize after a build finishes is expected, not an error.
    pub fn resize(&self, key: &str, cols: u16, rows: u16) -> bool {
        let target = self
            .registry
            .lock()
            .get(key)
            .and_then(|run| run.pane.clone());
        let Some((host, pane)) = target else {
            return false;
        };
        // A zero dimension is a degenerate grid some tools divide by; the pane can
        // briefly measure one while it's laying out.
        host.resize(pane, cols.max(1), rows.max(1))
    }

    /// Stop one running command. Its pane is closed and the run finishes as a
    /// failure, so the view leaves "running" on its own.
    ///
    /// A run that has no pane *yet* (still starting) keeps its slot: its
    /// process may be about to exist, and freeing the key would let a second
    /// script start over it. It is only flagged stopped, and the task starting
    /// it closes the pane the moment it has one, then frees the key.
    pub fn cancel(&self, key: &str) -> bool {
        let mut runs = self.registry.lock();
        let Some(run) = runs.get(key) else {
            return false;
        };
        run.stop.send_replace(true);
        if run.pane.is_none() {
            return true;
        }
        let run = runs.remove(key);
        drop(runs);
        if let Some((host, pane)) = run.and_then(|run| run.pane) {
            host.close(pane);
        }
        true
    }
}

/// What the run's pane tells the task following it.
enum Signal {
    /// The process exited (the empty chunk).
    Exit,
    Link(PaneLink),
}

/// The sinks of a run's pane: output to `on_text` as whole UTF-8, and the pane's
/// own news to `signals`.
///
/// `carry` holds a trailing partial UTF-8 sequence: a read can split a multi-byte
/// character (and does, on the box-drawing and emoji build tools print), and
/// decoding each read independently would emit a replacement char for each half.
///
/// These run inside the pane's own lock, so they only forward: no await, no
/// call back into the terminals.
fn sinks(on_text: Text, signals: mpsc::UnboundedSender<Signal>) -> Sinks {
    let carry = Arc::new(Mutex::new(Vec::<u8>::new()));
    let output = {
        let (on_text, signals) = (on_text, signals.clone());
        Arc::new(move |bytes: Vec<u8>| {
            let mut carry = carry.lock().unwrap_or_else(|e| e.into_inner());
            if bytes.is_empty() {
                if !carry.is_empty() {
                    // EOF with an incomplete sequence still pending — emit it
                    // lossily rather than dropping the tail of the output.
                    on_text(String::from_utf8_lossy(&carry).into_owned());
                    carry.clear();
                }
                let _ = signals.send(Signal::Exit);
                return;
            }
            carry.extend_from_slice(&bytes);
            let text = take_utf8(&mut carry);
            if !text.is_empty() {
                on_text(text);
            }
        })
    };
    let link = Arc::new(move |link: PaneLink| {
        let _ = signals.send(Signal::Link(link));
    });
    Sinks { output, link }
}

/// The exit code a finished run left in its status file. `None` when there is
/// none — the run was stopped or killed, hasn't ended, or the write is mid-flight.
async fn read_status(path: &str) -> Option<i32> {
    tokio::fs::read_to_string(path)
        .await
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// Start `launch` and follow it to its end; whether the script exited 0. The
/// slot must already be claimed ([`Runs::reserve`]); it's released when this
/// returns.
pub async fn start(host: &Arc<dyn RunHost>, slot: Slot, launch: Launch, on_text: Text) -> bool {
    let status = launch.status.clone();
    let (tx, signals) = mpsc::unbounded_channel();
    let pane = match host
        .open(launch, (COLS, ROWS), sinks(on_text.clone(), tx))
        .await
    {
        Ok(pane) => pane,
        Err(e) => {
            on_text(format!("failed to start: {e:#}\r\n"));
            return false;
        }
    };
    // A Stop can land between claiming the slot and getting here — the registry
    // then holds nothing that could end this pane, so end it ourselves.
    if !slot.attach(host, pane) {
        host.close(pane);
        return false;
    }
    match follow(host, &slot, pane, signals, &status, &on_text).await {
        Some(ok) => ok,
        // The pane stopped reporting without an exit: it was closed from
        // elsewhere (Settings → Terminal). Whatever the script left is the
        // answer; a process still alive would refuse the next run of the key
        // (`RunHost::any_live`), so freeing the slot here is safe.
        None => read_status(&status).await == Some(0),
    }
}

/// Follow an attached pane until its process is over: `Some(true)` when the
/// script exited 0, `Some(false)` when it didn't, `None` when the pane stopped
/// reporting without ending — that is not an exit, and the caller decides.
///
/// Neither a dropped link nor a slow host ends a run: the pane re-attaches from
/// its anchor on its own (nothing is lost), and what is concluded is only ever
/// what the process did — its exit, the host that held it being gone, a Stop, or
/// the [`DEADLINE`]. A Stop is looked at first, so it wins a race with an exit.
async fn follow(
    host: &Arc<dyn RunHost>,
    slot: &Slot,
    pane: PaneId,
    mut signals: mpsc::UnboundedReceiver<Signal>,
    status: &str,
    on_text: &Text,
) -> Option<bool> {
    let timer = tokio::time::sleep(DEADLINE);
    tokio::pin!(timer);
    let mut link = PaneLink::Live;
    let mut expired = false;
    loop {
        tokio::select! {
            biased;
            () = slot.stopped() => {
                // Idempotent when the Stop already closed it (and the only close
                // there is when the pane was found after the Stop).
                host.close(pane);
                return Some(false);
            }
            signal = signals.recv() => match signal {
                Some(Signal::Link(PaneLink::Lost)) => {
                    // The host that held it is gone, and the process with it.
                    let code = read_status(status).await;
                    if code.is_none() {
                        on_text("\r\nThe santree server this run was on is gone; the run ended with it.\r\n".into());
                    }
                    return Some(code == Some(0));
                }
                // It exited: the code, if the script got that far, is the answer.
                Some(Signal::Exit) => return Some(read_status(status).await == Some(0)),
                // Every sink of the pane is gone with nothing said: a page took
                // it, or it was closed from elsewhere.
                None => return None,
                Some(Signal::Link(now)) => {
                    link = now;
                    if expired && link == PaneLink::Live {
                        host.close(pane);
                        return Some(read_status(status).await == Some(0));
                    }
                }
            },
            () = &mut timer, if !expired => {
                expired = true;
                log::warn!("setup run exceeded {}s — stopping it", DEADLINE.as_secs());
                // Ending it is a message to the host: with the link down it
                // cannot be sent, so wait for the link rather than conclude.
                if link == PaneLink::Live {
                    host.close(pane);
                    // It may have finished in the same breath.
                    return Some(read_status(status).await == Some(0));
                }
            }
        }
    }
}

/// Split off everything in `buf` that forms complete UTF-8, leaving a trailing
/// partial sequence behind for the next read to complete. Invalid bytes (not merely
/// incomplete ones) are replaced rather than held forever — a tool emitting binary
/// junk must not wedge the stream.
pub(crate) fn take_utf8(buf: &mut Vec<u8>) -> String {
    match std::str::from_utf8(buf) {
        Ok(s) => {
            let out = s.to_string();
            buf.clear();
            out
        }
        Err(e) => {
            let good = e.valid_up_to();
            // `None` ⇒ the bytes after `good` are the start of a valid sequence that
            // simply hasn't all arrived; keep them. `Some` ⇒ genuinely invalid, so
            // consume one byte as a replacement char and let the next call retry.
            let take = match e.error_len() {
                None => good,
                Some(bad) => good + bad,
            };
            let out = String::from_utf8_lossy(&buf[..take]).into_owned();
            buf.drain(..take);
            out
        }
    }
}

/// A scripted [`RunHost`] for tests of the runs and of what settles them.
#[cfg(test)]
pub(crate) mod fake {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    /// A host that does what a test tells it to: it answers `any_live` with a
    /// scripted answer, keeps the sinks it was given (so a test can play the
    /// pane's output, link and exit) and records what it was asked to close
    /// and re-grid.
    pub(crate) struct FakeHost {
        pub live: Mutex<Option<bool>>,
        pub sinks: Mutex<Option<Sinks>>,
        pub closed: Mutex<Vec<PaneId>>,
        pub resized: Mutex<Vec<(PaneId, u16, u16)>>,
        pub opened: AtomicUsize,
    }

    /// The pane id every open of a [`FakeHost`] answers.
    pub(crate) const PANE: PaneId = 3;

    impl FakeHost {
        pub fn new() -> Arc<Self> {
            Arc::new(Self {
                live: Mutex::new(Some(false)),
                sinks: Mutex::new(None),
                closed: Mutex::default(),
                resized: Mutex::default(),
                opened: AtomicUsize::new(0),
            })
        }

        /// What `any_live` answers from now on.
        pub fn set_live(&self, live: Option<bool>) {
            *self.live.lock().unwrap() = live;
        }

        /// The pane's side of its sinks, once something attached.
        pub fn pane(&self) -> Sinks {
            self.sinks.lock().unwrap().clone().expect("a pane attached")
        }

        pub fn closed(&self) -> Vec<PaneId> {
            self.closed.lock().unwrap().clone()
        }

        /// Wait until a run has opened its pane here.
        pub async fn attached(&self) {
            tokio::time::timeout(Duration::from_secs(5), async {
                while self.sinks.lock().unwrap().is_none() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("the run opened its pane");
        }
    }

    impl RunHost for FakeHost {
        fn open(&self, _: Launch, _: (u16, u16), sinks: Sinks) -> BoxFuture<'_, Result<PaneId>> {
            self.opened.fetch_add(1, Ordering::SeqCst);
            *self.sinks.lock().unwrap() = Some(sinks);
            Box::pin(async { Ok(PANE) })
        }

        fn any_live(&self, _: &str) -> BoxFuture<'_, Option<bool>> {
            let answer = *self.live.lock().unwrap();
            Box::pin(async move { answer })
        }

        fn close(&self, pane: PaneId) {
            self.closed.lock().unwrap().push(pane);
        }

        fn resize(&self, pane: PaneId, cols: u16, rows: u16) -> bool {
            self.resized.lock().unwrap().push((pane, cols, rows));
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeHost;
    use super::*;

    /// Escape codes and complete text pass through untouched; a multibyte char
    /// split across reads is held until it completes; and a genuinely invalid
    /// byte is consumed, not mistaken for an incomplete sequence and held
    /// forever — that would stall every later chunk behind it.
    #[test]
    fn take_utf8_holds_a_split_char_and_never_stalls_on_a_bad_byte() {
        let mut buf = "\x1b[32mgreen\x1b[0m ✓\r\n".as_bytes().to_vec();
        assert_eq!(take_utf8(&mut buf), "\x1b[32mgreen\x1b[0m ✓\r\n");
        assert!(buf.is_empty());

        // "é" is 0xC3 0xA9 — arriving across two reads.
        let mut buf = b"ok \xc3".to_vec();
        assert_eq!(take_utf8(&mut buf), "ok ");
        assert_eq!(buf, b"\xc3", "the lead byte must be held, not mangled");
        buf.push(0xa9);
        assert_eq!(take_utf8(&mut buf), "é");
        assert!(buf.is_empty());

        let mut buf = b"a\xffb".to_vec();
        let out = take_utf8(&mut buf);
        assert!(out.starts_with('a'), "{out:?}");
        assert!(buf.len() < 3, "the bad byte must be consumed");
        // The rest drains on the next call rather than accumulating.
        let rest = take_utf8(&mut buf);
        assert!(buf.is_empty(), "leftover: {buf:?}");
        assert!(format!("{out}{rest}").ends_with('b'));
    }

    fn host_of(fake: &Arc<FakeHost>) -> Arc<dyn RunHost> {
        fake.clone()
    }

    /// Output collected as a run's view would get it.
    fn collector() -> (Text, Arc<Mutex<String>>) {
        let seen: Arc<Mutex<String>> = Arc::default();
        let into = seen.clone();
        (
            Arc::new(move |text| into.lock().unwrap().push_str(&text)),
            seen,
        )
    }

    /// A status file path nothing else uses, with `code` in it when given.
    fn status_file(name: &str, code: Option<&str>) -> String {
        let path =
            std::env::temp_dir().join(format!("santree-stream-{name}-{}", std::process::id()));
        let _ = std::fs::remove_file(&path);
        if let Some(code) = code {
            std::fs::write(&path, code).unwrap();
        }
        path.to_string_lossy().into_owned()
    }

    /// A finished run must only free *its own* entry. Cancel + re-run puts a newer
    /// run under the same key; an identity-less remove evicted it, leaving a live
    /// process that neither Stop nor a resize could ever see.
    #[test]
    fn a_finished_run_never_evicts_a_newer_one() {
        let runs = Runs::default();
        let fake = FakeHost::new();
        let host = host_of(&fake);
        let old = runs.reserve("k").unwrap();
        assert!(old.attach(&host, 1));

        // Stop → the old run's pane is closed and its entry dropped, so a re-run
        // can claim.
        assert!(runs.cancel("k"));
        assert_eq!(fake.closed(), [1]);
        let new = runs.reserve("k").expect("re-run claims the free slot");
        assert!(new.attach(&host, 2));

        // The cancelled run only now notices and finishes.
        drop(old);
        assert!(
            runs.is_running("k"),
            "the re-run's slot must survive the old run's release"
        );
        assert!(runs.cancel("k"), "the re-run is still stoppable");
        assert_eq!(fake.closed(), [1, 2]);
        drop(new);
    }

    /// A pane can only re-grid a run that's actually registered — and it asks on
    /// mount, which routinely happens while looking at a *finished* build. That must
    /// be an ordinary "no", not an error the view has to special-case.
    #[test]
    fn resize_reaches_a_live_run_and_ignores_a_finished_one() {
        let runs = Runs::default();
        let fake = FakeHost::new();
        let host = host_of(&fake);
        assert!(!runs.resize("k", 200, 50), "no run under the key yet");

        let slot = runs.reserve("k").unwrap();
        assert!(
            !runs.resize("k", 200, 50),
            "reserved but not started — there's no pane to grid yet"
        );
        assert!(slot.attach(&host, 5));
        assert!(runs.resize("k", 200, 50), "a live run takes the new grid");
        assert!(runs.resize("k", 0, 0), "a degenerate grid is clamped");
        assert_eq!(*fake.resized.lock().unwrap(), [(5, 200, 50), (5, 1, 1)]);

        drop(slot);
        assert!(!runs.resize("k", 200, 50), "the run is gone");
    }

    /// Stop can land in the window between claiming the slot and opening the pane.
    /// `attach` then fails, which is how the starter learns to end what it started
    /// — nothing else holds a handle on it.
    #[test]
    fn a_slot_cancelled_before_the_pane_exists_is_stopped_when_the_pane_arrives() {
        let runs = Runs::default();
        let host = host_of(&FakeHost::new());
        let slot = runs.reserve("k").unwrap();
        assert!(runs.cancel("k"), "stopped while still starting");
        assert!(
            runs.reserve("k").is_none(),
            "still claimed until its pane is closed"
        );
        assert!(slot.attach(&host, 9), "the pane registers…");
        assert!(
            *slot.stop.borrow(),
            "…and its follower sees the Stop and closes it"
        );
    }

    /// The reason this module exists: a real run's output reaches the view with its
    /// escape codes intact, through a real PTY — so it also proves the command sees a
    /// TTY (`test -t 1`), without which most build tools turn colour off before we
    /// ever get the chance to keep it. And the exit code is what the wrapper left.
    #[tokio::test]
    async fn a_real_run_streams_colour_and_reports_success() {
        let _serial = pty_guard().await;
        let dir = std::env::temp_dir().join(format!("santree-stream-real-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("run.sh");
        std::fs::write(
            &script,
            "#!/bin/bash\ntest -t 1 && printf '\\033[32mgreen\\033[0m\\r\\n'\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        let status = dir.join("status").to_string_lossy().into_owned();

        let runs = Runs::default();
        let host = crate::terminal::test_run_host();
        let (text, seen) = collector();
        let ok = start(
            &host,
            runs.reserve("colour").unwrap(),
            Launch::script("run:colour#1".into(), &dir, &script, &status, Vec::new()),
            text,
        )
        .await;

        assert!(ok, "the command exited successfully");
        let sent = seen.lock().unwrap().clone();
        assert!(
            sent.contains("\x1b[32mgreen"),
            "colour must survive: {sent:?}"
        );
        assert_eq!(read_status(&status).await, Some(0));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── Following a run ─────────────────────────────────────────────────────

    /// A launch whose status file is `status`.
    fn launch(status: &str) -> Launch {
        Launch::script(
            "run:k#1".into(),
            Path::new("/"),
            Path::new("/bin/true"),
            status,
            Vec::new(),
        )
    }

    /// `start` over the fake, spawned, with the slot of `k` in `runs`.
    fn started(fake: &Arc<FakeHost>, runs: &Runs, status: &str) -> tokio::task::JoinHandle<bool> {
        let (host, slot, launch) = (host_of(fake), runs.reserve("k").unwrap(), launch(status));
        let (text, _) = collector();
        tokio::spawn(async move { start(&host, slot, launch, text).await })
    }

    /// A launch is logged by its env's names: the project's environment can
    /// carry secrets, and a `{:?}` must never put one in the log file.
    #[test]
    fn a_launchs_debug_names_its_env_without_values() {
        let mut launch = launch("/x/status");
        launch.env = vec![("API_TOKEN".into(), "s3cr3t-value".into())];
        let shown = format!("{launch:?}");
        assert!(shown.contains("API_TOKEN"), "{shown}");
        assert!(!shown.contains("s3cr3t-value"), "{shown}");
    }

    /// A pane that exits ends the run as its script did.
    #[tokio::test]
    async fn a_run_ends_as_its_script_did() {
        for (left, ok) in [(Some("0"), true), (Some("3"), false), (None, false)] {
            let fake = FakeHost::new();
            let runs = Runs::default();
            let status = status_file("exit", None);
            let task = started(&fake, &runs, &status);
            fake.attached().await;
            assert!(runs.reserve("k").is_none(), "one run per key");
            if let Some(code) = left {
                std::fs::write(&status, code).unwrap();
            }
            (fake.pane().output)(Vec::new());
            assert_eq!(task.await.unwrap(), ok, "{left:?}");
            assert!(runs.reserve("k").is_some(), "and the slot is free");
            let _ = std::fs::remove_file(&status);
        }
    }

    /// A host that no longer has the pane (a server that restarted) ended the
    /// process; whether it succeeded is whatever it managed to leave.
    #[tokio::test]
    async fn a_pane_lost_with_its_host_is_over() {
        for (left, ok) in [(None, false), (Some("0"), true)] {
            let fake = FakeHost::new();
            let runs = Runs::default();
            let status = status_file("lost", None);
            let task = started(&fake, &runs, &status);
            fake.attached().await;
            if let Some(code) = left {
                std::fs::write(&status, code).unwrap();
            }
            (fake.pane().link)(PaneLink::Lost);
            assert_eq!(task.await.unwrap(), ok);
            let _ = std::fs::remove_file(&status);
        }
    }

    /// The backstop stops a run that never ends, counted from its start here.
    #[tokio::test(start_paused = true)]
    async fn the_deadline_stops_a_run_that_never_ends() {
        let fake = FakeHost::new();
        let runs = Runs::default();
        let task = started(&fake, &runs, &status_file("deadline", None));
        fake.attached().await;
        tokio::time::sleep(DEADLINE - Duration::from_secs(1)).await;
        assert!(!task.is_finished() && fake.closed().is_empty());
        assert!(!task.await.unwrap());
        assert_eq!(fake.closed(), [fake::PANE], "its pane was stopped");
    }

    /// The deadline is a message to the host. With the link down it cannot be
    /// sent, so the run waits for the link instead of calling it over.
    #[tokio::test(start_paused = true)]
    async fn an_expired_run_waits_for_the_link_before_it_is_stopped() {
        let fake = FakeHost::new();
        let runs = Runs::default();
        let task = started(&fake, &runs, &status_file("deadline-link", None));
        fake.attached().await;
        let pane = fake.pane();
        (pane.link)(PaneLink::Reconnecting);
        tokio::time::sleep(DEADLINE + Duration::from_secs(1)).await;
        assert!(fake.closed().is_empty(), "nothing could be sent");
        assert!(!task.is_finished(), "and nothing was concluded");

        (pane.link)(PaneLink::Live);
        assert!(!task.await.unwrap());
        assert_eq!(fake.closed(), [fake::PANE]);
    }

    /// Stop ends a run: the pane is closed and the run is a failure.
    #[tokio::test]
    async fn stopping_a_run_closes_its_pane() {
        let fake = FakeHost::new();
        let runs = Runs::default();
        let task = started(&fake, &runs, &status_file("stop", None));
        fake.attached().await;
        // The slot learns of its pane a beat after the sinks.
        tokio::time::timeout(Duration::from_secs(5), async {
            while !runs.cancel("k") {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(!task.await.unwrap());
        assert!(fake.closed().contains(&fake::PANE));
    }

    /// A pane whose sinks were taken from it (closed from Settings → Terminal)
    /// says nothing more; the run ends as whatever its script left.
    #[tokio::test]
    async fn a_pane_that_goes_silent_ends_as_its_status_file_says() {
        for (left, ok) in [(Some("0"), true), (None, false)] {
            let fake = FakeHost::new();
            let runs = Runs::default();
            let status = status_file("silent", None);
            let task = started(&fake, &runs, &status);
            fake.attached().await;
            if let Some(code) = left {
                std::fs::write(&status, code).unwrap();
            }
            drop(fake.sinks.lock().unwrap().take());
            assert_eq!(task.await.unwrap(), ok, "{left:?}");
            let _ = std::fs::remove_file(&status);
        }
    }

    #[test]
    fn a_run_label_is_unique_per_run_and_never_a_terminal_tab() {
        let a = run_label("setup:/r:AK-1", "one");
        let b = run_label("setup:/r:AK-1", "two");
        assert_ne!(a, b, "a new run can never claim an older run's process");
        assert!(is_run_label(&a));
        for tab in [
            "tree:AK-1:tab:t1",
            "triage:AK-9",
            "ai-review:o/r#4",
            "login:claude",
        ] {
            assert!(!is_run_label(tab), "{tab}");
        }
    }
}
