//! Tauri command adapter for the real terminal layer.
//!
//! These are thin wrappers over [`santree_pty::PtyManager`]. Output is streamed
//! to the frontend over a [`tauri::ipc::Channel`] (the correct high-throughput
//! primitive for per-chunk terminal output — `emit` would choke); input, resize
//! and close map straight onto the PTY.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use specta::{datatype::DataType, Type, Types};
use tauri::ipc::{Channel, InvokeResponseBody, IpcResponse};
use tauri::State;

use crate::db::Db;
use crate::error::CmdResult;
use santree_pty::{Anchor, OpenOpts, PtyManager, ReplayMode, SessionId};

/// A PTY output chunk, wrapped so it crosses the Tauri IPC [`Channel`] as raw
/// bytes (delivered to the frontend as an `ArrayBuffer`) instead of the
/// default `serde_json` encoding, which turns each chunk into a JSON array of
/// up to 8192 decimal integers — real CPU cost on both ends for
/// high-throughput output (verbose build logs, `cat` of a large file, fast
/// agent scroll).
///
/// [`IpcResponse::body`] bypasses `Serialize` entirely (there is no blanket
/// `Serialize` impl for this type, so it can't collide with `tauri`'s
/// `impl<T: Serialize> IpcResponse for T`), producing [`InvokeResponseBody::Raw`]
/// directly, which Tauri's JS runtime delivers to the channel's `onmessage` as
/// a real `ArrayBuffer` — never through `serde_json`.
///
/// `Type` is implemented by hand (not derived) to reflect exactly that: an
/// opaque reference to the built-in TS `ArrayBuffer`, not a structural
/// `number[]`. This is what keeps this on the sacred typed bridge — the
/// generated `bindings.ts` declares `Channel<ArrayBuffer>`, matching the real
/// runtime shape, instead of lying about it (tauri-specta rc.25's semantic-type
/// deserialize-transform machinery doesn't reach a bare `Channel<T>` generic —
/// verified empirically: it left the invoke call unwrapped — so we reflect the
/// honest runtime type directly instead of a `Uint8Array` alias with no actual
/// conversion behind it).
pub struct RawBytes(pub Vec<u8>);

impl Type for RawBytes {
    fn definition(_types: &mut Types) -> DataType {
        specta_typescript::define("ArrayBuffer").into()
    }
}

impl IpcResponse for RawBytes {
    fn body(self) -> tauri::Result<InvokeResponseBody> {
        Ok(InvokeResponseBody::Raw(self.0))
    }
}

/// How the frontend asks for a new terminal. An empty `command` means the user's
/// login shell.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenOpts {
    pub cwd: Option<String>,
    pub command: String,
    pub args: Vec<String>,
    pub cols: u16,
    pub rows: u16,
    /// The webview page-load this session belongs to — see [`terminal_adopt`].
    /// Opaque: never a path, an id we look anything up by, or an argv value.
    pub owner: String,
    /// What the frontend calls this session (its `term_key`). Handed back by
    /// [`terminal_adopt`] so a reloaded page can match a live session to the
    /// surface that owns it. Opaque, exactly like `owner`.
    pub label: String,
}

/// Where a reattaching client is in a session's output stream.
///
/// Mirrors [`santree_pty::Anchor`] at the IPC boundary rather than deriving
/// `Type` on it, so the pty crate stays free of a specta dependency.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum TerminalAnchor {
    /// "I have every byte of `epoch` through `seq`."
    ///
    /// `f64` rather than `u64` because specta forbids exporting BigInt-style
    /// types across the bridge. Harmless here: a double represents every integer
    /// up to 2^53, which is nine petabytes of terminal output on one session.
    At { epoch: String, seq: f64 },
    /// A brand-new terminal with nothing on it.
    Fresh,
    /// Bytes on screen, position unknown or untrustworthy. Answered by sending
    /// nothing — see [`terminal_attach`].
    Unknown,
}

impl From<TerminalAnchor> for Anchor {
    fn from(value: TerminalAnchor) -> Self {
        match value {
            // Negative or fractional values can only come from a corrupt
            // anchor; they land outside the ring and reanchor, which is the
            // right answer for a position we cannot trust.
            TerminalAnchor::At { epoch, seq } => Anchor::At {
                epoch,
                seq: seq.max(0.0) as u64,
            },
            TerminalAnchor::Fresh => Anchor::Fresh,
            TerminalAnchor::Unknown => Anchor::Unknown,
        }
    }
}

