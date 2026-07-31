//! Run a long command in the background and stream its output to a read-only view.
//!
//! The shape every caller wants: kick off a build / setup script, watch it live,
//! stop it, and keep the output afterwards — *without* handing the user an
//! interactive shell. That's deliberately not [`crate::terminal`]: a PTY session
//! there is a tab the user types into, whose lifetime is the tab's. Here the
//! process is owned by this module, the view is read-only, and the frontend keeps
//! the transcript after it exits.
//!
//! Output is streamed as raw PTY **chunks**, escape codes and all, so the view can
//! render exactly what the tool printed (colours, progress redraws). Callers used to
//! strip ANSI and split lines here; that threw away the colour a build's output is
//! largely made of, and each caller had to reimplement `\r` handling.
//!
//! Why a PTY rather than pipes: nearly every build tool block-buffers its output and
//! turns colour off when stdout isn't a TTY. Over a pipe `pnpm tauri build` looks
//! frozen for minutes and arrives monochrome.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, PtySize};
use serde::Serialize;
use specta::Type;
use tauri::ipc::Channel;

/// A backstop against a command that will *never* finish (waiting on stdin nobody
/// can answer, a wedged network mount) — not a performance budget. Stop is the
/// normal way out. Generous: a cold `cargo build --release` is genuinely slow.
const DEADLINE: Duration = Duration::from_secs(60 * 60);

/// The PTY grid every run gets. Fixed rather than fitted to the pane: the pane can
/// be hidden (or not yet mounted) when a run starts, and a build's output is wrapped
/// once, at write time — a later resize can't rewrap it. 120 columns is wide enough
/// for cargo/vite output to lay out as intended, and the view pins its own grid to
/// the same width so the wrapping it renders is the wrapping the tool chose.
pub const COLS: u16 = 120;
const ROWS: u16 = 40;

/// A streamed run event. `Chunk` is raw PTY output — arbitrary bytes as they
/// arrive, *not* line-aligned and with escape sequences intact; the view feeds it
/// to a terminal emulator verbatim. `Done` reports the exit status.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum StreamEvent {
    Chunk { text: String },
    Done { ok: bool },
}

/// The commands running right now, keyed by an opaque caller-chosen string (setup
/// keys by repo+issue, the dev build by checkout path). A process-wide singleton
/// rather than Tauri state, because the blocking reader thread outlives any borrow.
///
/// Without this registry nothing can see the child: quitting mid-run orphans the
/// command and everything it spawned, a hung run pins a blocking-pool thread with no
/// way to recover, and the view sits at "running" forever.
pub static RUNS: LazyLock<Runs> = LazyLock::new(Runs::default);

/// One registered run. The child is spawned on the blocking pool a moment *after*
/// the slot is claimed, so the killer arrives late — but the `id` names the run for
/// its whole life, which is what keeps a finished run from evicting the entry of a
/// newer one started under the same key.
struct Run {
    id: u64,
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
}

/// A claimed "something is running under this key" slot, held for one run's lifetime.
///
/// Claiming is the check *and* the insert under a single lock: a `contains`-then-
/// `insert` split let two calls both get past the guard and stack two processes over
/// the same directory. Dropping the guard frees the slot on every path out of a run —
/// a failed PTY alloc, an early return, a panic on the blocking pool — so a slot
/// can't leak and wedge the view at "already running" forever.
pub struct Slot<'a> {
    /// The registry to release back into. Borrowed rather than assumed to be the
    /// [`RUNS`] singleton so the registry's exclusion and identity rules can be
    /// tested against a private instance instead of process-wide shared state.
    runs: &'a Runs,
    key: String,
    id: u64,
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.runs.release(self);
    }
}

#[derive(Default)]
pub struct Runs {
    runs: Mutex<HashMap<String, Run>>,
    next_id: AtomicU64,
}

impl Runs {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Run>> {
        self.runs.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Claim the slot for `key`, or `None` when something is already running under
    /// it — re-running would stack a second process over the same directory.
    pub fn reserve(&self, key: &str) -> Option<Slot<'_>> {
        let mut runs = self.lock();
        if runs.contains_key(key) {
            return None;
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        runs.insert(key.to_string(), Run { id, killer: None });
        Some(Slot {
            runs: self,
            key: key.to_string(),
            id,
        })
    }

