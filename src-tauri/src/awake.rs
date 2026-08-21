//! Keep-awake: hold the machine awake (no display sleep, so no lock screen)
//! while santree is running long agent sessions. macOS only.
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
//! never the requested one, so a failed spawn or a non-macOS run can't leave a
//! phantom "on" behind for the next launch to trip over.

use std::process::{Child, Command};
use std::sync::Mutex;

use anyhow::Result;

use crate::db::Db;
use crate::settings;

/// The app-scope `settings` key holding the remembered hold (`"true"`, or the
/// row absent for off). Blocked from the generic `set_setting` IPC — see
/// [`settings::validate_user_scope`] — because a value written there would be
/// remembered without a `caffeinate` ever being spawned.
pub const KEEP_AWAKE_KEY: &str = "keep_awake";

/// Whether this platform can hold the machine awake at all. Compiled on every
/// platform (the bindings export runs on Linux in CI, so the command set must
/// not vary by OS); only the value is platform-dependent.
const SUPPORTED: bool = cfg!(target_os = "macos");

/// The current keep-awake state, as the chrome needs it: `supported` decides
/// whether the toggle renders at all, `active` its on/off look.
#[derive(Debug, Clone, Copy, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KeepAwakeStatus {
    pub supported: bool,
    pub active: bool,
}

/// Managed app state: the running `caffeinate` child while the hold is active.
#[derive(Default)]
pub struct KeepAwake(Mutex<Option<Child>>);

impl KeepAwake {
    pub fn status(&self) -> KeepAwakeStatus {
        KeepAwakeStatus {
            supported: SUPPORTED,
            active: alive(&mut self.0.lock().unwrap()),
        }
    }

    /// Turn the hold on or off at the process level; returns the resulting state
    /// rather than the requested one (the spawn can fail, and unsupported
    /// platforms stay off).
    ///
    /// Private on purpose: every caller goes through [`set`] or [`restore`], so
    /// there is no path that changes the hold without settling what the next
    /// launch will do with it.
    fn apply(&self, on: bool) -> std::io::Result<KeepAwakeStatus> {
        let mut slot = self.0.lock().unwrap();
        if on && SUPPORTED {
            if !alive(&mut slot) {
                *slot = Some(spawn_caffeinate()?);
            }
        } else if let Some(mut child) = slot.take() {
            // kill() errors on a child that already exited by itself; "already
            // dead" is exactly the state being asked for, so don't surface it.
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(KeepAwakeStatus {
            supported: SUPPORTED,
            active: alive(&mut slot),
        })
    }
}

/// Toggle the hold and remember it for the next launch. Returns the resulting
/// state, which is also what gets persisted — see the module docs.
pub async fn set(db: &Db, awake: &KeepAwake, on: bool) -> Result<KeepAwakeStatus> {
    let status = awake.apply(on)?;
    let value = status.active.then(|| "true".to_string());
    settings::set(db, "app", KEEP_AWAKE_KEY, value).await?;
    Ok(status)
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