/// What the client should believe after an attach.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttached {
    /// The stream's identity. Pair it with `seq` to form the next anchor.
    pub epoch: String,
    /// The position the client is at once it has written everything the channel
    /// delivered before this call returned. See [`TerminalAnchor::At`] on why
    /// this is a double.
    pub seq: f64,
    /// How the gap was closed. `Reanchor` means no catch-up was possible and the
    /// pane keeps whatever it already had; the caller repaints from the program.
    pub mode: TerminalReplayMode,
}

#[derive(Debug, Clone, Copy, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TerminalReplayMode {
    Exact,
    Tail,
    Reanchor,
}

impl From<ReplayMode> for TerminalReplayMode {
    fn from(value: ReplayMode) -> Self {
        match value {
            ReplayMode::Exact => TerminalReplayMode::Exact,
            ReplayMode::Tail => TerminalReplayMode::Tail,
            ReplayMode::Reanchor => TerminalReplayMode::Reanchor,
        }
    }
}

/// One live PTY session, for the Terminal settings panel.
///
/// Deliberately a different shape from `TerminalUsage` (`resources.rs`), which
/// answers "what is this costing" by joining the process table. This answers
/// "what is running, and can I still reach it" — the lifecycle question, which
/// is the one a reload made possible to get wrong.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub id: SessionId,
    /// The `term_key` it was opened under — how the UI names it.
    pub label: String,
    pub cwd: Option<String>,
    pub command: String,
    /// The root process's pid, or `None` when the platform didn't report one.
    pub pid: Option<u32>,
    pub cols: u16,
    pub rows: u16,
    /// Whether a pane is currently receiving this session's output. `false` is
    /// ordinary — a closed pane, or work inherited from a reload and not yet
    /// reopened — but it is otherwise invisible, which is why it is here.
    pub attached: bool,
    /// Whether the root process still exists.
    pub alive: bool,
}

/// A session handed over from a previous page load.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AdoptedSession {
    pub id: SessionId,
    /// The `term_key` it was opened under — how the caller finds its surface.
    pub label: String,
    pub cwd: Option<String>,
    pub command: String,
}

/// The `term_key`s that have a live PTY right now.
///
/// This is santree's whole answer to "which agents are actually running", and it
/// is a *live read*, not a record: the manager holds the real processes, and
/// `alive` is a non-blocking `try_wait` on each one. There is no daemon, so a PTY
/// cannot outlive the app — which is what makes an empty set after a restart the
/// correct answer rather than a missing one.
///
/// A session's `label` **is** its `term_key` (see [`TerminalOpenOpts::label`] and
/// `TauriBackend.ts`, which keys adopted sessions by it), so this needs no
/// translation. Consumed by `hooks::session_states`.
pub fn live_terminals(manager: &PtyManager) -> HashSet<String> {
    manager
        .sessions()
        .into_iter()
        .filter(|s| s.alive)
        .map(|s| s.label)
        .collect()
}

/// Wrap a session's output sink so the PTY's exit sentinel also retires whatever
/// agent session that terminal was hosting.
///
/// The sentinel is an empty chunk — `crates/pty`'s `pump` emits exactly one, at
/// EOF, and output chunks are otherwise never empty — so this is the existing
/// exit signal, not a new one. santree gets it for free where other apps have to
/// inject shell integration to recover it: the seed is `exec <cli>`, so the PTY
/// *is* the agent process and its EOF is the agent exiting, however it died.
///
/// The forward happens first, so the pane still tears down at exactly the moment
/// it did before; the retirement is a detached task because this runs on the PTY
/// reader thread, which must never block on a database write.
fn retiring_sink(
    db: Db,
    label: String,
    cwd: Option<String>,
    forward: impl Fn(Vec<u8>) + Send + 'static,
) -> impl Fn(Vec<u8>) + Send + 'static {
    move |bytes| {
        let exited = bytes.is_empty();
        forward(bytes);
        if !exited {
            return;
        }
        let (db, label, cwd) = (db.clone(), label.clone(), cwd.clone());
        tauri::async_runtime::spawn(async move {
            match crate::hooks::retire_terminal(&db, &label, cwd.as_deref()).await {
                Ok(n) if n > 0 => log::info!("pty for {label} exited; retired {n} session row(s)"),
                Ok(_) => {}
                Err(e) => log::warn!("retiring session rows for {label}: {e}"),
            }
        });
    }
}