    /// Whether a run is currently registered under `key`.
    #[cfg(test)]
    pub fn is_running(&self, key: &str) -> bool {
        self.lock().contains_key(key)
    }

    /// Hand the spawned child's killer to its slot. `false` when the slot is already
    /// gone — a Stop (or an app quit) landed between the reserve and the spawn — and
    /// the caller must then kill the child it just started, since nothing else holds
    /// a handle on it.
    fn attach(&self, slot: &Slot<'_>, killer: Box<dyn ChildKiller + Send + Sync>) -> bool {
        let mut runs = self.lock();
        match runs.get_mut(&slot.key) {
            Some(run) if run.id == slot.id => {
                run.killer = Some(killer);
                true
            }
            _ => false,
        }
    }

    /// Free a finished run's slot — but only when it's still *that* run's. A cancel
    /// followed by a re-run puts a newer run under the same key, and an identity-less
    /// remove would evict it: its process would then be unkillable (neither Stop nor
    /// `kill_all` on quit could see it).
    fn release(&self, slot: &Slot<'_>) {
        let mut runs = self.lock();
        if runs.get(&slot.key).is_some_and(|run| run.id == slot.id) {
            runs.remove(&slot.key);
        }
    }

    /// Kill one running command. The read loop then hits EOF and the run finishes
    /// normally (as a failure), so the view leaves "running" on its own. A run
    /// cancelled before its child exists is stopped by the slot's absence: its
    /// `attach` fails and the spawner kills the child immediately.
    pub fn cancel(&self, key: &str) -> bool {
        let mut runs = self.lock();
        match runs.remove(key) {
            Some(run) => {
                if let Some(mut killer) = run.killer {
                    let _ = killer.kill();
                }
                true
            }
            None => false,
        }
    }

    /// Kill every running command — called on app exit, beside `PtyManager::close_all`,
    /// so a quit mid-run doesn't leave a build and its children running headless.
    pub fn kill_all(&self) {
        let mut runs = self.lock();
        for (_, run) in runs.drain() {
            if let Some(mut killer) = run.killer {
                let _ = killer.kill();
            }
        }
    }
}

/// What to run: a shell command line, its working directory, and extra environment.
///
/// A command *line* (run via `bash -lc`) rather than an argv: these are developer
/// commands that want the login shell's PATH — `pnpm` from a version manager,
/// `cargo` from rustup, whatever direnv/nix put there. Nothing here is
/// IPC-supplied; every caller in this app builds its own literal.
pub struct Spec<'a> {
    pub command: String,
    pub cwd: &'a Path,
    pub env: Vec<(String, String)>,
}

