//! Keep-awake: hold the machine awake (no display sleep, so no lock screen)
//! while santree is running long agent sessions. macOS only.
//!
//! Implemented by spawning `/usr/bin/caffeinate -d -i -w <our pid>`: `-d`
//! blocks display sleep (the thing that triggers the lock screen), `-i` blocks
//! idle system sleep, and `-w` ties the assertion to this process — if santree
//! crashes or quits, caffeinate exits on its own and the machine sleeps
//! normally, with no cleanup path to get wrong. Toggling off kills the child.
//!
//! Deliberately session-scoped: the hold is never persisted, so a fresh launch
//! always starts with sleep allowed — a toggle forgotten weeks ago can't leave
//! a laptop permanently insomniac.

use std::process::{Child, Command};
use std::sync::Mutex;

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

    /// Turn the hold on or off; returns the resulting state rather than the
    /// requested one (the spawn can fail, and unsupported platforms stay off).
    pub fn set(&self, on: bool) -> std::io::Result<KeepAwakeStatus> {
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