// These are `async` so Tauri runs them on the async runtime rather than the main
// (UI) thread: opening a PTY does a fork+exec with a full env copy, and a write
// can block if a stuck child's PTY buffer is full — neither should ever stall the
// UI. The PtyManager's per-session locking keeps sessions isolated from each other.

/// Spawn a process behind a PTY and stream its raw output over `on_output`.
///
/// The spawn itself is `openpty` + a fork/exec with a full env copy + a reader
/// thread — all blocking, and slow enough (an interactive `claude` on a cold
/// cache) to stall a tokio worker, so it goes to the blocking pool like
/// [`terminal_write`]. Nothing about *what* is spawned or how its bytes stream
/// changes: `PtyManager::open` runs exactly once, with the same opts and the
/// same verbatim byte-forwarding sink (COMPLIANCE.md).
#[tauri::command]
#[specta::specta]
pub async fn terminal_open(
    opts: TerminalOpenOpts,
    on_output: Channel<RawBytes>,
    manager: State<'_, PtyManager>,
    db: State<'_, Db>,
) -> CmdResult<SessionId> {
    // The user's configured project env for the repo this cwd belongs to (app +
    // per-repo). Applies to every santree-spawned terminal — the one chokepoint.
    let env = crate::env::resolve_env(&db, opts.cwd.as_deref()).await;
    let opts = OpenOpts {
        cwd: opts.cwd,
        command: opts.command,
        args: opts.args,
        cols: opts.cols,
        rows: opts.rows,
        env,
        owner: opts.owner,
        label: opts.label,
    };
    let manager = manager.inner().clone();
    let sink = retiring_sink(
        db.inner().clone(),
        opts.label.clone(),
        opts.cwd.clone(),
        move |bytes| {
            // A failed send means the channel was dropped (view unmounted); the
            // session will be closed separately, so just stop forwarding.
            let _ = on_output.send(RawBytes(bytes));
        },
    );
    Ok(tokio::task::spawn_blocking(move || manager.open(opts, sink)).await??)
}

/// Write raw bytes (keystrokes or a seed) to a session.
///
/// Unlike resize/close, this can genuinely block (see the comment above): the
/// write is offloaded to a blocking-pool thread so a stuck child's full PTY
/// buffer can never pin a tokio worker and starve every other async command.
#[tauri::command]
#[specta::specta]
pub async fn terminal_write(
    id: SessionId,
    data: String,
    manager: State<'_, PtyManager>,
) -> CmdResult<()> {
    let manager = manager.inner().clone();
    Ok(tokio::task::spawn_blocking(move || manager.write(id, data.as_bytes())).await??)
}

/// Resize a session's PTY to the visible grid.
#[tauri::command]
#[specta::specta]
pub async fn terminal_resize(
    id: SessionId,
    cols: u16,
    rows: u16,
    manager: State<'_, PtyManager>,
) -> CmdResult<()> {
    Ok(manager.resize(id, cols, rows)?)
}

/// Kill a session's child and free it.
#[tauri::command]
#[specta::specta]
pub async fn terminal_close(id: SessionId, manager: State<'_, PtyManager>) -> CmdResult<()> {
    Ok(manager.close(id)?)
}