/// Run `spec` under a PTY, streaming its output to `ev`, and report whether it
/// exited successfully. Blocking — call it from `spawn_blocking`. The slot must
/// already be claimed (see [`Runs::reserve`]); it's released when this returns.
pub fn run(spec: Spec<'_>, slot: Slot<'_>, ev: &Channel<StreamEvent>) -> bool {
    let pair = match native_pty_system().openpty(PtySize {
        rows: ROWS,
        cols: COLS,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(p) => p,
        Err(e) => {
            send_text(ev, &format!("failed to allocate pty: {e}\r\n"));
            return false;
        }
    };

    // `-l` so the command sees the login shell's PATH (nvm/rustup/nix shims), which
    // a bare non-interactive shell doesn't get — `pnpm: command not found` otherwise.
    let mut cmd = CommandBuilder::new("/bin/bash");
    cmd.args(["-lc", &spec.command]);
    cmd.cwd(spec.cwd);
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    // Claim a colour-capable terminal — this is why we bothered with a PTY.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLUMNS", COLS.to_string());

    let mut child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            send_text(ev, &format!("failed to start: {e}\r\n"));
            return false;
        }
    };
    // Drop the slave so the master reader hits EOF once the command *and* its
    // children (which inherit the slave) exit — otherwise the read loop hangs.
    drop(pair.slave);

    let mut reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            send_text(ev, &format!("failed to read output: {e}\r\n"));
            let _ = child.kill();
            return false;
        }
    };

    // A Stop (or an app quit) can land between claiming the slot and getting here —
    // the registry then holds nothing that could kill this child, so stop it ourselves.
    if !slot.runs.attach(&slot, child.clone_killer()) {
        let _ = child.kill();
        let _ = child.wait();
        return false;
    }

    // Backstop for a command that never finishes at all. Killing the child closes the
    // last handle on the slave, which is what unblocks the read loop below —
    // `reader.read` has no timeout of its own. The watchdog parks on a channel it
    // never receives from, so it wakes the moment this function returns (dropping
    // `done`) rather than sleeping out the full deadline after a fast run. It kills
    // only the child it holds a killer for; the registry entry is the slot's to free.
    let (done, finished) = std::sync::mpsc::channel::<()>();
    {
        let mut killer = child.clone_killer();
        let key = slot.key.clone();
        std::thread::spawn(move || {
            if finished.recv_timeout(DEADLINE) != Err(std::sync::mpsc::RecvTimeoutError::Timeout) {
                return; // the run finished on its own
            }
            log::warn!("run {key} exceeded {}s — killing it", DEADLINE.as_secs());
            let _ = killer.kill();
        });
    }

    // Forward raw bytes as they arrive. `carry` holds a trailing partial UTF-8
    // sequence: a read can split a multi-byte character (and does, on the box-drawing
    // and emoji build tools print), and decoding each read independently would emit a
    // replacement char for each half.
    let mut buf = [0u8; 8192];
    let mut carry: Vec<u8> = Vec::new();
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                carry.extend_from_slice(&buf[..n]);
                let text = take_utf8(&mut carry);
                if !text.is_empty() {
                    let _ = ev.send(StreamEvent::Chunk { text });
                }
            }
        }
    }
    if !carry.is_empty() {
        // EOF with an incomplete sequence still pending — emit it lossily rather
        // than dropping the tail of the output.
        send_text(ev, &String::from_utf8_lossy(&carry));
    }

    let ok = child.wait().map(|s| s.success()).unwrap_or(false);
    drop(slot); // free the registry entry — but only if it's still this run's
    drop(done); // wake the watchdog so it doesn't outlive the run
    ok
}

fn send_text(ev: &Channel<StreamEvent>, text: &str) {
    let _ = ev.send(StreamEvent::Chunk {
        text: text.to_string(),
    });
}

