//! Getting a byte stream to a session host: the [`Connector`] seam, what a
//! connect can come back with, and an in-memory pipe for tests. The real
//! connector is [`crate::agent::AgentConnector`].
//!
//! A failed connect is a [`ConnectError`], a *state* the app renders rather
//! than an error it toasts (docs/remote.md, "unreachable is normal"). Some
//! of them do not change by trying again soon — [`ConnectError::permanent`]
//! — and the reconnect loop waits them out at its slowest pace.

use std::future::Future;
use std::pin::Pin;

use serde::Deserialize;
use tokio::io::{AsyncRead, AsyncWrite, DuplexStream};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// An open byte stream to a session host, speaking protocol v1.
pub struct Link {
    pub reader: Box<dyn AsyncRead + Send + Unpin>,
    pub writer: Box<dyn AsyncWrite + Send + Unpin>,
    /// The agent's `ok` line, when the link came through the Daedalus agent.
    pub agent: Option<AgentOk>,
    /// What the connector established about the far end BEFORE it handed the
    /// link over (nothing has been written to it yet). A connector that
    /// checked nothing leaves the default, [`PeerTrust::Unverified`].
    pub peer: PeerTrust,
}

/// How far the far end of a [`Link`] was verified, by its connector, before a
/// single byte was written to it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum PeerTrust {
    /// Nothing was checked. Only a test's in-memory pipe is this.
    #[default]
    Unverified,
    /// The Daedalus agent's socket: served by root, owned by root.
    Agent,
    /// santree's own server, checked by uid and socket ownership only (the
    /// opt-in, unsigned build).
    UidOnly,
    /// santree's own server, whose code signature names Apple team `team`.
    Signed { team: String },
}

/// How much trust a profile (or a [`crate::HostOptions`]) demands of a link.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Required {
    /// Nothing: tests, and a host that has not been wired to a profile.
    #[default]
    Any,
    /// The Daedalus agent's root-owned socket.
    Agent,
    /// At least the server's uid and socket owner.
    UidOnly,
    /// The server's code signature.
    Signed,
}

impl PeerTrust {
    /// Whether this much verification meets `required`. `Signed` meets
    /// `Signed`, `UidOnly` and `Any`; `UidOnly` meets itself and `Any`; `Agent`
    /// meets only `Agent` and `Any`; `Unverified` meets only `Any`.
    ///
    /// The two kinds of host are never interchangeable, in either direction: a
    /// root-owned agent socket says nothing about santree's own server, and the
    /// server's code signature says nothing about the Daedalus agent — so a
    /// `Signed` link does **not** satisfy `Agent`. A profile that demands the
    /// agent must not accept a link someone else's connector verified.
    pub fn satisfies(&self, required: Required) -> bool {
        matches!(
            (self, required),
            (_, Required::Any)
                | (
                    PeerTrust::Signed { .. },
                    Required::Signed | Required::UidOnly
                )
                | (PeerTrust::UidOnly, Required::UidOnly)
                | (PeerTrust::Agent, Required::Agent)
        )
    }
}

impl std::fmt::Debug for Link {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Link")
            .field("agent", &self.agent)
            .field("peer", &self.peer)
            .finish_non_exhaustive()
    }
}

/// The Daedalus agent's `ok` line: where it piped this connection.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AgentOk {
    /// The session host, as `host:port`.
    pub host: String,
    /// This machine's node id at the box.
    pub node: String,
    /// The agent's own version.
    pub agent: String,
}

/// Why the agent turned a connection away, from its refusal's `code`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// This machine's policy keeps santree off (Daedalus › Settings › Machines).
    SantreeOff,
    /// The session host proved another key than the one the box named.
    HostKeyChanged,
    /// This user may not use the agent's santree socket.
    Forbidden,
    /// The agent is carrying as many santree connections as it takes.
    Busy,
    /// Anything else the agent can't do now; its message says why (not
    /// paired, not approved, no session host, the host not reachable…).
    Unavailable,
}

