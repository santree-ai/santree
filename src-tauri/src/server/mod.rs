//! The local santree server, from the app's side (docs/server.md): finding,
//! installing, launching, trusting and supervising the detached
//! `santree-server` process whose sessions outlive the app.
//!
//! - [`layout`] — where it lives on disk.
//! - [`connector`] — the link, verified before a byte is written.
//! - [`spawn`] — installing the bundled binary and launching it.
//! - [`supervisor`] — [`LocalServers`]: ensure, legacy discovery, respawn, the
//!   state the UI shows, and the `sessions::LocalHosts` the terminals facade
//!   routes through.
//! - [`commands`] — the Tauri surface.
//!
//! Quitting the app only ever *disconnects* ([`LocalServers::release`]): the
//! point of the server is that nothing in it ends when the app does.

pub mod commands;
mod connector;
mod layout;
mod lock;
mod spawn;
mod supervisor;

pub use spawn::smoke_assert;
pub use supervisor::{LocalServers, ServerConfig};

/// `SANTREE_SMOKE`'s value means the smoke run: set and not `0`. The one
/// predicate for both `lib.rs` (which exits once the window loads) and
/// [`LocalServers::ensure`] (which must not start a server then) — two readings
/// of the same variable is how one of them launches a server CI never kills.
pub fn smoke_enabled_in(value: Option<&std::ffi::OsStr>) -> bool {
    value.is_some_and(|v| v != "0")
}

/// [`smoke_enabled_in`] over the process environment.
pub fn smoke_enabled() -> bool {
    smoke_enabled_in(std::env::var_os("SANTREE_SMOKE").as_deref())
}

#[cfg(test)]
pub(crate) mod testkit;

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn smoke_is_set_and_not_zero() {
        assert!(!smoke_enabled_in(None));
        assert!(!smoke_enabled_in(Some(OsStr::new("0"))));
        assert!(smoke_enabled_in(Some(OsStr::new("1"))));
        assert!(smoke_enabled_in(Some(OsStr::new(""))));
        assert!(smoke_enabled_in(Some(OsStr::new("true"))));
    }
}