/// Split off everything in `buf` that forms complete UTF-8, leaving a trailing
/// partial sequence behind for the next read to complete. Invalid bytes (not merely
/// incomplete ones) are replaced rather than held forever — a tool emitting binary
/// junk must not wedge the stream.
fn take_utf8(buf: &mut Vec<u8>) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    /// Stands in for a spawned child, recording that it was killed — the registry's
    /// rules are about *which* killer gets called and when, which is testable
    /// without any of `run`'s process machinery.
    #[derive(Debug, Clone, Default)]
    struct FakeKiller(Arc<AtomicBool>);

    impl FakeKiller {
        fn killed(&self) -> bool {
            self.0.load(Ordering::SeqCst)
        }
        fn boxed(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(self.clone())
        }
    }

    impl ChildKiller for FakeKiller {
        fn kill(&mut self) -> std::io::Result<()> {
            self.0.store(true, Ordering::SeqCst);
            Ok(())
        }
        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            self.boxed()
        }
    }

    #[test]
    fn take_utf8_holds_a_split_multibyte_char_until_it_completes() {
        // "é" is 0xC3 0xA9 — arriving across two reads.
        let mut buf = b"ok \xc3".to_vec();
        assert_eq!(take_utf8(&mut buf), "ok ");
        assert_eq!(buf, b"\xc3", "the lead byte must be held, not mangled");
        buf.push(0xa9);
        assert_eq!(take_utf8(&mut buf), "é");
        assert!(buf.is_empty());
    }

    #[test]
    fn take_utf8_passes_complete_input_through_untouched() {
        let mut buf = "\x1b[32mgreen\x1b[0m ✓\r\n".as_bytes().to_vec();
        assert_eq!(take_utf8(&mut buf), "\x1b[32mgreen\x1b[0m ✓\r\n");
        assert!(buf.is_empty());
    }

    /// A genuinely invalid byte must not be mistaken for an incomplete sequence and
    /// held forever — that would stall every later chunk behind it.
    #[test]
    fn take_utf8_consumes_invalid_bytes_instead_of_stalling() {
        let mut buf = b"a\xffb".to_vec();
        let out = take_utf8(&mut buf);
        assert!(out.starts_with('a'), "{out:?}");
        assert!(buf.len() < 3, "the bad byte must be consumed");
        // The rest drains on the next call rather than accumulating.
        let rest = take_utf8(&mut buf);
        assert!(buf.is_empty(), "leftover: {buf:?}");
        assert!(format!("{out}{rest}").ends_with('b'));
    }

    #[test]
    fn reserve_is_exclusive_per_key_and_frees_on_drop() {
        let runs = Runs::default();
        let slot = runs.reserve("k").expect("first claim");
        assert!(runs.reserve("k").is_none(), "second claim must be refused");
        assert!(runs.reserve("other").is_some(), "a different key is free");
        drop(slot);
        assert!(
            runs.reserve("k").is_some(),
            "dropping the slot frees the key"
        );
    }

    /// A finished run must only free *its own* entry. Cancel + re-run puts a newer
    /// run under the same key; an identity-less remove evicted it, leaving a live
    /// process that neither Stop nor `kill_all` could ever see.
    #[test]
    fn a_finished_run_never_evicts_a_newer_one() {
        let runs = Runs::default();
        let old = runs.reserve("k").unwrap();
        let old_killer = FakeKiller::default();
        assert!(runs.attach(&old, old_killer.boxed()));

        // Stop → the old run is killed and its entry dropped, so a re-run can claim.
        assert!(runs.cancel("k"));
        assert!(old_killer.killed());
        let new = runs.reserve("k").expect("re-run claims the free slot");
        let new_killer = FakeKiller::default();
        assert!(runs.attach(&new, new_killer.boxed()));

        // The cancelled run only now notices and finishes.
        drop(old);
        assert!(
            runs.is_running("k"),
            "the re-run's slot must survive the old run's release"
        );

        runs.kill_all();
        assert!(new_killer.killed(), "the re-run is still killable on quit");
        drop(new);
    }

    /// The reason this module exists: a real run's output reaches the view with its
    /// escape codes intact. The old setup runner stripped ANSI and split lines, which
    /// is exactly the colour a build's output is made of. Goes through a real PTY, so
    /// it also proves the command sees a TTY (`test -t 1`) — without one most build
    /// tools turn colour off before we ever get the chance to keep it.
    #[test]
    fn a_real_run_streams_colour_and_reports_success() {
        let runs = Runs::default();
        let slot = runs.reserve("colour").unwrap();
        let log: std::sync::Arc<Mutex<Vec<String>>> = Default::default();
        let sink = log.clone();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                sink.lock().unwrap().push(json);
            }
            Ok(())
        });

        let ok = run(
            Spec {
                command: "test -t 1 && printf '\\033[32mgreen\\033[0m\\r\\n'".into(),
                cwd: Path::new("/"),
                env: Vec::new(),
            },
            slot,
            &channel,
        );

        assert!(ok, "the command exited successfully");
        let sent = log.lock().unwrap().join("");
        // JSON-escaped: ESC is  and the text is not stripped or reflowed.
        assert!(sent.contains("u001b[32m"), "colour must survive: {sent}");
        assert!(sent.contains("green"), "{sent}");
    }

    /// Stop can land in the window between claiming the slot and spawning the child.
    /// `attach` then fails, which is how the spawner learns to kill what it started —
    /// nothing else holds a handle on it.
    #[test]
    fn a_slot_cancelled_before_the_spawn_refuses_the_killer() {
        let runs = Runs::default();
        let slot = runs.reserve("k").unwrap();
        assert!(runs.cancel("k"), "stopped while still spawning");
        assert!(
            !runs.attach(&slot, FakeKiller::default().boxed()),
            "the child has nowhere to register — its spawner must kill it"
        );
    }
}
