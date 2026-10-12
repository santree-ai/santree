//! The Tauri surface of the local server: its status, starting it, and the
//! event that says the status changed. Thin by design — the work is
//! [`LocalServers`]'s. Registered (and the managed `Arc<LocalServers>` put in
//! state) by `lib.rs`.

use std::sync::Arc;

use serde::Serialize;
use specta::Type;
use tauri::State;

use santree_core::domain::ServerStatus;

use super::supervisor::LocalServers;
use crate::error::CmdResult;

/// "The local server's state changed" — carries the new status, so the banner
/// and the Settings card need no refetch.
#[derive(Clone, Serialize, Type, tauri_specta::Event)]
pub struct ServerStateChanged(pub ServerStatus);

/// The local server's state and any older servers still draining. A value, never
/// an error: a server that is down is a state to show, not a toast.
#[tauri::command]
#[specta::specta]
pub fn server_status(servers: State<'_, Arc<LocalServers>>) -> ServerStatus {
    servers.status()
}

/// Start (or restart after a failure) the local server, with a fresh crash
/// budget. `Err` carries the reason it still isn't running.
#[tauri::command]
#[specta::specta]
pub async fn server_start(servers: State<'_, Arc<LocalServers>>) -> CmdResult<()> {
    servers.start().await?;
    Ok(())
}

/// Stop the local server and start a fresh one: every terminal it holds ends
/// (agents can be resumed from their tabs). The frontend confirms first, naming
/// what will end; this takes no argument, so there is nothing to validate. Not a
/// crash: it spends none of the respawn budget.
#[tauri::command]
#[specta::specta]
pub async fn server_restart(servers: State<'_, Arc<LocalServers>>) -> CmdResult<()> {
    servers.restart().await?;
    Ok(())
}

/// Stop the local server and leave it stopped, ending every terminal it holds.
/// Confirmed on the frontend. Nothing starts it again until `server_start`.
#[tauri::command]
#[specta::specta]
pub async fn server_stop(servers: State<'_, Arc<LocalServers>>) -> CmdResult<()> {
    servers.stop().await?;
    Ok(())
}

/// End an older, draining server and the terminals it still holds. Confirmed on
/// the frontend. `revision` is only ever a *lookup key* into the servers the
/// supervisor found by itself: one that is not a known draining server is
/// refused, so it can't be used to name a socket, a path or a process.
#[tauri::command]
#[specta::specta]
pub async fn server_end_draining(
    revision: u32,
    servers: State<'_, Arc<LocalServers>>,
) -> CmdResult<()> {
    servers.end_draining(revision).await?;
    Ok(())
}
