//! Keep-awake: hold the machine awake (no display sleep, so no lock screen)
//! while santree is running long agent sessions.
//!
//! Implemented by spawning `/usr/bin/caffeinate -d -i -w <our pid>`: `-d`
//! blocks display sleep (the thing that triggers the lock screen), `-i` blocks
//! idle system sleep, and `-w` ties the assertion to this process — if santree
//! crashes or quits, caffeinate exits on its own and the machine sleeps
//! normally, with no cleanup path to get wrong. Toggling off kills the child.
//!
//! The hold is sticky: [`set`] remembers it in the `keep_awake` app setting and
//! [`restore`] re-applies it at startup, so turning it on keeps the Mac awake
//! across relaunches until it is turned off again. Off is the default — the row
//! is absent until the toggle is first used.
//!
//! Only a hold that *took* is remembered: [`set`] persists the resulting state,
//! never the requested one, so a failed spawn can't leave a
//! phantom "on" behind for the next launch to trip over. With a local server the
//! hold is the server's to take: the wish is remembered (the server is told it
//! on every connect), and the toggle shows only what the server confirmed.

use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use anyhow::Result;

use crate::db::Db;
use crate::settings;

/// The app-scope `settings` key holding the remembered hold (`"true"`, or the
/// row absent for off). Blocked from the generic `set_setting` IPC — see
/// [`settings::validate_user_scope`] — because a value written there would be
/// remembered without a `caffeinate` ever being spawned.
pub const KEEP_AWAKE_KEY: &str = "keep_awake";

/// The current keep-awake state, as the chrome needs it: `supported` decides
/// whether the toggle renders at all, `active` its on/off look.
#[derive(Debug, Clone, Copy, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KeepAwakeStatus {
    pub supported: bool,
    pub active: bool,
}

/// Managed app state: who holds the machine awake, and whether it does.
pub enum KeepAwake {
    /// This process, through its `caffeinate` child while the hold is on.
    Own(Mutex<Option<Child>>),
    /// The local santree server (docs/server.md): `caffeinate -w <app pid>`
    /// ends with the app, and the agents in the server outlive it. `wanted` is
    /// what the user asked for — remembered, and told to the server on every
    /// connect (`supervisor::LocalServers`); `held` is what the server last
    /// confirmed, which is what the toggle shows.
    Server {
        wanted: AtomicBool,
        held: AtomicBool,
    },
}

impl Default for KeepAwake {
    fn default() -> Self {
        Self::Own(Mutex::new(None))
    }
}

impl KeepAwake {
    /// A hold the local server keeps. No `caffeinate` of the app's own is ever
    /// spawned.
    pub fn delegated_to_server() -> Self {
        Self::Server {
            wanted: AtomicBool::new(false),
            held: AtomicBool::new(false),
        }
    }

    pub fn status(&self) -> KeepAwakeStatus {
        let active = match self {
            Self::Own(child) => alive(&mut child.lock().unwrap()),
            Self::Server { held, .. } => held.load(Ordering::SeqCst),
        };
        KeepAwakeStatus {
            supported: true,
            active,
        }
    }

    /// Whether the hold is asked for: what the server is told.
    pub fn wanted(&self) -> bool {
        match self {
            Self::Own(_) => self.status().active,
            Self::Server { wanted, .. } => wanted.load(Ordering::SeqCst),
        }
    }

    /// What the server answered it holds (or `false` once it is gone). Nothing
    /// to confirm for a hold this process keeps itself.
    pub fn confirm(&self, active: bool) {
        if let Self::Server { held, .. } = self {
            held.store(active, Ordering::SeqCst);
        }
    }

    /// Turn the hold on or off at the process level; returns what to remember
    /// for the next launch: for a hold of this process's own, the resulting
    /// state (the spawn can fail); for the
    /// server's, the wish, which it is told on every connect.
    ///
    /// Private on purpose: every caller goes through [`set`] or [`restore`], so
    /// there is no path that changes the hold without settling what the next
    /// launch will do with it.
    fn apply(&self, on: bool) -> std::io::Result<bool> {
        let slot = match self {
            Self::Server { wanted, .. } => {
                wanted.store(on, Ordering::SeqCst);
                return Ok(on);
            }
            Self::Own(slot) => slot,
        };
        let mut slot = slot.lock().unwrap();
        if on {
            if !alive(&mut slot) {
                *slot = Some(spawn_caffeinate()?);
            }
        } else if let Some(mut child) = slot.take() {
            // kill() errors on a child that already exited by itself; "already
            // dead" is exactly the state being asked for, so don't surface it.
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(alive(&mut slot))
    }
}

/// Toggle the hold and remember it for the next launch. Returns the resulting
/// state — for a hold the server keeps, what it has confirmed so far.
pub async fn set(db: &Db, awake: &KeepAwake, on: bool) -> Result<KeepAwakeStatus> {
    let remembered = awake.apply(on)?;
    let value = remembered.then(|| "true".to_string());
    settings::set(db, "app", KEEP_AWAKE_KEY, value).await?;
    Ok(awake.status())
}

/// Re-apply the remembered hold, once, at startup.
///
/// Best-effort: if the spawn fails the machine just sleeps normally, and the
/// setting is deliberately left as-is so the next launch tries again rather than
/// silently forgetting a hold the user never turned off.
pub async fn restore(db: &Db, awake: &KeepAwake) {
    match settings::get(db, "app", KEEP_AWAKE_KEY).await {
        Ok(Some(v)) if v == "true" => {
            if let Err(e) = awake.apply(true) {
                log::warn!("restoring the keep-awake hold failed: {e:#}");
            }
        }
        Ok(_) => {}
        Err(e) => log::warn!("reading the remembered keep-awake hold failed: {e:#}"),
    }
}

/// Whether the slot holds a still-running child. A child that died on its own
/// (e.g. killed externally) is not a hold — clear it so the UI reads "off".
fn alive(slot: &mut Option<Child>) -> bool {
    let running = match slot.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(None)),
        None => false,
    };
    if !running {
        *slot = None;
    }
    running
}

fn spawn_caffeinate() -> std::io::Result<Child> {
    Command::new("/usr/bin/caffeinate")
        .args(["-d", "-i", "-w", &std::process::id().to_string()])
        .spawn()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// With a local server the hold is the server's: turning it on here spawns
    /// no `caffeinate` of the app's (which would die with the app, and be a
    /// second assertion beside the server's), and the wish is what the server
    /// is told. The toggle shows what holds the Mac awake, not what was asked
    /// for: a hold the server hasn't confirmed is not on, and one it confirmed is.
    #[test]
    fn a_hold_delegated_to_the_server_spawns_nothing_and_is_on_once_confirmed() {
        let awake = KeepAwake::delegated_to_server();
        assert!(!awake.wanted());
        assert!(awake.apply(true).unwrap());
        assert!(awake.wanted());
        assert!(!awake.status().active, "on before the server held it");
        awake.confirm(true);
        assert!(awake.status().active);
        awake.confirm(false);
        assert!(!awake.status().active, "the server let go");
        assert!(!awake.apply(false).unwrap());
        assert!(!awake.wanted());
    }

    #[test]
    fn without_a_server_the_app_holds_the_machine_awake_itself() {
        let awake = KeepAwake::default();
        assert!(awake.apply(true).unwrap());
        assert!(awake.status().active);
        assert!(!awake.apply(false).unwrap());
        assert!(!awake.status().active);
    }
}
