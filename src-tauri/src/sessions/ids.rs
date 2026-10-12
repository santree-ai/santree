//! The app's pane ids for remote hosts.
//!
//! Panes are named by app-side ids, one counter for every remote host, so ids
//! never collide across hosts and a command handed only an id can ask each host
//! whether it holds it (`Terminals::target`). In-app PTYs count from 1 in
//! `PtyManager` and never come from here: an id below [`MINT_BASE`] is the
//! in-app manager's.
//!
//! Ids here are *this app's*, never the host's: a server restarts its own
//! session ids at 1 on every boot, so what ties a pane to a session is
//! `RemoteTerminals`'s record of the boot it bound under, not anything here.

use std::sync::atomic::{AtomicU32, Ordering};

use super::PaneId;

/// The first remote pane id. `PtyManager` counts its own from 1 and would need
/// two billion sessions in one run to get here.
const MINT_BASE: PaneId = 1 << 31;

/// Which remote host runs a pane.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HostKey {
    Daedalus,
    /// A local santree server, by the revision it was built at: the app can
    /// hold several at once while an older one drains.
    Local {
        revision: u32,
    },
}

/// The app's one id counter, shared by every host's `RemoteTerminals`.
#[derive(Debug)]
pub struct IdRegistry {
    next: AtomicU32,
}

impl Default for IdRegistry {
    fn default() -> Self {
        Self {
            next: AtomicU32::new(MINT_BASE),
        }
    }
}

impl IdRegistry {
    /// A new pane id. Never reused: a stale id in a frontend that outlived its
    /// pane must miss, not land on a stranger.
    pub fn mint(&self) -> PaneId {
        self.next.fetch_add(1, Ordering::Relaxed)
    }

    /// Whether `id` was ever minted here — held by a host or since ended — as
    /// opposed to belonging to the in-app manager. A remote pane that has ended
    /// must not be handed to `PtyManager`, which would blame the wrong place.
    pub fn minted(&self, id: PaneId) -> bool {
        id >= MINT_BASE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minted_ids_never_collide_with_the_in_app_range_and_are_never_reused() {
        let ids = IdRegistry::default();
        let (a, b) = (ids.mint(), ids.mint());
        assert_ne!(a, b);
        assert!(a >= 1 << 31, "{a}");
        assert!(ids.minted(a) && ids.minted(b));
        assert!(!ids.minted(1));
        assert!(!ids.minted((1 << 31) - 1));
    }
}