impl Refusal {
    /// The refusal a wire `code` names; a code this santree doesn't know
    /// reads as `Unavailable`, whose message still says why.
    pub fn of(code: &str) -> Self {
        match code {
            "santree_off" => Refusal::SantreeOff,
            "host_key_changed" => Refusal::HostKeyChanged,
            "forbidden" => Refusal::Forbidden,
            "busy" => Refusal::Busy,
            _ => Refusal::Unavailable,
        }
    }
}

/// Why no link opened.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConnectError {
    /// No agent socket on this machine: the Daedalus agent isn't installed.
    #[error("the Daedalus agent isn't installed on this machine")]
    NoAgent,
    /// The agent is installed but serves no santree socket: it predates it.
    #[error("the Daedalus agent on this machine is too old to serve santree")]
    AgentOutdated,
    /// The peer was judged and is not the host it should be (something other
    /// than the agent holds its socket, or the server's check said no): a
    /// verdict about who is there.
    #[error("{0}")]
    Untrusted(String),
    /// The peer could not be judged (the check ran out of time, failed, or
    /// couldn't read the peer). Fails closed like `Untrusted`, but says nothing
    /// about who is there. `slow`: the check only ran out of time, and the next
    /// attempt is expected to pass.
    #[error("{why}")]
    Unverified { slow: bool, why: String },
    /// Nothing listens on the local server's socket: a state, not a failure.
    #[error("santree server isn't running")]
    NotRunning,
    /// The agent answered with a refusal; `msg` is its own reason.
    #[error("{msg}")]
    Refused { refusal: Refusal, msg: String },
    /// Anything else, as a short human line.
    #[error("{0}")]
    Failed(String),
}

impl ConnectError {
    /// Whether trying again soon is pointless: nothing changes until someone
    /// installs or updates the agent, flips a setting in Daedalus, or looks
    /// into a changed key.
    pub fn permanent(&self) -> bool {
        match self {
            ConnectError::NoAgent
            | ConnectError::AgentOutdated
            | ConnectError::Untrusted(_)
            | ConnectError::Unverified { .. } => true,
            ConnectError::Refused { refusal, .. } => matches!(
                refusal,
                Refusal::SantreeOff | Refusal::HostKeyChanged | Refusal::Forbidden
            ),
            ConnectError::Failed(_) | ConnectError::NotRunning => false,
        }
    }
}

/// Opens links. `RemoteHost` takes one so tests can swap the agent for the
/// fake.
pub trait Connector: Send + Sync + 'static {
    fn connect(&self) -> BoxFuture<'static, Result<Link, ConnectError>>;
}

impl<F> Connector for F
where
    F: Fn() -> BoxFuture<'static, Result<Link, ConnectError>> + Send + Sync + 'static,
{
    fn connect(&self) -> BoxFuture<'static, Result<Link, ConnectError>> {
        self()
    }
}

/// An in-memory link: the client half, and the stream a (fake) daemon serves.
pub fn memory_link() -> (Link, DuplexStream) {
    let (client, server) = tokio::io::duplex(256 * 1024);
    let (reader, writer) = tokio::io::split(client);
    (
        Link {
            reader: Box::new(reader),
            writer: Box::new(writer),
            agent: None,
            peer: PeerTrust::Unverified,
        },
        server,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_what_waits_on_a_person_is_permanent() {
        let refused = |refusal| ConnectError::Refused {
            refusal,
            msg: "why".into(),
        };
        for permanent in [
            ConnectError::NoAgent,
            ConnectError::AgentOutdated,
            ConnectError::Untrusted("x".into()),
            ConnectError::Unverified {
                slow: true,
                why: "x".into(),
            },
            refused(Refusal::SantreeOff),
            refused(Refusal::HostKeyChanged),
            refused(Refusal::Forbidden),
        ] {
            assert!(permanent.permanent(), "{permanent:?}");
        }
        for transient in [
            refused(Refusal::Busy),
            refused(Refusal::Unavailable),
            ConnectError::Failed("x".into()),
            ConnectError::NotRunning,
        ] {
            assert!(!transient.permanent(), "{transient:?}");
        }
    }
}
