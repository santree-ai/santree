//! Where a terminal's process lives, and how a pane reaches it.
//!
//! A pane is an app-side id and a byte channel; its process is one of three
//! places, and this module is the seam that keeps the rest of the app from
//! knowing which:
//!
//! - **In-app** — a PTY owned by this process (`santree_pty::PtyManager`). It
//!   dies with the app. This is `Mode::Off`, and what every Mac without a
//!   trusted santree server does.
//! - **A local santree server** — the same protocol-v1 host Daedalus runs, on a
//!   socket on this Mac, launched detached so the process outlives the app
//!   (docs/server.md).
//! - **Daedalus** — the host on the home server, through the local agent
//!   (docs/remote.md).
//!
//! The last two are the one implementation: [`remote::RemoteTerminals`],
//! parameterised by a [`remote::Profile`]. [`backend::Terminals`] is the facade
//! the commands hold, dispatching by id through [`ids::IdRegistry`].

pub mod backend;
pub mod env;
pub mod ids;
pub mod remote;

use std::collections::HashSet;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::Serialize;
use specta::Type;

use santree_core::domain::AgentKind;
use santree_pty::SessionId;
use santree_remote_client::proto::ReplayMode;

pub use backend::{Local, LocalHosts, Route, SeedPolicy, Snapshot, Terminals};
pub use ids::{HostKey, IdRegistry};
pub use remote::{Exited, Gone, OnExited, Profile, RemoteTerminals, Timing};

/// A pane's app-side id: what the frontend holds, whichever host runs it.
pub type PaneId = SessionId;

/// Environment variables as the wire and the PTY layer carry them.
pub type EnvVars = Vec<(String, String)>;

/// How long a pane open or a read waits out a link that is still coming up,
/// so one made right after launch doesn't fail on a connect a moment from done.
pub const CONNECT_WAIT: Duration = Duration::from_secs(5);

/// Whether, and how, local terminals go through a santree server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// In-app PTYs: no server, nothing outlives the app.
    Off,
    /// A release build that can prove it is the one signed by `team`: the
    /// server admits only a peer signed the same way, so an agent can't drive
    /// another agent's terminal through it.
    Signed { team: &'static str },
    /// An unsigned build the user opted into (`SANTREE_SERVER=1`): the server
    /// can only check the uid, which every agent in a pane shares. The one
    /// sanctioned exception, named in COMPLIANCE.md.
    OptIn,
}

/// The Team ID a release build is baked with (CI sets it, and verifies it
/// before any release). `None` for every build a developer makes.
const BAKED_TEAM: Option<&str> = option_env!("SANTREE_TEAM_ID");

/// The mode this process runs in, chosen once: a process's signature and
/// environment don't change under it, and every pane's route depends on the
/// answer staying the same.
pub fn server_mode() -> Mode {
    static MODE: OnceLock<Mode> = OnceLock::new();
    *MODE.get_or_init(|| {
        let own = santree_server::peer::own_identity();
        choose_mode(
            BAKED_TEAM,
            match &own {
                santree_server::peer::Identity::Signed { team } => Some(team.as_str()),
                santree_server::peer::Identity::Unsigned => None,
            },
            std::env::var("SANTREE_SERVER").is_ok_and(|v| v == "1"),
        )
    })
}

/// [`server_mode`]'s decision over its three inputs. `baked` is the team the
/// binary was built for, `own` the team its signature actually names.
///
/// A baked build that can't confirm its own signature is `Off`, never `OptIn`:
/// a release that fails to prove who it is must not fall back to a mode that
/// admits any process of the same uid. The env opt-in is for builds without a
/// baked team.
fn choose_mode(baked: Option<&'static str>, own: Option<&str>, opt_in: bool) -> Mode {
    match baked {
        Some(team) if own == Some(team) => Mode::Signed { team },
        Some(_) => Mode::Off,
        None if opt_in => Mode::OptIn,
        None => Mode::Off,
    }
}

/// Whether a pane is reaching its session right now, pushed on its own
/// channel beside the bytes. A local in-app PTY is always reachable and never
/// sends one. `Reconnecting` is never an exit — the process is still running
/// on the other side, and the pane catches up from its anchor when the link
/// returns; only the empty output chunk says a process ended.
///
/// `Lost` is the one other thing that isn't an exit either: the host the
/// pane's session lived on is no longer the one answering (a server that was
/// stopped, killed or restarted), so the session is gone with the process
/// behind it. The empty chunk would close the tab, taking the pane's place
/// along with the news; `Lost` leaves the tab up, saying why.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PaneLink {
    Live,
    Reconnecting,
    Lost,
}

/// One live PTY, named the way `terminal_sessions` names a session: the surface
/// it hosts and the provider running in it.
///
/// The pair is the identity, and it is a pair on purpose. `term_key` alone is
/// what the durable row is keyed by *together with* `agent_kind` — one surface
/// holds one conversation per provider — so a single string could only carry
/// both by decorating one with the other, which is exactly the bug this replaced:
/// a triage PTY opened under `AK-1::codex` matched no `term_key` on the way back,
/// and a live agent was reported as exited.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct LiveTerminal {
    /// The `term_key` the pane's PTY was opened under.
    pub term_key: String,
    /// The provider santree launched in it, or `None` for a plain shell.
    pub agent_kind: Option<AgentKind>,
}

/// Which panes have a live process — and whether that is the whole truth.
///
/// A server santree can't reach right now may be holding agents that are
/// running fine; reading its absence as "exited" would let a conversation be
/// resumed twice. `complete: false` is "this is what is known": the caller
/// keeps what it had and refuses to act on an absence.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Liveness {
    pub live: HashSet<LiveTerminal>,
    pub complete: bool,
}