/// Point a live session's output at this page's channel, and catch it up.
///
/// This is what makes a session survive losing its view. The previous sink — an
/// unmounted pane's channel, or a whole page that reloaded — is replaced, and
/// the bytes the client is missing are written to `on_output` **before** this
/// returns, so they arrive ahead of any live output on the same channel.
///
/// `anchor` is what the client claims to already have. When that claim can't be
/// verified against the session's ring (a different stream, or a gap older than
/// the ring keeps) nothing is sent and the mode comes back `Reanchor`: the
/// client's own screen is better than anything this could synthesize, and the
/// caller repaints from the running program instead.
///
/// Untrusted like any IPC value, and inert: `epoch` is compared for string
/// equality against a value this process minted, `seq` indexes a byte count.
/// Neither reaches the filesystem, a git argv, or a lookup key, and neither
/// grants authority the caller doesn't already have.
#[tauri::command]
#[specta::specta]
pub async fn terminal_attach(
    id: SessionId,
    anchor: TerminalAnchor,
    on_output: Channel<RawBytes>,
    manager: State<'_, PtyManager>,
    db: State<'_, Db>,
) -> CmdResult<TerminalAttached> {
    // Attaching *replaces* the sink, so the exit retirement has to be re-wrapped
    // here or a session loses it the first time its pane remounts — which is the
    // common case, not the rare one. The label comes from the manager rather than
    // the caller: it is the value this process stored at open, and an IPC-supplied
    // one could name another surface's terminal.
    let owner = manager
        .sessions()
        .into_iter()
        .find(|s| s.id == id)
        .map(|s| (s.label, s.cwd));
    let forward = {
        let on_output = on_output.clone();
        move |bytes: Vec<u8>| {
            let _ = on_output.send(RawBytes(bytes));
        }
    };
    let replay = match owner {
        Some((label, cwd)) => manager.attach(
            id,
            &anchor.into(),
            retiring_sink(db.inner().clone(), label, cwd, forward),
        ),
        None => manager.attach(id, &anchor.into(), forward),
    }?;
    // Never send an empty chunk: empty is the exit sentinel, and an `Exact`
    // attach with no gap (or any `Reanchor`) legitimately has nothing to write.
    if !replay.bytes.is_empty() {
        let _ = on_output.send(RawBytes(replay.bytes));
    }
    Ok(TerminalAttached {
        epoch: replay.epoch,
        seq: replay.seq as f64,
        mode: replay.mode.into(),
    })
}

/// Stop delivering a session's output without ending it — what a pane does when
/// it unmounts. The process keeps running and keeps recording; only delivery
/// stops, and [`terminal_attach`] resumes it.
#[tauri::command]
#[specta::specta]
pub async fn terminal_detach(id: SessionId, manager: State<'_, PtyManager>) -> CmdResult<()> {
    manager.detach(id);
    Ok(())
}

/// Every live PTY session, for the Terminal settings panel.
///
/// Read-only and cheap: a snapshot under the manager lock plus one non-blocking
/// `try_wait` per session. It grants no authority the frontend doesn't have —
/// it can already close any id — and it reveals nothing about a session's
/// *contents*, only that it exists.
#[tauri::command]
#[specta::specta]
pub async fn terminal_sessions(manager: State<'_, PtyManager>) -> CmdResult<Vec<TerminalSession>> {
    Ok(manager
        .sessions()
        .into_iter()
        .map(|info| TerminalSession {
            id: info.id,
            label: info.label,
            cwd: info.cwd,
            command: info.command,
            pid: info.pid,
            cols: info.cols,
            rows: info.rows,
            attached: info.attached,
            alive: info.alive,
        })
        .collect())
}

/// Claim the sessions an earlier page-load left running, and report them so the
/// caller can put each one back on the surface that owns it.
///
/// A session deliberately outlives the view that opened it — that is what lets a
/// terminal keep running while you look at another tab. It used to also have to
/// die with the *page*: every handle to one lived in the webview, and a reload
/// threw all of them away, so the sessions were unreachable and had to be
/// reaped. They no longer are. Each session records its own recent output, so a
/// reloaded page can rebuild the tab from `label` and catch the pane up from the
/// stream — a reload now costs the view, not the work.
///
/// The caller must close whatever it cannot host (a worktree deleted while the
/// page was down); this reports everything rather than filtering, because only
/// the caller knows which surfaces still exist.
///
/// `owner` is untrusted like any IPC value and only ever compared for string
/// equality against tags this process stored. It grants no authority the
/// frontend doesn't already have: anything that can call this can call
/// [`terminal_close`] on every id in turn.
#[tauri::command]
#[specta::specta]
pub async fn terminal_adopt(
    owner: String,
    manager: State<'_, PtyManager>,
) -> CmdResult<Vec<AdoptedSession>> {
    let adopted: Vec<AdoptedSession> = manager
        .adopt_others(&owner)
        .into_iter()
        .map(|info| AdoptedSession {
            id: info.id,
            label: info.label,
            cwd: info.cwd,
            command: info.command,
        })
        .collect();
    if !adopted.is_empty() {
        log::info!(
            "adopted {} pty session(s) from a previous page load",
            adopted.len()
        );
    }
    Ok(adopted)
}
