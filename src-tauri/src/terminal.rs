//! Tauri command adapter for the real terminal layer.
//!
//! These are thin wrappers over [`santree_pty::PtyManager`]. Output is streamed
//! to the frontend over a [`tauri::ipc::Channel`] (the correct high-throughput
//! primitive for per-chunk terminal output — `emit` would choke); input, resize
//! and close map straight onto the PTY.

use std::collections::HashMap;

use serde::Deserialize;
use specta::Type;
use tauri::ipc::Channel;
use tauri::State;

use santree_pty::{OpenOpts, PtyManager, SessionId};

/// How the frontend asks for a new terminal. An empty `command` means the user's
/// login shell.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenOpts {
    pub cwd: Option<String>,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

/// Spawn a process behind a PTY and stream its raw output over `on_output`.
#[tauri::command]
#[specta::specta]
pub fn terminal_open(
    opts: TerminalOpenOpts,
    on_output: Channel<Vec<u8>>,
    manager: State<'_, PtyManager>,
) -> Result<SessionId, String> {
    let opts = OpenOpts {
        cwd: opts.cwd,
        command: opts.command,
        args: opts.args,
        env: opts.env.into_iter().collect(),
        cols: opts.cols,
        rows: opts.rows,
    };
    manager
        .open(opts, move |bytes| {
            // A failed send means the channel was dropped (view unmounted); the
            // session will be closed separately, so just stop forwarding.
            let _ = on_output.send(bytes);
        })
        .map_err(|e| e.to_string())
}

/// Write raw bytes (keystrokes or a seed) to a session.
#[tauri::command]
#[specta::specta]
pub fn terminal_write(
    id: SessionId,
    data: String,
    manager: State<'_, PtyManager>,
) -> Result<(), String> {
    manager
        .write(id, data.as_bytes())
        .map_err(|e| e.to_string())
}

/// Resize a session's PTY to the visible grid.
#[tauri::command]
#[specta::specta]
pub fn terminal_resize(
    id: SessionId,
    cols: u16,
    rows: u16,
    manager: State<'_, PtyManager>,
) -> Result<(), String> {
    manager.resize(id, cols, rows).map_err(|e| e.to_string())
}

/// Kill a session's child and free it.
#[tauri::command]
#[specta::specta]
pub fn terminal_close(id: SessionId, manager: State<'_, PtyManager>) -> Result<(), String> {
    manager.close(id).map_err(|e| e.to_string())
}