impl Liveness {
    /// Merge another host's answer in: live is the union, and the whole is
    /// only complete when every part was.
    pub fn merge(&mut self, other: Liveness) {
        self.live.extend(other.live);
        self.complete &= other.complete;
    }

    /// Whether a live pane matches `pane`: `Some(true)` when one does,
    /// `Some(false)` only when none does and the answer is whole, `None`
    /// otherwise. An absence from a partial answer is not evidence — the one
    /// rule every liveness consumer follows.
    pub fn knows(&self, pane: impl Fn(&LiveTerminal) -> bool) -> Option<bool> {
        let present = self.live.iter().any(pane);
        (present || self.complete).then_some(present)
    }
}

/// Where a pane's output goes: raw bytes (empty = the process exited, as for
/// a local session), and the pane's link state.
#[derive(Clone)]
pub struct Sinks {
    pub output: Arc<dyn Fn(Vec<u8>) + Send + Sync>,
    pub link: Arc<dyn Fn(PaneLink) + Send + Sync>,
}

/// What a pane runs, and where. `cwd` is a path on the host that runs it.
#[derive(Clone)]
pub struct Spec {
    /// `None` = the host user's home.
    pub cwd: Option<String>,
    pub command: String,
    pub args: Vec<String>,
    /// The user's project env (`resolve_env`) — the only place its secrets go.
    /// What the session inherits beneath it is its host's
    /// ([`remote::Profile::base_env`]); an in-app PTY inherits ambiently.
    pub env: Vec<(String, String)>,
    pub label: String,
    pub agent_kind: Option<AgentKind>,
}

impl std::fmt::Debug for Spec {
    /// `env` by name only: it holds the project's secrets.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Spec")
            .field("cwd", &self.cwd)
            .field("command", &self.command)
            .field("args", &self.args)
            .field("env", &santree_pty::EnvNames(&self.env))
            .field("label", &self.label)
            .field("agent_kind", &self.agent_kind)
            .finish()
    }
}

/// What an attach answered: where the pane is in its session's stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attached {
    pub epoch: String,
    pub seq: u64,
    pub mode: ReplayMode,
}

#[cfg(test)]
pub(crate) mod testkit;
#[cfg(test)]
mod tests;

#[cfg(test)]
mod unit {
    use super::*;

    /// A baked build serves `Signed` only when its own signature names the
    /// baked team, and the env flag never overrides it; one that can't confirm
    /// its signature fails closed, not even taking the opt-in (that admits any
    /// process of the same uid). An unbaked build serves only on opt-in.
    #[test]
    fn a_build_serves_a_mode_only_when_it_can_prove_it() {
        let signed = Mode::Signed { team: "TEAM1" };
        for (baked, own, opt_in, mode) in [
            (Some("TEAM1"), Some("TEAM1"), false, signed),
            (Some("TEAM1"), Some("TEAM1"), true, signed),
            (Some("TEAM1"), None, false, Mode::Off),
            (Some("TEAM1"), Some("OTHER"), false, Mode::Off),
            (Some("TEAM1"), None, true, Mode::Off),
            (Some("TEAM1"), Some("OTHER"), true, Mode::Off),
            (None, None, false, Mode::Off),
            (None, Some("TEAM1"), false, Mode::Off),
            (None, None, true, Mode::OptIn),
        ] {
            assert_eq!(
                choose_mode(baked, own, opt_in),
                mode,
                "{baked:?} {own:?} {opt_in}"
            );
        }
    }

    #[test]
    fn a_specs_debug_names_its_environment_and_never_shows_a_value() {
        const SECRET: &str = "s3cr3t-value-0x42";
        let env = || vec![("SOME_TOKEN".to_string(), SECRET.to_string())];
        let spec = Spec {
            cwd: None,
            command: "sh".into(),
            args: Vec::new(),
            env: env(),
            label: "tree:A".into(),
            agent_kind: None,
        };
        for shown in [format!("{spec:?}"), format!("{spec:#?}")] {
            assert!(!shown.contains(SECRET), "a value leaked: {shown}");
            assert!(shown.contains("SOME_TOKEN"), "{shown}");
        }
    }

    #[test]
    fn liveness_is_complete_only_when_every_part_is() {
        let pane = |key: &str| LiveTerminal {
            term_key: key.into(),
            agent_kind: None,
        };
        let mut all = Liveness {
            live: HashSet::from([pane("a")]),
            complete: true,
        };
        all.merge(Liveness {
            live: HashSet::from([pane("b")]),
            complete: false,
        });
        assert_eq!(all.live, HashSet::from([pane("a"), pane("b")]));
        assert!(!all.complete);
    }

    /// Unknown is not absent: a match is a match from any answer, an absence
    /// only from a whole one.
    #[test]
    fn an_absence_is_known_only_from_a_whole_answer() {
        let pane = |key: &str| LiveTerminal {
            term_key: key.into(),
            agent_kind: None,
        };
        let is = |key: &'static str| move |p: &LiveTerminal| p.term_key == key;
        for complete in [true, false] {
            let seen = Liveness {
                live: HashSet::from([pane("a")]),
                complete,
            };
            assert_eq!(seen.knows(is("a")), Some(true), "{complete}");
        }
        let whole = Liveness {
            live: HashSet::from([pane("a")]),
            complete: true,
        };
        assert_eq!(whole.knows(is("b")), Some(false));
        let partial = Liveness {
            complete: false,
            ..whole
        };
        assert_eq!(partial.knows(is("b")), None);
    }
}
