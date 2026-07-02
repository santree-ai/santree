//! Tauri command adapter for the real terminal layer.
//!
//! These are thin wrappers over [`santree_pty::PtyManager`]. Output is streamed
//! to the frontend over a [`tauri::ipc::Channel`] (the correct high-throughput
//! primitive for per-chunk terminal output — `emit` would choke); input, resize
//! and close map straight onto the PTY.

use serde::Deserialize;
use specta::{datatype::DataType, Type, Types};
use tauri::ipc::{Channel, InvokeResponseBody, IpcResponse};
use tauri::State;

use crate::error::CmdResult;
use santree_pty::{OpenOpts, PtyManager, SessionId};

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
}

// These are `async` so Tauri runs them on the async runtime rather than the main
// (UI) thread: opening a PTY does a fork+exec with a full env copy, and a write
// can block if a stuck child's PTY buffer is full — neither should ever stall the
// UI. The PtyManager's per-session locking keeps sessions isolated from each other.

/// Spawn a process behind a PTY and stream its raw output over `on_output`.
#[tauri::command]
#[specta::specta]
pub async fn terminal_open(
    opts: TerminalOpenOpts,
    on_output: Channel<RawBytes>,
    manager: State<'_, PtyManager>,
) -> CmdResult<SessionId> {
    let opts = OpenOpts {
        cwd: opts.cwd,
        command: opts.command,
        args: opts.args,
        cols: opts.cols,
        rows: opts.rows,
    };
    Ok(manager.open(opts, move |bytes| {
        // A failed send means the channel was dropped (view unmounted); the
        // session will be closed separately, so just stop forwarding.
        let _ = on_output.send(RawBytes(bytes));
    })?)
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
